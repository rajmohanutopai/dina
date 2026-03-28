package middleware

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// TraceEmitter records structured trace events for request debugging.
// Implemented by handler.Tracer; nil-safe — middleware skips emit when nil.
type TraceEmitter interface {
	Emit(ctx context.Context, step, component string, detail map[string]string)
}

// Logging provides structured request logging.
// It logs method, path, status code, and duration. No PII is captured.
type Logging struct {
	Emitter TraceEmitter // optional — set to emit trace events per request
}

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

		attrs := []slog.Attr{
			slog.String("method", r.Method),
			slog.String("path", path),
			slog.Int("status", sw.status),
			slog.Duration("duration", duration),
		}

		// Add caller identity for traceability.
		if rid, ok := r.Context().Value(RequestIDKey).(string); ok && rid != "" {
			attrs = append(attrs, slog.String("req_id", rid))
		}
		if caller, ok := r.Context().Value(CallerTypeKey).(string); ok && caller != "" {
			attrs = append(attrs, slog.String("caller", caller))
		}
		if svcID, ok := r.Context().Value(ServiceIDKey).(string); ok && svcID != "" {
			attrs = append(attrs, slog.String("service", svcID))
		}
		if did := r.Header.Get("X-DID"); did != "" {
			attrs = append(attrs, slog.String("did", did))
		}

		// Log with a manually constructed record so "source" shows the
		// request path instead of this middleware file.
		level := slog.LevelInfo
		if sw.status >= 500 {
			level = slog.LevelWarn
		}
		rec := slog.NewRecord(time.Now(), level, "http request", 0)
		rec.AddAttrs(attrs...)
		_ = slog.Default().Handler().Handle(r.Context(), rec)

		// Emit trace event for request debugging (no-op when Emitter is nil).
		if l.Emitter != nil {
			l.Emitter.Emit(r.Context(), "http_response", "core", map[string]string{
				"method":   r.Method,
				"path":     path,
				"status":   fmt.Sprintf("%d", sw.status),
				"duration": duration.String(),
			})
		}
	})
}
