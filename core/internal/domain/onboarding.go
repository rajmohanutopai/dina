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
	FilesRestored  int
	DID            string
	PersonaCount   int
	RequiresRepair bool
}
