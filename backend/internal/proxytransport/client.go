package proxytransport

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"
)

type authorizedTransport struct {
	transport     *http.Transport
	authorization string
}

func (t authorizedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme == "http" && t.authorization != "" {
		request = request.Clone(request.Context())
		request.Header.Set("Proxy-Authorization", t.authorization)
	}
	return t.transport.RoundTrip(request)
}

// NewHTTPClient shares the explicit proxy and connect/read timeout behavior used
// by probes, DoH, and discovery. An empty endpoint deliberately selects direct
// transport. The caller closes response bodies and calls the returned cleanup.
func NewHTTPClient(ctx context.Context, endpoint string, timeout time.Duration) (*http.Client, func(), error) {
	if timeout <= 0 {
		return nil, nil, errors.New("HTTP timeout must be positive")
	}
	transport := &http.Transport{DisableKeepAlives: true, TLSHandshakeTimeout: timeout}
	transport.DialContext = func(dialCtx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{Timeout: timeout}).DialContext(dialCtx, network, address)
		if err != nil {
			return nil, err
		}
		return &probeConn{Conn: conn, timeout: timeout}, nil
	}
	authorization := ""
	if endpoint != "" {
		proxy, err := url.Parse(endpoint)
		if err != nil || proxy.Hostname() == "" {
			return nil, nil, errors.New("invalid proxy endpoint")
		}
		switch proxy.Scheme {
		case "http", "https":
			authorization, err = probeHTTPAuthorization(proxy)
			if err != nil {
				return nil, nil, err
			}
			proxy.User = nil
			if authorization != "" {
				transport.ProxyConnectHeader = http.Header{"Proxy-Authorization": []string{authorization}}
			}
			transport.Proxy = http.ProxyURL(proxy)
		case "socks4", "socks5", "socks5h":
			transport.DialContext = func(_ context.Context, network, address string) (net.Conn, error) {
				dialCtx, cancel := context.WithTimeout(ctx, timeout)
				defer cancel()
				conn, err := dialSOCKS(dialCtx, proxy, address)
				if err != nil {
					return nil, err
				}
				return &probeConn{Conn: conn, timeout: timeout}, nil
			}
		default:
			return nil, nil, errors.New("unsupported proxy protocol")
		}
	}
	return &http.Client{Transport: authorizedTransport{transport, authorization}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, transport.CloseIdleConnections, nil
}
