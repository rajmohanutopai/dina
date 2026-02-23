// Package main is the composition root for dina-core.
// It constructs all dependencies, wires them together,
// and starts the HTTP server. No business logic lives here.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/anthropics/dina/core/internal/adapter/auth"
	"github.com/anthropics/dina/core/internal/adapter/brainclient"
	"github.com/anthropics/dina/core/internal/adapter/clock"
	"github.com/anthropics/dina/core/internal/adapter/crypto"
	"github.com/anthropics/dina/core/internal/adapter/estate"
	"github.com/anthropics/dina/core/internal/adapter/gatekeeper"
	"github.com/anthropics/dina/core/internal/adapter/identity"
	"github.com/anthropics/dina/core/internal/adapter/observability"
	"github.com/anthropics/dina/core/internal/adapter/pairing"
	"github.com/anthropics/dina/core/internal/adapter/pii"
	"github.com/anthropics/dina/core/internal/adapter/portability"
	"github.com/anthropics/dina/core/internal/adapter/server"
	"github.com/anthropics/dina/core/internal/adapter/taskqueue"
	"github.com/anthropics/dina/core/internal/adapter/transport"
	"github.com/anthropics/dina/core/internal/adapter/vault"
	"github.com/anthropics/dina/core/internal/adapter/ws"
	"github.com/anthropics/dina/core/internal/config"
	"github.com/anthropics/dina/core/internal/handler"
	"github.com/anthropics/dina/core/internal/middleware"
	"github.com/anthropics/dina/core/internal/service"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// ---------- Load configuration ----------

	cfgLoader := config.NewLoader()
	cfg, err := cfgLoader.Load()
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// ---------- Construct adapters (bottom-up) ----------

	// 1. Clock
	clk := clock.NewRealClock()

	// 2. Crypto primitives
	bip39 := crypto.NewBIP39Generator()
	slip0010 := crypto.NewSLIP0010Deriver()
	hkdfDeriver := crypto.NewHKDFKeyDeriver()
	argon2Deriver := crypto.NewArgon2Deriver()
	signer := crypto.NewEd25519Signer()
	converter := crypto.NewKeyConverter()
	nacl := crypto.NewNaClBoxSealer()
	keyWrapper := crypto.NewAESGCMKeyWrapper()
	keyDeriver := crypto.NewKeyDeriver(slip0010)

	// Bootstrap identity signing key from a deterministic seed.
	// In production, this would come from the unlocked vault's master seed.
	// For now, derive from SLIP-0010 path m/9999'/0' with a zero seed.
	bootstrapSeed := make([]byte, 32)
	if seedHex := os.Getenv("DINA_IDENTITY_SEED"); seedHex != "" {
		if decoded, err := hex.DecodeString(seedHex); err == nil && len(decoded) == 32 {
			copy(bootstrapSeed, decoded)
		}
	}
	_, signingKeyBytes, _ := slip0010.DerivePath(bootstrapSeed, "m/9999'/0'")
	var signingPrivKey ed25519.PrivateKey
	if len(signingKeyBytes) == ed25519.SeedSize {
		signingPrivKey = ed25519.NewKeyFromSeed(signingKeyBytes)
	} else {
		signingPrivKey = ed25519.PrivateKey(signingKeyBytes)
	}
	identitySigner := crypto.NewIdentitySigner(signingPrivKey)

	// 3. Vault
	vaultMgr := vault.NewManager(cfg.VaultPath)
	backupMgr := vault.NewBackupManager(vaultMgr)
	auditLogger := vault.NewAuditLogger()

	// 4. PII
	scrubber := pii.NewScrubber()

	// 5. Identity
	didMgr := identity.NewDIDManager(cfg.VaultPath)
	personaMgr := identity.NewPersonaManager()
	contactDir := identity.NewContactDirectory()
	deviceRegistry := identity.NewDeviceRegistry()
	recoveryMgr := identity.NewRecoveryManager()

	// 6. Auth
	tokenValidator := auth.NewDefaultTokenValidator(cfg.BrainToken)
	rateLimiter := auth.NewRateLimiter(cfg.RateLimit, 60)

	// 7. Gatekeeper
	gk := gatekeeper.New()
	sharingMgr := gatekeeper.NewSharingPolicyManager()

	// 8. Transport
	didResolver := transport.NewDIDResolver()
	// KNOWN_PEERS are configured at startup and should not expire during process lifetime.
	didResolver.SetTTL(365 * 24 * time.Hour)

	// Pre-populate DID resolver with known peer endpoints for D2D.
	// Each peer gets a full DID document with a verificationMethod so that
	// TransportService.SendMessage can resolve the key for encryption.
	// Format: did=endpoint=seedhex (3 parts) or did=endpoint (2 parts, legacy).
	if peers := os.Getenv("DINA_KNOWN_PEERS"); peers != "" {
		for _, entry := range strings.Split(peers, ",") {
			parts := strings.SplitN(entry, "=", 3)
			if len(parts) < 2 {
				continue
			}
			did := strings.TrimSpace(parts[0])
			endpoint := strings.TrimSpace(parts[1])

			var pubKeyHex string
			if len(parts) == 3 {
				// Real key exchange: derive peer's Ed25519 public key from their seed.
				peerSeedHex := strings.TrimSpace(parts[2])
				peerSeedBytes, _ := hex.DecodeString(peerSeedHex)
				_, peerKeyBytes, _ := slip0010.DerivePath(peerSeedBytes, "m/9999'/0'")
				var peerPrivKey ed25519.PrivateKey
				if len(peerKeyBytes) == ed25519.SeedSize {
					peerPrivKey = ed25519.NewKeyFromSeed(peerKeyBytes)
				} else {
					peerPrivKey = ed25519.PrivateKey(peerKeyBytes)
				}
				peerPubKey := peerPrivKey.Public().(ed25519.PublicKey)
				pubKeyHex = hex.EncodeToString(peerPubKey)
			} else {
				// Legacy: deterministic placeholder pubkey from the DID.
				peerSeed := sha256.Sum256([]byte(did))
				pubKeyHex = hex.EncodeToString(peerSeed[:])
			}

			doc := fmt.Sprintf(`{`+
				`"id":"%s",`+
				`"verificationMethod":[{"id":"%s#key-1","type":"Ed25519VerificationKey2020","controller":"%s","publicKeyMultibase":"z%s"}],`+
				`"service":[{"id":"%s#msg","type":"DinaMessaging","serviceEndpoint":"%s"}]`+
				`}`, did, did, did, pubKeyHex, did, endpoint)
			didResolver.AddDocument(did, []byte(doc))
		}
	}

	didResolverPort := transport.NewDIDResolverPort(didResolver)
	outboxMgr := transport.NewOutboxManager(100)
	inboxMgr := transport.NewInboxManager(transport.DefaultInboxConfig())
	transporter := transport.NewTransporter(didResolver)

	// 9. Task Queue
	taskQueue := taskqueue.NewTaskQueue()
	watchdog := taskqueue.NewWatchdog(taskQueue)
	_ = taskqueue.NewReminderScheduler()

	// 10. WebSocket
	wsHub := ws.NewWSHub()
	notifier := ws.NewNotifier(wsHub)

	// 11. Pairing
	pairer := pairing.NewManager(pairing.DefaultConfig())

	// 12. Brain Client
	brain := brainclient.New(cfg.BrainURL, cfg.BrainToken)

	// 13. Observability
	healthChecker := server.NewDynamicHealthChecker(func() bool {
		return vaultMgr.IsOpen("identity")
	})
	crashLogger := observability.NewCrashLogger()

	// 14. Portability
	exportMgr := portability.NewExportManager()
	importMgr := portability.NewImportManager(false)

	// 15. Estate
	estateMgr := estate.NewPortEstateManager()

	// ---------- Construct services ----------

	identitySvc := service.NewIdentityService(
		bip39, slip0010, keyDeriver, didMgr, personaMgr,
		keyWrapper, argon2Deriver, vaultMgr, clk,
	)

	vaultSvc := service.NewVaultService(
		vaultMgr, vaultMgr, vaultMgr, gk, clk,
	)

	transportSvc := service.NewTransportService(
		nacl, identitySigner, converter, didResolverPort,
		outboxMgr, inboxMgr, clk,
	)
	transportSvc.SetDeliverer(transporter)
	transportSvc.SetRecipientKeys(
		signingPrivKey.Public().(ed25519.PublicKey),
		[]byte(signingPrivKey),
	)

	taskSvc := service.NewTaskService(taskQueue, watchdog, brain, clk)

	deviceSvc := service.NewDeviceService(pairer, deviceRegistry, clk)

	_ = service.NewGatekeeperService(
		vaultMgr, vaultMgr, gk, auditLogger, notifier, clk,
	)

	estateSvc := service.NewEstateService(
		estateMgr, vaultMgr, recoveryMgr, notifier, clk,
	)

	migrationSvc := service.NewMigrationService(
		exportMgr, importMgr, backupMgr, vaultMgr, clk,
	)

	_ = service.NewSyncService(
		vaultMgr, vaultMgr, vaultMgr, wsHub, notifier, clk,
	)

	_ = service.NewWatchdogService(
		healthChecker, brain, crashLogger, auditLogger, clk,
	)

	_ = service.NewOnboardingService(identitySvc, vaultMgr, clk)

	// Suppress unused warnings for adapters/services wired but not yet routed.
	_ = estateSvc
	_ = hkdfDeriver
	_ = signer

	// ---------- Construct handlers ----------

	healthH := &handler.HealthHandler{Health: healthChecker}
	adminH := &handler.AdminHandler{ProxyURL: cfg.BrainURL, Token: cfg.BrainToken}
	vaultH := &handler.VaultHandler{Vault: vaultSvc, PII: scrubber}
	identityH := &handler.IdentityHandler{Identity: identitySvc, DID: didMgr, Signer: identitySigner, Mnemonic: bip39, IdentitySeed: bootstrapSeed}
	messageH := &handler.MessageHandler{Transport: transportSvc}
	taskH := &handler.TaskHandler{Task: taskSvc}
	deviceH := &handler.DeviceHandler{Device: deviceSvc}

	personaH := &handler.PersonaHandler{Identity: identitySvc, Personas: personaMgr, VaultManager: vaultMgr}
	contactH := &handler.ContactHandler{Contacts: contactDir, Sharing: sharingMgr}
	piiH := &handler.PIIHandler{Scrubber: scrubber}
	notifyH := &handler.NotifyHandler{Notifier: notifier}
	exportH := &handler.ExportHandler{Migration: migrationSvc}
	wellknownH := &handler.WellKnownHandler{DID: didMgr}

	// ---------- Build router ----------

	mux := http.NewServeMux()

	// Health probes (public)
	mux.HandleFunc("/healthz", healthH.HandleLiveness)
	mux.HandleFunc("/readyz", healthH.HandleReadiness)

	// AT Protocol discovery
	mux.HandleFunc("/.well-known/atproto-did", wellknownH.HandleATProtoDID)

	// NaCl ingress (authenticated by sealed box)
	mux.HandleFunc("/msg", messageH.HandleIngestNaCl)

	// Vault API
	mux.HandleFunc("/v1/vault/query", vaultH.HandleQuery)
	mux.HandleFunc("/v1/vault/store", vaultH.HandleStore)
	mux.HandleFunc("/v1/vault/store/batch", vaultH.HandleStoreBatch)
	mux.HandleFunc("/v1/vault/item/", routeByMethod(vaultH.HandleGetItem, vaultH.HandleDeleteItem))
	mux.HandleFunc("/v1/vault/kv/", routeByMethod(vaultH.HandleGetKV, vaultH.HandlePutKV))

	// Identity API
	mux.HandleFunc("/v1/did", identityH.HandleGetDID)
	mux.HandleFunc("/v1/did/sign", identityH.HandleSign)
	mux.HandleFunc("/v1/did/verify", identityH.HandleVerify)
	mux.HandleFunc("/v1/did/document", identityH.HandleGetDocument)
	mux.HandleFunc("/v1/identity/mnemonic", identityH.HandleGetMnemonic)

	// Messaging API
	mux.HandleFunc("/v1/msg/send", messageH.HandleSend)
	mux.HandleFunc("/v1/msg/inbox", messageH.HandleInbox)

	// PII API
	mux.HandleFunc("/v1/pii/scrub", piiH.HandleScrub)

	// Task API
	mux.HandleFunc("/v1/task/ack", taskH.HandleAck)

	// Persona API
	mux.HandleFunc("/v1/personas", routeByMethod(personaH.HandleListPersonas, personaH.HandleCreatePersona))
	mux.HandleFunc("/v1/persona/unlock", personaH.HandleUnlockPersona)

	// Contact API
	mux.HandleFunc("/v1/contacts", routeByMethod(contactH.HandleListContacts, contactH.HandleAddContact))
	mux.HandleFunc("/v1/contacts/", routeByMethod(contactH.HandleGetPolicy, contactH.HandleSetPolicy))

	// Device Pairing API
	mux.HandleFunc("/v1/pair/initiate", deviceH.HandleInitiatePairing)
	mux.HandleFunc("/v1/pair/complete", deviceH.HandleCompletePairing)
	mux.HandleFunc("/v1/devices", deviceH.HandleListDevices)
	mux.HandleFunc("/v1/devices/", deviceH.HandleRevokeDevice)

	// Notification API
	mux.HandleFunc("/v1/notify", notifyH.HandleNotify)

	// Admin proxy
	mux.HandleFunc("/admin/sync-status", adminH.HandleSyncStatus)
	mux.HandleFunc("/admin/", adminH.HandleAdmin)

	// Export/Import API
	mux.HandleFunc("/v1/export", exportH.HandleExport)
	mux.HandleFunc("/v1/import", exportH.HandleImport)

	// Test-only: vault clear endpoint (guarded by DINA_TEST_MODE)
	if os.Getenv("DINA_TEST_MODE") == "true" {
		slog.Warn("DINA_TEST_MODE enabled — /v1/vault/clear endpoint is active")
		mux.HandleFunc("/v1/vault/clear", handler.HandleClearVault(vaultMgr))
	}

	// ---------- Apply middleware chain ----------

	authMW := &middleware.Auth{Tokens: tokenValidator}
	rateLimitMW := &middleware.RateLimit{Limiter: rateLimiter}
	recovery := &middleware.Recovery{}
	logging := &middleware.Logging{}
	timeout := &middleware.Timeout{Duration: 30 * time.Second}
	cors := &middleware.CORS{AllowOrigin: "*"}

	// Chain: CORS → Recovery → Logging → RateLimit → Auth → Timeout → Router
	var chain http.Handler = mux
	chain = timeout.Handler(chain)
	chain = authMW.Handler(chain)
	chain = rateLimitMW.Handler(chain)
	chain = logging.Handler(chain)
	chain = recovery.Handler(chain)
	chain = cors.Handler(chain)

	// ---------- Start server ----------

	addr := cfg.ListenAddr
	if addr == "" {
		addr = ":8100"
	}

	srv := &http.Server{
		Addr:         addr,
		Handler:      chain,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 35 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		slog.Info("dina-core starting", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-stop
	slog.Info("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "error", err)
	}

	slog.Info("dina-core stopped")
}

// routeByMethod dispatches GET to getHandler, POST/PUT/DELETE to mutateHandler.
func routeByMethod(getHandler, mutateHandler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			getHandler(w, r)
		case http.MethodPost, http.MethodPut, http.MethodDelete:
			mutateHandler(w, r)
		default:
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}
}
