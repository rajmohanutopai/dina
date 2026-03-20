package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// clientError writes a safe error response to the client and logs the detailed
// internal error server-side. This prevents information disclosure.
// GH6: uses json.Marshal to prevent JSON injection from msg containing
// quotes, backslashes, or control characters.
func clientError(w http.ResponseWriter, msg string, status int, internalErr error) {
	if internalErr != nil {
		slog.Error("handler error", "client_msg", msg, "status", status, "error", internalErr.Error())
	}
	body, _ := json.Marshal(map[string]string{"error": msg})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}
