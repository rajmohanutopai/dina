package middleware

import (
	"net"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// RateLimit enforces per-IP request rate limiting.
type RateLimit struct {
	Limiter        port.RateLimiter
	TrustedProxies []*net.IPNet // CIDR ranges whose X-Forwarded-For we trust
}

// Handler returns middleware that rate-limits requests by client IP.
func (rl *RateLimit) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, rl.TrustedProxies)

		if !rl.Limiter.Allow(ip) {
			http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// clientIP extracts the client IP address from the request.
// It only trusts X-Forwarded-For when the direct connection (RemoteAddr) comes
// from a known trusted proxy. If TrustedProxies is empty, RemoteAddr is always
// used — a safe default that prevents IP spoofing via forged XFF headers.
func clientIP(r *http.Request, trusted []*net.IPNet) string {
	remoteIP := r.RemoteAddr
	// Strip port from RemoteAddr.
	if host, _, err := net.SplitHostPort(remoteIP); err == nil {
		remoteIP = host
	}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" && isTrusted(remoteIP, trusted) {
		// Use the first (leftmost) IP from XFF when from trusted proxy.
		parts := strings.SplitN(xff, ",", 2)
		ip := strings.TrimSpace(parts[0])
		if ip != "" {
			return ip
		}
	}
	return remoteIP
}

// isTrusted checks whether ip falls within any of the trusted CIDR ranges.
func isTrusted(ip string, trusted []*net.IPNet) bool {
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return false
	}
	for _, cidr := range trusted {
		if cidr.Contains(parsedIP) {
			return true
		}
	}
	return false
}
