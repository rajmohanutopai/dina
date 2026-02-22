package handler

import (
	"encoding/json"
	"net/http"

	"github.com/anthropics/dina/core/internal/port"
	"github.com/anthropics/dina/core/internal/service"
)

// PersonaHandler serves the /v1/personas endpoints.
type PersonaHandler struct {
	Identity *service.IdentityService
	Personas port.PersonaManager
}

// createPersonaRequest is the JSON body for POST /v1/personas.
type createPersonaRequest struct {
	Name string `json:"name"`
	Tier string `json:"tier"`
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

	personaID, err := h.Personas.Create(r.Context(), req.Name, req.Tier)
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
		http.Error(w, `{"error":"failed to unlock persona"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "unlocked"})
}
