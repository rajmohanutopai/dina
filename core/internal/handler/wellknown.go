package handler

import (
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// WellKnownHandler serves the /.well-known/* endpoints.
type WellKnownHandler struct {
	DID    port.DIDManager
	Signer port.IdentitySigner
}

// HandleATProtoDID handles GET /.well-known/atproto-did.
// It returns the root DID as plain text, per the AT Protocol specification.
func (h *WellKnownHandler) HandleATProtoDID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Derive the root DID from the node's signing key.
	pubKey := h.Signer.PublicKey()
	did, err := h.DID.Create(r.Context(), pubKey)
	if err != nil {
		http.Error(w, "DID not available", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(string(did)))
}
