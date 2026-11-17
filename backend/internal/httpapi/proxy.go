package httpapi

import "net/http"

// WithProxy mounts the native proxy lifecycle and managed source contracts.
func WithProxy(handler http.Handler) Option {
	return func(mux *http.ServeMux) { mux.Handle("/api/v1/proxy/", handler) }
}
