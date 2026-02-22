package handler

import (
	"encoding/json"
	"net/http"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/service"
)

// ExportHandler serves the /v1/export and /v1/import endpoints.
type ExportHandler struct {
	Migration *service.MigrationService
}

// exportRequest is the JSON body for POST /v1/export.
type exportRequest struct {
	Passphrase string `json:"passphrase"`
	DestPath   string `json:"dest_path"`
}

// importRequest is the JSON body for POST /v1/import.
type importRequest struct {
	ArchivePath string `json:"archive_path"`
	Passphrase  string `json:"passphrase"`
}

// HandleExport handles POST /v1/export.
func (h *ExportHandler) HandleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req exportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Passphrase == "" || req.DestPath == "" {
		http.Error(w, `{"error":"passphrase and dest_path are required"}`, http.StatusBadRequest)
		return
	}

	opts := domain.ExportOptions{
		Passphrase: req.Passphrase,
		DestPath:   req.DestPath,
	}

	archivePath, err := h.Migration.Export(r.Context(), opts)
	if err != nil {
		http.Error(w, `{"error":"export failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"archive_path": archivePath})
}

// HandleImport handles POST /v1/import.
func (h *ExportHandler) HandleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req importRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.ArchivePath == "" || req.Passphrase == "" {
		http.Error(w, `{"error":"archive_path and passphrase are required"}`, http.StatusBadRequest)
		return
	}

	opts := domain.ImportOptions{
		ArchivePath: req.ArchivePath,
		Passphrase:  req.Passphrase,
	}

	result, err := h.Migration.Import(r.Context(), opts)
	if err != nil {
		http.Error(w, `{"error":"import failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
