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
//
// SEC-MED-15: Uses rightmost-trusted approach — walks XFF right-to-left,
// skipping trusted proxies, and returns the first non-trusted IP. This is
// resistant to attacker-injected leftmost values in XFF.
func clientIP(r *http.Request, trusted []*net.IPNet) string {
	remoteIP := r.RemoteAddr
	// Strip port from RemoteAddr.
	if host, _, err := net.SplitHostPort(remoteIP); err == nil {
		remoteIP = host
	}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" && isTrusted(remoteIP, trusted) {
		// Rightmost-trusted: walk right-to-left through XFF chain.
		// Each trusted proxy appends the connecting IP to XFF. The rightmost
		// non-trusted IP is the real client (or the last hop we can verify).
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(parts[i])
			if ip == "" {
				continue
			}
			if !isTrusted(ip, trusted) {
				return ip
			}
		}
		// All XFF entries are trusted proxies — fall through to remoteIP.
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
