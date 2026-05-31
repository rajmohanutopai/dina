package middleware

import (
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
)

// Recovery catches panics in downstream handlers and returns a 500 response.
// It logs the panic value and stack trace safely without exposing details to the client.
type Recovery struct {
	Emitter TraceEmitter // optional — emit panic_recovered trace
}

// Handler returns middleware that recovers from panics.
func (rec *Recovery) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				stack := debug.Stack()
				slog.Error("panic recovered",
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.Any("error", err),
					slog.String("stack", string(stack)),
				)
				// Emit trace event so panics appear in dina-admin trace output.
				if rec.Emitter != nil {
					// Normalize error to type name only — never raw panic text
					// which may contain user data or stack details.
					errType := fmt.Sprintf("%T", err)
					if errType == "string" {
						errType = "panic_string"
					}
					rec.Emitter.Emit(r.Context(), "panic_recovered", "core", map[string]string{
						"path":       r.URL.Path,
						"error_type": errType,
					})
				}
				http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			}
		}()

		next.ServeHTTP(w, r)
	})
}
