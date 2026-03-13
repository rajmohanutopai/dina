package domain

// OnboardingStep represents a step in the first-run setup wizard.
type OnboardingStep struct {
	Name      string
	Completed bool
	Data      map[string]interface{}
}

// ExportManifest holds metadata for an exported archive.
type ExportManifest struct {
	Version   string
	Timestamp string
	Checksums map[string]string
}

// ExportOptions configures an archive export operation.
type ExportOptions struct {
	Passphrase string
	DestPath   string
}

// ImportOptions configures an archive import operation.
type ImportOptions struct {
	ArchivePath string
	Passphrase  string
	Force       bool
}

// ImportResult holds the outcome of an archive import.
type ImportResult struct {
	FilesRestored   int
	DID             string // populated when identity.sqlite contains a real DID; empty for raw file restores
	PersonaCount    int
	RequiresRepair  bool // devices must be re-paired after import
	RequiresRestart bool // identity DB was closed for safe overwrite; process must restart
}
