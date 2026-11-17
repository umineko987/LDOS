package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"

	"ldos/backend/internal/config"
)

func JSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		Error(w, http.StatusInternalServerError, "internal_error", "服务内部错误", nil)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func Error(w http.ResponseWriter, status int, code, message string, details any) {
	JSON(w, status, map[string]any{"error": map[string]any{
		"code": code, "message": message, "details": details,
		"request_id": w.Header().Get("X-Request-ID"),
	}})
}

// Guard retains the local HTTP contract, including DNS-rebinding protection.
// All routes, error responses and streams pass through the same origin checks.
func Guard(server config.Server, next http.Handler) http.Handler {
	origins := make(map[string]bool, len(server.CORSOrigins))
	for _, origin := range server.CORSOrigins {
		origins[origin] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			var id [16]byte
			_, _ = rand.Read(id[:])
			requestID = hex.EncodeToString(id[:])
		}
		w.Header().Set("X-Request-ID", requestID)
		host := strings.ToLower(strings.TrimSpace(r.Host))
		hostname, port, err := net.SplitHostPort(host)
		hostname = strings.TrimSuffix(hostname, ".")
		if err != nil || (hostname != "localhost" && hostname != "127.0.0.1" && hostname != "::1") || port != strconv.Itoa(server.Port) {
			Error(w, http.StatusForbidden, "forbidden_host", "仅允许从本机回环地址访问", nil)
			return
		}
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		fetchSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")))
		sameOrigin := "http://" + net.JoinHostPort(hostname, port)
		configured := origins[origin]
		if ((fetchSite == "cross-site" || fetchSite == "same-site") && !configured) || (origin != "" && origin != sameOrigin && !configured) {
			Error(w, http.StatusForbidden, "forbidden_cross_site", "仅允许同源访问", nil)
			return
		}
		if configured {
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", "ETag, X-Request-ID")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			if !configured {
				Error(w, http.StatusBadRequest, "invalid_preflight", "不允许的跨源请求", nil)
				return
			}
			method := r.Header.Get("Access-Control-Request-Method")
			allowedMethods := map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}
			allowedHeaders := map[string]bool{"accept": true, "accept-language": true, "content-language": true, "content-type": true, "idempotency-key": true, "if-none-match": true, "x-request-id": true}
			valid := allowedMethods[method]
			for _, h := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
				h = strings.ToLower(strings.TrimSpace(h))
				if h != "" && !allowedHeaders[h] {
					valid = false
				}
			}
			if !valid {
				Error(w, http.StatusBadRequest, "invalid_preflight", "不允许的跨源请求", nil)
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Accept-Language, Content-Language, Content-Type, Idempotency-Key, If-None-Match, X-Request-ID")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
