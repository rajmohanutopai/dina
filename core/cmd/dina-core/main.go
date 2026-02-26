// Package main is the composition root for dina-core.
// It constructs all dependencies, wires them together,
// and starts the HTTP server. No business logic lives here.
package main

import (
	"context"
	"crypto/ed25519"
	crypto_rand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/internal/adapter/brainclient"
	"github.com/rajmohanutopai/dina/core/internal/adapter/clock"
	"github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/internal/adapter/estate"
	"github.com/rajmohanutopai/dina/core/internal/adapter/gatekeeper"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/adapter/observability"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pairing"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pds"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pii"
	"github.com/rajmohanutopai/dina/core/internal/adapter/portability"
	"github.com/rajmohanutopai/dina/core/internal/adapter/server"
	"github.com/rajmohanutopai/dina/core/internal/adapter/taskqueue"
	"github.com/rajmohanutopai/dina/core/internal/adapter/transport"
	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
	"github.com/rajmohanutopai/dina/core/internal/adapter/ws"
	"github.com/rajmohanutopai/dina/core/internal/config"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/internal/ingress"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
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

	// ---------- Security guards ----------

	// HIGH-02: DINA_ALLOW_UNSIGNED_D2D must only be enabled in non-production environments.
	if os.Getenv("DINA_ALLOW_UNSIGNED_D2D") == "1" {
		env := os.Getenv("DINA_ENV")
		if env != "test" && env != "migration" && env != "development" {
			log.Fatal("SECURITY: DINA_ALLOW_UNSIGNED_D2D=1 is only allowed when DINA_ENV is test, migration, or development")
		}
		slog.Warn("SECURITY: unsigned D2D message acceptance is enabled", "env", env)
	}

	// HIGH-03: DINA_TEST_MODE must not be enabled in production.
	if os.Getenv("DINA_TEST_MODE") == "true" {
		env := os.Getenv("DINA_ENV")
		if env == "" || env == "production" {
			log.Fatal("SECURITY: DINA_TEST_MODE=true is not allowed in production (set DINA_ENV=test)")
		}
		slog.Warn("SECURITY: test mode enabled — destructive endpoints active", "env", env)
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
	// Priority: 1) DINA_IDENTITY_SEED env var, 2) persisted seed file, 3) generate new random seed.
	bootstrapSeed := make([]byte, 32)
	seedPath := filepath.Join(cfg.VaultPath, "identity_seed.hex")
	if seedHex := os.Getenv("DINA_IDENTITY_SEED"); seedHex != "" {
		decoded, err := hex.DecodeString(seedHex)
		if err != nil {
			slog.Error("Invalid DINA_IDENTITY_SEED hex", "error", err)
			os.Exit(1)
		}
		if len(decoded) != 32 {
			slog.Error("DINA_IDENTITY_SEED must be exactly 32 bytes (64 hex chars)", "got_bytes", len(decoded))
			os.Exit(1)
		}
		copy(bootstrapSeed, decoded)
	} else if data, err := os.ReadFile(seedPath); err == nil {
		decoded, err := hex.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(decoded) != 32 {
			slog.Error("Corrupt identity seed file — refusing to start", "path", seedPath, "error", err)
			os.Exit(1)
		}
		copy(bootstrapSeed, decoded)
		slog.Info("Loaded identity seed from file", "path", seedPath)
	} else {
		if _, err := crypto_rand.Read(bootstrapSeed); err != nil {
			slog.Error("Failed to generate random seed", "error", err)
			os.Exit(1)
		}
		os.MkdirAll(filepath.Dir(seedPath), 0700)
		if err := os.WriteFile(seedPath, []byte(hex.EncodeToString(bootstrapSeed)), 0600); err != nil {
			slog.Warn("Could not persist identity seed", "error", err)
		} else {
			slog.Warn("Generated new identity seed — set DINA_IDENTITY_SEED for explicit control", "path", seedPath)
		}
	}
	// Verify seed is not all zeros.
	allZero := true
	for _, b := range bootstrapSeed {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		slog.Error("Identity seed is all zeros — refusing to start")
		os.Exit(1)
	}
	_, signingKeyBytes, _ := slip0010.DerivePath(bootstrapSeed, "m/9999'/0'")
	var signingPrivKey ed25519.PrivateKey
	if len(signingKeyBytes) == ed25519.SeedSize {
		signingPrivKey = ed25519.NewKeyFromSeed(signingKeyBytes)
	} else {
		signingPrivKey = ed25519.PrivateKey(signingKeyBytes)
	}
	identitySigner := crypto.NewIdentitySigner(signingPrivKey)

	// 3. Vault — build-tag factory selects SQLCipher (CGO) or in-memory (no CGO)
	vaultMgr := newVaultBackend(cfg.VaultPath)
	backupMgr := newBackupMgr(vaultMgr)
	auditLogger := vault.NewAuditLogger()

	// 4. PII
	scrubber := pii.NewScrubber()

	// 5. Identity
	didMgr := identity.NewDIDManager(cfg.VaultPath)
	personaMgr := identity.NewPersonaManager()
	personaMgr.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return auth.NewPassphraseVerifier(storedHash).Verify(passphrase)
	}
	contactDir := identity.NewContactDirectory()
	deviceRegistry := identity.NewDeviceRegistry()
	recoveryMgr := identity.NewRecoveryManager()

	// 5b. K256 rotation key + PLC/PDS (optional — enabled when DINA_PDS_URL is set)
	k256Mgr := crypto.NewK256KeyManager(cfg.VaultPath)
	var plcClient *pds.PLCClient
	var pdsPublisher port.PDSPublisher
	if cfg.PDSURL != "" {
		plcURL := cfg.PLCURL
		if plcURL == "" {
			plcURL = "https://plc.directory"
		}
		plcClient = pds.NewPLCClient(cfg.PDSURL, plcURL)
		if cfg.PDSAdminPassword != "" {
			plcClient.SetAdminToken(cfg.PDSAdminPassword)
		}
		didMgr.SetPLCClient(plcClient, k256Mgr)
		didMgr.SetPDSCredentials(cfg.PDSHandle, cfg.PDSAdminPassword, cfg.PDSEmail)
		slog.Info("AT Protocol PDS configured", "pds_url", cfg.PDSURL, "plc_url", plcURL)
	} else {
		pdsPublisher = pds.NewPDSPublisher("")
		slog.Info("AT Protocol PDS not configured — using local-only identity")
	}
	_, _ = plcClient, pdsPublisher

	// 6. Auth
	tokenValidator := auth.NewTokenValidator(cfg.BrainToken, map[string]string{})
	if cfg.ClientToken != "" {
		tokenValidator.RegisterClientToken(cfg.ClientToken, "bootstrap")
		slog.Info("Pre-registered client token from DINA_CLIENT_TOKEN")
	}
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
	transportSvc.SetVerifier(signer)
	transportSvc.SetRecipientKeys(
		signingPrivKey.Public().(ed25519.PublicKey),
		[]byte(signingPrivKey),
	)
	if cfg.OwnDID != "" {
		transportSvc.SetSenderDID(cfg.OwnDID)
		slog.Info("D2D sender DID configured", "did", cfg.OwnDID)
	}

	// Ingress: dead-drop + rate limiter + sweeper + router (§7 3-valve pipeline)
	deadDropDir := filepath.Join(cfg.VaultPath, "deaddrop")
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, 500*1024*1024)
	ingressLimiter := ingress.NewRateLimiter(50, time.Minute, 10000, 500*1024*1024, deadDrop)
	ingressSweeper := ingress.NewSweeper(deadDrop, nacl, didResolverPort, clk, 24*time.Hour)
	ingressSweeper.SetKeys(
		signingPrivKey.Public().(ed25519.PublicKey),
		[]byte(signingPrivKey),
	)
	ingressSweeper.SetConverter(converter)
	ingressSweeper.SetOnMessage(func(msg *domain.DinaMessage) {
		transportSvc.StoreInbound(msg)
	})
	ingressRouter := ingress.NewRouter(vaultMgr, inboxMgr, deadDrop, ingressSweeper, ingressLimiter)
	ingressRouter.SetOnEnvelope(func(ctx context.Context, envelope []byte) {
		msg, err := transportSvc.ProcessInbound(ctx, envelope)
		if err != nil {
			slog.Warn("ingress: fast-path decrypt failed", "error", err)
			return
		}
		transportSvc.StoreInbound(msg)
		slog.Info("ingress: fast-path message decrypted and stored", "type", msg.Type)
	})

	// Background sweep: periodically drain dead-drop and spool after vault unlock.
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if n, err := ingressRouter.ProcessPending(context.Background()); err != nil {
				slog.Warn("ingress ProcessPending error", "error", err)
			} else if n > 0 {
				slog.Info("ingress ProcessPending processed messages", "count", n)
			}
		}
	}()

	taskSvc := service.NewTaskService(taskQueue, watchdog, brain, clk)

	deviceSvc := service.NewDeviceService(pairer, deviceRegistry, clk)
	deviceSvc.SetKeyRegistrar(tokenValidator)
	deviceSvc.SetTokenRegistrar(tokenValidator)

	_ = service.NewGatekeeperService(
		vaultMgr, vaultMgr, gk, auditLogger, notifier, clk,
	)

	estateSvc := service.NewEstateService(
		estateMgr, vaultMgr, recoveryMgr, notifier, clk,
	)

	// CRIT-02: MigrationService kept for future use but not wired to handler
	// until export/import is fully implemented with path validation.
	_ = service.NewMigrationService(
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

	// ---------- Construct handlers ----------

	// MED-09: Use a separate internal token for brain proxy communication.
	internalToken := os.Getenv("DINA_INTERNAL_TOKEN")
	if internalToken == "" {
		slog.Warn("SECURITY: DINA_INTERNAL_TOKEN not set — falling back to client token for brain proxy")
	}

	healthH := &handler.HealthHandler{Health: healthChecker}
	adminH := &handler.AdminHandler{ProxyURL: cfg.BrainURL, Token: cfg.ClientToken, InternalToken: internalToken}
	vaultH := &handler.VaultHandler{Vault: vaultSvc, PII: scrubber}
	identityH := &handler.IdentityHandler{Identity: identitySvc, DID: didMgr, Signer: identitySigner, Mnemonic: bip39, IdentitySeed: bootstrapSeed}
	messageH := &handler.MessageHandler{Transport: transportSvc, IngressRouter: ingressRouter}
	taskH := &handler.TaskHandler{Task: taskSvc}
	deviceH := &handler.DeviceHandler{Device: deviceSvc}

	personaH := &handler.PersonaHandler{Identity: identitySvc, Personas: personaMgr, VaultManager: vaultMgr, KeyDeriver: keyDeriver, Seed: bootstrapSeed}
	contactH := &handler.ContactHandler{Contacts: contactDir, Sharing: sharingMgr}
	piiH := &handler.PIIHandler{Scrubber: scrubber}
	notifyH := &handler.NotifyHandler{Notifier: notifier}
	exportH := &handler.ExportHandler{}
	wellknownH := &handler.WellKnownHandler{DID: didMgr, Signer: identitySigner}

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
	mux.HandleFunc("/v1/contacts/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/policy") {
			// /v1/contacts/{did}/policy → policy handlers
			routeByMethod(contactH.HandleGetPolicy, contactH.HandleSetPolicy)(w, r)
		} else {
			// /v1/contacts/{did} → update/delete handlers
			switch r.Method {
			case http.MethodPut:
				contactH.HandleUpdateContact(w, r)
			case http.MethodDelete:
				contactH.HandleDeleteContact(w, r)
			default:
				http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			}
		}
	})

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
	authzMW := middleware.NewAuthzMiddleware(auth.NewAdminEndpointChecker())
	rateLimitMW := &middleware.RateLimit{Limiter: rateLimiter}
	recovery := &middleware.Recovery{}
	logging := &middleware.Logging{}
	timeout := &middleware.Timeout{Duration: 30 * time.Second}
	cors := &middleware.CORS{AllowOrigin: "*"}

	// Chain: CORS → Recovery → Logging → RateLimit → Auth → Authz → Timeout → Router
	var chain http.Handler = mux
	chain = timeout.Handler(chain)
	chain = authzMW(chain)
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
		Addr:           addr,
		Handler:        chain,
		ReadTimeout:    10 * time.Second,
		WriteTimeout:   35 * time.Second,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 1 << 20,
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
