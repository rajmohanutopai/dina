package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/gen"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// vaultErrStatus maps domain errors to HTTP status codes.
func vaultErrStatus(err error) int {
	if errors.Is(err, domain.ErrPersonaLocked) {
		return http.StatusForbidden
	}
	if errors.Is(err, domain.ErrPersonaNotFound) || errors.Is(err, identity.ErrPersonaNotFound) {
		return http.StatusNotFound
	}
	var approvalErr *identity.ErrApprovalRequired
	if errors.As(err, &approvalErr) {
		return http.StatusForbidden
	}
	return http.StatusInternalServerError
}

// vaultErrMsg returns a client-safe error message.
func vaultErrMsg(err error, defaultMsg string) string {
	if errors.Is(err, domain.ErrPersonaLocked) {
		return "persona locked"
	}
	if errors.Is(err, domain.ErrPersonaNotFound) || errors.Is(err, identity.ErrPersonaNotFound) {
		return "persona not found"
	}
	return defaultMsg
}

// VaultHandler exposes vault CRUD and KV endpoints.
type VaultHandler struct {
	Vault     *service.VaultService
	PII       port.PIIScrubber
	Approvals port.ApprovalManager // optional — queues approval requests for sensitive personas
}

// agentDID extracts the agent DID from the request context (set by auth
// middleware). Falls back to "brain" when no value is present.
func agentDID(r *http.Request) string {
	if v, ok := r.Context().Value(middleware.AgentDIDKey).(string); ok && v != "" {
		return v
	}
	return "brain"
}

// validUserOrigins is the Core-enforced allowlist of user_origin values
// that elevate Brain requests to user-equivalent access. Brain convention
// alone is not sufficient — Core validates the exact set.
var validUserOrigins = map[string]bool{
	"telegram": true,
	"admin":    true,
}

// injectUserOrigin sets UserOriginatedKey in the request context when the
// signed body contains a user_origin field. Only Brain service key requests
// can claim user origin, and only for allowlisted origin values.
// Fails closed if both X-Agent-DID and user_origin are present (ambiguous).
func injectUserOrigin(r *http.Request, userOrigin string) *http.Request {
	if userOrigin == "" {
		return r
	}
	// Core-enforced allowlist: reject unknown origin values.
	if !validUserOrigins[userOrigin] {
		return r
	}
	// Only accept user_origin from Brain service key (CallerType=brain).
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType != "brain" {
		return r // Connector/device cannot claim user origin
	}
	// Fail closed: reject ambiguous context (both agent and user origin).
	if agentOverride := r.Header.Get("X-Agent-DID"); agentOverride != "" {
		return r // X-Agent-DID + user_origin = ambiguous, ignore user_origin
	}
	ctx := context.WithValue(r.Context(), middleware.UserOriginatedKey, true)
	ctx = context.WithValue(ctx, middleware.UserOriginKey, userOrigin)
	return r.WithContext(ctx)
}

