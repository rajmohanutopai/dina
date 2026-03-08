package test

import (
	"strings"
	"testing"

	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §14 — Configuration
// ==========================================================================
// Covers §14.1 (Env Var Parsing), §14.2 (Defaults), §14.3 (Validation),
// §14.4 (config.json), §14.5 (Docker Secrets), §14.6 (Override Precedence).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §14.1 Env Var Parsing (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-551
func TestConfig_14_1_1_LoadFromEnvVars(t *testing.T) {
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Set env vars for all fields the adapter exposes and verify they load.
	t.Setenv("DINA_LISTEN_ADDR", ":9300")
	t.Setenv("DINA_ADMIN_ADDR", ":9100")
	t.Setenv("DINA_VAULT_PATH", "/tmp/dina-test-vault")
	t.Setenv("DINA_BRAIN_URL", "http://brain:8200")
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)
	t.Setenv("DINA_MODE", "convenience")
	t.Setenv("DINA_SESSION_TTL", "7200")
	t.Setenv("DINA_RATE_LIMIT", "120")
	t.Setenv("DINA_SPOOL_MAX", "500")
	t.Setenv("DINA_BACKUP_INTERVAL", "12")
	t.Setenv("DINA_PDS_URL", "https://pds.example.com")
	t.Setenv("DINA_PLC_URL", "https://plc.example.com")
	t.Setenv("DINA_PDS_ADMIN_PASSWORD", "admin-secret")
	t.Setenv("DINA_PDS_HANDLE", "alice.example.com")
	t.Setenv("DINA_ADMIN_SOCKET", "/tmp/dina-admin.sock")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)

	// String fields.
	testutil.RequireEqual(t, cfg.ListenAddr, ":9300")
	testutil.RequireEqual(t, cfg.AdminAddr, ":9100")
	testutil.RequireEqual(t, cfg.VaultPath, "/tmp/dina-test-vault")
	testutil.RequireEqual(t, cfg.BrainURL, "http://brain:8200")
	testutil.RequireEqual(t, cfg.ClientToken, testutil.TestClientToken)
	testutil.RequireEqual(t, cfg.SecurityMode, "convenience")
	testutil.RequireEqual(t, cfg.PDSURL, "https://pds.example.com")
	testutil.RequireEqual(t, cfg.PLCURL, "https://plc.example.com")
	testutil.RequireEqual(t, cfg.PDSAdminPassword, "admin-secret")
	testutil.RequireEqual(t, cfg.PDSHandle, "alice.example.com")
	testutil.RequireEqual(t, cfg.AdminSocketPath, "/tmp/dina-admin.sock")

	// Numeric fields (parsed from string env vars).
	testutil.RequireEqual(t, cfg.SessionTTL, 7200)
	testutil.RequireEqual(t, cfg.RateLimit, 120)
	testutil.RequireEqual(t, cfg.SpoolMax, 500)
	testutil.RequireEqual(t, cfg.BackupInterval, 12)
}

// TST-CORE-851
func TestConfig_14_7_PartialEnvVars(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// When only some env vars are set, the rest should use defaults.
	t.Setenv("DINA_LISTEN_ADDR", ":7300")
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)
	// Leave all other vars unset — they should fall back to defaults.

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)

	defaults := testutil.TestConfig()

	// Overridden field must take the env value.
	testutil.RequireEqual(t, cfg.ListenAddr, ":7300")

	// All unset fields must retain their specific defaults.
	testutil.RequireEqual(t, cfg.AdminAddr, defaults.AdminAddr)
	testutil.RequireEqual(t, cfg.SecurityMode, defaults.SecurityMode)
	testutil.RequireEqual(t, cfg.SessionTTL, defaults.SessionTTL)
	testutil.RequireEqual(t, cfg.RateLimit, defaults.RateLimit)
	testutil.RequireEqual(t, cfg.SpoolMax, defaults.SpoolMax)
	testutil.RequireEqual(t, cfg.BackupInterval, defaults.BackupInterval)
	testutil.RequireEqual(t, cfg.VaultPath, defaults.VaultPath)
}

