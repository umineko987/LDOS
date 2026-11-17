package main

import (
	"encoding/base64"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func nativeProxyFixture(t *testing.T, root string) (map[string]any, []string, *atomic.Int32) {
	t.Helper()
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "proxied fixture") }))
	t.Cleanup(target.Close)
	hits := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != target.Listener.Addr().String() {
			http.Error(w, "unexpected target", 400)
			return
		}
		if r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("fixture:private-proxy-password")) {
			http.Error(w, "proxy credentials missing", 407)
			return
		}
		peer, err := net.DialTimeout("tcp", target.Listener.Addr().String(), time.Second)
		if err != nil {
			http.Error(w, "target unavailable", 502)
			return
		}
		defer peer.Close()
		conn, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
		_ = peer.SetDeadline(time.Now().Add(15 * time.Second))
		_, _ = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		if err := buffer.Flush(); err != nil {
			return
		}
		hits.Add(1)
		done := make(chan struct{})
		go func() { _, _ = io.Copy(peer, buffer); peer.Close(); close(done) }()
		_, _ = io.Copy(conn, peer)
		conn.Close()
		<-done
	}))
	t.Cleanup(upstream.Close)
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: target.Certificate().Raw})
	ca := filepath.Join(root, "fixture-ca.pem")
	if err := os.WriteFile(ca, certificate, 0600); err != nil {
		t.Fatal(err)
	}
	endpoint, _ := url.Parse(upstream.URL)
	endpoint.User = url.UserPassword("fixture", "private-proxy-password")
	return map[string]any{"enabled": true, "auto_start": true, "transport_core_enabled": false, "inline_nodes": []string{endpoint.String()}, "probe_url": target.URL, "probe_timeout_seconds": 2},
		[]string{"SSL_CERT_FILE=" + ca, "SSL_CERT_DIR=" + root, "LDOS_TEST_FETCH_URL=" + target.URL}, hits
}

func validateFixtureProxy() error {
	target := os.Getenv("LDOS_TEST_FETCH_URL")
	if target == "" {
		return nil
	}
	var endpoint string
	for i, arg := range os.Args {
		if arg == "--proxy" && i+1 < len(os.Args) {
			endpoint = os.Args[i+1]
			break
		}
	}
	proxy, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	if proxy.Host == "" || proxy.User != nil {
		return &url.Error{Op: "fixture proxy", URL: "", Err: os.ErrInvalid}
	}
	transport := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	response, err := client.Get(target)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode != 200 || string(body) != "proxied fixture" {
		return os.ErrInvalid
	}
	return nil
}
