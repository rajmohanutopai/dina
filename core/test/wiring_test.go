package test

// wiring_test.go connects real implementations to testutil interfaces.
// This is the contract-first TDD activation layer — replacing nil mocks
// with real implementations causes previously-skipped tests to run.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/rajmohanutopai/dina/core/internal/adapter/adminproxy"
	"github.com/rajmohanutopai/dina/core/internal/adapter/apicontract"
	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/adapter/brainclient"
	dinacrypto "github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	errpkg "github.com/rajmohanutopai/dina/core/internal/adapter/errors"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/adapter/gatekeeper"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/adapter/logging"
	"github.com/rajmohanutopai/dina/core/internal/adapter/observability"
	"github.com/rajmohanutopai/dina/core/internal/adapter/onboarding"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pairing"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pds"
	piipkg "github.com/rajmohanutopai/dina/core/internal/adapter/pii"
	"github.com/rajmohanutopai/dina/core/internal/adapter/bot"
	"github.com/rajmohanutopai/dina/core/internal/adapter/estate"
	dinasync "github.com/rajmohanutopai/dina/core/internal/adapter/sync"
	"github.com/rajmohanutopai/dina/core/internal/adapter/portability"
	"github.com/rajmohanutopai/dina/core/internal/adapter/security"
	"github.com/rajmohanutopai/dina/core/internal/adapter/server"
	"github.com/rajmohanutopai/dina/core/internal/adapter/taskqueue"
	"github.com/rajmohanutopai/dina/core/internal/adapter/transport"
	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
	"github.com/rajmohanutopai/dina/core/internal/adapter/ws"
	"github.com/rajmohanutopai/dina/core/internal/config"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ---------- Crypto implementations (§2) ----------

var (
	realHDKey           port.HDKeyDeriver      = dinacrypto.NewSLIP0010Deriver()
	realVaultDEKDeriver port.VaultDEKDeriver   = dinacrypto.NewHKDFKeyDeriver()
	realKEKDeriver      port.KEKDeriver        = dinacrypto.NewArgon2Deriver()
	realSigner          port.Signer            = dinacrypto.NewEd25519Signer()
	realConverter       port.KeyConverter      = dinacrypto.NewKeyConverter()
	realEncryptor       port.Encryptor         = dinacrypto.NewNaClBoxSealer()
	realKeyWrapper      port.KeyWrapper        = dinacrypto.NewAESGCMKeyWrapper()
)

// ---------- PII implementations (§5) ----------

var realPIIScrubber = piipkg.NewScrubber()                      // concrete type — tests also call AddPattern
var realDeSanitizer port.PIIDeSanitizer = piipkg.NewDeSanitizer() // port interface

// ---------- Config adapter (§14) ----------

type configLoaderAdapter struct {
	inner *config.Loader
}

func (a *configLoaderAdapter) Load() (*testutil.Config, error) {
	cfg, err := a.inner.Load()
	if err != nil {
		return nil, err
	}
	return &testutil.Config{
		ListenAddr:       cfg.ListenAddr,
		AdminAddr:        cfg.AdminAddr,
		VaultPath:        cfg.VaultPath,
		BrainURL:         cfg.BrainURL,
		ClientToken:      cfg.ClientToken,
		SecurityMode:     cfg.SecurityMode,
		SessionTTL:       cfg.SessionTTL,
		RateLimit:        cfg.RateLimit,
		SpoolMax:         cfg.SpoolMax,
		BackupInterval:   cfg.BackupInterval,
		PDSURL:           cfg.PDSURL,
		PLCURL:           cfg.PLCURL,
		PDSAdminPassword: cfg.PDSAdminPassword,
		PDSHandle:        cfg.PDSHandle,
		AdminSocketPath:  cfg.AdminSocketPath,
	}, nil
}

func (a *configLoaderAdapter) Validate(cfg *testutil.Config) error {
	return a.inner.Validate(&config.Config{
		ListenAddr:     cfg.ListenAddr,
		AdminAddr:      cfg.AdminAddr,
		VaultPath:      cfg.VaultPath,
		BrainURL:       cfg.BrainURL,
		ClientToken:    cfg.ClientToken,
		SecurityMode:   cfg.SecurityMode,
		SessionTTL:     cfg.SessionTTL,
		RateLimit:      cfg.RateLimit,
		SpoolMax:       cfg.SpoolMax,
		BackupInterval: cfg.BackupInterval,
	})
}

var realConfigLoader testutil.ConfigLoader = &configLoaderAdapter{inner: config.NewLoader()}

// ---------- Auth implementations (§1) ----------

var (
	realTokenValidator port.TokenValidator      = auth.NewDefaultTokenValidator()
	realSessionManager port.SessionManager      = auth.NewSessionManager(3600)
	realRateLimiter    port.RateLimiter          = auth.NewRateLimiter(5, 60)
)

var realPassphraseVerifier port.PassphraseVerifier
var realAuthGateway testutil.AuthGateway
var realAdminEndpointChecker testutil.AdminEndpointChecker = auth.NewAdminEndpointChecker()

