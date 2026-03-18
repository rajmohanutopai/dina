package domain

// OnboardingStep represents a step in the first-run setup wizard.
type OnboardingStep struct {
	Name      string                 `json:"name"`
	Completed bool                   `json:"completed"`
	Data      map[string]interface{} `json:"data,omitempty"`
}

// ExportManifest holds metadata for an exported archive.
type ExportManifest struct {
	Version   string            `json:"version"`
	Timestamp string            `json:"timestamp"`
	Checksums map[string]string `json:"checksums"`
}

// ExportOptions configures an archive export operation.
type ExportOptions struct {
	Passphrase string `json:"passphrase"`
	DestPath   string `json:"dest_path"`
}

// ImportOptions configures an archive import operation.
type ImportOptions struct {
	ArchivePath string `json:"archive_path"`
	Passphrase  string `json:"passphrase"`
	Force       bool   `json:"force"`
}

// ImportResult holds the outcome of an archive import.
type ImportResult struct {
	FilesRestored   int    `json:"files_restored"`
	DID             string `json:"did,omitempty"`    // populated when identity.sqlite contains a real DID; empty for raw file restores
	PersonaCount    int    `json:"persona_count"`
	RequiresRepair  bool   `json:"requires_repair"`  // devices must be re-paired after import
	RequiresRestart bool   `json:"requires_restart"` // identity DB was closed for safe overwrite; process must restart
}
