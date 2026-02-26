package handler

import (
	"log/slog"
	"net/http"
)

// clientError writes a safe error response to the client and logs the detailed
// internal error server-side. This prevents information disclosure.
func clientError(w http.ResponseWriter, msg string, status int, internalErr error) {
	if internalErr != nil {
		slog.Error("handler error", "client_msg", msg, "status", status, "error", internalErr.Error())
	}
	http.Error(w, `{"error":"`+msg+`"}`, status)
}