// queryRequest is the JSON body for POST /v1/vault/query.
// Matches gen.VaultQueryRequest from the OpenAPI spec.
type queryRequest = gen.VaultQueryRequest

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

	// Inject user-origin context if present in the signed body.
	// Only Brain service key can claim user origin. Fail closed if ambiguous.
	r = injectUserOrigin(r, string(req.UserOrigin))

	persona, err := domain.NewPersonaName(req.Persona)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	mode := domain.SearchFTS5
	switch domain.SearchMode(string(req.Mode)) {
	case domain.SearchSemantic:
		mode = domain.SearchSemantic
	case domain.SearchHybrid:
		mode = domain.SearchHybrid
	case domain.SearchFTS5:
		mode = domain.SearchFTS5
	}

	// DM3: Clamp query limit at domain level to prevent data exfiltration.
	limit := domain.ClampSearchLimit(req.Limit)

	q := domain.SearchQuery{
		Mode:            mode,
		Query:           req.Query,
		Types:           req.Types,
		Limit:           limit,
		Embedding:       req.Embedding,
		IncludeAll:      req.IncludeAll,
		IncludeContent:  req.IncludeContent,
		RetrievalPolicy: string(req.RetrievalPolicy),
	}

	// Track whether we requested a mode that falls back to FTS5.
	requestedMode := mode

	items, err := h.Vault.Query(r.Context(), agentDID(r), persona, q)
	if err != nil {
		// If approval is needed, create an approval request and return 403 with details.
		var approvalErr *identity.ErrApprovalRequired
		if errors.As(err, &approvalErr) && h.Approvals != nil {
			sessionName, _ := r.Context().Value(middleware.SessionNameKey).(string)
			reqID, aprErr := h.Approvals.RequestApproval(r.Context(), domain.ApprovalRequest{
				ClientDID: agentDID(r),
				PersonaID: string(persona),
				SessionID: sessionName,
				Action:    "vault_query",
				Reason:    req.Query,
			})
			if aprErr == nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{
					"error":       "approval_required",
					"approval_id": reqID,
					"persona":     string(persona),
					"message":     "Access requires approval. Run: ./dina-admin persona approve " + reqID,
				})
				return
			}
		}
		clientError(w, vaultErrMsg(err, "query failed"), vaultErrStatus(err), err)
		return
	}

	// Signal degradation when semantic/hybrid was requested but no embedding provided.
	if (requestedMode == domain.SearchSemantic || requestedMode == domain.SearchHybrid) && len(req.Embedding) == 0 {
		w.Header().Set("X-Search-Mode", "fts5")
		w.Header().Set("X-Search-Degraded-From", string(requestedMode))
	}

	// Ensure JSON encodes as [] not null when no results found.
	if items == nil {
		items = []domain.VaultItem{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"items": items})
}

// storeRequest is the JSON body for POST /v1/vault/store.
// Matches gen.VaultStoreRequest from the OpenAPI spec.
type storeRequest = gen.VaultStoreRequest

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

	r = injectUserOrigin(r, string(req.UserOrigin))

	persona, err := domain.NewPersonaName(req.Persona)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	// Direct user writes (CLI remember, admin) get self/high/normal defaults.
	// This ensures user-authored content is always trusted without Brain involvement.
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType == "agent" || callerType == "user" {
		if req.Item.SourceType == "" {
			req.Item.SourceType = "self"
		}
		if req.Item.Sender == "" {
			req.Item.Sender = "user"
		}
		if req.Item.SenderTrust == "" {
			req.Item.SenderTrust = "self"
		}
		if req.Item.Confidence == "" {
			req.Item.Confidence = "high"
		}
		if req.Item.RetrievalPolicy == "" {
			req.Item.RetrievalPolicy = "normal"
		}
	}

	id, err := h.Vault.Store(r.Context(), agentDID(r), persona, req.Item)
	if err != nil {
		// If approval is needed, create an approval request and return 403 with details.
		var approvalErr *identity.ErrApprovalRequired
		if errors.As(err, &approvalErr) && h.Approvals != nil {
			sessionName, _ := r.Context().Value(middleware.SessionNameKey).(string)
			reqID, aprErr := h.Approvals.RequestApproval(r.Context(), domain.ApprovalRequest{
				ClientDID: agentDID(r),
				PersonaID: string(persona),
				SessionID: sessionName,
				Action:    "vault_store",
				Reason:    req.Item.Summary,
			})
			if aprErr == nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{
					"error":       "approval_required",
					"approval_id": reqID,
					"persona":     string(persona),
					"message":     "Access requires approval. Run: ./dina-admin persona approve " + reqID,
				})
				return
			}
		}
		clientError(w, vaultErrMsg(err, "store failed"), vaultErrStatus(err), err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": id})
}

