package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// VaultHandler exposes vault CRUD and KV endpoints.
type VaultHandler struct {
	Vault *service.VaultService
	PII   port.PIIScrubber
}

// agentDID extracts the agent DID from the request context (set by auth
// middleware). Falls back to "brain" when no value is present.
func agentDID(r *http.Request) string {
	if v, ok := r.Context().Value(middleware.AgentDIDKey).(string); ok && v != "" {
		return v
	}
	return "brain"
}

// queryRequest is the JSON body for POST /v1/vault/query.
type queryRequest struct {
	Persona string   `json:"persona"`
	Query   string   `json:"query"`
	Mode    string   `json:"mode"`
	Types   []string `json:"types"`
	Limit   int      `json:"limit"`
}

// HandleQuery handles POST /v1/vault/query. It parses the search parameters,
// calls VaultService.Query, and returns the matching items as JSON.
func (h *VaultHandler) HandleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	persona, err := domain.NewPersonaName(req.Persona)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	mode := domain.SearchFTS5
	switch domain.SearchMode(req.Mode) {
	case domain.SearchSemantic:
		mode = domain.SearchSemantic
	case domain.SearchHybrid:
		mode = domain.SearchHybrid
	case domain.SearchFTS5:
		mode = domain.SearchFTS5
	}

	q := domain.SearchQuery{
		Mode:  mode,
		Query: req.Query,
		Types: req.Types,
		Limit: req.Limit,
	}

	// Track whether we requested a mode that falls back to FTS5.
	requestedMode := mode

	items, err := h.Vault.Query(r.Context(), agentDID(r), persona, q)
	if err != nil {
		clientError(w, "query failed", http.StatusInternalServerError, err)
		return
	}

	// Signal degradation when semantic/hybrid was requested but FTS5 was used.
	if requestedMode == domain.SearchSemantic || requestedMode == domain.SearchHybrid {
		w.Header().Set("X-Search-Mode", "fts5")
		w.Header().Set("X-Search-Degraded-From", string(requestedMode))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"items": items})
}

// storeRequest is the JSON body for POST /v1/vault/store.
type storeRequest struct {
	Persona string           `json:"persona"`
	Item    domain.VaultItem `json:"item"`
}

// HandleStore handles POST /v1/vault/store. It persists a single item into the
// named persona's vault and returns the generated ID.
func (h *VaultHandler) HandleStore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req storeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	persona, err := domain.NewPersonaName(req.Persona)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	id, err := h.Vault.Store(r.Context(), persona, req.Item)
	if err != nil {
		clientError(w, "store failed", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": id})
}

// storeBatchRequest is the JSON body for POST /v1/vault/store/batch.
type storeBatchRequest struct {
	Persona string             `json:"persona"`
	Items   []domain.VaultItem `json:"items"`
}

// HandleStoreBatch handles POST /v1/vault/store/batch. It persists multiple
// items in a single operation and returns their IDs.
func (h *VaultHandler) HandleStoreBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req storeBatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	persona, err := domain.NewPersonaName(req.Persona)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	ids, err := h.Vault.StoreBatch(r.Context(), persona, req.Items)
	if err != nil {
		clientError(w, "store batch failed", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"ids": ids})
}

