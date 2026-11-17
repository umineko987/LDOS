package network

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type trackedBody struct {
	io.Reader
	closed bool
	bytes  int
}

func (b *trackedBody) Read(p []byte) (int, error) {
	n, e := b.Reader.Read(p)
	b.bytes += n
	return n, e
}
func (b *trackedBody) Close() error { b.closed = true; return nil }
func dnsRecord(owner string, kind int, data string) map[string]any {
	return map[string]any{"name": owner, "type": kind, "data": data}
}
func dnsBody(t *testing.T, kind int, answers ...map[string]any) []byte {
	t.Helper()
	b, e := json.Marshal(map[string]any{"Status": 0, "Question": []any{map[string]any{"name": "images.example.", "type": kind}}, "Answer": answers})
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func assertDNSError(t *testing.T, err error, code string, retry bool) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code || e.Retryable != retry || e.ProxyFault != retry {
		t.Fatalf("error = %#v, want %s retry/proxyFault=%v", err, code, retry)
	}
	for _, secret := range []string{"supersecret", "images.example", "private.example"} {
		if strings.Contains(e.Error(), secret) {
			t.Fatalf("error leaks %q: %s", secret, e)
		}
	}
}
func fakeResolver(t *testing.T, settings DNSSettings, transport roundTripFunc) (*Resolver, *int) {
	t.Helper()
	r, e := NewResolver(settings)
	if e != nil {
		t.Fatal(e)
	}
	closed := 0
	r.newClient = func(_ context.Context, proxy string, timeout time.Duration) (*http.Client, func(), error) {
		if proxy != "http://user:supersecret@proxy.example:8080" || timeout != settings.Timeout {
			t.Errorf("client args %q %v", proxy, timeout)
		}
		return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, func() { closed++ }, nil
	}
	return r, &closed
}

const testProxy = "http://user:supersecret@proxy.example:8080"

func TestResolverDualQueriesAndClose(t *testing.T) {
	var queries []string
	var bodies []*trackedBody
	r, closed := fakeResolver(t, DefaultDNSSettings(), func(req *http.Request) (*http.Response, error) {
		q := req.URL.Query()
		queries = append(queries, q.Get("type"))
		if req.Method != "GET" || q.Get("name") != "images.example" || req.Header.Get("Accept") != "application/dns-json" {
			t.Errorf("request %v", req)
		}
		kind, address := 1, "8.8.8.8"
		if q.Get("type") == "AAAA" {
			kind, address = 28, "2001:4860:4860::8888"
		}
		body := &trackedBody{Reader: strings.NewReader(string(dnsBody(t, kind, dnsRecord("images.example", kind, address))))}
		bodies = append(bodies, body)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: body}, nil
	})
	got, err := r.Resolve(context.Background(), "IMAGES.example.", testProxy)
	if err != nil || !reflect.DeepEqual(got, []string{"8.8.8.8", "2001:4860:4860::8888"}) || !reflect.DeepEqual(queries, []string{"A", "AAAA"}) || *closed != 1 {
		t.Fatalf("%v %v queries=%v closed=%d", got, err, queries, *closed)
	}
	for _, body := range bodies {
		if !body.closed {
			t.Fatal("body not closed")
		}
	}
}

func TestResolverAdmissionAndCancellation(t *testing.T) {
	for _, tc := range []struct {
		name, proxy, code string
		enabled           bool
	}{{"no proxy", " ", "proxy_dns_failed", true}, {"disabled", testProxy, "encrypted_dns_unavailable", false}} {
		t.Run(tc.name, func(t *testing.T) {
			s := DefaultDNSSettings()
			s.Enabled = tc.enabled
			r, _ := NewResolver(s)
			r.newClient = func(context.Context, string, time.Duration) (*http.Client, func(), error) {
				t.Fatal("must fail before client creation")
				return nil, nil, nil
			}
			_, err := r.Resolve(context.Background(), "images.example", tc.proxy)
			assertDNSError(t, err, tc.code, false)
		})
	}
	r, closed := fakeResolver(t, DefaultDNSSettings(), func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := r.Resolve(ctx, "images.example", testProxy)
	if !errors.Is(err, context.Canceled) || *closed != 1 {
		t.Fatalf("cancel: %v closed=%d", err, *closed)
	}
	r.newClient = func(context.Context, string, time.Duration) (*http.Client, func(), error) {
		return nil, nil, errors.New("supersecret private.example")
	}
	_, err = r.Resolve(context.Background(), "images.example", testProxy)
	assertDNSError(t, err, "encrypted_dns_unavailable", true)
}

func TestResolverResponseBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name               string
		status             int
		length, body, code string
		retry              bool
	}{
		{"redirect", 302, "", "supersecret", "encrypted_dns_redirect", true},
		{"HTTP error", 503, "", "supersecret", "encrypted_dns_http_error", true},
		{"declared limit", 200, "257", "", "encrypted_dns_response_too_large", true},
		{"negative length", 200, "-1", "", "encrypted_dns_response_too_large", true},
		{"invalid length", 200, "bad", "", "encrypted_dns_protocol", true},
		{"stream limit", 200, "", strings.Repeat("x", 400), "encrypted_dns_response_too_large", true},
		{"invalid UTF8", 200, "", "\xff", "encrypted_dns_protocol", true},
		{"invalid JSON", 200, "", "supersecret", "encrypted_dns_protocol", true},
		{"NXDOMAIN", 200, "", `{"Status":3}`, "encrypted_dns_nxdomain", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := DefaultDNSSettings()
			s.MaxResponseBytes = 256
			body := &trackedBody{Reader: strings.NewReader(tc.body)}
			calls := 0
			r, closed := fakeResolver(t, s, func(*http.Request) (*http.Response, error) {
				calls++
				header := make(http.Header)
				header.Set("Content-Length", tc.length)
				return &http.Response{StatusCode: tc.status, Header: header, Body: body}, nil
			})
			_, err := r.Resolve(context.Background(), "images.example", testProxy)
			assertDNSError(t, err, tc.code, tc.retry)
			if !body.closed || *closed != 1 || calls != 1 || body.bytes > 257 {
				t.Fatalf("cleanup/bound: body=%+v client=%d calls=%d", body, *closed, calls)
			}
		})
	}
}