// storeBatchRequest is the JSON body for POST /v1/vault/store/batch.
// Matches gen.VaultStoreBatchRequest from the OpenAPI spec.
type storeBatchRequest = gen.VaultStoreBatchRequest

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

	r = injectUserOrigin(r, string(req.UserOrigin))

	persona, err := domain.NewPersonaName(req.Persona)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	ids, err := h.Vault.StoreBatch(r.Context(), agentDID(r), persona, req.Items)
	if err != nil {
		clientError(w, vaultErrMsg(err, "store batch failed"), vaultErrStatus(err), err)
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
		personaStr = "general"
	}
	persona, err := domain.NewPersonaName(personaStr)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	// Inject user-origin from query parameter (signed in the canonical payload via query string).
	r = injectUserOrigin(r, r.URL.Query().Get("user_origin"))

	item, err := h.Vault.GetItem(r.Context(), agentDID(r), persona, id)
	if err != nil {
		// Distinguish "not found" from other errors.
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"item not found"}`, http.StatusNotFound)
			return
		}
		clientError(w, vaultErrMsg(err, "get item failed"), vaultErrStatus(err), err)
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
	// HIGH-03: Enforce DELETE method to prevent method confusion.
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	path := r.URL.Path
	id := path[strings.LastIndex(path, "/")+1:]
	if id == "" {
		http.Error(w, `{"error":"missing item id"}`, http.StatusBadRequest)
		return
	}

	personaStr := r.URL.Query().Get("persona")
	if personaStr == "" {
		personaStr = "general"
	}
	persona, err := domain.NewPersonaName(personaStr)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	// Inject user-origin from query parameter (signed in the canonical payload).
	r = injectUserOrigin(r, r.URL.Query().Get("user_origin"))

	if err := h.Vault.Delete(r.Context(), agentDID(r), persona, id); err != nil {
		clientError(w, vaultErrMsg(err, "delete failed"), vaultErrStatus(err), err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// enrichRequest is the JSON body for PATCH /v1/vault/item/{id}/enrich.
// Matches gen.VaultEnrichRequest from the OpenAPI spec.
type enrichRequest = gen.VaultEnrichRequest

// HandleEnrich handles PATCH /v1/vault/item/{id}/enrich. It updates only the
// enrichment fields (content_l0, content_l1, embedding, enrichment_status,
// enrichment_version) on an existing vault item via get-merge-store (upsert).
func (h *VaultHandler) HandleEnrich(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Extract item ID: path is /v1/vault/item/{id}/enrich
	// Strip the "/enrich" suffix, then take the last segment as the ID.
	path := strings.TrimSuffix(r.URL.Path, "/enrich")
	id := path[strings.LastIndex(path, "/")+1:]
	if id == "" {
		http.Error(w, `{"error":"missing item id"}`, http.StatusBadRequest)
		return
	}

	personaStr := r.URL.Query().Get("persona")
	if personaStr == "" {
		personaStr = "general"
	}
	persona, err := domain.NewPersonaName(personaStr)
	if err != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	var req enrichRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	// Validate enrichment_status if provided.
	if req.EnrichmentStatus != "" && !domain.ValidEnrichmentStatus[string(req.EnrichmentStatus)] {
		http.Error(w, `{"error":"invalid enrichment_status"}`, http.StatusBadRequest)
		return
	}

	// Fetch existing item.
	item, err := h.Vault.GetItem(r.Context(), agentDID(r), persona, id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"item not found"}`, http.StatusNotFound)
			return
		}
		clientError(w, vaultErrMsg(err, "get item failed"), vaultErrStatus(err), err)
		return
	}

	// Merge enrichment fields onto existing item.
	if req.ContentL0 != "" {
		item.ContentL0 = req.ContentL0
	}
	if req.ContentL1 != "" {
		item.ContentL1 = req.ContentL1
	}
	if len(req.Embedding) > 0 {
		item.Embedding = req.Embedding
	}
	if req.EnrichmentStatus != "" {
		item.EnrichmentStatus = string(req.EnrichmentStatus)
	}
	if req.EnrichmentVersion != "" {
		item.EnrichmentVersion = req.EnrichmentVersion
	}

	// Store (upsert by ID preserves all existing fields).
	if _, err := h.Vault.Store(r.Context(), agentDID(r), persona, *item); err != nil {
		clientError(w, vaultErrMsg(err, "enrich failed"), vaultErrStatus(err), err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": id, "enrichment_status": item.EnrichmentStatus})
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
			req.Persona = "general"
		}

		persona, err := domain.NewPersonaName(req.Persona)
		if err != nil {
			http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
			return
		}

		count, err := clearer.ClearAll(r.Context(), persona)
		if err != nil {
			clientError(w, vaultErrMsg(err, "clear failed"), vaultErrStatus(err), err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"cleared": count})
	}
}

