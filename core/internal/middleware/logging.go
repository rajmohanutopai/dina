package middleware

import (
	"log/slog"
	"net/http"
	"time"
)

// Logging provides structured request logging.
// It logs method, path, status code, and duration. No PII is captured.
type Logging struct{}

// statusWriter wraps http.ResponseWriter to capture the response status code.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}

// Handler returns middleware that logs each request with structured fields.
func (l *Logging) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		sw := &statusWriter{
			ResponseWriter: w,
			status:         http.StatusOK,
		}

		next.ServeHTTP(sw, r)

		path := r.URL.Path
		duration := time.Since(start)

		// Suppress successful health check logs — they flood the output
		// and hide real requests. Failed health checks still log.
		if sw.status < 400 && (path == "/healthz" || path == "/readyz") {
			return
		}

		slog.Info("http request",
			slog.String("method", r.Method),
			slog.String("path", path),
			slog.Int("status", sw.status),
			slog.Duration("duration", duration),
		)
	})
}
