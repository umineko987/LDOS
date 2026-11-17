package activity

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func openSSE(t *testing.T, bus *Bus, query url.Values, header string) (*http.Response, *bufio.Reader, <-chan struct{}) {
	t.Helper()
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		bus.ServeHTTP(w, r)
	}))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/v1/events?"+query.Encode(), nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Last-Event-ID", header)
	response, err := server.Client().Do(request)
	if err != nil {
		cancel()
		server.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		response.Body.Close()
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("disconnect did not stop handler")
			bus.Close()
		}
		server.Close()
		if bus.SubscriberCount() != 0 {
			t.Error("HTTP subscriber leaked")
		}
	})
	return response, bufio.NewReader(response.Body), done
}

func readSSEBlock(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var block strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		block.WriteString(line)
		if line == "\n" {
			return block.String()
		}
	}
}

func TestHTTPHelloWireEncodingAndJobUpdate(t *testing.T) {
	bus := NewBus(0)
	response, reader, _ := openSSE(t, bus, nil, "")
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" || response.Header.Get("Cache-Control") != "no-cache" || response.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("unexpected response %d %v", response.StatusCode, response.Header)
	}
	cursor := bus.LastEventID()
	want := "event: hello\ndata: {\"last_event_id\":\"" + cursor + "\",\"reason\":\"\"}\nid: " + cursor + "\nretry: 2000\n\n"
	if block := readSSEBlock(t, reader); block != want {
		t.Fatalf("hello wire format\ngot: %q\nwant: %q", block, want)
	}
	registry := NewRegistry(bus)
	job := startJob(t, registry, "tagger.tag", "打标 <>&\n第二行", StartOptions{ID: "tagger:x"})
	payload, err := encodeJSON(struct {
		Job *Job `json:"job"`
	}{job})
	if err != nil {
		t.Fatal(err)
	}
	want = "event: job.updated\ndata: " + string(payload) + "\nid: " + bus.LastEventID() + "\n\n"
	if block := readSSEBlock(t, reader); block != want || !strings.Contains(block, "打标 <>&\\n第二行") {
		t.Fatalf("job wire format %q", block)
	}
}

func TestHTTPCursorPrecedenceAndReplay(t *testing.T) {
	for _, test := range []struct {
		name, header string
		duplicate    bool
		expected     string
	}{
		{"query", "", false, "ds1"},
		{"header", "newer", false, "ds2"},
		{"empty_header", "", false, "ds1"},
		{"duplicate_query_uses_last", "", true, "ds2"},
	} {
		t.Run(test.name, func(t *testing.T) {
			bus := NewBus(0)
			old := bus.LastEventID()
			publish(t, bus, "dataset.updated", map[string]string{"dataset_id": "ds1"})
			newer := bus.LastEventID()
			publish(t, bus, "dataset.updated", map[string]string{"dataset_id": "ds2"})
			query := url.Values{"last_event_id": {old}}
			if test.duplicate {
				query.Add("last_event_id", newer)
			}
			header := test.header
			if header == "newer" {
				header = newer
			}
			_, reader, _ := openSSE(t, bus, query, header)
			block := readSSEBlock(t, reader)
			if !strings.HasPrefix(block, "event: dataset.updated\n") || !strings.Contains(block, `"dataset_id":"`+test.expected+`"`) || strings.Contains(block, "retry:") {
				t.Fatalf("wrong replay %q", block)
			}
		})
	}
}

func TestHTTPResyncAndClosedStream(t *testing.T) {
	bus := NewBus(1)
	_, reader, done := openSSE(t, bus, nil, "previous-process-42")
	block := readSSEBlock(t, reader)
	if !strings.HasPrefix(block, "event: resync\n") || !strings.Contains(block, `"reason":"unknown_cursor"`) || strings.Contains(block, "retry:") {
		t.Fatalf("wrong resync %q", block)
	}
	bus.Close()
	if remaining, err := io.ReadAll(reader); err != nil || len(remaining) != 0 {
		t.Fatalf("closed stream: %q %v", remaining, err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("close did not stop HTTP handler")
	}
}

func TestHTTPClientDisconnectReleasesSubscriber(t *testing.T) {
	bus := NewBus(0)
	response, reader, done := openSSE(t, bus, nil, "")
	readSSEBlock(t, reader)
	if bus.SubscriberCount() != 1 {
		t.Fatal("subscriber not registered")
	}
	response.Body.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("disconnect did not stop HTTP handler")
	}
	if bus.SubscriberCount() != 0 {
		t.Fatal("disconnect leaked subscriber")
	}
}

