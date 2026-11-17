package proxytransport

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProbeUsesSeparateConnectAndReadBudgets(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		reader := bufio.NewReader(conn)
		if _, err := io.ReadFull(reader, make([]byte, 9)); err != nil {
			return
		}
		time.Sleep(300 * time.Millisecond)
		_, _ = conn.Write([]byte{0, 90, 0, 0, 0, 0, 0, 0})
		if _, err := http.ReadRequest(reader); err != nil {
			return
		}
		time.Sleep(300 * time.Millisecond)
		_, _ = io.WriteString(conn, "HTTP/1.1 204 No Content\r\n\r\n")
	}()
	status, err := ProbeHTTPStatus(context.Background(), "http://127.0.0.1/", "socks4://"+listener.Addr().String(), 500*time.Millisecond)
	if err != nil || status != 204 {
		t.Fatalf("connect and read incorrectly shared one deadline: %d %v", status, err)
	}
	<-done
}

func TestProbeProxyCONNECTReadTimeout(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		reader := bufio.NewReader(conn)
		if _, err := readProxyHeader(reader); err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, reader)
	}()
	_, err = ProbeHTTPStatus(context.Background(), "https://example.invalid/", "http://"+listener.Addr().String(), 100*time.Millisecond)
	if err == nil {
		t.Fatal("silent CONNECT proxy succeeded")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("CONNECT read timeout leaked socket")
	}
}

func TestProbeHTTPAuthenticationMatchesRequests(t *testing.T) {
	for _, tc := range []struct {
		endpoint, auth string
		fail           bool
	}{
		{"http://us%C3%A9r:p%C3%A4ss@127.0.0.1:80", "Basic dXPpcjpw5HNz", false},
		{"http://:pass@127.0.0.1:80", "", false},
		{"http://%E7%94%A8%E6%88%B7:pass@127.0.0.1:80", "", true},
	} {
		proxy, err := url.Parse(tc.endpoint)
		if err != nil {
			t.Fatal(err)
		}
		auth, err := probeHTTPAuthorization(proxy)
		if (err != nil) != tc.fail || auth != tc.auth {
			t.Fatalf("unexpected HTTP auth result: %q %v", auth, err)
		}
	}
}

func TestProbeHTTPStatusNoRedirectNoBodyNoEnvironment(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("ALL_PROXY", "socks5://127.0.0.1:1")
	t.Setenv("NO_PROXY", "*")
	var requests atomic.Int32
	closed := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.RequestURI != "http://example.invalid/probe" || r.Header.Get("User-Agent") != "gallery-dl-backend-probe/1.0" {
			t.Errorf("probe request changed: %s %s", r.RequestURI, r.UserAgent())
		}
		if r.Header.Get("Proxy-Authorization") != "Basic dXNlcjpwYXNz" {
			t.Error("missing proxy authentication")
		}
		w.Header().Set("Location", "http://example.invalid/followed")
		w.Header().Set("Content-Length", "1000000")
		w.WriteHeader(302)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	}))
	defer upstream.Close()
	endpoint := strings.Replace(upstream.URL, "http://", "http://user:pass@", 1)
	status, err := ProbeHTTPStatus(context.Background(), "http://example.invalid/probe", endpoint, 2*time.Second)
	if err != nil || status != 302 {
		t.Fatalf("status %d: %v", status, err)
	}
	if requests.Load() != 1 {
		t.Fatal("probe followed redirect")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("stream body was not closed")
	}
}

