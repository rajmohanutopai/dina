package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
	"github.com/anthropics/dina/core/internal/service"
)

// VaultHandler exposes vault CRUD and KV endpoints.
type VaultHandler struct {
	Vault *service.VaultService
	PII   port.PIIScrubber
}

// agentDID extracts the agent DID from the request context (set by auth
// middleware). Falls back to "brain" when no value is present.
func agentDID(r *http.Request) string {
	if v, ok := r.Context().Value("agent_did").(string); ok && v != "" {
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

	items, err := h.Vault.Query(r.Context(), agentDID(r), persona, q)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
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
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
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
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
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

	// Use a minimal query to retrieve by ID. The persona is passed as a query
	// parameter since the URL does not contain it.
	personaStr := r.URL.Query().Get("persona")
	if personaStr == "" {
		personaStr = "personal"
	}
	persona, err := domain.NewPersonaName(personaStr)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	q := domain.SearchQuery{
		Mode:  domain.SearchFTS5,
		Query: id,
		Limit: 1,
	}
	items, err := h.Vault.Query(r.Context(), agentDID(r), persona, q)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	if len(items) == 0 {
		http.Error(w, `{"error":"item not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items[0])
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
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandlePutKV handles PUT /v1/vault/kv/{key}. It reads the raw body as the
// value and stores it under the given key. Returns 204 No Content.
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

	persona, pErr := domain.NewPersonaName("personal")
	if pErr != nil {
		http.Error(w, `{"error":"invalid persona"}`, http.StatusInternalServerError)
		return
	}

	item := domain.VaultItem{
		ID:       "kv:" + key,
		Type:     "kv",
		BodyText: string(body),
	}
	if _, err := h.Vault.Store(r.Context(), persona, item); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleGetKV handles GET /v1/vault/kv/{key}. It retrieves the value stored
// under the given key and returns it as the response body.
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

	q := domain.SearchQuery{
		Mode:  domain.SearchFTS5,
		Query: "kv:" + key,
		Limit: 1,
	}
	items, err := h.Vault.Query(r.Context(), agentDID(r), persona, q)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	if len(items) == 0 {
		http.Error(w, `{"error":"key not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write([]byte(items[0].BodyText))
}
