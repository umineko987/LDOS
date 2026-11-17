package httpapi

import "net/http"

func WithAuthorization(handler http.Handler) Option {
	return func(mux *http.ServeMux) {
		mux.Handle("/api/v1/auth", handler)
		mux.Handle("/api/v1/auth/", handler)
	}
}

func WithSearch(handler http.Handler) Option {
	return func(mux *http.ServeMux) {
		mux.Handle("/api/v1/search", handler)
		mux.Handle("/api/v1/search/", handler)
	}
}
