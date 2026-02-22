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
func (t *Timeout) Handler(next http.Handler) http.Handler {
	return http.TimeoutHandler(next, t.Duration, `{"error":"request timeout"}`)
}