func init() {
	hash, _ := auth.HashPassphrase(testutil.TestPassphrase, testutil.TestUserSalt[:16])
	testutil.TestPassphraseHash = hash
	pv := auth.NewPassphraseVerifier(hash)
	realPassphraseVerifier = pv
	sm := auth.NewSessionManager(86400)
	tv := auth.NewDefaultTokenValidator()
	realAuthGateway = auth.NewAuthGateway(pv, sm, tv)
}

// ---------- Identity implementations (§3) ----------

var (
	realDIDManager        port.DIDManager        = identity.NewDIDManager("")
	realPersonaManager    port.PersonaManager     = identity.NewPersonaManager()
	realContactDirectory  port.ContactDirectory   = identity.NewContactDirectory()
	realDeviceRegistry    port.DeviceRegistry     = identity.NewDeviceRegistry()
	realRecoveryManager   port.RecoveryManager    = identity.NewRecoveryManager()
)

// ---------- Vault implementations (§4) ----------

var vaultDir string
var vaultMgr *vault.Manager

func init() {
	vaultDir, _ = os.MkdirTemp("", "dina-vault-test-")
	vaultMgr = vault.NewManager(vaultDir)
	// Open the identity vault so the dynamic HealthChecker reports healthy.
	_ = vaultMgr.Open(context.Background(), "identity", testutil.TestDEK[:])
	// Open the personal vault for backup and other tests that reference it.
	_ = vaultMgr.Open(context.Background(), "general", testutil.TestDEK[:])
}

var (
	realVaultManager      *vault.Manager                     // concrete — satisfies port.VaultManager + port.VaultReader + port.VaultWriter
	realScratchpadManager port.ScratchpadManager             = vault.NewScratchpadManager()
	realSchemaInspector   testutil.SchemaInspector           = vault.NewSchemaInspector() // testutil is superset of port
	realEmbeddingMigrator testutil.EmbeddingMigrator         = vault.NewEmbeddingMigrator()
	realVaultAuditLogger  *vault.AuditLogger                 = vault.NewAuditLogger() // concrete — satisfies port.VaultAuditLogger + PurgeCrashLog
)

var (
	realStagingManager  port.StagingManager
	realBackupManager   testutil.BackupManager
	realMigrationSafety testutil.MigrationSafety
	realBootSequencer   testutil.BootSequencer
)

func init() {
	realVaultManager = vaultMgr
	realStagingManager = vault.NewStagingManager(vaultMgr)
	realBackupManager = vault.NewBackupManager(vaultMgr)
	migDir, _ := os.MkdirTemp("", "dina-migration-test-")
	realMigrationSafety = vault.NewMigrationSafety(migDir)
	realBootSequencer = vault.NewBootSequencer(vaultMgr)
}

// ---------- Gatekeeper implementations (§6) ----------

var (
	realGatekeeper            port.Gatekeeper                = gatekeeper.New()
	realSharingPolicyManager  testutil.SharingPolicyManager  = gatekeeper.NewSharingPolicyManager() // testutil superset (has SetBulkPolicy)
)

// ---------- Transport implementations (§7) ----------

var didResolver = transport.NewTestDIDResolver()

var (
	realTransporter   testutil.Transporter   = transport.NewTransporter(didResolver)
	realOutboxManager testutil.OutboxManager = transport.NewOutboxManager(100)
	realInboxManager  testutil.InboxManager = transport.NewInboxManager(transport.DefaultInboxConfig()) // testutil superset (has CheckDIDRate)
	realDIDResolver   testutil.DIDResolver   = didResolver
)

// ---------- Task Queue implementations (§8) ----------

var taskQ = taskqueue.NewTaskQueue()

var (
	realTaskQueuer         port.TaskQueue              = taskQ
	realWatchdogRunner     port.WatchdogRunner         = taskqueue.NewWatchdog(taskQ)
	realReminderScheduler  port.ReminderScheduler      = taskqueue.NewReminderScheduler()
)

// ---------- WebSocket implementations (§9) ----------

var (
	realWSHub            port.WSHub                = ws.NewWSHub()
	realWSHandler        testutil.WSHandler        = ws.NewWSHandler( // testutil superset (has IsAuthenticated)
		func(token string) (string, error) {
			// Reject known-bad tokens; accept any other non-empty token.
			if token == "" || token == "wrong_token_value" || token == "revoked_client_token_hex" {
				return "", errors.New("invalid or revoked CLIENT_TOKEN")
			}
			return "test-device", nil
		},
		nil,
	)
	realHeartbeatManager testutil.HeartbeatManager = ws.NewHeartbeatManager(nil) // testutil superset (has ResetPongCounter)
	realMessageBuffer    testutil.MessageBuffer    = ws.NewMessageBuffer()     // testutil superset (has AckMessage, IsExpired)
)

// ---------- Pairing implementations (§10) ----------

var realPairingManager testutil.PairingManager = pairing.NewManager(pairing.DefaultConfig()) // testutil superset (PairingManager extends DevicePairer)

// ---------- Brain Client implementations (§11) ----------

