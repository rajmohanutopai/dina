package middleware

import (
	"net/http"
	"time"
)

// Timeout enforces a per-route request deadline.
// If the handler does not complete within Duration, the client receives a 503.
type Timeout struct {
	Duration time.Duration
}

// Handler returns middleware that wraps the next handler with http.TimeoutHandler.
// WebSocket endpoints (/ws) are excluded because http.TimeoutHandler wraps the
// ResponseWriter in a type that doesn't implement http.Hijacker, which breaks
// the HTTP→WebSocket upgrade.
func (t *Timeout) Handler(next http.Handler) http.Handler {
	timeoutHandler := http.TimeoutHandler(next, t.Duration, `{"error":"request timeout"}`)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			next.ServeHTTP(w, r)
			return
		}
		timeoutHandler.ServeHTTP(w, r)
	})
}
