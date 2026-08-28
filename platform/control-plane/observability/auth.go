package observability

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

func RequireControlPlaneToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions || r.URL.Path == "/healthz" || r.URL.Path == "/metrics" {
				next.ServeHTTP(w, r)
				return
			}
			if token == "" {
				writeAuthError(w, http.StatusServiceUnavailable, "control-plane authentication is not configured")
				return
			}
			presented, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || presented == "" || subtle.ConstantTimeCompare([]byte(token), []byte(presented)) != 1 {
				writeAuthError(w, http.StatusUnauthorized, "invalid control-plane credential")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeAuthError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "control_plane_auth", "message": message})
}