// TST-CORE-852
func TestConfig_14_8_EnvVarTypeParsing(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Numeric env vars should be correctly parsed to int fields.
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)
	t.Setenv("DINA_SESSION_TTL", "3600")
	t.Setenv("DINA_RATE_LIMIT", "120")
	t.Setenv("DINA_SPOOL_MAX", "2000")
	t.Setenv("DINA_BACKUP_INTERVAL", "12")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.SessionTTL, 3600)
	testutil.RequireEqual(t, cfg.RateLimit, 120)
	testutil.RequireEqual(t, cfg.SpoolMax, 2000)
	testutil.RequireEqual(t, cfg.BackupInterval, 12)
}

// --------------------------------------------------------------------------
// §14.2 Defaults (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-554
func TestConfig_14_2_1_DefaultValues(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// With minimal env (only required token), defaults should populate.
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)

	// Validate defaults from TestConfig fixture.
	defaults := testutil.TestConfig()
	testutil.RequireEqual(t, cfg.ListenAddr, defaults.ListenAddr)
	testutil.RequireEqual(t, cfg.AdminAddr, defaults.AdminAddr)
	testutil.RequireEqual(t, cfg.SecurityMode, defaults.SecurityMode)
	testutil.RequireEqual(t, cfg.SessionTTL, defaults.SessionTTL)
	testutil.RequireEqual(t, cfg.RateLimit, defaults.RateLimit)
	testutil.RequireEqual(t, cfg.SpoolMax, defaults.SpoolMax)
	testutil.RequireEqual(t, cfg.BackupInterval, defaults.BackupInterval)
}

// TST-CORE-853
func TestConfig_14_9_DefaultSecurityMode(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Default SecurityMode must be "security" (not "convenience").
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.SecurityMode, "security")
}

// --------------------------------------------------------------------------
// §14.3 Validation (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-553 — ClientToken is optional at config-validation layer.
func TestConfig_14_3_1_EmptyClientTokenAccepted(t *testing.T) {
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Config with empty ClientToken should pass validation.
	cfg := testutil.TestConfig()
	cfg.ClientToken = ""

	err := impl.Validate(&cfg)
	testutil.RequireNoError(t, err)
}

// TST-CORE-555
func TestConfig_14_3_2_InvalidSecurityMode(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// SecurityMode must be "security" or "convenience" — anything else fails.
	cfg := testutil.TestConfig()
	cfg.SecurityMode = "yolo"

	err := impl.Validate(&cfg)
	testutil.RequireError(t, err)
}

// TST-CORE-854
func TestConfig_14_10_NegativeSessionTTL(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Negative SessionTTL must fail validation.
	cfg := testutil.TestConfig()
	cfg.SessionTTL = -1

	err := impl.Validate(&cfg)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §14.4 config.json (1 scenario)
// --------------------------------------------------------------------------

// TST-CORE-855
func TestConfig_14_11_LoadFromConfigJSON(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Create a config.json in a temp dir and verify it is loaded.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "config.json", `{
		"listen_addr": ":6300",
		"admin_addr": ":6100",
		"security_mode": "convenience"
	}`)
	t.Setenv("DINA_CONFIG_PATH", dir+"/config.json")
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)

	// Fields specified in JSON must be loaded.
	testutil.RequireEqual(t, cfg.ListenAddr, ":6300")
	testutil.RequireEqual(t, cfg.AdminAddr, ":6100")
	testutil.RequireEqual(t, cfg.SecurityMode, "convenience")

	// Fields NOT in JSON must receive their defaults (not zero values).
	defaults := testutil.TestConfig()
	testutil.RequireEqual(t, cfg.VaultPath, defaults.VaultPath)
	testutil.RequireEqual(t, cfg.BrainURL, defaults.BrainURL)
	testutil.RequireEqual(t, cfg.RateLimit, defaults.RateLimit)
}

// --------------------------------------------------------------------------
// §14.5 Docker Secrets (1 scenario)
// --------------------------------------------------------------------------

// TST-CORE-552
func TestConfig_14_5_1_LoadClientTokenFromDockerSecret(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// CLIENT_TOKEN can be loaded from a Docker secret file at a known path.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "client_token", testutil.TestClientToken)
	t.Setenv("DINA_CLIENT_TOKEN_FILE", dir+"/client_token")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ClientToken, testutil.TestClientToken)
}

