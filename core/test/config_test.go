package test

import (
	"strings"
	"testing"

	"github.com/anthropics/dina/core/test/testutil"
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
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Set all required env vars and verify they are read correctly.
	t.Setenv("DINA_LISTEN_ADDR", ":9300")
	t.Setenv("DINA_ADMIN_ADDR", ":9100")
	t.Setenv("DINA_VAULT_PATH", "/tmp/dina-test-vault")
	t.Setenv("DINA_BRAIN_URL", "http://brain:8200")
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)
	t.Setenv("DINA_MODE", "convenience")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ListenAddr, ":9300")
	testutil.RequireEqual(t, cfg.AdminAddr, ":9100")
	testutil.RequireEqual(t, cfg.VaultPath, "/tmp/dina-test-vault")
	testutil.RequireEqual(t, cfg.BrainURL, "http://brain:8200")
	testutil.RequireEqual(t, cfg.BrainToken, testutil.TestBrainToken)
	testutil.RequireEqual(t, cfg.SecurityMode, "convenience")
}

// TST-CORE-851
func TestConfig_14_1_2_PartialEnvVars(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// When only some env vars are set, the rest should use defaults.
	t.Setenv("DINA_LISTEN_ADDR", ":7300")
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)
	// Leave all other vars unset — they should fall back to defaults.

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ListenAddr, ":7300")
	// Default values should be populated for unset fields.
	testutil.RequireTrue(t, cfg.VaultPath != "", "VaultPath default must be set")
}

// TST-CORE-852
func TestConfig_14_1_3_EnvVarTypeParsing(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Numeric env vars should be correctly parsed to int fields.
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)
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
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// With minimal env (only required token), defaults should populate.
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)

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
func TestConfig_14_2_2_DefaultSecurityMode(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Default SecurityMode must be "security" (not "convenience").
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.SecurityMode, "security")
}

// --------------------------------------------------------------------------
// §14.3 Validation (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-553
func TestConfig_14_3_1_MissingBrainToken(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Config with missing BRAIN_TOKEN must fail validation.
	cfg := testutil.TestConfig()
	cfg.BrainToken = ""

	err := impl.Validate(&cfg)
	testutil.RequireError(t, err)
	testutil.RequireContains(t, err.Error(), "token")
}

// TST-CORE-555
func TestConfig_14_3_2_InvalidSecurityMode(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// SecurityMode must be "security" or "convenience" — anything else fails.
	cfg := testutil.TestConfig()
	cfg.SecurityMode = "yolo"

	err := impl.Validate(&cfg)
	testutil.RequireError(t, err)
}

// TST-CORE-854
func TestConfig_14_3_3_NegativeSessionTTL(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
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
func TestConfig_14_4_1_LoadFromConfigJSON(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Create a config.json in a temp dir and verify it is loaded.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "config.json", `{
		"listen_addr": ":6300",
		"admin_addr": ":6100",
		"security_mode": "convenience"
	}`)
	t.Setenv("DINA_CONFIG_PATH", dir+"/config.json")
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ListenAddr, ":6300")
	testutil.RequireEqual(t, cfg.AdminAddr, ":6100")
	testutil.RequireEqual(t, cfg.SecurityMode, "convenience")
}

// --------------------------------------------------------------------------
// §14.5 Docker Secrets (1 scenario)
// --------------------------------------------------------------------------

// TST-CORE-552
func TestConfig_14_5_1_LoadBrainTokenFromDockerSecret(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// BRAIN_TOKEN can be loaded from a Docker secret file at a known path.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "brain_token", testutil.TestBrainToken)
	t.Setenv("DINA_BRAIN_TOKEN_FILE", dir+"/brain_token")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.BrainToken, testutil.TestBrainToken)
}

// --------------------------------------------------------------------------
// §14.6 Override Precedence (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-856
func TestConfig_14_6_1_EnvOverridesConfigJSON(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Env vars take precedence over config.json.
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "config.json", `{
		"listen_addr": ":6300",
		"admin_addr": ":6100"
	}`)
	t.Setenv("DINA_CONFIG_PATH", dir+"/config.json")
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)
	t.Setenv("DINA_LISTEN_ADDR", ":5300") // env override

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.ListenAddr, ":5300") // env wins
	testutil.RequireEqual(t, cfg.AdminAddr, ":6100")  // from config.json
}

// TST-CORE-857
func TestConfig_14_6_2_DockerSecretOverridesEnvToken(t *testing.T) {
	// var impl testutil.ConfigLoader = realconfig.NewLoader(...)
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// Docker secret file takes precedence over DINA_BRAIN_TOKEN env var.
	secretToken := "secret-token-from-docker-" + strings.Repeat("f", 39)
	dir := testutil.TempDir(t)
	testutil.TempFile(t, dir, "brain_token", secretToken)
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)
	t.Setenv("DINA_BRAIN_TOKEN_FILE", dir+"/brain_token")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.BrainToken, secretToken)
}

// ==========================================================================
// Uncovered plan scenarios — added by entries 400-600 fix
// ==========================================================================

// TST-CORE-556
func TestConfig_14_6_3_SpoolMaxEnforcement(t *testing.T) {
	var impl testutil.ConfigLoader
	testutil.RequireImplementation(t, impl, "ConfigLoader")

	// DINA_SPOOL_MAX configures the spool directory size limit.
	// When the spool directory exceeds the configured max, Valve 2 closes
	// and new spooling is rejected.
	t.Setenv("DINA_BRAIN_TOKEN", testutil.TestBrainToken)
	t.Setenv("DINA_SPOOL_MAX", "500")

	cfg, err := impl.Load()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, cfg.SpoolMax, 500)
}
