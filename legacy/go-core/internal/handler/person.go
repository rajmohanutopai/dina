package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// PersonHandler serves the /v1/people endpoints.
type PersonHandler struct {
	People port.PersonStore
}

// HandleApplyExtraction handles POST /v1/people/apply-extraction.
func (h *PersonHandler) HandleApplyExtraction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var result domain.ExtractionResult
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if result.SourceItemID == "" || result.ExtractorVersion == "" {
		http.Error(w, `{"error":"source_item_id and extractor_version required"}`, http.StatusBadRequest)
		return
	}

	resp, err := h.People.ApplyExtraction(r.Context(), result)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if resp.Skipped {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusCreated)
	}
	json.NewEncoder(w).Encode(resp)
}

// HandleListPeople handles GET /v1/people.
func (h *PersonHandler) HandleListPeople(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	people, err := h.People.ListPeople(r.Context())
	if err != nil {
		http.Error(w, `{"error":"failed to list people"}`, http.StatusInternalServerError)
		return
	}
	if people == nil {
		people = []domain.Person{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"people": people})
}

// HandleGetPerson handles GET /v1/people/{person_id}.
func (h *PersonHandler) HandleGetPerson(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	personID := strings.TrimPrefix(r.URL.Path, "/v1/people/")
	if personID == "" || personID == r.URL.Path {
		http.Error(w, `{"error":"missing person_id"}`, http.StatusBadRequest)
		return
	}
	// Strip sub-paths.
	if idx := strings.Index(personID, "/"); idx >= 0 {
		personID = personID[:idx]
	}

	person, err := h.People.GetPerson(r.Context(), personID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, `{"error":"person not found"}`, http.StatusNotFound)
		} else {
			http.Error(w, `{"error":"failed to get person"}`, http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(person)
}

// HandleConfirmPerson handles PUT /v1/people/{person_id}/confirm.
func (h *PersonHandler) HandleConfirmPerson(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	personID := extractPersonID(r.URL.Path)
	if err := h.People.ConfirmPerson(r.Context(), personID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "confirmed"})
}

// HandleRejectPerson handles PUT /v1/people/{person_id}/reject.
func (h *PersonHandler) HandleRejectPerson(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	personID := extractPersonID(r.URL.Path)
	if err := h.People.RejectPerson(r.Context(), personID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "rejected"})
}

// HandleDeletePerson handles DELETE /v1/people/{person_id}.
func (h *PersonHandler) HandleDeletePerson(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	personID := extractPersonID(r.URL.Path)
	if err := h.People.DeletePerson(r.Context(), personID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// HandleConfirmSurface handles PUT /v1/people/{person_id}/surfaces/{id}/confirm.
func (h *PersonHandler) HandleConfirmSurface(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	personID, surfaceID := extractPersonAndSurfaceID(r.URL.Path, "/confirm")
	if err := h.People.ConfirmSurface(r.Context(), personID, surfaceID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "confirmed"})
}

// HandleRejectSurface handles PUT /v1/people/{person_id}/surfaces/{id}/reject.
func (h *PersonHandler) HandleRejectSurface(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	personID, surfaceID := extractPersonAndSurfaceID(r.URL.Path, "/reject")
	if err := h.People.RejectSurface(r.Context(), personID, surfaceID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "rejected"})
}

// HandleDetachSurface handles DELETE /v1/people/{person_id}/surfaces/{id}.
func (h *PersonHandler) HandleDetachSurface(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	personID, surfaceID := extractPersonAndSurfaceID(r.URL.Path, "")
	if err := h.People.DetachSurface(r.Context(), personID, surfaceID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "detached"})
}

type mergeRequest struct {
	KeepPersonID  string `json:"keep_person_id"`
	MergePersonID string `json:"merge_person_id"`
}

// HandleMergePeople handles POST /v1/people/merge.
func (h *PersonHandler) HandleMergePeople(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	var req mergeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.KeepPersonID == "" || req.MergePersonID == "" {
		http.Error(w, `{"error":"keep_person_id and merge_person_id required"}`, http.StatusBadRequest)
		return
	}
	if err := h.People.MergePeople(r.Context(), req.KeepPersonID, req.MergePersonID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "merged"})
}

type linkContactRequest struct {
	ContactDID string `json:"contact_did"`
}

// HandleLinkContact handles POST /v1/people/{person_id}/link-contact.
func (h *PersonHandler) HandleLinkContact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	personID := extractPersonID(r.URL.Path)
	personID = strings.TrimSuffix(personID, "/link-contact")

	var req linkContactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.ContactDID == "" {
		http.Error(w, `{"error":"contact_did required"}`, http.StatusBadRequest)
		return
	}
	if err := h.People.LinkContact(r.Context(), personID, req.ContactDID); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "linked"})
}

// --- path helpers ---

func extractPersonID(path string) string {
	trimmed := strings.TrimPrefix(path, "/v1/people/")
	if idx := strings.Index(trimmed, "/"); idx >= 0 {
		return trimmed[:idx]
	}
	return trimmed
}

func extractPersonAndSurfaceID(path, suffix string) (string, int64) {
	if suffix != "" {
		path = strings.TrimSuffix(path, suffix)
	}
	// path: /v1/people/{pid}/surfaces/{sid}
	trimmed := strings.TrimPrefix(path, "/v1/people/")
	parts := strings.SplitN(trimmed, "/surfaces/", 2)
	if len(parts) != 2 {
		return "", 0
	}
	sid, _ := strconv.ParseInt(parts[1], 10, 64)
	return parts[0], sid
}
