package middleware

import (
	"net/http"
	"strings"
)

// CORS sets Cross-Origin Resource Sharing headers for the admin UI.
type CORS struct {
	AllowOrigin string
}

// Handler returns middleware that applies CORS headers and handles preflight OPTIONS requests.
func (c *CORS) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c.AllowOrigin == "" {
			// No CORS configured — same-origin only
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}

		// Wildcard: allow any origin (no credentials support).
		if c.AllowOrigin == "*" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
			return
		}

		// Check if origin is in the allowed list
		allowed := false
		for _, o := range strings.Split(c.AllowOrigin, ",") {
			if strings.TrimSpace(o) == origin {
				allowed = true
				break
			}
		}

		if !allowed {
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Credentials", "true")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
