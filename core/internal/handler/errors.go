package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime"
	"time"
)

// clientError writes a safe error response to the client and logs the detailed
// internal error server-side. This prevents information disclosure.
// GH6: uses json.Marshal to prevent JSON injection from msg containing
// quotes, backslashes, or control characters.
//
// The log source shows the CALLER (the handler), not this helper.
func clientError(w http.ResponseWriter, msg string, status int, internalErr error) {
	if internalErr != nil {
		// Skip 1 frame so source shows the calling handler, not errors.go.
		var pcs [1]uintptr
		runtime.Callers(2, pcs[:])
		rec := slog.NewRecord(time.Now(), slog.LevelError, "handler error", pcs[0])
		rec.AddAttrs(
			slog.String("client_msg", msg),
			slog.Int("status", status),
			slog.String("error", internalErr.Error()),
		)
		_ = slog.Default().Handler().Handle(context.Background(), rec)
	}
	body, _ := json.Marshal(map[string]string{"error": msg})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}
