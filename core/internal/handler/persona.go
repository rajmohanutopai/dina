package handler

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// PersonaHandler serves the /v1/personas endpoints.
type PersonaHandler struct {
	Identity     *service.IdentityService
	Personas     port.PersonaManager
	VaultManager port.VaultManager // opens vault when persona is unlocked
	KeyDeriver   port.KeyDeriver   // derives DEK from master seed
	Seed         []byte            // master seed for DEK derivation
}

// createPersonaRequest is the JSON body for POST /v1/personas.
type createPersonaRequest struct {
	Name       string `json:"name"`
	Tier       string `json:"tier"`
	Passphrase string `json:"passphrase"`
}

// unlockPersonaRequest is the JSON body for POST /v1/persona/unlock.
type unlockPersonaRequest struct {
	Persona    string `json:"persona"`
	Passphrase string `json:"passphrase"`
}

// HandleListPersonas handles GET /v1/personas.
func (h *PersonaHandler) HandleListPersonas(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	personas, err := h.Identity.ListPersonas(r.Context())
	if err != nil {
		http.Error(w, `{"error":"failed to list personas"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(personas); err != nil {
		http.Error(w, `{"error":"failed to encode response"}`, http.StatusInternalServerError)
	}
}

// HandleCreatePersona handles POST /v1/personas.
func (h *PersonaHandler) HandleCreatePersona(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req createPersonaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}

	if req.Passphrase == "" {
		http.Error(w, `{"error":"passphrase is required"}`, http.StatusBadRequest)
		return
	}

	// Generate a random 16-byte salt and hash the passphrase with Argon2id.
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		http.Error(w, `{"error":"failed to generate salt"}`, http.StatusInternalServerError)
		return
	}
	passphraseHash, err := auth.HashPassphrase(req.Passphrase, salt)
	if err != nil {
		http.Error(w, `{"error":"failed to hash passphrase"}`, http.StatusInternalServerError)
		return
	}

	personaID, err := h.Personas.Create(r.Context(), req.Name, req.Tier, passphraseHash)
	if err != nil {
		http.Error(w, `{"error":"failed to create persona"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": personaID, "status": "created"})
}

// HandleUnlockPersona handles POST /v1/persona/unlock.
func (h *PersonaHandler) HandleUnlockPersona(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req unlockPersonaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Persona == "" || req.Passphrase == "" {
		http.Error(w, `{"error":"persona and passphrase are required"}`, http.StatusBadRequest)
		return
	}

	// Default TTL of 3600 seconds (1 hour).
	const defaultTTL = 3600
	if err := h.Personas.Unlock(r.Context(), req.Persona, req.Passphrase, defaultTTL); err != nil {
		if errors.Is(err, domain.ErrInvalidPassphrase) {
			http.Error(w, `{"error":"invalid passphrase"}`, http.StatusForbidden)
			return
		}
		http.Error(w, `{"error":"failed to unlock persona"}`, http.StatusInternalServerError)
		return
	}

	// Open the corresponding vault so store/query operations work.
	if h.VaultManager != nil && h.KeyDeriver != nil {
		// Strip "persona-" prefix before validation — NewPersonaName only allows [a-z0-9_].
		rawName := strings.TrimPrefix(req.Persona, "persona-")
		persona, err := domain.NewPersonaName(rawName)
		if err != nil {
			http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
			return
		}
		// CRITICAL-02: Use versioned DEK derivation so v1 and v2 personas get
		// different keys. This ensures upgraded personas derive a new DEK,
		// enabling future vault re-encryption during migration.
		dekVersion, _ := h.Personas.GetDEKVersion(r.Context(), req.Persona)
		if dekVersion == 0 {
			dekVersion = 1 // fallback for legacy personas
		}
		dek, err := h.KeyDeriver.DerivePersonaDEKVersioned(h.Seed, persona, dekVersion)
		if err != nil {
			http.Error(w, `{"error":"failed to derive vault DEK"}`, http.StatusInternalServerError)
			return
		}
		if err := h.VaultManager.Open(r.Context(), persona, dek); err != nil {
			http.Error(w, `{"error":"failed to open vault"}`, http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "unlocked"})
}
