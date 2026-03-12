package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// MigrationExporter is the subset of service.MigrationService used by ExportHandler.
type MigrationExporter interface {
	Export(ctx context.Context, opts domain.ExportOptions) (string, error)
	Import(ctx context.Context, opts domain.ImportOptions) (*domain.ImportResult, error)
	VerifyArchive(archivePath, passphrase string) error
}

// ExportHandler serves the /v1/export and /v1/import endpoints.
type ExportHandler struct {
	// ExportBaseDir is the allowed base directory for export destinations.
	// Defaults to "/tmp/dina-exports" if empty.
	ExportBaseDir string

	// Migration is the service that orchestrates export/import operations.
	Migration MigrationExporter
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
	Force       bool   `json:"force"`
}

// validateExportPath validates a destination path for defense-in-depth against
// path traversal attacks. It rejects absolute paths, paths containing "..",
// and paths that escape the configured ExportBaseDir.
func (h *ExportHandler) validateExportPath(destPath string) (string, error) {
	baseDir := h.ExportBaseDir
	if baseDir == "" {
		baseDir = "/tmp/dina-exports"
	}

	// Reject absolute paths outright.
	if filepath.IsAbs(destPath) {
		return "", fmt.Errorf("absolute paths are not allowed")
	}

	// Clean the path to resolve any . or redundant separators.
	cleaned := filepath.Clean(destPath)

	// Reject any path traversal components.
	if strings.Contains(cleaned, "..") {
		return "", fmt.Errorf("path traversal is not allowed")
	}

	// Join with base directory and verify the result stays within bounds.
	absPath := filepath.Join(baseDir, cleaned)
	rel, err := filepath.Rel(baseDir, absPath)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path escapes export base directory")
	}

	return absPath, nil
}

// HandleExport handles POST /v1/export.
func (h *ExportHandler) HandleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if h.Migration == nil {
		w.WriteHeader(http.StatusNotImplemented)
		w.Write([]byte(`{"error":"export not yet configured"}`))
		return
	}

	var req exportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid request body"})
		return
	}

	if req.Passphrase == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "passphrase is required"})
		return
	}

	// Validate and resolve destination path.
	destPath := req.DestPath
	if destPath == "" {
		destPath = "default"
	}
	safePath, err := h.validateExportPath(destPath)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	archivePath, err := h.Migration.Export(r.Context(), domain.ExportOptions{
		Passphrase: req.Passphrase,
		DestPath:   safePath,
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]string{
		"status":       "ok",
		"archive_path": archivePath,
	})
}

// HandleImport handles POST /v1/import.
func (h *ExportHandler) HandleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if h.Migration == nil {
		w.WriteHeader(http.StatusNotImplemented)
		w.Write([]byte(`{"error":"import not yet configured"}`))
		return
	}

	var req importRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid request body"})
		return
	}

	if req.Passphrase == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "passphrase is required"})
		return
	}
	if req.ArchivePath == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "archive_path is required"})
		return
	}

	result, err := h.Migration.Import(r.Context(), domain.ImportOptions{
		ArchivePath: req.ArchivePath,
		Passphrase:  req.Passphrase,
		Force:       req.Force,
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          "ok",
		"files_restored":  result.FilesRestored,
		"persona_count":   result.PersonaCount,
		"requires_repair": result.RequiresRepair,
	})
}