// HandleGetItem handles GET /v1/vault/item/{id}. It extracts the item ID from
// the URL path and returns the item as JSON.
func (h *VaultHandler) HandleGetItem(w http.ResponseWriter, r *http.Request) {
	// Extract item ID from the last path segment: /v1/vault/item/{id}
	path := r.URL.Path
	id := path[strings.LastIndex(path, "/")+1:]
	if id == "" {
		http.Error(w, `{"error":"missing item id"}`, http.StatusBadRequest)
		return
	}

	// The persona is passed as a query parameter since the URL does not contain it.
	personaStr := r.URL.Query().Get("persona")
	if personaStr == "" {
		personaStr = "personal"
	}
	persona, err := domain.NewPersonaName(personaStr)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	item, err := h.Vault.GetItem(r.Context(), agentDID(r), persona, id)
	if err != nil {
		// Distinguish "not found" from other errors.
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"item not found"}`, http.StatusNotFound)
			return
		}
		clientError(w, "get item failed", http.StatusInternalServerError, err)
		return
	}
	if item == nil {
		http.Error(w, `{"error":"item not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(item)
}

// HandleDeleteItem handles DELETE /v1/vault/item/{id}. It removes the item
// from the persona's vault and returns 204 No Content.
func (h *VaultHandler) HandleDeleteItem(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	id := path[strings.LastIndex(path, "/")+1:]
	if id == "" {
		http.Error(w, `{"error":"missing item id"}`, http.StatusBadRequest)
		return
	}

	personaStr := r.URL.Query().Get("persona")
	if personaStr == "" {
		personaStr = "personal"
	}
	persona, err := domain.NewPersonaName(personaStr)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	if err := h.Vault.Delete(r.Context(), persona, id); err != nil {
		clientError(w, "delete failed", http.StatusInternalServerError, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// VaultClearer clears all items from a persona's vault. Exposed as a separate
// interface so the handler can accept it without coupling to VaultService.
type VaultClearer interface {
	ClearAll(ctx context.Context, persona domain.PersonaName) (int, error)
}

// HandleClearVault handles POST /v1/vault/clear. It removes ALL items from a
// persona's vault. Only registered when DINA_TEST_MODE=true to prevent
// accidental use in production.
func HandleClearVault(clearer VaultClearer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Persona string `json:"persona"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		if req.Persona == "" {
			req.Persona = "personal"
		}

		persona, err := domain.NewPersonaName(req.Persona)
		if err != nil {
			http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
			return
		}

		count, err := clearer.ClearAll(r.Context(), persona)
		if err != nil {
			clientError(w, "clear failed", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"cleared": count})
	}
}

// HandlePutKV handles PUT /v1/vault/kv/{key}. It accepts a JSON body with a
// "value" field and stores the value under the given key. Returns 204 No Content.
func (h *VaultHandler) HandlePutKV(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	key := path[strings.LastIndex(path, "/")+1:]
	if key == "" {
		http.Error(w, `{"error":"missing key"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}

	// Extract "value" from JSON envelope if present; otherwise store raw body.
	value := string(body)
	var envelope map[string]interface{}
	if json.Unmarshal(body, &envelope) == nil {
		if v, ok := envelope["value"]; ok {
			switch tv := v.(type) {
			case string:
				value = tv
			default:
				// Re-encode non-string values as JSON.
				if b, err := json.Marshal(tv); err == nil {
					value = string(b)
				}
			}
		}
	}

	persona, pErr := domain.NewPersonaName("personal")
	if pErr != nil {
		http.Error(w, `{"error":"invalid persona"}`, http.StatusInternalServerError)
		return
	}

	item := domain.VaultItem{
		ID:       "kv:" + key,
		Type:     "kv",
		BodyText: value,
	}
	if _, err := h.Vault.Store(r.Context(), persona, item); err != nil {
		clientError(w, "store failed", http.StatusInternalServerError, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleGetKV handles GET /v1/vault/kv/{key}. It retrieves the value stored
// under the given key and returns it as JSON {"value": "..."}.
func (h *VaultHandler) HandleGetKV(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	key := path[strings.LastIndex(path, "/")+1:]
	if key == "" {
		http.Error(w, `{"error":"missing key"}`, http.StatusBadRequest)
		return
	}

	persona, pErr := domain.NewPersonaName("personal")
	if pErr != nil {
		http.Error(w, `{"error":"invalid persona"}`, http.StatusInternalServerError)
		return
	}

	item, err := h.Vault.GetKV(r.Context(), agentDID(r), persona, key)
	if err != nil {
		// Distinguish "not found" from other errors.
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"key not found"}`, http.StatusNotFound)
			return
		}
		clientError(w, "get failed", http.StatusInternalServerError, err)
		return
	}
	if item == nil {
		http.Error(w, `{"error":"key not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"value": item.BodyText})
}