// mockHealthCalls tracks health endpoint calls for stateful testing.
// First call returns 200 (test 11_2_1), subsequent calls return 503 (test 11_2_2).
var mockHealthCalls int32

// mockBrainServer simulates the brain sidecar for testing.
var mockBrainServer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/v1/process":
		var event map[string]interface{}
		if json.NewDecoder(r.Body).Decode(&event) == nil {
			switch event["type"] {
			case "slow_event":
				w.WriteHeader(http.StatusGatewayTimeout)
				return
			case "test_event", "test":
				// Simulate brain error for circuit breaker tests.
				w.WriteHeader(http.StatusInternalServerError)
				return
			case "trigger_malformed_response":
				// Simulate brain returning garbage.
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`not-valid-json{{{`))
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok","action":"none"}`))
	case "/api/v1/reason":
		var body map[string]interface{}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["prompt"] == nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":"mock reasoning result","model":"test","tokens_in":10,"tokens_out":20}`))
	case "/healthz":
		n := atomic.AddInt32(&mockHealthCalls, 1)
		if n > 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}))

var realBrainClient testutil.BrainClient = brainclient.New(mockBrainServer.URL, nil)

// ---------- Server implementations (§15) ----------

var (
	realServer        testutil.Server        = server.NewServer()
	realHealthChecker port.HealthChecker     = server.NewDynamicHealthChecker(func() bool {
		// Vault is healthy when the identity database is open.
		return vaultMgr.IsOpen("identity")
	})
	realVaultAPI        testutil.VaultAPI        = server.NewVaultAPI()
	realIdentityAPI     testutil.IdentityAPI     = server.NewIdentityAPI()
	realMessagingAPI    testutil.MessagingAPI    = server.NewMessagingAPI()
	realPairingAPI      testutil.PairingAPI      = server.NewPairingAPI()
	realATProtoDiscovery testutil.ATProtoDiscovery = server.NewATProtoDiscovery("did:plc:root123")
)

// Factory for HealthChecker with configurable vault health.
func newHealthChecker(vaultHealthy bool) port.HealthChecker {
	return server.NewHealthChecker(vaultHealthy)
}

// ---------- Rate Limit Checker (§13) ----------

var realRateLimitChecker testutil.RateLimitChecker = auth.NewRateLimitChecker(60, 60)

// ---------- Logging implementations (§21) ----------

var realLogAuditor testutil.LogAuditor = logging.NewLogAuditor()

// ---------- Observability implementations (§20) ----------

var (
	realCrashLogger         port.CrashLogger              = observability.NewCrashLogger()
	realSystemWatchdog      testutil.SystemWatchdog       = observability.NewSystemWatchdogWithPurge(true, true, 1000000, realCrashLogger, realVaultAuditLogger)
	realDockerComposeParser testutil.DockerComposeParser  = observability.NewDockerComposeParser()
)

// ---------- Security implementations (§17) ----------

var realSecurityAuditor testutil.SecurityAuditor = security.NewSecurityAuditor("", nil)

// ---------- Onboarding implementations (§19) ----------

var realOnboardingSequence testutil.OnboardingSequence = onboarding.NewOnboardingSequence() // testutil superset (has GetRootDID, GetPersonas, etc.)

// ---------- Error handling implementations (§16) ----------

var realErrorHandler testutil.ErrorHandler = errpkg.NewErrorHandler(0)

// ---------- Admin Proxy implementations (§12) ----------

var realAdminProxy testutil.AdminProxy = adminproxy.NewAdminProxy("http://brain:8200", testutil.TestClientToken)

// ---------- PDS implementations (§22) ----------

var realPDSPublisher testutil.PDSPublisher = pds.NewPDSPublisher("did:plc:author") // testutil superset (port uses ctx on some methods)

// ---------- Portability implementations (§23) ----------

var (
	realExportManager testutil.ExportManager
	realImportManager testutil.ImportManager
)

func init() {
	// The test vault manager (vault.NewManager) creates .dek/.json files but not
	// .sqlite files. The ExportManager expects identity.sqlite (and any persona
	// .sqlite files) to exist on disk, so we create minimal stubs here.
	for _, name := range []string{"identity.sqlite", "general.sqlite"} {
		p := filepath.Join(vaultDir, name)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			_ = os.WriteFile(p, []byte("stub-vault-for-export-test"), 0600)
		}
	}
	realExportManager = portability.NewExportManager(vaultDir)
	realImportManager = portability.NewImportManager(vaultDir, false)
}

// ---------- Bot Interface implementations (§25) ----------

var realBotQueryHandler testutil.BotQueryHandler = bot.NewQueryHandler()

// ---------- Client Sync implementations (§26) ----------

var realClientSyncManager testutil.ClientSyncManager = dinasync.NewClientSyncManager()

// ---------- Digital Estate implementations (§27) ----------

var realEstateManager testutil.EstateManager = estate.NewEstateManager()

// ---------- API Contract implementations (§18) ----------

var realAPIContract testutil.APIContract = apicontract.NewAPIContract(testutil.TestBrainToken)