// kvBlockedForDevice returns true if the KV key is sensitive and the caller
// is a device-scoped client. FC1: prevents devices from reading/writing
// admin secrets (API keys, provider config) stored in KV.
func kvBlockedForDevice(r *http.Request, key string) bool {
	callerType, _ := r.Context().Value(middleware.CallerTypeKey).(string)
	if callerType != "agent" {
		return false // admin, brain, etc. — allowed
	}
	// Blocklist: keys that contain secrets or admin-only config.
	if key == "user_settings" || strings.HasPrefix(key, "admin:") {
		return true
	}
	return false
}

// HandlePutKV handles PUT /v1/vault/kv/{key}. It accepts a JSON body with a
// "value" field and stores the value under the given key. Returns 204 No Content.
func (h *VaultHandler) HandlePutKV(w http.ResponseWriter, r *http.Request) {
	// HIGH-03: Enforce PUT method to prevent method confusion.
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	path := r.URL.Path
	key := path[strings.LastIndex(path, "/")+1:]
	if key == "" {
		http.Error(w, `{"error":"missing key"}`, http.StatusBadRequest)
		return
	}

	// FC1: Block device-scoped callers from writing sensitive KV keys.
	if kvBlockedForDevice(r, key) {
		http.Error(w, `{"error":"forbidden","message":"this key is admin-only"}`, http.StatusForbidden)
		return
	}

	// GH3: Enforce body size limit (1 MiB) to prevent OOM DoS.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"request body too large or unreadable"}`, http.StatusBadRequest)
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

	// MEDIUM-08: Accept persona from query param instead of hardcoding "general".
	personaStr := r.URL.Query().Get("persona")
	if personaStr == "" {
		personaStr = "general"
	}
	persona, pErr := domain.NewPersonaName(personaStr)
	if pErr != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	item := domain.VaultItem{
		ID:       "kv:" + key,
		Type:     "kv",
		BodyText: value,
	}
	if _, err := h.Vault.Store(r.Context(), agentDID(r), persona, item); err != nil {
		clientError(w, vaultErrMsg(err, "store failed"), vaultErrStatus(err), err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleGetKV handles GET /v1/vault/kv/{key}. It retrieves the value stored
// under the given key and returns it as JSON {"value": "..."}.
func (h *VaultHandler) HandleGetKV(w http.ResponseWriter, r *http.Request) {
	// HIGH-03: Enforce GET method to prevent method confusion.
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	path := r.URL.Path
	key := path[strings.LastIndex(path, "/")+1:]
	if key == "" {
		http.Error(w, `{"error":"missing key"}`, http.StatusBadRequest)
		return
	}

	// FC1: Block device-scoped callers from reading sensitive KV keys.
	if kvBlockedForDevice(r, key) {
		http.Error(w, `{"error":"forbidden","message":"this key is admin-only"}`, http.StatusForbidden)
		return
	}

	// MEDIUM-08: Accept persona from query param instead of hardcoding "general".
	personaStr := r.URL.Query().Get("persona")
	if personaStr == "" {
		personaStr = "general"
	}
	persona, pErr := domain.NewPersonaName(personaStr)
	if pErr != nil {
		http.Error(w, `{"error":"invalid persona name"}`, http.StatusBadRequest)
		return
	}

	item, err := h.Vault.GetKV(r.Context(), agentDID(r), persona, key)
	if err != nil {
		// Distinguish "not found" from other errors.
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"key not found"}`, http.StatusNotFound)
			return
		}
		clientError(w, vaultErrMsg(err, "get failed"), vaultErrStatus(err), err)
		return
	}
	if item == nil {
		http.Error(w, `{"error":"key not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"value": item.BodyText})
}
