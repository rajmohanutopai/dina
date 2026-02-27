// Package config implements typed configuration loading for dina-core.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all typed configuration for dina-core.
// Field names and types match testutil.Config exactly for structural typing.
type Config struct {
	ListenAddr       string `json:"listen_addr"`
	AdminAddr        string `json:"admin_addr"`
	VaultPath        string `json:"vault_path"`
	BrainURL         string `json:"brain_url"`
	BrainToken       string `json:"brain_token"`
	SecurityMode     string `json:"security_mode"`
	SessionTTL       int    `json:"session_ttl"`
	RateLimit        int    `json:"rate_limit"`
	SpoolMax         int    `json:"spool_max"`
	BackupInterval   int    `json:"backup_interval"`
	PDSURL           string `json:"pds_url"`
	PLCURL           string `json:"plc_url"`
	PDSAdminPassword string `json:"pds_admin_password"`
	PDSHandle        string `json:"pds_handle"`
	PDSEmail         string `json:"pds_email"`
	ClientToken      string `json:"client_token"`
	OwnDID           string `json:"own_did"`
	AllowedOrigins   string `json:"allowed_origins"`
	TrustedProxies   string `json:"trusted_proxies"` // comma-separated CIDRs for XFF trust
}

// Loader implements testutil.ConfigLoader.
type Loader struct{}

// NewLoader returns a config loader.
func NewLoader() *Loader {
	return &Loader{}
}

// Load reads config from defaults, config.json, env vars, and Docker Secrets.
// Priority: Docker Secret (for BrainToken) > env vars > config.json > defaults.
func (l *Loader) Load() (*Config, error) {
	cfg := defaults()

	// 1. Load from config.json if DINA_CONFIG_PATH is set.
	if path := os.Getenv("DINA_CONFIG_PATH"); path != "" {
		if err := loadJSON(path, cfg); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("config: %w", err)
		}
	}

	// 2. Override with environment variables.
	loadEnv(cfg)

	// 3. Load BrainToken from Docker Secret file (highest priority for token).
	if path := os.Getenv("DINA_BRAIN_TOKEN_FILE"); path != "" {
		if err := loadSecretFileStrict(path, &cfg.BrainToken); err != nil {
			return nil, err
		}
	}

	// 4. Load ClientToken from Docker Secret file (optional — for pre-registered admin access).
	if path := os.Getenv("DINA_CLIENT_TOKEN_FILE"); path != "" {
		loadSecretFile(path, &cfg.ClientToken)
	}

	return cfg, nil
}

// Validate checks config values for sanity.
func (l *Loader) Validate(cfg *Config) error {
	if cfg.ListenAddr == "" {
		return fmt.Errorf("config: listen_addr is required")
	}
	if cfg.VaultPath == "" {
		return fmt.Errorf("config: vault_path is required")
	}
	if cfg.BrainToken == "" {
		return fmt.Errorf("config: brain_token is required")
	}
	if cfg.SecurityMode != "security" && cfg.SecurityMode != "convenience" {
		return fmt.Errorf("config: security_mode must be 'security' or 'convenience', got %q", cfg.SecurityMode)
	}
	if cfg.SessionTTL <= 0 {
		return fmt.Errorf("config: session_ttl must be positive")
	}
	if cfg.RateLimit <= 0 {
		return fmt.Errorf("config: rate_limit must be positive")
	}
	return nil
}

func defaults() *Config {
	return &Config{
		ListenAddr:     ":8300",
		AdminAddr:      ":8100",
		VaultPath:      "/var/lib/dina",
		BrainURL:       "http://brain:8200",
		SecurityMode:   "security",
		SessionTTL:     86400,
		RateLimit:      60,
		SpoolMax:       1000,
		BackupInterval: 24,
	}
}

func loadJSON(path string, cfg *Config) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, cfg)
}

func loadSecretFile(path string, target *string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	val := strings.TrimSpace(string(data))
	if val != "" {
		*target = val
	}
}

// loadSecretFileStrict reads a token from a file and returns an error
// if the file is missing or empty. Used for DINA_BRAIN_TOKEN_FILE where
// a missing or empty token file must fail startup.
func loadSecretFileStrict(path string, target *string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("config: brain token file error: %w", err)
	}
	val := strings.TrimSpace(string(data))
	if val == "" {
		return fmt.Errorf("config: brain token file is empty: %s", path)
	}
	*target = val
	return nil
}

func loadEnv(cfg *Config) {
	if v := os.Getenv("DINA_LISTEN_ADDR"); v != "" {
		cfg.ListenAddr = v
	}
	if v := os.Getenv("DINA_ADMIN_ADDR"); v != "" {
		cfg.AdminAddr = v
	}
	if v := os.Getenv("DINA_VAULT_PATH"); v != "" {
		cfg.VaultPath = v
	}
	if v := os.Getenv("DINA_BRAIN_URL"); v != "" {
		cfg.BrainURL = v
	}
	if v := os.Getenv("DINA_BRAIN_TOKEN"); v != "" {
		cfg.BrainToken = v
	}
	if v := os.Getenv("DINA_MODE"); v != "" {
		cfg.SecurityMode = v
	}
	if v := os.Getenv("DINA_SESSION_TTL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.SessionTTL = n
		}
	}
	if v := os.Getenv("DINA_RATE_LIMIT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.RateLimit = n
		}
	}
	if v := os.Getenv("DINA_SPOOL_MAX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.SpoolMax = n
		}
	}
	if v := os.Getenv("DINA_BACKUP_INTERVAL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.BackupInterval = n
		}
	}
	if v := os.Getenv("DINA_PDS_URL"); v != "" {
		cfg.PDSURL = v
	}
	if v := os.Getenv("DINA_PLC_URL"); v != "" {
		cfg.PLCURL = v
	}
	if v := os.Getenv("DINA_PDS_ADMIN_PASSWORD"); v != "" {
		cfg.PDSAdminPassword = v
	}
	if v := os.Getenv("DINA_PDS_HANDLE"); v != "" {
		cfg.PDSHandle = v
	}
	if v := os.Getenv("DINA_PDS_EMAIL"); v != "" {
		cfg.PDSEmail = v
	}
	if v := os.Getenv("DINA_CLIENT_TOKEN"); v != "" {
		cfg.ClientToken = v
	}
	if v := os.Getenv("DINA_OWN_DID"); v != "" {
		cfg.OwnDID = v
	}
	if v := os.Getenv("DINA_ALLOWED_ORIGINS"); v != "" {
		cfg.AllowedOrigins = v
	}
	if v := os.Getenv("DINA_TRUSTED_PROXIES"); v != "" {
		cfg.TrustedProxies = v
	}
}
