package proxytransport

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestForwarderHTTPAuthenticationAndBody(t *testing.T) {
	seen := make(chan *http.Request, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != "payload" {
			t.Errorf("body lost: %q", body)
		}
		seen <- r
		w.WriteHeader(201)
		_, _ = w.Write([]byte("forwarded"))
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	u.User = url.UserPassword("usér", "p:a ss")
	forwarder, err := NewForwarder(u.String())
	if err != nil {
		t.Fatal(err)
	}
	local, err := forwarder.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer forwarder.Stop()
	if again, err := forwarder.Start(); err != nil || again != local {
		t.Fatal("Start is not idempotent")
	}
	proxy, _ := url.Parse(local)
	transport := &http.Transport{Proxy: http.ProxyURL(proxy)}
	defer transport.CloseIdleConnections()
	request, _ := http.NewRequest(http.MethodPost, "http://example.invalid/resource?x=1", strings.NewReader("payload"))
	request.Header.Set("Proxy-Authorization", "Basic client-credentials")
	response, err := (&http.Client{Transport: transport, Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 201 || string(body) != "forwarded" {
		t.Fatalf("unexpected response: %d %q", response.StatusCode, body)
	}
	r := <-seen
	if r.RequestURI != "http://example.invalid/resource?x=1" {
		t.Error(r.RequestURI)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("usér:p:a ss"))
	if got := r.Header.Values("Proxy-Authorization"); len(got) != 1 || got[0] != wantAuth {
		t.Error("upstream authentication was not substituted")
	}
	if r.Header.Get("Connection") != "close" {
		t.Error("HTTP request must close upstream")
	}
}

func TestForwarderCONNECTAndStopClosesAcceptedConnections(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	upstreamClosed := make(chan struct{})
	seen := make(chan string, 1)
	go func() {
		defer close(upstreamClosed)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		reader := bufio.NewReader(conn)
		header, err := readProxyHeader(reader)
		if err != nil {
			return
		}
		seen <- header
		_, _ = io.WriteString(conn, "HTTP/1.1 299 Connected\r\n\r\nwelcome")
		buf := make([]byte, 4)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return
		}
		_, _ = conn.Write(buf)
		_, _ = io.Copy(io.Discard, reader)
	}()
	f, _ := NewForwarder("http://user:pass@" + listener.Addr().String())
	local, err := f.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	client, err := net.Dial("tcp", strings.TrimPrefix(local, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(client, "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\npRoXy-AuThOrIzAtIoN: forged\r\n\r\nping")
	reader := bufio.NewReader(client)
	header, err := readProxyHeader(reader)
	if err != nil || !connectSucceeded(header) {
		t.Fatalf("CONNECT failed: %s %v", header, err)
	}
	buf := make([]byte, 11)
	if _, err := io.ReadFull(reader, buf); err != nil || string(buf) != "welcomeping"[:11] {
		t.Fatalf("tunnel data: %q %v", buf, err)
	}
	upstreamHeader := <-seen
	if strings.Contains(upstreamHeader, "forged") || strings.Count(strings.ToLower(upstreamHeader), "proxy-authorization:") != 1 {
		t.Error("client authentication leaked")
	}
	idle, err := net.Dial("tcp", strings.TrimPrefix(local, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	if err := f.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []net.Conn{client, idle} {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := conn.Read(make([]byte, 1)); err == nil {
			t.Error("accepted connection survived Stop")
		}
	}
	select {
	case <-upstreamClosed:
	case <-time.After(time.Second):
		t.Fatal("upstream connection survived Stop")
	}
}

func TestForwarderRejectsCONNECTRedirect(t *testing.T) {
	l, _ := net.Listen("tcp4", "127.0.0.1:0")
	defer l.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = readProxyHeader(bufio.NewReader(c))
		_, _ = io.WriteString(c, "HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n")
		_, _ = c.Read(make([]byte, 1))
	}()
	f, _ := NewForwarder("http://user:pass@" + l.Addr().String())
	local, err := f.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	c, err := net.Dial("tcp", strings.TrimPrefix(local, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.WriteString(c, "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n")
	reader := bufio.NewReader(c)
	header, err := readProxyHeader(reader)
	if err != nil || !strings.Contains(header, "302") {
		t.Fatal(header, err)
	}
	if _, err := reader.ReadByte(); err == nil {
		t.Error("redirect became a tunnel")
	}
	<-done
}

func TestForwarderTLSVerificationAndNoDirectFallback(t *testing.T) {
	for _, endpoint := range []string{"socks5://user:pass@127.0.0.1:1", "http://127.0.0.1:80", "http://user:pass@127.0.0.1"} {
		if _, err := NewForwarder(endpoint); err == nil {
			t.Error("accepted invalid upstream")
		}
	}
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS upstream accepted") }))
	defer upstream.Close()
	f, err := NewForwarder(strings.Replace(upstream.URL, "https://", "https://user:pass@", 1))
	if err != nil {
		t.Fatal(err)
	}
	local, err := f.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("request fell back to direct connection") }))
	defer target.Close()
	if _, err := ProbeHTTPStatus(context.Background(), target.URL, local, 2*time.Second); err == nil {
		t.Error("untrusted upstream succeeded")
	}
}

func TestForwarderConcurrentLifecycle(t *testing.T) {
	f, _ := NewForwarder("http://user:pass@127.0.0.1:1")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 8; j++ {
				if _, err := f.Start(); err != nil {
					t.Error(err)
				}
				_ = f.Stop()
			}
		}()
	}
	wg.Wait()
	_ = f.Stop()
}

func TestProxyHeaderLimitsAndCredentials(t *testing.T) {
	if _, err := readProxyHeader(bufio.NewReader(strings.NewReader(strings.Repeat("x", 65537) + "\r\n\r\n"))); err == nil {
		t.Error("oversize header accepted")
	}
	for _, header := range []string{
		"GET /origin HTTP/1.1\r\n\r\n",
		"GET http://example.invalid/ HTTP/1.1\r\nX: value\nProxy-Authorization: forged\r\n\r\n",
		"GET http://example.invalid/ HTTP/1.1\r\n Proxy-Authorization: forged\r\n\r\n",
	} {
		if _, _, err := withProxyAuth(header, "Basic good"); err == nil {
			t.Errorf("accepted malformed request %q", header)
		}
	}
	for _, status := range []int{200, 299, 302, 407} {
		if got := connectSucceeded(fmt.Sprintf("HTTP/1.1 %d Status\r\n", status)); got != (status < 300) {
			t.Error(status)
		}
	}
}
