package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// MemoryHandler exposes the Core-side surface of the working-memory
// index (docs/WORKING_MEMORY_DESIGN.md):
//
//   POST /v1/memory/topic/touch  — Brain records a mention.
//   GET  /v1/memory/toc          — Brain reads the ranked ToC.
//
// No admin endpoints yet; Core never mutates topics except through
// Touch. Personas that are locked are invisible at the handler level —
// the pool returns a nil TopicStore for them, and we skip silently.
type MemoryHandler struct {
	// Memory aggregates the cross-persona read path.
	Memory *service.MemoryService
	// Provider lets the handler find a per-persona TopicStore for
	// Touch. Same interface the service uses; reused here so the
	// handler doesn't need direct pool access.
	Provider service.TopicStoreProvider
	// Clock injects time for Touch's NowUnix field. Tests use a fixed
	// clock; production wires the real clock.
	Clock port.Clock
}

// ---------------------------------------------------------------------------
// POST /v1/memory/topic/touch
// ---------------------------------------------------------------------------

type touchRequestBody struct {
	Persona      string `json:"persona"`
	Topic        string `json:"topic"`
	Kind         string `json:"kind"`
	SampleItemID string `json:"sample_item_id,omitempty"`
}

// HandleTouch applies a topic mention to the named persona's salience
// index. Variant → canonical mapping happens inside the store; the
// caller passes the extracted surface form.
func (h *MemoryHandler) HandleTouch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Provider == nil {
		http.Error(w, `{"error":"memory service not available"}`, http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024))
	if err != nil {
		http.Error(w, `{"error":"read body failed"}`, http.StatusBadRequest)
		return
	}
	var req touchRequestBody
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	// Validate payload before hitting the store.
	req.Persona = strings.TrimSpace(req.Persona)
	req.Topic = strings.TrimSpace(req.Topic)
	if req.Persona == "" || req.Topic == "" {
		http.Error(w, `{"error":"persona and topic are required"}`, http.StatusBadRequest)
		return
	}
	kind := domain.TopicKind(req.Kind)
	if !kind.IsValid() {
		http.Error(w, `{"error":"kind must be 'entity' or 'theme'"}`, http.StatusBadRequest)
		return
	}

	store := h.Provider.TopicStoreFor(req.Persona)
	if store == nil {
		// Persona locked or unknown — treat as soft no-op (Brain may
		// touch topics that happen to live in a just-locked persona).
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"skipped","reason":"persona not open"}`))
		return
	}

	// Canonicalise the variant before storing so re-mentions of
	// near-duplicates compound against the same row.
	canonical, err := store.ResolveAlias(r.Context(), req.Topic)
	if err != nil {
		clientError(w, "alias lookup failed", http.StatusInternalServerError, err)
		return
	}

	err = store.Touch(r.Context(), port.TouchRequest{
		Topic:        canonical,
		Kind:         kind,
		NowUnix:      h.Clock.Now().Unix(),
		SampleItemID: req.SampleItemID,
	})
	if err != nil {
		clientError(w, "topic touch failed", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	resp := map[string]string{"status": "ok", "canonical": canonical}
	_ = json.NewEncoder(w).Encode(resp)
}

// ---------------------------------------------------------------------------
// GET /v1/memory/toc?persona=a,b,c&limit=50
// ---------------------------------------------------------------------------

// HandleToc returns the ranked ToC across the requested personas.
// Query params:
//
//	persona  — comma-separated list of personas; empty means "all open".
//	limit    — max entries returned (default 50, capped at 200).
//
// Locked personas are silently skipped. The service applies EWMA decay
// at read time.
func (h *MemoryHandler) HandleToc(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Memory == nil {
		http.Error(w, `{"error":"memory service not available"}`, http.StatusServiceUnavailable)
		return
	}

	var personas []string
	if p := r.URL.Query().Get("persona"); p != "" {
		for _, name := range strings.Split(p, ",") {
			if name = strings.TrimSpace(name); name != "" {
				personas = append(personas, name)
			}
		}
	}
	if len(personas) == 0 {
		// No filter → caller wants all currently-open user personas.
		// Provider knows which are open because it returns nil for
		// closed ones.
		//
		// Skip the "identity" persona: it's the Tier-0 cross-cutting
		// store (contacts, device tokens, audit log) and does NOT
		// carry the topic_salience table — walking it would crash
		// with "no such table".
		if lister, ok := h.Provider.(openPersonaLister); ok {
			for _, name := range lister.OpenPersonas() {
				if name == "identity" {
					continue
				}
				personas = append(personas, name)
			}
		}
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		var parsed int
		if _, err := sscanfInt(l, &parsed); err == nil && parsed > 0 {
			if parsed > 200 {
				parsed = 200
			}
			limit = parsed
		}
	}

	entries, err := h.Memory.Toc(r.Context(), personas, limit)
	if err != nil {
		clientError(w, "toc query failed", http.StatusInternalServerError, err)
		return
	}
	if entries == nil {
		entries = []domain.TocEntry{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"entries": entries,
		"limit":   limit,
	})
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// openPersonaLister lets the handler ask the provider for the set of
// currently-open personas without importing the sqlite package directly.
// The pool satisfies this via its OpenPersonas method.
type openPersonaLister interface {
	OpenPersonas() []string
}

// sscanfInt parses a base-10 integer without pulling in the whole
// strconv/fmt formatting cost. The caller ignores the returned int when
// err is non-nil.
func sscanfInt(s string, out *int) (int, error) {
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, errInvalidInt
		}
		n = n*10 + int(c-'0')
	}
	*out = n
	return n, nil
}

var errInvalidInt = &parseError{msg: "not a non-negative integer"}

type parseError struct{ msg string }

func (e *parseError) Error() string { return e.msg }
