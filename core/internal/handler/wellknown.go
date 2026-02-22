package handler

import (
	"net/http"

	"github.com/anthropics/dina/core/internal/port"
)

// WellKnownHandler serves the /.well-known/* endpoints.
type WellKnownHandler struct {
	DID port.DIDManager
}

// HandleATProtoDID handles GET /.well-known/atproto-did.
// It returns the root DID as plain text, per the AT Protocol specification.
func (h *WellKnownHandler) HandleATProtoDID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Resolve the root DID (empty DID resolves the node's own identity).
	didBytes, err := h.DID.Resolve(r.Context(), "")
	if err != nil {
		http.Error(w, "DID not available", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(didBytes)
}
