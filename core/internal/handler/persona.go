package handler

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// PersonaHandler serves the /v1/personas endpoints.
type PersonaHandler struct {
	Identity       *service.IdentityService
	Personas       port.PersonaManager
	Approvals      port.ApprovalManager      // approval request management
	VaultManager   port.VaultManager         // opens vault when persona is unlocked
	KeyDeriver     port.KeyDeriver           // derives DEK from master seed
	Seed           []byte                    // master seed for DEK derivation
	StagingInbox   port.StagingInbox         // drains pending items on persona unlock
	PendingReasons port.PendingReasonStore   // async approval-wait-resume
	Brain          port.BrainClient          // for pushing resume events
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
	if err := json.NewEncoder(w).Encode(map[string]interface{}{"personas": personas}); err != nil {
		http.Error(w, `{"error":"failed to encode response"}`, http.StatusInternalServerError)
	}
}

// HandleCreatePersona handles POST /v1/personas.
// FH3: Only admin-scoped callers can create personas — Brain is denied.
func (h *PersonaHandler) HandleCreatePersona(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// FH3: Brain must not create personas — persona management is admin-only.
	tokenKind, _ := r.Context().Value(middleware.TokenKindKey).(string)
	serviceID, _ := r.Context().Value(middleware.ServiceIDKey).(string)
	if tokenKind == "service" && serviceID == "brain" {
		http.Error(w, `{"error":"forbidden","message":"persona creation is admin-only"}`, http.StatusForbidden)
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
	alreadyExists := errors.Is(err, identity.ErrPersonaExists)
	if err != nil && !alreadyExists {
		switch {
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
	// Uses versioned DEK derivation for compatibility with upgraded personas.
	// For already-existing personas, this ensures the vault is open even if
	// Core booted before the persona was created (E2E/Docker scenario).
	vaultStatus := "closed"
	if (req.Tier == "default" || req.Tier == "standard") && h.VaultManager != nil && h.KeyDeriver != nil {
		persona, perr := domain.NewPersonaName(req.Name)
		if perr == nil {
			personaFullID := "persona-" + req.Name
			dekVersion, dvErr := h.Personas.GetDEKVersion(r.Context(), personaFullID)
			if dvErr != nil {
				// GH8: Log DEK version error instead of silently defaulting.
				slog.Warn("persona: GetDEKVersion failed, defaulting to v1",
					"persona", personaFullID, "error", dvErr)
				dekVersion = 1
			} else if dekVersion == 0 {
				dekVersion = 1
			}
			dek, derr := h.KeyDeriver.DerivePersonaDEKVersioned(h.Seed, persona, dekVersion)
			if derr != nil {
				http.Error(w, `{"error":"persona created but vault DEK derivation failed"}`, http.StatusInternalServerError)
				return
			}
			if oerr := h.VaultManager.Open(r.Context(), persona, dek); oerr != nil {
				slog.Warn("persona: vault open failed after create", "persona", req.Name, "error", oerr)
				http.Error(w, `{"error":"persona created but vault failed to open"}`, http.StatusInternalServerError)
				return
			}
			vaultStatus = "open"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if alreadyExists {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "exists", "vault": vaultStatus})
	} else {
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"id": personaID, "status": "created", "vault": vaultStatus})
	}
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

	if req.Persona == "" {
		http.Error(w, `{"error":"persona is required"}`, http.StatusBadRequest)
		return
	}
	// Empty passphrase is allowed — personas created without a passphrase
	// (e.g. bootstrap) can be unlocked with empty string.

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

	// Default and standard tier personas cannot be locked — they must
	// always be open. Only sensitive and locked tiers support locking.
	if h.Personas != nil {
		personaID := req.Persona
		if !strings.HasPrefix(personaID, "persona-") {
			personaID = "persona-" + personaID
		}
		tier, _ := h.Personas.GetTier(r.Context(), personaID)
		if tier == "default" || tier == "standard" {
			http.Error(w, `{"error":"default and standard personas cannot be locked"}`, http.StatusBadRequest)
			return
		}
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

	// GH7: Get persona from the approval request before approving (need it for vault open).
	// Log ListPending errors instead of silently discarding — approvedPersona stays empty
	// but the approval still proceeds (vault just won't auto-open).
	var approvedPersona string
	pending, listErr := h.Approvals.ListPending(r.Context())
	if listErr != nil {
		slog.Warn("approval: ListPending failed — vault auto-open will be skipped",
			"approval_id", req.ID, "error", listErr)
	}
	for _, p := range pending {
		if p.ID == req.ID {
			approvedPersona = p.PersonaID
			break
		}
	}

	if err := h.Approvals.ApproveRequest(r.Context(), req.ID, req.Scope, req.GrantedBy); err != nil {
		slog.Warn("approval.failed", "id", req.ID, "error", err)
		http.Error(w, `{"error":"approval not found or already resolved"}`, http.StatusNotFound)
		return
	}

	// Open the vault for the approved persona if not already open.
	h.openVaultForApproval(r, approvedPersona)

	// Trigger resume for any pending reason requests linked to this approval.
	if h.PendingReasons != nil && h.Brain != nil {
		go h.resumePendingReasons(req.ID)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "approved", "id": req.ID})
}

// openVaultForApproval opens the vault for the approved persona if not already open.
func (h *PersonaHandler) openVaultForApproval(r *http.Request, approvedPersona string) {
	if approvedPersona == "" || h.VaultManager == nil || h.KeyDeriver == nil {
		return
	}
	rawName := strings.TrimPrefix(approvedPersona, "persona-")
	persona, perr := domain.NewPersonaName(rawName)
	if perr != nil || h.VaultManager.IsOpen(persona) {
		return
	}
	dekVersion, dekErr := h.Personas.GetDEKVersion(r.Context(), approvedPersona)
	if dekErr != nil {
		slog.Warn("approval: failed to get DEK version", "persona", approvedPersona, "error", dekErr)
		return
	}
	if dekVersion == 0 {
		dekVersion = 1
	}
	dek, dErr := h.KeyDeriver.DerivePersonaDEKVersioned(h.Seed, persona, dekVersion)
	if dErr != nil {
		slog.Warn("approval: failed to derive vault DEK", "persona", approvedPersona, "error", dErr)
		return
	}
	if oErr := h.VaultManager.Open(r.Context(), persona, dek); oErr != nil {
		slog.Warn("approval: failed to open vault", "persona", approvedPersona, "error", oErr)
		return
	}
	// Mark this vault as opened via approval — only these get
	// closed when the session ends or single-use grant is consumed.
	// User/admin manually unlocked vaults are never auto-closed.
	// GH8: Log warning if type assertion fails instead of silently skipping.
	if mgr, ok := h.Personas.(*identity.PersonaManager); ok {
		mgr.MarkGrantOpened(approvedPersona)
	} else {
		slog.Warn("approval: cannot mark grant-opened — Personas is not PersonaManager",
			"persona", approvedPersona)
	}
}

// resumePendingReasons finds pending reason requests for the given approval
// and pushes resume events to Brain. Runs in a goroutine.
func (h *PersonaHandler) resumePendingReasons(approvalID string) {
	ctx := context.Background()
	records, err := h.PendingReasons.GetByApprovalID(ctx, approvalID)
	if err != nil || len(records) == 0 {
		return
	}

	for _, rec := range records {
		slog.Info("pending_reason: triggering resume",
			"request_id", rec.RequestID,
			"approval_id", approvalID,
		)
		// Mark as resuming
		_ = h.PendingReasons.UpdateStatus(ctx, rec.RequestID, domain.ReasonResuming, "", "")

		// Push resume event to Brain. Brain replays the reasoning request.
		// The response contains the completed result.
		err := h.Brain.Process(ctx, domain.TaskEvent{
			Type: "reason_resume",
			Payload: map[string]interface{}{
				"request_id":   rec.RequestID,
				"request_meta": rec.RequestMeta,
			},
		})
		if err != nil {
			slog.Error("pending_reason: resume failed",
				"request_id", rec.RequestID,
				"error", err,
			)
			_ = h.PendingReasons.UpdateStatus(ctx, rec.RequestID, domain.ReasonFailed, "", err.Error())
		}
		// Note: Brain's reason_resume handler returns the result via the
		// Process response. But Process() returns error only, not the payload.
		// So Brain must call Core back to update the record.
		// Alternative: Brain calls a new Core endpoint to submit the result.
	}
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

	h.markPendingReasonsDenied(req.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "denied", "id": req.ID})
}

// markPendingReasonsDenied marks any pending reason requests for this approval as denied.
func (h *PersonaHandler) markPendingReasonsDenied(approvalID string) {
	if h.PendingReasons == nil {
		return
	}
	go func() {
		records, err := h.PendingReasons.GetByApprovalID(context.Background(), approvalID)
		if err != nil || len(records) == 0 {
			return
		}
		for _, rec := range records {
			_ = h.PendingReasons.UpdateStatus(context.Background(), rec.RequestID, domain.ReasonDenied, "", "user denied the approval request")
			slog.Info("pending_reason: marked denied", "request_id", rec.RequestID)
		}
	}()
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
