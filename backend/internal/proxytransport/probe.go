package proxytransport

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// requests' scalar timeout is a connect/read idle budget, not an overall request
// deadline. Socket deadlines also cover HTTP proxy CONNECT response headers.
type probeConn struct {
	net.Conn
	timeout time.Duration
}

func (c *probeConn) Read(p []byte) (int, error) {
	if err := c.Conn.SetReadDeadline(time.Now().Add(c.timeout)); err != nil {
		return 0, err
	}
	return c.Conn.Read(p)
}

func (c *probeConn) Write(p []byte) (int, error) {
	if err := c.Conn.SetWriteDeadline(time.Now().Add(c.timeout)); err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}

// ProbeHTTPStatus performs one GET, does not follow redirects, and closes the
// response without downloading its body. Proxy selection never consults the environment.
func ProbeHTTPStatus(ctx context.Context, target, endpoint string, timeout time.Duration) (int, error) {
	if endpoint == "" {
		return 0, errors.New("invalid proxy endpoint")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	client, closeClient, err := NewHTTPClient(ctx, endpoint, timeout)
	if err != nil {
		return 0, err
	}
	defer closeClient()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set("User-Agent", "gallery-dl-backend-probe/1.0")
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}

// requests uses Latin-1 for HTTP proxy Basic authentication. The forwarder's
// UTF-8 authorization is a separate legacy contract in proxy_runtime.py.
func probeHTTPAuthorization(proxy *url.URL) (string, error) {
	username := proxy.User.Username()
	if username == "" {
		return "", nil
	}
	password, _ := proxy.User.Password()
	var credentials []byte
	for _, r := range strings.ToValidUTF8(username+":"+password, "�") {
		if r > 255 {
			return "", errors.New("HTTP proxy credentials cannot be encoded as Latin-1")
		}
		credentials = append(credentials, byte(r))
	}
	return "Basic " + base64.StdEncoding.EncodeToString(credentials), nil
}

func dialSOCKS(ctx context.Context, proxy *url.URL, address string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("invalid SOCKS destination port")
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", proxyAddress(proxy))
	if err != nil {
		return nil, err
	}
	// Handshakes use raw sockets; HTTP's request cancellation must also interrupt them.
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if proxy.Scheme == "socks4" {
		err = socks4Handshake(ctx, conn, proxy, host, port)
	} else {
		err = socks5Handshake(ctx, conn, proxy, host, port)
	}
	cancelStopped := stopCancel()
	if !cancelStopped && ctx.Err() != nil {
		err = ctx.Err()
	}
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func lookupSOCKSIP(ctx context.Context, host string, ipv4 bool) (net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		if ipv4 && ip.To4() == nil {
			return nil, errors.New("SOCKS4 requires an IPv4 destination")
		}
		return ip, nil
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, address := range addresses {
		if !ipv4 || address.IP.To4() != nil {
			return address.IP, nil
		}
	}
	return nil, errors.New("no compatible address for SOCKS destination")
}

func socks4Handshake(ctx context.Context, conn net.Conn, proxy *url.URL, host string, port int) error {
	ip, err := lookupSOCKSIP(ctx, host, true)
	if err != nil {
		return err
	}
	username := proxy.User.Username()
	if strings.ContainsRune(username, 0) {
		return errors.New("SOCKS4 user ID contains NUL")
	}
	request := []byte{4, 1, byte(port >> 8), byte(port)}
	request = append(request, ip.To4()...)
	request = append(request, username...)
	request = append(request, 0)
	if _, err := conn.Write(request); err != nil {
		return err
	}
	response := make([]byte, 8)
	if _, err := io.ReadFull(conn, response); err != nil {
		return err
	}
	if response[0] != 0 {
		return errors.New("invalid SOCKS4 response")
	}
	if response[1] != 90 {
		return proxyProtocolError("SOCKS4", response[1])
	}
	return nil
}

func socks5Handshake(ctx context.Context, conn net.Conn, proxy *url.URL, host string, port int) error {
	username := proxy.User.Username()
	password, _ := proxy.User.Password()
	methods := []byte{5, 1, 0}
	hasAuth := username != "" && password != ""
	if hasAuth {
		methods = []byte{5, 2, 0, 2}
	}
	if _, err := conn.Write(methods); err != nil {
		return err
	}
	response := make([]byte, 2)
	if _, err := io.ReadFull(conn, response); err != nil {
		return err
	}
	if response[0] != 5 {
		return errors.New("invalid SOCKS5 response")
	}
	switch response[1] {
	case 0:
	case 2:
		if !hasAuth {
			return errors.New("SOCKS5 proxy requires authentication")
		}
		if len(username) > 255 || len(password) > 255 {
			return errors.New("SOCKS5 credentials exceed 255 bytes")
		}
		auth := append([]byte{1, byte(len(username))}, username...)
		auth = append(auth, byte(len(password)))
		auth = append(auth, password...)
		if _, err := conn.Write(auth); err != nil {
			return err
		}
		if _, err := io.ReadFull(conn, response); err != nil {
			return err
		}
		if response[0] != 1 || response[1] != 0 {
			return errors.New("SOCKS5 authentication failed")
		}
	default:
		return proxyProtocolError("SOCKS5 authentication", response[1])
	}
	request := []byte{5, 1, 0}
	ip := net.ParseIP(host)
	if ip == nil && proxy.Scheme != "socks5h" {
		var err error
		ip, err = lookupSOCKSIP(ctx, host, false)
		if err != nil {
			return err
		}
	}
	if ip == nil {
		if len(host) > 255 {
			return errors.New("SOCKS5 destination exceeds 255 bytes")
		}
		request = append(request, 3, byte(len(host)))
		request = append(request, host...)
	} else if ipv4 := ip.To4(); ipv4 != nil {
		request = append(request, 1)
		request = append(request, ipv4...)
	} else {
		request = append(request, 4)
		request = append(request, ip.To16()...)
	}
	request = binary.BigEndian.AppendUint16(request, uint16(port))
	if _, err := conn.Write(request); err != nil {
		return err
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return err
	}
	if header[0] != 5 || header[2] != 0 {
		return errors.New("invalid SOCKS5 response")
	}
	if header[1] != 0 {
		return proxyProtocolError("SOCKS5", header[1])
	}
	length := 0
	switch header[3] {
	case 1:
		length = 4
	case 4:
		length = 16
	case 3:
		if _, err := io.ReadFull(conn, response[:1]); err != nil {
			return err
		}
		length = int(response[0])
	default:
		return fmt.Errorf("invalid SOCKS5 address type %d", header[3])
	}
	_, err := io.ReadFull(conn, make([]byte, length+2))
	return err
}