func TestDNSPayloadValidation(t *testing.T) {
	for _, body := range []string{`null`, `[]`, `{}`, `{"Status":true}`, `{"Status":0.0}`, `{"Status":0,"TC":true}`, `{"Status":0,"Question":[{"name":"private.example","type":1}]}`, `{"Status":0,"Question":[{"name":"images.example","type":28}]}`, `{"Status":0,"Question":[{"name":"images.example","type":1}],"Answer":{}}`, string(dnsBody(t, 1)) + ` {}`} {
		_, err := parsePayload([]byte(body), 1, "images.example")
		assertDNSError(t, err, "encrypted_dns_protocol", true)
	}
	_, err := parsePayload([]byte(`{"Status":2}`), 1, "images.example")
	assertDNSError(t, err, "encrypted_dns_status_error", true)
	for _, data := range []string{"supersecret", "::1"} {
		_, err := parsePayload(dnsBody(t, 1, dnsRecord("images.example", 1, data)), 1, "images.example")
		assertDNSError(t, err, "encrypted_dns_protocol", true)
	}
	for _, answers := range [][]map[string]any{
		{dnsRecord("images.example", 5, "edge.example"), dnsRecord("edge.example", 5, "images.example")},
		{dnsRecord("images.example", 5, "a.example"), dnsRecord("images.example", 5, "b.example")},
		{dnsRecord("images.example", 5, "8.8.8.8")},
	} {
		_, err := parsePayload(dnsBody(t, 1, answers...), 1, "images.example")
		assertDNSError(t, err, "encrypted_dns_protocol", true)
	}
	for _, hops := range []int{0, 1, 16, 17} {
		t.Run(fmt.Sprint(hops), func(t *testing.T) {
			owner := "images.example"
			var answers []map[string]any
			for i := 0; i < hops; i++ {
				next := fmt.Sprintf("hop%d.example", i)
				answers = append(answers, dnsRecord(owner, 5, next), dnsRecord(owner, 1, "9.9.9.9"))
				owner = next
			}
			answers = append(answers, dnsRecord(owner, 1, "8.8.8.8"), dnsRecord("unrelated.example", 1, "10.0.0.1"))
			if hops == 0 {
				answers = answers[len(answers)-2:]
			}
			for i, j := 0, len(answers)-1; i < j; i, j = i+1, j-1 {
				answers[i], answers[j] = answers[j], answers[i]
			}
			got, err := parsePayload(dnsBody(t, 1, answers...), 1, "images.example")
			if hops > 16 {
				assertDNSError(t, err, "encrypted_dns_protocol", true)
			} else if err != nil || !reflect.DeepEqual(got, []string{"8.8.8.8"}) {
				t.Fatalf("%v %v", got, err)
			}
		})
	}
}

func TestResolverEmptyAnswers(t *testing.T) {
	for _, withA := range []bool{false, true} {
		t.Run(fmt.Sprint(withA), func(t *testing.T) {
			r, _ := fakeResolver(t, DefaultDNSSettings(), func(req *http.Request) (*http.Response, error) {
				kind := 1
				if req.URL.Query().Get("type") == "AAAA" {
					kind = 28
				}
				answers := []map[string]any{dnsRecord("unrelated.example", kind, "8.8.8.8")}
				if withA && kind == 1 {
					answers = append(answers, dnsRecord("images.example", 1, "8.8.8.8"))
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(dnsBody(t, kind, answers...))))}, nil
			})
			got, err := r.Resolve(context.Background(), "images.example", testProxy)
			if withA {
				if err != nil || !reflect.DeepEqual(got, []string{"8.8.8.8"}) {
					t.Fatalf("%v %v", got, err)
				}
			} else {
				assertDNSError(t, err, "encrypted_dns_no_answer", false)
			}
		})
	}
}
