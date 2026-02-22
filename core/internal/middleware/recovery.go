package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"
)

// Recovery catches panics in downstream handlers and returns a 500 response.
// It logs the panic value and stack trace safely without exposing details to the client.
type Recovery struct{}

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
				http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			}
		}()

		next.ServeHTTP(w, r)
	})
}
