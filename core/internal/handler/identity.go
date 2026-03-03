package handler

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/mr-tron/base58"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
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
	// LOW-16: Enforce GET method.
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Derive the DID from the signer's public key.
	pubKey := h.Signer.PublicKey()
	did, err := h.DID.Create(r.Context(), pubKey)
	if err != nil && did == "" {
		clientError(w, "failed to create DID", http.StatusInternalServerError, err)
		return
	}

	doc, err := h.DID.Resolve(r.Context(), did)
	if err != nil {
		clientError(w, "failed to resolve DID", http.StatusInternalServerError, err)
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
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

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
		clientError(w, "signing failed", http.StatusInternalServerError, err)
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
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

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
		// MEDIUM-10: Return 404 for unknown DIDs instead of 500.
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"DID not found"}`, http.StatusNotFound)
			return
		}
		clientError(w, "DID resolution failed", http.StatusInternalServerError, err)
		return
	}

	// Parse the DID document to extract the public key.
	var didDoc domain.DIDDocument
	if err := json.Unmarshal(doc, &didDoc); err != nil {
		http.Error(w, `{"error":"invalid DID document"}`, http.StatusBadRequest)
		return
	}

	// Extract the first verification method.
	if len(didDoc.VerificationMethod) == 0 {
		http.Error(w, `{"error":"no verification method in DID document"}`, http.StatusBadRequest)
		return
	}

	multibaseKey := didDoc.VerificationMethod[0].PublicKeyMultibase
	if len(multibaseKey) < 2 || multibaseKey[0] != 'z' {
		http.Error(w, `{"error":"unsupported multibase encoding"}`, http.StatusBadRequest)
		return
	}

	// Decode base58btc (strip 'z' prefix).
	decoded, err := base58.Decode(multibaseKey[1:])
	if err != nil {
		http.Error(w, `{"error":"invalid base58 encoding"}`, http.StatusBadRequest)
		return
	}

	// Strip the 2-byte Ed25519 multicodec prefix (0xed, 0x01).
	if len(decoded) < 34 || decoded[0] != 0xed || decoded[1] != 0x01 {
		http.Error(w, `{"error":"invalid Ed25519 multicodec prefix"}`, http.StatusBadRequest)
		return
	}
	pubKey := ed25519.PublicKey(decoded[2:])

	// Verify the Ed25519 signature.
	valid := ed25519.Verify(pubKey, data, sig)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"valid": valid})
}

// HandleGetDocument handles GET /v1/did/document. It resolves the node's own
// DID and returns the full DID document.
func (h *IdentityHandler) HandleGetDocument(w http.ResponseWriter, r *http.Request) {
	// LOW-16: Enforce GET method.
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	pubKey := h.Signer.PublicKey()
	did, err := h.DID.Create(r.Context(), pubKey)
	if err != nil && did == "" {
		clientError(w, "failed to create DID", http.StatusInternalServerError, err)
		return
	}

	doc, err := h.DID.Resolve(r.Context(), did)
	if err != nil {
		clientError(w, "failed to resolve DID", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(doc)
}


