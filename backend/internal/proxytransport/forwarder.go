package proxytransport

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const relayIdleTimeout = 300 * time.Second

type forwardRun struct {
	listener    net.Listener
	ctx         context.Context
	cancel      context.CancelFunc
	connections map[net.Conn]struct{}
	wg          sync.WaitGroup
}

type Forwarder struct {
	upstream      *url.URL
	authorization string
	lifecycle     sync.Mutex
	mu            sync.Mutex
	run           *forwardRun
}

func NewForwarder(upstream string) (*Forwarder, error) {
	u, err := url.Parse(upstream)
	if err != nil {
		return nil, errors.New("本地认证转发器仅接收 HTTP/HTTPS 上游代理")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("本地认证转发器仅接收 HTTP/HTTPS 上游代理")
	}
	username := u.User.Username()
	password, _ := u.User.Password()
	if username == "" && password == "" {
		return nil, errors.New("上游代理不含认证信息")
	}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
	return &Forwarder{upstream: u, authorization: auth}, nil
}

func (f *Forwarder) Start() (string, error) {
	f.lifecycle.Lock()
	defer f.lifecycle.Unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.run != nil {
		return "http://" + f.run.listener.Addr().String(), nil
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &forwardRun{listener: listener, ctx: ctx, cancel: cancel, connections: make(map[net.Conn]struct{})}
	f.run = run
	run.wg.Add(1)
	go f.accept(run)
	return "http://" + listener.Addr().String(), nil
}

func (f *Forwarder) Stop() error {
	f.lifecycle.Lock()
	defer f.lifecycle.Unlock()
	f.mu.Lock()
	run := f.run
	f.run = nil
	if run != nil {
		run.cancel()
		_ = run.listener.Close()
		for conn := range run.connections {
			_ = conn.Close()
		}
	}
	f.mu.Unlock()
	if run != nil {
		run.wg.Wait()
	}
	return nil
}

func (f *Forwarder) track(run *forwardRun, conn net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if run.ctx.Err() != nil {
		conn.Close()
		return false
	}
	run.connections[conn] = struct{}{}
	return true
}

func (f *Forwarder) untrack(run *forwardRun, conn net.Conn) {
	_ = conn.Close()
	f.mu.Lock()
	delete(run.connections, conn)
	f.mu.Unlock()
}

func (f *Forwarder) accept(run *forwardRun) {
	defer run.wg.Done()
	for {
		client, err := run.listener.Accept()
		if err != nil {
			return
		}
		if !f.track(run, client) {
			return
		}
		run.wg.Add(1)
		go func() {
			defer run.wg.Done()
			defer f.untrack(run, client)
			f.handle(run, client)
		}()
	}
}

func (f *Forwarder) handle(run *forwardRun, client net.Conn) {
	_ = client.SetDeadline(time.Now().Add(30 * time.Second))
	clientReader := bufio.NewReader(client)
	header, err := readProxyHeader(clientReader)
	if err != nil {
		return
	}
	header, connect, err := withProxyAuth(header, f.authorization)
	if err != nil {
		return
	}
	raw, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(run.ctx, "tcp", f.upstream.Host)
	if err != nil {
		return
	}
	if !f.track(run, raw) {
		return
	}
	defer f.untrack(run, raw)
	_ = raw.SetDeadline(time.Now().Add(30 * time.Second))
	var upstream net.Conn = raw
	if f.upstream.Scheme == "https" {
		tlsConn := tls.Client(raw, &tls.Config{ServerName: f.upstream.Hostname(), MinVersion: tls.VersionTLS12})
		if err := tlsConn.HandshakeContext(run.ctx); err != nil {
			return
		}
		upstream = tlsConn
	}
	if _, err := io.WriteString(upstream, header); err != nil {
		return
	}
	upstreamReader := bufio.NewReader(upstream)
	if connect {
		response, err := readProxyHeader(upstreamReader)
		if err != nil {
			return
		}
		if _, err := io.WriteString(client, response); err != nil {
			return
		}
		if !connectSucceeded(response) {
			return
		}
	}
	relay(client, clientReader, upstream, upstreamReader)
}

func readProxyHeader(reader *bufio.Reader) (string, error) {
	var header strings.Builder
	for {
		part, err := reader.ReadSlice('\n')
		if header.Len()+len(part) > 65536 {
			return "", errors.New("HTTP proxy header too large")
		}
		header.Write(part)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return "", err
		}
		if strings.HasSuffix(header.String(), "\r\n\r\n") {
			return header.String(), nil
		}
	}
}

func withProxyAuth(header, authorization string) (string, bool, error) {
	lines := strings.Split(strings.TrimSuffix(header, "\r\n\r\n"), "\r\n")
	parts := strings.Split(lines[0], " ")
	if len(parts) != 3 || (parts[2] != "HTTP/1.1" && parts[2] != "HTTP/1.0") {
		return "", false, errors.New("invalid HTTP proxy request")
	}
	connect := strings.EqualFold(parts[0], "CONNECT")
	if !connect {
		u, err := url.Parse(parts[1])
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return "", false, errors.New("proxy request requires an absolute URI")
		}
	}
	output := []string{lines[0]}
	for _, line := range lines[1:] {
		name, _, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) != name || name == "" || strings.ContainsAny(line, "\r\n") {
			return "", false, errors.New("invalid HTTP proxy header")
		}
		switch strings.ToLower(name) {
		case "proxy-authorization", "proxy-connection", "connection":
			continue
		}
		output = append(output, line)
	}
	output = append(output, "Proxy-Authorization: "+authorization)
	if connect {
		output = append(output, "Proxy-Connection: Keep-Alive")
	} else {
		output = append(output, "Connection: close")
	}
	return strings.Join(output, "\r\n") + "\r\n\r\n", connect, nil
}

func connectSucceeded(header string) bool {
	line, _, _ := strings.Cut(header, "\r\n")
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 2 {
		return false
	}
	code, err := strconv.Atoi(parts[1])
	return err == nil && code >= 200 && code <= 299
}

func relay(left net.Conn, leftReader io.Reader, right net.Conn, rightReader io.Reader) {
	refresh := func() {
		deadline := time.Now().Add(relayIdleTimeout)
		_ = left.SetDeadline(deadline)
		_ = right.SetDeadline(deadline)
	}
	refresh()
	done := make(chan struct{}, 2)
	copySide := func(dst net.Conn, src io.Reader) {
		defer func() { _ = left.Close(); _ = right.Close(); done <- struct{}{} }()
		buf := make([]byte, 65536)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				refresh()
				if _, writeErr := dst.Write(buf[:n]); writeErr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go copySide(right, leftReader)
	go copySide(left, rightReader)
	<-done
	<-done
}

func proxyAddress(u *url.URL) string {
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else if u.Scheme == "http" {
			port = "80"
		} else {
			port = "1080"
		}
	}
	return net.JoinHostPort(u.Hostname(), port)
}

func proxyProtocolError(protocol string, code byte) error {
	return fmt.Errorf("%s proxy refused request (code %d)", protocol, code)
}
