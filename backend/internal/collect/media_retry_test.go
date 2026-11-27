package collect

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
)

type previewTestPool struct {
	endpoints []string
	faults    []bool
}

func (p *previewTestPool) Acquire(_ context.Context, req proxypool.Request) (*proxypool.Lease, error) {
	for _, endpoint := range p.endpoints {
		if !slices.Contains(req.ExcludeIDs, endpoint) {
			return &proxypool.Lease{Owner: req.Owner, NodeID: endpoint, Endpoint: endpoint}, nil
		}
	}
	return nil, nil
}

func (p *previewTestPool) Release(_ context.Context, _ string, fault bool, _ string) error {
	p.faults = append(p.faults, fault)
	return nil
}

func (*previewTestPool) Status() map[string]any { return nil }

func TestPreviewProxyFailover(t *testing.T) {
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		panic(http.ErrAbortHandler) // Drop the connection before sending any response.
	}))
	defer broken.Close()
	working := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte("preview"))
	}))
	defer working.Close()

	for _, tc := range []struct {
		name      string
		target    string
		endpoints []string
		retries   int
		faults    []bool
		wantOK    bool
	}{
		{"drop rotates to working node", "http://cdn.example/image", []string{broken.URL, working.URL}, 2, []bool{true, false}, true},
		{"CONNECT failure exhausts budget", "https://cdn.example/image", []string{broken.URL, working.URL}, 0, []bool{true}, false},
		{"origin 404 does not rotate", "http://cdn.example/missing", []string{working.URL, broken.URL}, 2, []bool{false}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := &previewTestPool{endpoints: tc.endpoints}
			s := New(Dependencies{
				Transport: &discovery.Transport{Pool: pool, Validator: network.URLValidator{}},
				PolicyFor: func(context.Context, string) (scheduler.Policy, error) {
					return scheduler.Policy{ProxyMode: "required", RetryLimit: tc.retries}, nil
				},
			})
			data, err := s.fetchHTTPMedia(t.Context(), "danbooru", tc.target)
			if (err == nil) != tc.wantOK || (tc.wantOK && string(data) != "preview") || !slices.Equal(pool.faults, tc.faults) {
				t.Fatalf("data=%q err=%v lease faults=%v, want success=%t faults=%v", data, err, pool.faults, tc.wantOK, tc.faults)
			}
		})
	}
}
