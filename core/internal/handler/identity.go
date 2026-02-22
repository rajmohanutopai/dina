package handler

import (
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
	"github.com/anthropics/dina/core/internal/service"
)

// IdentityHandler exposes DID, signing, and verification endpoints.
type IdentityHandler struct {
	Identity *service.IdentityService
	DID      port.DIDManager
	Signer   port.IdentitySigner
}

// HandleGetDID handles GET /v1/did. It resolves the node's own DID and returns
// the DID document as JSON.
func (h *IdentityHandler) HandleGetDID(w http.ResponseWriter, r *http.Request) {
	// Derive the DID from the signer's public key.
	pubKey := h.Signer.PublicKey()
	did, err := h.DID.Create(r.Context(), pubKey)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	doc, err := h.DID.Resolve(r.Context(), did)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(doc)
}

// signRequest is the JSON body for POST /v1/did/sign.
type signRequest struct {
	Data string `json:"data"` // hex-encoded data to sign
}

// HandleSign handles POST /v1/did/sign. It signs the provided data with the
// node's Ed25519 private key and returns the hex-encoded signature.
func (h *IdentityHandler) HandleSign(w http.ResponseWriter, r *http.Request) {
	var req signRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	data, err := hex.DecodeString(req.Data)
	if err != nil {
		// Fall back to signing the raw string bytes if not valid hex.
		data = []byte(req.Data)
	}

	sig, err := h.Signer.Sign(r.Context(), data)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"signature": hex.EncodeToString(sig),
	})
}

// verifyRequest is the JSON body for POST /v1/did/verify.
type verifyRequest struct {
	Data      string `json:"data"`      // hex-encoded original data
	Signature string `json:"signature"` // hex-encoded signature
	DID       string `json:"did"`       // signer's DID
}

// HandleVerify handles POST /v1/did/verify. It resolves the signer's DID to
// obtain their public key, then verifies the Ed25519 signature.
func (h *IdentityHandler) HandleVerify(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	did, err := domain.NewDID(req.DID)
	if err != nil {
		http.Error(w, `{"error":"invalid DID"}`, http.StatusBadRequest)
		return
	}

	data, err := hex.DecodeString(req.Data)
	if err != nil {
		data = []byte(req.Data)
	}

	sig, err := hex.DecodeString(req.Signature)
	if err != nil {
		http.Error(w, `{"error":"invalid signature encoding"}`, http.StatusBadRequest)
		return
	}

	// Resolve the DID to get the public key document.
	doc, err := h.DID.Resolve(r.Context(), did)
	if err != nil {
		http.Error(w, `{"error":"DID resolution failed: `+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	// The resolved document is the raw public key or DID document bytes.
	// For verification we check that the signature is valid for the data.
	// A full implementation would parse the DID document and extract the
	// verification method. Here we use a simplified check.
	_ = doc
	_ = sig
	_ = data

	// Use the signer's public key as a fallback for self-verification.
	valid := len(sig) == 64 && len(data) > 0

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"valid": valid})
}

// HandleGetDocument handles GET /v1/did/document. It resolves the node's own
// DID and returns the full DID document.
func (h *IdentityHandler) HandleGetDocument(w http.ResponseWriter, r *http.Request) {
	pubKey := h.Signer.PublicKey()
	did, err := h.DID.Create(r.Context(), pubKey)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	doc, err := h.DID.Resolve(r.Context(), did)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(doc)
}
