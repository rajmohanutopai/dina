// Package main is the composition root for dina-core.
// It constructs all dependencies, wires them together,
// and starts the HTTP server. No business logic lives here.
package main

import (
	"context"
	"crypto/ed25519"
	crypto_rand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/mr-tron/base58"
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
	"github.com/rajmohanutopai/dina/core/internal/adapter/servicekey"
	"github.com/rajmohanutopai/dina/core/internal/adapter/taskqueue"
	"github.com/rajmohanutopai/dina/core/internal/adapter/transport"
	trustadapter "github.com/rajmohanutopai/dina/core/internal/adapter/trust"
	"github.com/rajmohanutopai/dina/core/internal/adapter/ws"
	"github.com/rajmohanutopai/dina/core/internal/config"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/internal/ingress"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/reminder"
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

	if err := cfgLoader.Validate(cfg); err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	// ---------- Security guards ----------

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

	// 2. Crypto primitives (BIP-39 mnemonic handled client-side in Python)
	slip0010 := crypto.NewSLIP0010Deriver()
	hkdfDeriver := crypto.NewHKDFKeyDeriver()
	argon2Deriver := crypto.NewArgon2Deriver()
	signer := crypto.NewEd25519Signer()
	converter := crypto.NewKeyConverter()
	nacl := crypto.NewNaClBoxSealer()
	keyWrapper := crypto.NewAESGCMKeyWrapper()
	keyDeriver := crypto.NewKeyDeriver(slip0010)

	// Bootstrap identity signing key from a deterministic seed.
	// Strict no-legacy mode:
	//   1) DINA_MASTER_SEED env var (explicit bootstrap)
	//   2) wrapped seed file (.wrapped + .salt)
	//   3) generate new wrapped seed when password is available
	masterSeed := make([]byte, 32)
	wrappedSeedPath := filepath.Join(cfg.VaultPath, "master_seed.wrapped")
	saltPath := filepath.Join(cfg.VaultPath, "master_seed.salt")
	seedPassword := os.Getenv("DINA_SEED_PASSWORD")
	if seedPassword == "" {
		if path := os.Getenv("DINA_SEED_PASSWORD_FILE"); path != "" {
			data, err := os.ReadFile(path)
			if err != nil {
				slog.Error("Failed to read DINA_SEED_PASSWORD_FILE", "path", path, "error", err)
				os.Exit(1)
			}
			seedPassword = strings.TrimSpace(string(data))
		}
	}

	// Require one explicit bootstrap path: wrapped-seed password or raw master seed.
	// No plaintext seed path is supported.
	dinaEnv := os.Getenv("DINA_ENV")
	isDevOrTest := dinaEnv == "test" || dinaEnv == "development" || dinaEnv == "migration"
	if seedPassword == "" && os.Getenv("DINA_MASTER_SEED") == "" {
		log.Fatal("SECURITY: DINA_SEED_PASSWORD or DINA_MASTER_SEED is required")
	}

	// Derive KEK from seed password if configured.
	var seedKEK []byte
	var argon2Salt []byte
	if seedPassword != "" {
		if data, err := os.ReadFile(saltPath); err == nil {
			if len(data) != 16 {
				slog.Error("Invalid Argon2id salt length", "path", saltPath, "got_bytes", len(data), "expected", 16)
				os.Exit(1)
			}
			argon2Salt = data
		} else if !os.IsNotExist(err) {
			slog.Error("Failed to read Argon2id salt file", "path", saltPath, "error", err)
			os.Exit(1)
		}
		// Wrapped seed without salt is an invalid state in strict mode.
		if len(argon2Salt) == 0 {
			if _, err := os.Stat(wrappedSeedPath); err == nil {
				slog.Error("Wrapped seed exists but salt file is missing", "wrapped", wrappedSeedPath, "salt", saltPath)
				os.Exit(1)
			}
			argon2Salt = make([]byte, 16)
			if _, err := crypto_rand.Read(argon2Salt); err != nil {
				slog.Error("Failed to generate Argon2id salt", "error", err)
				os.Exit(1)
			}
		}
		var kekErr error
		seedKEK, kekErr = argon2Deriver.DeriveKEK(seedPassword, argon2Salt)
		if kekErr != nil {
			slog.Error("Failed to derive Argon2id KEK from seed password", "error", kekErr)
			os.Exit(1)
		}
	}

	// persistWrappedSeed writes wrapped seed + salt when password mode is active.
	persistWrappedSeed := func(seed []byte) {
		if seedKEK == nil {
			return
		}
		rewrapped, err := keyWrapper.Wrap(seed, seedKEK)
		if err != nil {
			slog.Error("Failed to wrap seed with Argon2id KEK", "error", err)
			os.Exit(1)
		}
		os.MkdirAll(filepath.Dir(wrappedSeedPath), 0700)
		if err := os.WriteFile(wrappedSeedPath, rewrapped, 0600); err != nil {
			slog.Error("Could not persist wrapped identity seed", "error", err)
			os.Exit(1)
		}
		if err := os.WriteFile(saltPath, argon2Salt, 0600); err != nil {
			slog.Error("Could not persist Argon2id salt", "error", err)
			os.Exit(1)
		}
	}

	if seedHex := os.Getenv("DINA_MASTER_SEED"); seedHex != "" {
		decoded, err := hex.DecodeString(seedHex)
		if err != nil {
			slog.Error("Invalid DINA_MASTER_SEED hex", "error", err)
			os.Exit(1)
		}
		if len(decoded) != 32 {
			slog.Error("DINA_MASTER_SEED must be exactly 32 bytes (64 hex chars)", "got_bytes", len(decoded))
			os.Exit(1)
		}
		copy(masterSeed, decoded)
		persistWrappedSeed(masterSeed)
	} else if seedKEK != nil {
		if data, err := os.ReadFile(wrappedSeedPath); err == nil {
			unwrapped, err := keyWrapper.Unwrap(data, seedKEK)
			if err != nil {
				slog.Error("Failed to unwrap identity seed — wrong DINA_SEED_PASSWORD?", "error", err)
				os.Exit(1)
			}
			if len(unwrapped) != 32 {
				slog.Error("Unwrapped seed has wrong length", "got_bytes", len(unwrapped))
				os.Exit(1)
			}
			copy(masterSeed, unwrapped)
			slog.Info("Loaded wrapped identity seed", "path", wrappedSeedPath)
		} else if os.IsNotExist(err) {
			if _, err := crypto_rand.Read(masterSeed); err != nil {
				slog.Error("Failed to generate random seed", "error", err)
				os.Exit(1)
			}
			persistWrappedSeed(masterSeed)
			slog.Info("Generated and wrapped new identity seed", "path", wrappedSeedPath)
		} else {
			slog.Error("Failed to read wrapped identity seed", "path", wrappedSeedPath, "error", err)
			os.Exit(1)
		}
	}

	// Verify seed is not all zeros.
	allZero := true
	for _, b := range masterSeed {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		slog.Error("Identity seed is all zeros — refusing to start")
		os.Exit(1)
	}
	// 3. Vault — build-tag factory selects SQLCipher (CGO) or in-memory (no CGO)
	vaultMgr := newVaultBackend(cfg.VaultPath)
	backupMgr := newBackupMgr(vaultMgr)
	auditLogger := newAuditLogger(vaultMgr)

	// 3a. Open identity database (Tier 0: contacts, audit log, kv_store, device_tokens).
	// Persona vaults are opened on unlock; identity is always-open with its own DEK.
	identityPersona, _ := domain.NewPersonaName("identity")
	identityDEK, err := keyDeriver.DerivePersonaDEK(masterSeed, identityPersona)
	if err != nil {
		slog.Error("Failed to derive identity DEK", "error", err)
		os.Exit(1)
	}
	if err := vaultMgr.Open(context.Background(), identityPersona, identityDEK); err != nil {
		slog.Error("Failed to open identity database", "error", err)
		os.Exit(1)
	}
	slog.Info("Identity database opened", "path", cfg.VaultPath)

	// 4. PII
	scrubber := pii.NewScrubber()

	// 5. Identity — consume persisted signing generation if metadata exists,
	//    otherwise default to generation 0. Fail-closed: a corrupt or
	//    unreadable metadata file is fatal — silently falling back to gen-0
	//    would put the node on the wrong signing key path.
	didMgr := identity.NewDIDManager(cfg.VaultPath)
	signingGeneration := uint32(0)
	meta, metaErr := didMgr.LoadDIDMetadata()
	if metaErr != nil {
		slog.Error("Cannot read DID metadata — refusing to start (corrupt file?)", "error", metaErr)
		os.Exit(1)
	}
	if meta != nil && meta.SigningGeneration > 0 {
		signingGeneration = uint32(meta.SigningGeneration)
		slog.Info("Resuming from persisted signing generation",
			"generation", signingGeneration,
			"signing_key_path", meta.SigningKeyPath,
		)
	}
	_, signingKeyBytes, _ := slip0010.DerivePath(masterSeed, identity.RootSigningPath(int(signingGeneration)))
	var signingPrivKey ed25519.PrivateKey
	if len(signingKeyBytes) == ed25519.SeedSize {
		signingPrivKey = ed25519.NewKeyFromSeed(signingKeyBytes)
	} else {
		signingPrivKey = ed25519.PrivateKey(signingKeyBytes)
	}
	identitySigner := crypto.NewIdentitySigner(signingPrivKey)
	didMgr.SetSigningKeyPath(identity.RootSigningPath(int(signingGeneration)))
	didMgr.SetSigningGeneration(int(signingGeneration))
	didMgr.SetMasterSeed(masterSeed, keyDeriver)
	personaMgr := identity.NewPersonaManager()
	// CRITICAL-01/02: Enable file-based persona persistence.
	personaStatePath := filepath.Join(cfg.VaultPath, "persona_state.json")
	if err := personaMgr.SetPersistPath(personaStatePath); err != nil {
		// CRITICAL-01: Fail startup in production when persona state cannot be loaded.
		// In dev/test/migration or when DINA_RECOVER_PERSONAS=1, allow degraded start.
		if isDevOrTest || os.Getenv("DINA_RECOVER_PERSONAS") == "1" {
			slog.Warn("persona state load failed — continuing (dev/test/recover)", "error", err)
		} else {
			slog.Error("persona state load failed — refusing to start", "error", err)
			os.Exit(1)
		}
	}
	personaMgr.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return auth.NewPassphraseVerifier(storedHash).Verify(passphrase)
	}
	personaMgr.HashUpgrader = func(passphrase string) (string, error) {
		salt := make([]byte, 16)
		if _, err := crypto_rand.Read(salt); err != nil {
			return "", err
		}
		return auth.HashPassphrase(passphrase, salt)
	}
	personaMgr.OnLock = func(personaID string) {
		// Strip "persona-" prefix to get the bare name for VaultManager.
		name := strings.TrimPrefix(personaID, "persona-")
		pn, err := domain.NewPersonaName(name)
		if err != nil {
			slog.Warn("OnLock: invalid persona name", "personaID", personaID, "error", err)
			return
		}
		if err := vaultMgr.Close(pn); err != nil {
			slog.Warn("OnLock: vault close failed", "persona", name, "error", err)
			return
		}
		slog.Info("Vault closed on persona lock", "persona", name)
	}
	// Wire approval notification callback.
	// For Phase 1: log + notify via WebSocket. Telegram relay is Phase 2.
	// OnApprovalNeeded is wired after notifier creation (see below).

	// CRITICAL-01: Wire orphan-guard callback. If vault DB files exist on disk for
	// a persona that has no in-memory state, reject creation to prevent DEK reuse.
	personaMgr.CheckOrphanedVault = func(personaID string) bool {
		name := strings.TrimPrefix(personaID, "persona-")
		dbFile := filepath.Join(cfg.VaultPath, name+".sqlite")
		_, err := os.Stat(dbFile)
		return err == nil // file exists → orphaned vault artifact
	}
	// Auto-open default and standard tier personas at boot.
	// This ensures vault queries work immediately for non-sensitive personas.
	personaNames, _ := personaMgr.List(context.Background())
	for _, pNameStr := range personaNames {
		tier, _ := personaMgr.GetTier(context.Background(), pNameStr)
		if tier == "default" || tier == "standard" {
			pName, pErr := domain.NewPersonaName(strings.TrimPrefix(pNameStr, "persona-"))
			if pErr != nil {
				continue
			}
			if !vaultMgr.IsOpen(pName) {
				dekVersion, dvErr := personaMgr.GetDEKVersion(context.Background(), pNameStr)
				if dvErr != nil || dekVersion == 0 {
					dekVersion = 1
				}
				dek, dErr := keyDeriver.DerivePersonaDEKVersioned(masterSeed, pName, dekVersion)
				if dErr == nil {
					if oErr := vaultMgr.Open(context.Background(), pName, dek); oErr == nil {
						slog.Info("Auto-opened persona vault", "persona", pNameStr, "tier", tier)
					}
				}
			}
		}
	}

	contactDir := identity.NewContactDirectory()
	deviceRegistry := identity.NewDeviceRegistry()
	recoveryMgr := identity.NewRecoveryManager()

	// 5a. Trust cache + resolver (for ingress gatekeeper — no SQLite dependency for now)
	trustCache := trustadapter.NewInMemoryCache()
	trustResolver := trustadapter.NewResolver(cfg.AppViewURL)
	trustSvc := service.NewTrustService(trustCache, trustResolver, contactDir)

	// 5b. K256 rotation key + PLC/PDS (optional — enabled when DINA_PDS_URL is set)
	k256Mgr := crypto.NewK256KeyManager(cfg.VaultPath)
	k256Mgr.SetMasterSeed(masterSeed)
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

	// 6. Service Keys (Ed25519 service-to-service auth)
	// PEM files are provisioned at install time via provision_derived_service_keys.py
	// (seed-derived at m/9999'/3'/<index>'). Runtime is load-only, fail-closed.
	coreKey := servicekey.New(cfg.ServiceKeyDir)
	if err := coreKey.EnsureExistingKey("core"); err != nil {
		log.Fatalf("Service key load failed (provisioned at install time?): %v", err)
	}
	slog.Info("Core service key ready", "did", coreKey.DID(), "key_dir", cfg.ServiceKeyDir)

	// Load Brain's public key for signature verification.
	// Keys are provisioned at install time — must be available at startup.
	var brainPub ed25519.PublicKey
	var brainDID string
	{
		var peerErr error
		peerDeadline := time.Now().Add(30 * time.Second)
		for {
			brainPub, brainDID, peerErr = coreKey.LoadPeerKey("brain")
			if peerErr == nil {
				break
			}
			if time.Now().After(peerDeadline) {
				log.Fatalf("Brain public key load failed: %v", peerErr)
			}
			slog.Warn("Brain public key not yet available — retrying", "error", peerErr)
			time.Sleep(1 * time.Second)
		}
		slog.Info("Loaded Brain public key", "did", brainDID)
	}

	// 6b. Auth
	tokenValidator := auth.NewTokenValidator(map[string]string{})
	if len(brainPub) > 0 {
		tokenValidator.RegisterServiceKey(brainDID, []byte(brainPub), "brain")
		slog.Info("Registered Brain service key in auth validator", "did", brainDID)
	}
	if cfg.ClientToken != "" {
		tokenValidator.RegisterClientToken(cfg.ClientToken, "bootstrap", "admin")
		slog.Info("Pre-registered client token from DINA_CLIENT_TOKEN", "scope", "admin")
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
	// Format: did=endpoint=seedhex (strict, no legacy 2-part format).
	if peers := os.Getenv("DINA_KNOWN_PEERS"); peers != "" {
		for i, entry := range strings.Split(peers, ",") {
			parts := strings.SplitN(entry, "=", 3)
			if len(parts) != 3 {
				slog.Error("KNOWN_PEERS: invalid entry format (expected did=endpoint=seedhex)", "index", i, "entry", entry)
				os.Exit(1)
			}
			did := strings.TrimSpace(parts[0])
			endpoint := strings.TrimSpace(parts[1])
			peerSeedHex := strings.TrimSpace(parts[2])
			peerSeedBytes, seedErr := hex.DecodeString(peerSeedHex)
			if seedErr != nil {
				slog.Error("KNOWN_PEERS: invalid seed hex", "index", i, "did", did, "error", seedErr)
				os.Exit(1)
			}
			if len(peerSeedBytes) != 32 {
				slog.Error("KNOWN_PEERS: invalid seed length", "index", i, "did", did, "got", len(peerSeedBytes), "expected", 32)
				os.Exit(1)
			}
			_, peerKeyBytes, deriveErr := slip0010.DerivePath(peerSeedBytes, "m/9999'/0'/0'")
			if deriveErr != nil {
				slog.Error("KNOWN_PEERS: key derivation failure", "index", i, "did", did, "error", deriveErr)
				os.Exit(1)
			}
			var peerPrivKey ed25519.PrivateKey
			if len(peerKeyBytes) == ed25519.SeedSize {
				peerPrivKey = ed25519.NewKeyFromSeed(peerKeyBytes)
			} else {
				peerPrivKey = ed25519.PrivateKey(peerKeyBytes)
			}
			peerPubKey := peerPrivKey.Public().(ed25519.PublicKey)
			multicodecKey := append([]byte{0xed, 0x01}, peerPubKey...)
			pubKeyMultibase := "z" + base58.Encode(multicodecKey)

			doc := fmt.Sprintf(`{`+
				`"id":"%s",`+
				`"verificationMethod":[{"id":"%s#key-1","type":"Ed25519VerificationKey2020","controller":"%s","publicKeyMultibase":"%s"}],`+
				`"service":[{"id":"%s#msg","type":"DinaMessaging","serviceEndpoint":"%s"}]`+
				`}`, did, did, did, pubKeyMultibase, did, endpoint)
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
	reminderSched := taskqueue.NewReminderScheduler()

	// 10. WebSocket
	wsHub := ws.NewWSHub()
	notifier := ws.NewNotifier(wsHub)

	// Wire approval notification: broadcast to WebSocket + log.
	personaMgr.OnApprovalNeeded = func(req domain.ApprovalRequest) {
		slog.Info("Approval requested",
			"approval_id", req.ID,
			"client_did", req.ClientDID,
			"persona", req.PersonaID,
			"session", req.SessionID,
			"reason", req.Reason,
		)
		// Broadcast to WebSocket clients (admin UI).
		// Use json.Marshal to safely escape user-supplied fields.
		payload, merr := json.Marshal(map[string]string{
			"type":       "approval_needed",
			"id":         req.ID,
			"persona":    req.PersonaID,
			"client_did": req.ClientDID,
			"session":    req.SessionID,
			"reason":     req.Reason,
		})
		if merr != nil {
			slog.Error("failed to marshal approval notification", "error", merr)
			return
		}
		notifier.Broadcast(context.Background(), payload)

		// Brain push is wired after brain client creation (see below).
	}

	// 11. Pairing
	pairer := pairing.NewManager(pairing.DefaultConfig())

	// 12. Brain Client (service-key auth only).
	brain := brainclient.New(cfg.BrainURL, coreKey)

	// Wire approval → Brain push (now that brain client exists).
	// The OnApprovalNeeded callback was partially set above (WebSocket broadcast).
	// Here we add the Brain push for Telegram delivery.
	origOnApproval := personaMgr.OnApprovalNeeded
	personaMgr.OnApprovalNeeded = func(req domain.ApprovalRequest) {
		if origOnApproval != nil {
			origOnApproval(req)
		}
		go func() {
			_ = brain.Process(context.Background(), domain.TaskEvent{
				Type: "approval_needed",
				Payload: map[string]interface{}{
					"id":         req.ID,
					"persona":    req.PersonaID,
					"client_did": req.ClientDID,
					"session":    req.SessionID,
					"reason":     req.Reason,
				},
			})
		}()
	}

	// 12b. Reminder Loop — fires reminders on schedule, delegates to Brain.
	reminderLoop := reminder.NewLoop(reminderSched, clk)
	onReminderFire := func(ctx context.Context, reminderID, reminderType string) {
		rem, err := reminderSched.GetByID(ctx, reminderID)
		if err != nil {
			slog.Error("reminder: get by id", "id", reminderID, "error", err)
			return
		}
		event := domain.TaskEvent{
			Type: "reminder_fired",
			Payload: map[string]interface{}{
				"reminder_id":   reminderID,
				"reminder_type": reminderType,
				"message":       rem.Message,
				"metadata":      rem.Metadata,
			},
		}
		if err := brain.Process(ctx, event); err != nil {
			slog.Error("reminder: brain process", "id", reminderID, "error", err)
		}
	}
	reminderCtx, reminderCancel := context.WithCancel(context.Background())
	defer reminderCancel()
	go reminderLoop.Run(reminderCtx, onReminderFire)

	// 13. Observability
	healthChecker := server.NewDynamicHealthChecker(func() bool {
		// Check 1: service key must be initialized
		if coreKey.DID() == "" {
			return false
		}
		// Check 2: vault path must exist
		if _, err := os.Stat(cfg.VaultPath); err != nil {
			return false
		}
		// Check 3: brain sidecar must be reachable
		if !brain.IsHealthy(context.Background()) {
			return false
		}
		return true
	})
	crashLogger := observability.NewCrashLogger()

	// 14. Portability
	exportMgr := portability.NewExportManager(cfg.VaultPath)
	importMgr := portability.NewImportManager(cfg.VaultPath, false)

	// 15. Estate
	estateMgr := estate.NewPortEstateManager()

	// ---------- Construct services ----------

	identitySvc := service.NewIdentityService(
		slip0010, keyDeriver, didMgr, personaMgr,
		keyWrapper, argon2Deriver, vaultMgr, clk,
	)

	gkSvc := service.NewGatekeeperService(
		vaultMgr, vaultMgr, gk, auditLogger, notifier, clk,
	)

	vaultSvc := service.NewVaultService(
		vaultMgr, vaultMgr, vaultMgr, gkSvc, clk,
	)
	vaultSvc.SetPersonaManager(personaMgr)

	transportSvc := service.NewTransportService(
		nacl, identitySigner, converter, didResolverPort,
		outboxMgr, inboxMgr, clk,
	)
	transportSvc.SetDeliverer(transporter)
	transportSvc.SetVerifier(signer)
	transportSvc.SetEgress(gkSvc) // SEC-HIGH-04: enforce egress policy on outbound D2D
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
	deadDrop := ingress.NewDeadDrop(deadDropDir, 10000, int64(cfg.SpoolMax))
	ingressLimiter := ingress.NewRateLimiter(50, time.Minute, 10000, int64(cfg.SpoolMax), deadDrop)
	ingressSweeper := ingress.NewSweeper(deadDrop, nacl, didResolverPort, clk, 24*time.Hour)
	ingressSweeper.SetKeys(
		signingPrivKey.Public().(ed25519.PublicKey),
		[]byte(signingPrivKey),
	)
	ingressSweeper.SetConverter(converter)
	ingressSweeper.SetOnMessage(func(msg *domain.DinaMessage) {
		// SEC-MED-12: Enforce per-DID rate limit on sweeper path (same as fast path).
		if msg.From != "" && !inboxMgr.CheckDIDRate(msg.From) {
			slog.Warn("sweeper: per-DID rate limit exceeded", "did", msg.From)
			return
		}
		// Trust-based ingress filtering.
		if msg.From != "" {
			decision := trustSvc.EvaluateIngress(msg.From)
			switch decision {
			case domain.IngressDrop:
				slog.Info("sweeper: dropped message from blocked DID", "did", msg.From)
				return
			case domain.IngressQuarantine:
				msg.Quarantined = true
				slog.Info("sweeper: quarantined message from unknown DID", "did", msg.From)
			}
		}
		transportSvc.StoreInbound(msg)
	})
	ingressSweeper.SetTransport(transportSvc)
	ingressRouter := ingress.NewRouter(vaultMgr, inboxMgr, deadDrop, ingressSweeper, ingressLimiter)
	ingressRouter.SetOnEnvelope(func(ctx context.Context, envelope []byte) error {
		msg, err := transportSvc.ProcessInbound(ctx, envelope)
		if err != nil {
			slog.Warn("ingress: fast-path decrypt failed", "error", err)
			return err
		}
		// SEC-MED-12: Per-DID rate enforcement before storing.
		if msg.From != "" && !inboxMgr.CheckDIDRate(msg.From) {
			slog.Warn("ingress: per-DID rate limit exceeded", "did", msg.From)
			return fmt.Errorf("per-DID rate limit exceeded for %s", msg.From)
		}
		// Trust-based ingress filtering.
		if msg.From != "" {
			decision := trustSvc.EvaluateIngress(msg.From)
			switch decision {
			case domain.IngressDrop:
				slog.Info("ingress: dropped message from blocked DID", "did", msg.From)
				return nil // Not an error — intentionally discarded
			case domain.IngressQuarantine:
				msg.Quarantined = true
				slog.Info("ingress: quarantined message from unknown DID", "did", msg.From)
			}
		}
		transportSvc.StoreInbound(msg)
		slog.Info("ingress: fast-path message decrypted and stored", "type", msg.Type)
		return nil
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

	// Background outbox retry: periodically attempt delivery of pending outbox messages.
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if n, err := transportSvc.ProcessOutbox(context.Background()); err != nil {
				slog.Warn("outbox ProcessOutbox error", "error", err)
			} else if n > 0 {
				slog.Info("outbox ProcessOutbox delivered messages", "count", n)
			}
		}
	}()

	// SEC-HIGH-08: Purge replay cache periodically (24h TTL matches dead-drop/sweeper model).
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			n := transportSvc.PurgeReplayCache(24 * time.Hour)
			if n > 0 {
				slog.Debug("replay cache purged", "count", n)
			}
		}
	}()

	// SEC-MED-09: Periodic outbox/transport retention cleanup.
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			if n, err := outboxMgr.DeleteExpired(86400); err == nil && n > 0 {
				slog.Info("outbox retention cleanup", "deleted", n)
			}
		}
	}()

	// SEC-MED-13: Purge expired pairing codes periodically.
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			if n := pairer.PurgeExpiredCodes(); n > 0 {
				slog.Info("purged expired pairing codes", "count", n)
			}
		}
	}()

	// SEC-MED-12: Reset per-DID rate limit counters every minute (sliding window).
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			inboxMgr.ResetRateLimits()
		}
	}()

	// Trust cache: periodic neighborhood sync from AppView (1 hour).
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if err := trustSvc.SyncNeighborhood(cfg.OwnDID); err != nil {
				slog.Warn("trust sync failed", "error", err)
			}
		}
	}()

	taskSvc := service.NewTaskService(taskQueue, watchdog, brain, clk)

	deviceSvc := service.NewDeviceService(pairer, deviceRegistry, clk)
	deviceSvc.SetKeyRegistrar(tokenValidator)

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

	// ---------- Construct handlers ----------

	healthH := &handler.HealthHandler{Health: healthChecker}
	adminH := &handler.AdminHandler{ProxyURL: cfg.BrainURL}
	vaultH := &handler.VaultHandler{Vault: vaultSvc, PII: scrubber, Approvals: personaMgr}
	identityH := &handler.IdentityHandler{Identity: identitySvc, DID: didMgr, Signer: identitySigner}
	messageH := &handler.MessageHandler{Transport: transportSvc, IngressRouter: ingressRouter}
	taskH := &handler.TaskHandler{Task: taskSvc}
	deviceH := &handler.DeviceHandler{Device: deviceSvc}
	// Agent validation proxy uses Ed25519 service-key auth.
	agentBrain := brainclient.New(cfg.BrainURL, coreKey)
	agentH := &handler.AgentHandler{Brain: agentBrain}

	personaH := &handler.PersonaHandler{Identity: identitySvc, Personas: personaMgr, Approvals: personaMgr, VaultManager: vaultMgr, KeyDeriver: keyDeriver, Seed: masterSeed}
	sessionH := &handler.SessionHandler{Sessions: personaMgr}
	trustH := &handler.TrustHandler{Trust: trustSvc, OwnDID: cfg.OwnDID}
	contactH := &handler.ContactHandler{Contacts: contactDir, Sharing: sharingMgr}
	piiH := &handler.PIIHandler{Scrubber: scrubber}
	notifyH := &handler.NotifyHandler{Notifier: notifier}
	exportH := &handler.ExportHandler{Migration: migrationSvc}
	reminderH := &handler.ReminderHandler{
		Scheduler: reminderSched,
		Loop:      reminderLoop,
		OnFire: func(id, typ string) {
			onReminderFire(context.Background(), id, typ)
		},
	}
	wellknownH := &handler.WellKnownHandler{DID: didMgr, Signer: identitySigner}
	auditH := &handler.AuditHandler{Auditor: auditLogger}

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

	// Messaging API
	mux.HandleFunc("/v1/msg/send", messageH.HandleSend)
	mux.HandleFunc("/v1/msg/inbox", messageH.HandleInbox)

	// PII API
	mux.HandleFunc("/v1/pii/scrub", piiH.HandleScrub)

	// Audit API
	mux.HandleFunc("/v1/audit/query", auditH.HandleQuery)
	mux.HandleFunc("/v1/audit/append", auditH.HandleAppend)

	// Task API
	mux.HandleFunc("/v1/task/ack", taskH.HandleAck)

	// Persona API
	mux.HandleFunc("/v1/personas", routeByMethod(personaH.HandleListPersonas, personaH.HandleCreatePersona))
	mux.HandleFunc("/v1/persona/unlock", personaH.HandleUnlockPersona)
	mux.HandleFunc("/v1/persona/lock", personaH.HandleLockPersona)
	mux.HandleFunc("/v1/persona/approve", personaH.HandleApprove)
	mux.HandleFunc("/v1/persona/deny", personaH.HandleDeny)
	mux.HandleFunc("/v1/persona/approvals", personaH.HandleListApprovals)

	// Session API
	mux.HandleFunc("/v1/session/start", sessionH.HandleStartSession)
	mux.HandleFunc("/v1/session/end", sessionH.HandleEndSession)
	mux.HandleFunc("/v1/sessions", sessionH.HandleListSessions)

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

	// Trust Cache API
	mux.HandleFunc("/v1/trust/cache", trustH.HandleListCache)
	mux.HandleFunc("/v1/trust/stats", trustH.HandleStats)
	mux.HandleFunc("/v1/trust/sync", trustH.HandleSync)
	mux.HandleFunc("/v1/trust/resolve", trustH.HandleResolve)

	// Device Pairing API
	mux.HandleFunc("/v1/pair/initiate", deviceH.HandleInitiatePairing)
	mux.HandleFunc("/v1/pair/complete", deviceH.HandleCompletePairing)
	mux.HandleFunc("/v1/devices", deviceH.HandleListDevices)
	mux.HandleFunc("/v1/devices/", deviceH.HandleRevokeDevice)

	// Agent Safety Layer — proxies to brain's guardian
	mux.HandleFunc("/v1/agent/validate", agentH.HandleValidate)

	// Notification API
	mux.HandleFunc("/v1/notify", notifyH.HandleNotify)

	// Reminder API
	mux.HandleFunc("/v1/reminder", reminderH.HandleStoreReminder)
	mux.HandleFunc("/v1/reminders/pending", reminderH.HandleListPending)

	// Brain reasoning proxy — agents interact with Brain via Core.
	// Core re-signs the request with its own service key (agents have device keys).
	reasonH := &handler.ReasonHandler{Brain: brain}
	mux.HandleFunc("/api/v1/reason", reasonH.HandleReason)

	// Admin proxy
	mux.HandleFunc("/admin/sync-status", adminH.HandleSyncStatus)
	mux.HandleFunc("/admin/", adminH.HandleAdmin)

	// Export/Import API
	mux.HandleFunc("/v1/export", exportH.HandleExport)
	mux.HandleFunc("/v1/import", exportH.HandleImport)

	// WebSocket endpoint (CORE-MED-07)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		// SEC-HIGH-05: Use origin patterns from config instead of insecure skip.
		var wsOpts []ws.UpgraderOption
		if cfg.AllowedOrigins != "" {
			wsOpts = append(wsOpts, ws.WithOriginPatterns(strings.Split(cfg.AllowedOrigins, ",")...))
		}
		wsUpgrader := ws.NewUpgrader(wsOpts...)
		wsTokenValidator := func(token string) (string, error) {
			deviceID, ok := tokenValidator.ValidateClientToken(token)
			if !ok {
				return "", fmt.Errorf("invalid client token")
			}
			return deviceID, nil
		}
		wsBrainRouter := func(clientID string, msgType string, payload map[string]interface{}) ([]byte, error) {
			query, _ := payload["query"].(string)
			if query == "" {
				query = msgType
			}
			result, err := brain.Reason(r.Context(), query)
			if err != nil {
				return nil, err
			}
			return []byte(result.Content), nil
		}
		wsHandlerWS := ws.NewWSHandler(wsTokenValidator, wsBrainRouter)
		wsHandlerWS.SetHub(wsHub)
		hb := ws.NewHeartbeatManager(func(clientID string, data []byte) error {
			return wsHub.Send(clientID, data)
		})
		wsHandlerWS.SetHeartbeat(hb)
		buf := ws.NewMessageBuffer()
		wsHandlerWS.SetBuffer(buf)
		ws.ServeWS(wsUpgrader, wsHub, wsHandlerWS, hb, buf, w, r)
	})

	// Test-only endpoints (guarded by DINA_TEST_MODE)
	if os.Getenv("DINA_TEST_MODE") == "true" {
		slog.Warn("DINA_TEST_MODE enabled — test-only endpoints active")
		mux.HandleFunc("/v1/vault/clear", handler.HandleClearVault(vaultMgr))
		mux.HandleFunc("/v1/reminder/fire", reminderH.HandleFireReminder)
	}

	// ---------- Apply middleware chain ----------

	authMW := &middleware.Auth{Tokens: tokenValidator, ScopeResolver: tokenValidator}
	authzMW := middleware.NewAuthzMiddleware(auth.NewAdminEndpointChecker())
	rateLimitMW := &middleware.RateLimit{Limiter: rateLimiter, TrustedProxies: parseCIDRs(cfg.TrustedProxies)}
	recovery := &middleware.Recovery{}
	logging := &middleware.Logging{}
	timeout := &middleware.Timeout{Duration: 30 * time.Second}
	cors := &middleware.CORS{AllowOrigin: cfg.AllowedOrigins}

	// Chain: CORS → BodyLimit → Recovery → Logging → RateLimit → Auth → Authz → Timeout → Router
	var chain http.Handler = mux
	chain = timeout.Handler(chain)
	chain = authzMW(chain)
	chain = authMW.Handler(chain)
	chain = rateLimitMW.Handler(chain)
	chain = logging.Handler(chain)
	chain = recovery.Handler(chain)
	chain = middleware.BodyLimit(1 << 20)(chain) // 1 MB default body limit
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

	// ---------- Admin Unix socket (optional) ----------
	//
	// Core listens on a Unix domain socket for local admin CLI access.
	// Socket access = admin auth: no CLIENT_TOKEN required.
	// The real trust boundary is docker exec access to the container —
	// whoever can exec in can reach the socket and act as admin.
	// Usage: docker compose exec core dina-admin ...

	var socketSrv *http.Server
	if cfg.AdminSocketPath != "" {
		// Build socket-specific middleware chain: same as TCP but replace
		// Auth+Authz with SocketAdminAuth (pre-authenticated as admin).
		var socketChain http.Handler = mux
		socketChain = timeout.Handler(socketChain)
		socketChain = middleware.SocketAdminAuth(socketChain)
		socketChain = rateLimitMW.Handler(socketChain)
		socketChain = logging.Handler(socketChain)
		socketChain = recovery.Handler(socketChain)
		socketChain = middleware.BodyLimit(1 << 20)(socketChain)

		// Clean up stale socket file from previous run.
		os.Remove(cfg.AdminSocketPath)
		if err := os.MkdirAll(filepath.Dir(cfg.AdminSocketPath), 0o750); err != nil {
			slog.Error("failed to create admin socket directory", "error", err)
		} else {
			sockLn, err := net.Listen("unix", cfg.AdminSocketPath)
			if err != nil {
				slog.Error("failed to listen on admin socket", "path", cfg.AdminSocketPath, "error", err)
			} else {
				// Socket is 0600. The real access gate is docker exec into
				// the container, not the file mode.
				os.Chmod(cfg.AdminSocketPath, 0o600)

				socketSrv = &http.Server{
					Handler:        socketChain,
					ReadTimeout:    10 * time.Second,
					WriteTimeout:   35 * time.Second,
					IdleTimeout:    60 * time.Second,
					MaxHeaderBytes: 1 << 20,
				}
				go func() {
					slog.Info("admin socket listening", "path", cfg.AdminSocketPath)
					if err := socketSrv.Serve(sockLn); err != nil && err != http.ErrServerClosed {
						slog.Error("admin socket error", "error", err)
					}
				}()
			}
		}
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
	if socketSrv != nil {
		if err := socketSrv.Shutdown(ctx); err != nil {
			slog.Error("admin socket shutdown error", "error", err)
		}
		os.Remove(cfg.AdminSocketPath)
	}

	slog.Info("dina-core stopped")
}

// routeByMethod dispatches GET to getHandler, POST/PUT/DELETE to mutateHandler.
// parseCIDRs parses a comma-separated list of CIDR strings into net.IPNet slices.
// Invalid CIDRs are logged and skipped.
func parseCIDRs(csv string) []*net.IPNet {
	if csv == "" {
		return nil
	}
	var nets []*net.IPNet
	for _, s := range strings.Split(csv, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		_, cidr, err := net.ParseCIDR(s)
		if err != nil {
			slog.Warn("ignoring invalid trusted proxy CIDR", "cidr", s, "error", err)
			continue
		}
		nets = append(nets, cidr)
	}
	return nets
}

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
