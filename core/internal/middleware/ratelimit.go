package middleware

import (
	"net"
	"net/http"

	"github.com/anthropics/dina/core/internal/port"
)

// RateLimit enforces per-IP request rate limiting.
type RateLimit struct {
	Limiter port.RateLimiter
}

// Handler returns middleware that rate-limits requests by client IP.
func (rl *RateLimit) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)

		if !rl.Limiter.Allow(ip) {
			http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// clientIP extracts the client IP address from the request.
// It checks X-Forwarded-For first, then falls back to RemoteAddr.
func clientIP(r *http.Request) string {
	// Check X-Forwarded-For header (first IP in the chain).
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP from the comma-separated list.
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return xff[:i]
			}
		}
		return xff
	}

	// Fall back to RemoteAddr, stripping the port.
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
