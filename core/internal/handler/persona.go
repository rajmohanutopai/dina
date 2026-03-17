package handler

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// PersonaHandler serves the /v1/personas endpoints.
type PersonaHandler struct {
	Identity     *service.IdentityService
	Personas     port.PersonaManager
	Approvals    port.ApprovalManager   // approval request management
	VaultManager port.VaultManager      // opens vault when persona is unlocked
	KeyDeriver   port.KeyDeriver        // derives DEK from master seed
	Seed         []byte                 // master seed for DEK derivation
	StagingInbox port.StagingInbox      // drains pending items on persona unlock
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
		// LOW-11: Map validation errors to appropriate HTTP status codes.
		switch {
		case errors.Is(err, identity.ErrPersonaExists):
			http.Error(w, `{"error":"persona already exists"}`, http.StatusConflict)
		case errors.Is(err, identity.ErrOrphanedVaultArtifacts):
			http.Error(w, `{"error":"orphaned vault artifacts exist; use recovery flow (DINA_RECOVER_PERSONAS=1)"}`, http.StatusConflict)
		case errors.Is(err, identity.ErrInvalidTier):
			http.Error(w, `{"error":"invalid tier: must be default, standard, sensitive, or locked"}`, http.StatusBadRequest)
		default:
			http.Error(w, `{"error":"failed to create persona"}`, http.StatusInternalServerError)
		}
		return
	}

	// Auto-open vault for default and standard tier personas.
	vaultStatus := "closed"
	if (req.Tier == "default" || req.Tier == "standard") && h.VaultManager != nil && h.KeyDeriver != nil {
		persona, perr := domain.NewPersonaName(req.Name)
		if perr == nil {
			dek, derr := h.KeyDeriver.DerivePersonaDEK(h.Seed, persona)
			if derr != nil {
				http.Error(w, `{"error":"persona created but vault DEK derivation failed"}`, http.StatusInternalServerError)
				return
			}
			if oerr := h.VaultManager.Open(r.Context(), persona, dek); oerr != nil {
				http.Error(w, `{"error":"persona created but vault failed to open: `+oerr.Error()+`"}`, http.StatusInternalServerError)
				return
			}
			vaultStatus = "open"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": personaID, "status": "created", "vault": vaultStatus})
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
		// LOW-15: Propagate GetDEKVersion error — post-unlock failure is an invariant violation.
		dekVersion, dekErr := h.Personas.GetDEKVersion(r.Context(), req.Persona)
		if dekErr != nil {
			http.Error(w, `{"error":"failed to get DEK version"}`, http.StatusInternalServerError)
			return
		}
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

		// Drain staging items that were pending unlock for this persona.
		if h.StagingInbox != nil {
			if n, err := h.StagingInbox.DrainPending(r.Context(), string(persona)); err != nil {
				slog.Warn("staging drain on unlock failed", "persona", string(persona), "error", err)
			} else if n > 0 {
				slog.Info("staging drain on persona unlock", "persona", string(persona), "drained", n)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "unlocked"})
}

// lockPersonaRequest is the JSON body for POST /v1/persona/lock.
type lockPersonaRequest struct {
	Persona string `json:"persona"`
}

// HandleLockPersona handles POST /v1/persona/lock.
// It closes the persona's vault, zeroing the DEK from memory.
func (h *PersonaHandler) HandleLockPersona(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req lockPersonaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Persona == "" {
		http.Error(w, `{"error":"persona is required"}`, http.StatusBadRequest)
		return
	}

	// Strip "persona-" prefix for vault operations.
	rawName := strings.TrimPrefix(req.Persona, "persona-")
	persona, err := domain.NewPersonaName(rawName)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	if h.VaultManager != nil {
		if err := h.VaultManager.Close(persona); err != nil {
			http.Error(w, `{"error":"failed to close vault"}`, http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "locked"})
}

// ---------------------------------------------------------------------------
// Approval endpoints
// ---------------------------------------------------------------------------

type approveReq struct {
	ID        string `json:"id"`
	Scope     string `json:"scope"`      // "single", "session"
	GrantedBy string `json:"granted_by"` // optional — defaults to auth identity
}

// HandleApprove handles POST /v1/persona/approve.
func (h *PersonaHandler) HandleApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Approvals == nil {
		http.Error(w, `{"error":"approvals not configured"}`, http.StatusNotImplemented)
		return
	}

	var req approveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}
	if req.Scope == "" {
		req.Scope = "session"
	}
	if req.GrantedBy == "" {
		req.GrantedBy = "admin"
	}

	// Get persona from the approval request before approving (need it for vault open).
	pending, _ := h.Approvals.ListPending(r.Context())
	var approvedPersona string
	for _, p := range pending {
		if p.ID == req.ID {
			approvedPersona = p.PersonaID
			break
		}
	}

	if err := h.Approvals.ApproveRequest(r.Context(), req.ID, req.Scope, req.GrantedBy); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	// Open the vault for the approved persona if not already open.
	if approvedPersona != "" && h.VaultManager != nil && h.KeyDeriver != nil {
		rawName := strings.TrimPrefix(approvedPersona, "persona-")
		persona, perr := domain.NewPersonaName(rawName)
		if perr == nil && !h.VaultManager.IsOpen(persona) {
			dekVersion, dekErr := h.Personas.GetDEKVersion(r.Context(), approvedPersona)
			if dekErr != nil {
				http.Error(w, `{"error":"approved but failed to get DEK version"}`, http.StatusInternalServerError)
				return
			}
			if dekVersion == 0 {
				dekVersion = 1
			}
			dek, dErr := h.KeyDeriver.DerivePersonaDEKVersioned(h.Seed, persona, dekVersion)
			if dErr != nil {
				http.Error(w, `{"error":"approved but failed to derive vault DEK"}`, http.StatusInternalServerError)
				return
			}
			if oErr := h.VaultManager.Open(r.Context(), persona, dek); oErr != nil {
				http.Error(w, `{"error":"approved but failed to open vault: `+oErr.Error()+`"}`, http.StatusInternalServerError)
				return
			}
			// Mark this vault as opened via approval — only these get
			// closed when the session ends or single-use grant is consumed.
			// User/admin manually unlocked vaults are never auto-closed.
			if mgr, ok := h.Personas.(*identity.PersonaManager); ok {
				mgr.MarkGrantOpened(approvedPersona)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "approved", "id": req.ID})
}

type denyReq struct {
	ID string `json:"id"`
}

// HandleDeny handles POST /v1/persona/deny.
func (h *PersonaHandler) HandleDeny(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Approvals == nil {
		http.Error(w, `{"error":"approvals not configured"}`, http.StatusNotImplemented)
		return
	}

	var req denyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}

	if err := h.Approvals.DenyRequest(r.Context(), req.ID); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "denied", "id": req.ID})
}

// HandleListApprovals handles GET /v1/persona/approvals.
func (h *PersonaHandler) HandleListApprovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Approvals == nil {
		http.Error(w, `{"error":"approvals not configured"}`, http.StatusNotImplemented)
		return
	}

	pending, err := h.Approvals.ListPending(r.Context())
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"approvals": pending})
}