func TestProbeSOCKSProtocols(t *testing.T) {
	for _, scheme := range []string{"socks4", "socks5", "socks5h"} {
		t.Run(scheme, func(t *testing.T) {
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			result := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					result <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				result <- serveSOCKSProbe(conn, scheme)
			}()
			target := "http://127.0.0.1:18080/probe"
			if scheme == "socks5h" {
				target = "http://remote-only.invalid:18080/probe"
			}
			status, err := ProbeHTTPStatus(context.Background(), target, scheme+"://user:pass@"+listener.Addr().String(), 2*time.Second)
			if err != nil || status != 204 {
				t.Fatalf("status=%d error=%v", status, err)
			}
			if err := <-result; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func serveSOCKSProbe(conn net.Conn, scheme string) error {
	reader := bufio.NewReader(conn)
	if scheme == "socks4" {
		header := make([]byte, 8)
		if _, err := io.ReadFull(reader, header); err != nil {
			return err
		}
		user, err := reader.ReadString(0)
		if err != nil {
			return err
		}
		if header[0] != 4 || header[1] != 1 || binary.BigEndian.Uint16(header[2:4]) != 18080 || !net.IP(header[4:]).Equal(net.ParseIP("127.0.0.1")) || user != "user\x00" {
			return fmt.Errorf("unexpected SOCKS4 request: %v %q", header, user)
		}
		_, _ = conn.Write([]byte{0, 90, 0, 0, 0, 0, 0, 0})
	} else {
		header := make([]byte, 2)
		if _, err := io.ReadFull(reader, header); err != nil {
			return err
		}
		methods := make([]byte, int(header[1]))
		if _, err := io.ReadFull(reader, methods); err != nil {
			return err
		}
		if header[0] != 5 || len(methods) != 2 || methods[0] != 0 || methods[1] != 2 {
			return fmt.Errorf("invalid SOCKS5 greeting")
		}
		_, _ = conn.Write([]byte{5, 2})
		if _, err := io.ReadFull(reader, header); err != nil {
			return err
		}
		user := make([]byte, int(header[1]))
		if _, err := io.ReadFull(reader, user); err != nil {
			return err
		}
		length, err := reader.ReadByte()
		if err != nil {
			return err
		}
		password := make([]byte, int(length))
		if _, err := io.ReadFull(reader, password); err != nil {
			return err
		}
		if header[0] != 1 || string(user) != "user" || string(password) != "pass" {
			return fmt.Errorf("wrong SOCKS5 auth")
		}
		_, _ = conn.Write([]byte{1, 0})
		request := make([]byte, 4)
		if _, err := io.ReadFull(reader, request); err != nil {
			return err
		}
		if request[0] != 5 || request[1] != 1 || request[2] != 0 {
			return fmt.Errorf("wrong SOCKS5 command")
		}
		if scheme == "socks5h" {
			if request[3] != 3 {
				return fmt.Errorf("socks5h resolved DNS locally")
			}
			length, err := reader.ReadByte()
			if err != nil {
				return err
			}
			host := make([]byte, int(length))
			if _, err := io.ReadFull(reader, host); err != nil {
				return err
			}
			if string(host) != "remote-only.invalid" {
				return fmt.Errorf("wrong domain")
			}
		} else {
			if request[3] != 1 {
				return fmt.Errorf("socks5 failed to use local IP")
			}
			ip := make([]byte, 4)
			if _, err := io.ReadFull(reader, ip); err != nil {
				return err
			}
			if !net.IP(ip).Equal(net.ParseIP("127.0.0.1")) {
				return fmt.Errorf("wrong IP")
			}
		}
		if _, err := io.ReadFull(reader, header); err != nil {
			return err
		}
		if binary.BigEndian.Uint16(header) != 18080 {
			return fmt.Errorf("wrong port")
		}
		// A domain-name bind response also exercises variable-length reply parsing.
		_, _ = conn.Write([]byte{5, 0, 0, 3, 1, 'x', 0, 0})
	}
	req, err := http.ReadRequest(reader)
	if err != nil {
		return err
	}
	defer req.Body.Close()
	if req.RequestURI != "/probe" || req.UserAgent() != "gallery-dl-backend-probe/1.0" {
		return fmt.Errorf("wrong tunneled request")
	}
	_, err = io.WriteString(conn, "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
	return err
}

func TestProbeSOCKSCancellationClosesHandshake(t *testing.T) {
	listener, _ := net.Listen("tcp4", "127.0.0.1:0")
	defer listener.Close()
	accepted := make(chan struct{})
	closed := make(chan struct{})
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		close(accepted)
		_, _ = io.Copy(io.Discard, conn)
		close(closed)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := ProbeHTTPStatus(ctx, "http://remote-only.invalid/", "socks5h://"+listener.Addr().String(), 5*time.Second)
		done <- err
	}()
	<-accepted
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("cancelled probe succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("probe cancellation blocked")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("SOCKS handshake leaked after cancellation")
	}
}

func TestProbeRejectsUntrustedHTTPSProxy(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted proxy received request") }))
	defer server.Close()
	if _, err := ProbeHTTPStatus(context.Background(), "http://example.invalid/", server.URL, time.Second); err == nil {
		t.Error("TLS verification bypassed")
	}
}

func TestSOCKS4IPv6AndAuthenticationFailure(t *testing.T) {
	if _, err := lookupSOCKSIP(context.Background(), "::1", true); err == nil {
		t.Error("SOCKS4 accepted IPv6")
	}
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	go func() { b := make([]byte, 4); _, _ = io.ReadFull(right, b); _, _ = right.Write([]byte{5, 255}) }()
	_ = left.SetDeadline(time.Now().Add(time.Second))
	proxy, _ := url.Parse("socks5://user:pass@127.0.0.1:1080")
	if err := socks5Handshake(context.Background(), left, proxy, "127.0.0.1", 80); err == nil {
		t.Error("SOCKS rejection accepted")
	}
}
