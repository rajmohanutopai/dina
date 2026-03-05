package domain

// GatekeeperConfig holds the configuration for the gatekeeper subsystem.
type GatekeeperConfig struct {
	// RiskyActions lists actions that require audit/review (e.g. send_email, transfer_money, share_data).
	RiskyActions []string
	// BlockedActions lists actions that are always denied for untrusted agents.
	BlockedActions []string
	// TrustedDestinations is the allowlist for egress.
	TrustedDestinations []string
	// BlockedDestinations is the blocklist for egress.
	BlockedDestinations []string
}

// BootConfig holds configuration for the boot sequence.
type BootConfig struct {
	Mode            string // "security" or "convenience"
	KeyfilePath     string
	WrappedSeedPath string
	VaultPath       string
	Personas        []string // persona names to open at boot
	Passphrase      string   // for security mode
}

// Config holds all typed configuration for dina-core.
type Config struct {
	ListenAddr     string
	AdminAddr      string
	VaultPath      string
	BrainURL       string
	SecurityMode   string // "security" or "convenience"
	SessionTTL     int    // seconds
	RateLimit      int    // requests per minute per IP
	SpoolMax       int    // max spool directory size (buffered messages when locked)
	BackupInterval  int    // hours between automatic backups
	AdminSocketPath string // Unix socket path for local admin CLI (empty = disabled)
}

// EstatePlan holds the digital estate configuration.
type EstatePlan struct {
	Trigger       string              // "custodian_threshold" (only valid value)
	Custodians    []string            // DIDs of custodian contacts
	Threshold     int                 // k-of-n threshold for activation
	Beneficiaries map[string][]string // beneficiary DID -> list of persona names
	DefaultAction string              // "destroy" or "archive"
	Notifications []string            // DIDs to notify on activation
	AccessTypes   map[string]string   // beneficiary DID -> access type
	CreatedAt     int64
	UpdatedAt     int64
}