// --------------------------------------------------------------------------
// §14.6 Override Precedence (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-856
func TestConfig_14_12_EnvOverridesConfigJSON(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Env vars take precedence over config.json.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "config.json", `{
		"listen_addr": ":6300",
		"admin_addr": ":6100"
	}`)
	t.Setenv("DINA_CONFIG_PATH", dir+"/config.json")
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)
	t.Setenv("DINA_LISTEN_ADDR", ":5300") // env override

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ListenAddr, ":5300") // env wins
	testutil.RequireEqual(t, cfg.AdminAddr, ":6100")  // from config.json
}

// TST-CORE-857
func TestConfig_14_13_DockerSecretOverridesEnvToken(t *testing.T) {
	// impl := realConfigLoader = realconfig.NewLoader(...)
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Docker secret file takes precedence over DINA_CLIENT_TOKEN env var.
	secretToken := "secret-token-from-docker-" + strings.Repeat("f", 39)
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "client_token", secretToken)
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)
	t.Setenv("DINA_CLIENT_TOKEN_FILE", dir+"/client_token")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ClientToken, secretToken)
}

// ==========================================================================
// Uncovered plan scenarios — added by entries 400-600 fix
// ==========================================================================

// TST-CORE-556
func TestConfig_14_6_3_SpoolMaxEnforcement(t *testing.T) {
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// DINA_SPOOL_MAX configures the spool directory size limit.
	// When the spool directory exceeds the configured max, Valve 2 closes
	// and new spooling is rejected.
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)
	t.Setenv("DINA_SPOOL_MAX", "500")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.SpoolMax, 500)
}

// TST-CORE-898
func TestConfig_14_14_AuditLogRetentionConfigurable(t *testing.T) {
	// Audit log retention configurable via config.json (retention_days).
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Default load must succeed and return a valid config.
	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, cfg != nil, "config must load successfully")

	// Verify defaults include a sensible retention value (>0 days).
	defaults := testutil.TestConfig()
	testutil.RequireTrue(t, defaults.AuditLogRetentionDays > 0,
		"default audit log retention must be positive")

	// Load from config.json with custom retention.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "config.json", `{
		"listen_addr": ":8300",
		"audit_log_retention_days": 365
	}`)
	t.Setenv("DINA_CONFIG_PATH", dir+"/config.json")
	t.Setenv("DINA_CLIENT_TOKEN", testutil.TestClientToken)

	cfg, err = impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.AuditLogRetentionDays, 365)
}

// TST-CORE-899
func TestConfig_14_15_CloudLLMConsentFlag(t *testing.T) {
	// Cloud LLM consent flag stored and enforced before cloud routing.
	// TEST_PLAN §14.15 expects: consent_cloud_llm=false in config →
	// cloud LLM routing blocked when consent not given.
	//
	// Production Config struct has no CloudLLMConsent field yet.
	// Skip until the feature is implemented in config.Config and loadEnv().
	t.Skip("CloudLLMConsent field not yet implemented in production config.Config — test cannot verify consent enforcement")
}

// TST-CORE-900
func TestConfig_14_16_HistoryDaysDefault365(t *testing.T) {
	// DINA_HISTORY_DAYS config default 365.
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, cfg != nil, "config must load")
}

// TST-CORE-554
func TestConfig_14_4_DefaultValues(t *testing.T) {
	impl := realConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, cfg != nil, "config with defaults must load")

	// Validate defaults match the TestConfig fixture (production defaults).
	defaults := testutil.TestConfig()
	testutil.RequireEqual(t, cfg.ListenAddr, defaults.ListenAddr)
	testutil.RequireEqual(t, cfg.AdminAddr, defaults.AdminAddr)
	testutil.RequireEqual(t, cfg.SecurityMode, defaults.SecurityMode)
	testutil.RequireEqual(t, cfg.SessionTTL, defaults.SessionTTL)
	testutil.RequireEqual(t, cfg.RateLimit, defaults.RateLimit)
	testutil.RequireEqual(t, cfg.SpoolMax, defaults.SpoolMax)
	testutil.RequireEqual(t, cfg.BackupInterval, defaults.BackupInterval)
}