func TestHTTPValidCurrentCursorFlushesHeaders(t *testing.T) {
	bus := NewBus(0)
	response, reader, _ := openSSE(t, bus, nil, bus.LastEventID())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	publish(t, bus, "later", nil)
	if block := readSSEBlock(t, reader); !strings.HasPrefix(block, "event: later\n") {
		t.Fatalf("unexpected marker: %q", block)
	}
}

func TestHTTPCursorLengthValidation(t *testing.T) {
	bus := NewBus(0)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/events?last_event_id="+url.QueryEscape(strings.Repeat("字", 65)), nil)
	request.Header.Set("Last-Event-ID", strings.Repeat("x", 65))
	request.Header.Set("X-Request-ID", "client-request-id")
	recorder := httptest.NewRecorder()
	recorder.Header().Set("X-Request-ID", "guard-request-id")
	bus.ServeHTTP(recorder, request)
	var payload struct {
		Error struct {
			Code      string                  `json:"code"`
			Message   string                  `json:"message"`
			Details   []cursorValidationError `json:"details"`
			RequestID string                  `json:"request_id"`
		} `json:"error"`
	}
	decoder := json.NewDecoder(recorder.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error.Code != "validation_error" || payload.Error.Message != "请求参数校验失败" || payload.Error.RequestID != "guard-request-id" {
		t.Fatalf("unexpected error envelope: %+v", payload.Error)
	}
	if recorder.Header().Get("X-Request-ID") != payload.Error.RequestID || recorder.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected error headers: %v", recorder.Header())
	}
	details := payload.Error.Details
	if recorder.Code != 422 || len(details) != 2 || details[0].Loc != [2]string{"query", "last_event_id"} || details[1].Loc != [2]string{"header", "Last-Event-ID"} || bus.SubscriberCount() != 0 {
		t.Fatalf("cursor validation: %d %+v", recorder.Code, payload.Error)
	}
	// Validation also applies to the query when a valid header takes precedence.
	request.Header.Set("Last-Event-ID", bus.LastEventID())
	recorder = httptest.NewRecorder()
	bus.ServeHTTP(recorder, request)
	if recorder.Code != 422 {
		t.Fatal("unused overlong query was accepted")
	}
}

type sseCapture struct {
	header http.Header
	chunks chan string
}

func (w *sseCapture) Header() http.Header { return w.header }
func (w *sseCapture) WriteHeader(int)     {}
func (w *sseCapture) Flush()              {}
func (w *sseCapture) Write(data []byte) (int, error) {
	w.chunks <- string(data)
	return len(data), nil
}

func TestHTTPIdleHeartbeatResetsAfterEvents(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		bus := NewBus(0)
		writer := &sseCapture{header: make(http.Header), chunks: make(chan string, 4)}
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		request := httptest.NewRequest(http.MethodGet, "/api/v1/events", nil).WithContext(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			bus.ServeHTTP(writer, request)
		}()
		synctest.Wait()
		if hello := <-writer.chunks; !strings.HasPrefix(hello, "event: hello\n") {
			t.Fatalf("unexpected hello %q", hello)
		}
		time.Sleep(14 * time.Second)
		synctest.Wait()
		if len(writer.chunks) != 0 {
			t.Fatal("heartbeat arrived before 15 idle seconds")
		}
		publish(t, bus, "tick", nil)
		synctest.Wait()
		if event := <-writer.chunks; !strings.HasPrefix(event, "event: tick\n") {
			t.Fatalf("unexpected event %q", event)
		}
		time.Sleep(14 * time.Second)
		synctest.Wait()
		if len(writer.chunks) != 0 {
			t.Fatal("event did not reset idle heartbeat")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		if heartbeat := <-writer.chunks; heartbeat != ": ping\n\n" {
			t.Fatalf("heartbeat wire format: %q", heartbeat)
		}
		cancel()
		synctest.Wait()
		select {
		case <-done:
		default:
			t.Fatal("cancel did not stop handler")
		}
		if bus.SubscriberCount() != 0 {
			t.Fatal("heartbeat stream leaked subscriber")
		}
	})
}
