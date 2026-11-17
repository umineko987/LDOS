package activity

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	SSERetryMS           = 2000
	SSEHeartbeatInterval = 15 * time.Second
)

// ServeHTTP serves /api/v1/events. Origin/CORS policy belongs to the enclosing
// HTTP server. Last-Event-ID takes precedence over the query cursor when nonempty.
func (b *Bus) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.serveHTTP(w, r, SSEHeartbeatInterval)
}

func (b *Bus) serveHTTP(w http.ResponseWriter, r *http.Request, heartbeat time.Duration) {
	var query string
	if values := r.URL.Query()["last_event_id"]; len(values) > 0 {
		query = values[len(values)-1]
	}
	header := r.Header.Get("Last-Event-ID")
	if !validateCursors(w, query, header) {
		return
	}
	cursor := query
	if header != "" {
		cursor = header
	}
	subscriber := b.Subscribe(cursor)
	defer subscriber.Close()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	if err := controller.Flush(); err != nil {
		return
	}
	timer := time.NewTimer(heartbeat)
	defer timer.Stop()
	for {
		event, err := subscriber.next(r.Context(), timer.C)
		if err != nil {
			return
		}
		if event == nil {
			_, err = io.WriteString(w, ": ping\n\n")
		} else {
			_, err = io.WriteString(w, formatSSE(*event))
		}
		if err != nil || controller.Flush() != nil {
			return
		}
		timer.Reset(heartbeat)
	}
}

// FastAPI's SSE encoder orders fields event, data, id, retry and uses LF.
func formatSSE(event Event) string {
	var out strings.Builder
	fmt.Fprintf(&out, "event: %s\ndata: %s\nid: %s\n", event.Kind, event.Data, event.ID)
	if event.Retry > 0 {
		fmt.Fprintf(&out, "retry: %d\n", event.Retry)
	}
	out.WriteByte('\n')
	return out.String()
}

type cursorValidationError struct {
	Type    string         `json:"type"`
	Loc     [2]string      `json:"loc"`
	Message string         `json:"msg"`
	Input   string         `json:"input"`
	Context map[string]int `json:"ctx"`
}

func validateCursors(w http.ResponseWriter, query, header string) bool {
	errors := make([]cursorValidationError, 0)
	for _, field := range []struct{ location, name, value string }{
		{"query", "last_event_id", query}, {"header", "Last-Event-ID", header},
	} {
		if utf8.RuneCountInString(field.value) > 64 {
			errors = append(errors, cursorValidationError{
				Type: "string_too_long", Loc: [2]string{field.location, field.name},
				Message: "String should have at most 64 characters", Input: field.value,
				Context: map[string]int{"max_length": 64},
			})
		}
	}
	if len(errors) == 0 {
		return true
	}
	payload, _ := encodeJSON(map[string]any{
		"error": map[string]any{
			"code":       "validation_error",
			"message":    "请求参数校验失败",
			"details":    errors,
			"request_id": w.Header().Get("X-Request-ID"),
		},
	})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnprocessableEntity)
	w.Write(payload)
	return false
}
