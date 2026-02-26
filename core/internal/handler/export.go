package handler

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
)

// ExportHandler serves the /v1/export and /v1/import endpoints.
type ExportHandler struct {
	// ExportBaseDir is the allowed base directory for export destinations.
	// Defaults to "/tmp/dina-exports" if empty.
	ExportBaseDir string
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

// TODO: implement real export -- re-enable after path validation is verified

// HandleExport handles POST /v1/export.
// CRIT-02: Export is not yet implemented. Returns 501 until the real
// implementation is complete and path validation has been verified.
func (h *ExportHandler) HandleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotImplemented)
	w.Write([]byte(`{"error":"export not yet implemented","status":"placeholder"}`))
}

// HandleImport handles POST /v1/import.
// CRIT-02: Import is not yet implemented. Returns 501 until the real
// implementation is complete.
func (h *ExportHandler) HandleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotImplemented)
	w.Write([]byte(`{"error":"import not yet implemented","status":"placeholder"}`))
}
