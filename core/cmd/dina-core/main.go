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
	"errors"
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
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo, AddSource: true}))
	slog.SetDefault(logger)

	// ---------- Load configuration ----------

	cfgLoader := config.NewLoader()
	// F15: Load() now includes Validate() — single call, no duplicate.
	cfg, err := cfgLoader.Load()
	if err != nil {
		slog.Error("failed to load config", "error", err)
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

	// 3b. Request trace store (uses identity.sqlite for ephemeral debug traces).
	traceStore := newTraceStore(vaultMgr)
	tracer := &handler.Tracer{Store: traceStore}
	traceH := &handler.TraceHandler{Store: traceStore}

	// Periodic trace purge: discard events older than 1 hour.
	if traceStore != nil {
		go func() {
			ticker := time.NewTicker(10 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				if n, err := traceStore.Purge(context.Background(), 3600); err != nil {
					slog.Warn("trace purge error", "error", err)
				} else if n > 0 {
					slog.Info("trace purge", "purged", n)
				}
			}
		}()
	}

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

	// Phase A: MsgBox URL from env var (before RestoreDID so DID docs get the correct endpoint).
	msgboxURL := os.Getenv("DINA_MSGBOX_URL")
	if msgboxURL != "" {
		didMgr.SetMessagingService("DinaMsgBox", msgboxURL)
		slog.Info("MsgBox URL from env", "url", msgboxURL)
	}

	// Restore DID from persisted metadata so the node keeps its identity
	// across restarts. Without this, the DID is only created on first
	// /v1/did request, and restarts would generate a new one.
	var ownDID string // used later for D2D sender identification
	if meta != nil && meta.DID != "" {
		pubKey := identitySigner.PublicKey()
		restoredDID, restoreErr := didMgr.RestoreDID(context.Background(), meta, pubKey)
		if restoreErr != nil {
			slog.Warn("DID restore failed — will be recreated on first request",
				"error", restoreErr,
				"did", meta.DID,
			)
		} else {
			slog.Info("DID restored from metadata", "did", restoredDID)
			ownDID = string(restoredDID)
		}
	}


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
	// For Phase 1: log + notify via WebSocket. Telegram forwarding is Phase 2.
	// OnApprovalNeeded is wired after notifier creation (see below).

	// CRITICAL-01: Wire orphan-guard callback. If vault DB files exist on disk for
	// a persona that has no in-memory state, reject creation to prevent DEK reuse.
	personaMgr.CheckOrphanedVault = func(personaID string) bool {
		name := strings.TrimPrefix(personaID, "persona-")
		dbFile := filepath.Join(cfg.VaultPath, name+".sqlite")
		_, err := os.Stat(dbFile)
		return err == nil // file exists → orphaned vault artifact
	}
	// Bootstrap: create default personas on first run.
	// Covers 90% of life — Brain's classifier routes data automatically.
	// general (default) + work (standard) auto-open at boot.
	// health + finance (sensitive) auto-open on authorized access (v1 model).
	// Empty passphrase hash is valid for sensitive personas — they are
	// policy-gated via AccessPersona(), not passphrase-unlocked.
	{
		existingPersonas, _ := personaMgr.List(context.Background())
		if len(existingPersonas) == 0 {
			// In test mode (DINA_TEST_MODE=true), use "test" as the passphrase
			// so E2E/integration tests can explicitly unlock sensitive personas.
			// In production, sensitive personas don't need a passphrase —
			// they auto-open when AccessPersona() authorizes the request.
			var bootstrapPassHash string
			if os.Getenv("DINA_TEST_MODE") == "true" {
				salt := make([]byte, 16)
				crypto_rand.Read(salt)
				var hashErr error
				bootstrapPassHash, hashErr = auth.HashPassphrase("test", salt)
				if hashErr != nil {
					slog.Warn("bootstrap: could not hash test passphrase", "error", hashErr)
				}
			}

			bootstrapPersonas := []struct {
				name, tier, description string
			}{
				{"general", "default", "Personal facts, preferences, family, relationships, hobbies, recipes, pets, birthdays, daily life, opinions"},
				{"work", "standard", "Professional context, meetings, colleagues, deadlines, projects, office logistics, career"},
				{"health", "sensitive", "Medical records, diagnoses, prescriptions, lab results, doctor visits, symptoms, allergies, medications, vital signs"},
				{"finance", "sensitive", "Bank accounts, investments, bills, rent, salary, tax, loans, insurance, financial planning"},
			}
			for _, p := range bootstrapPersonas {
				id, err := personaMgr.Create(context.Background(), p.name, p.tier, bootstrapPassHash)
				if err != nil {
					slog.Warn("bootstrap: could not create persona", "name", p.name, "error", err)
					continue
				}
				_ = personaMgr.SetDescription(context.Background(), id, p.description)
			}
			slog.Info("bootstrap: created default personas (first run)",
				"personas", "general, work, health, finance")
		}
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

	// Phase B: KV-based admin config overrides (general persona now open).
	// Takes precedence over env vars. If msgbox URL changed, re-persist DID doc.
	if v := readAdminKV(vaultMgr, "msgbox_url"); v != "" {
		slog.Info("MsgBox URL overridden from KV", "url", v)
		if v != msgboxURL {
			msgboxURL = v
			didMgr.SetMessagingService("DinaMsgBox", v)
			if err := didMgr.RePersistCurrentDID(); err != nil {
				slog.Warn("Failed to re-persist DID doc with KV msgbox URL", "error", err)
			}
		}
	}
	if v := readAdminKV(vaultMgr, "appview_url"); v != "" {
		slog.Info("AppView URL overridden from KV", "url", v)
		cfg.AppViewURL = v
	}

	contactDir := newContactDirectory(vaultMgr)
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

		// Eager DID creation: on first install, no persisted DID exists yet.
		// Must happen after SetPLCClient so the DID registers on global PLC.
		if ownDID == "" {
			pubKey := identitySigner.PublicKey()
			createdDID, createErr := didMgr.Create(context.Background(), pubKey)
			if createErr != nil {
				slog.Warn("Eager DID creation failed — will retry on first request", "error", createErr)
			} else {
				slog.Info("DID created on first boot", "did", createdDID)
				ownDID = string(createdDID)
			}
		}

		// Update PLC directory with MsgBox service and Ed25519 key so other
		// nodes can discover this node's D2D endpoint and encrypt messages.
		// PDS creates the DID with only #atproto (secp256k1) — we add
		// #dina_messaging service and the Ed25519 verification method.
		if ownDID != "" && msgboxURL != "" {
			rotKey, rotErr := k256Mgr.GenerateOrLoad()
			if rotErr != nil {
				slog.Warn("PLC update: rotation key not available", "error", rotErr)
			} else {
				// Build Ed25519 did:key for the verification method.
				ed25519PubKey := signingPrivKey.Public().(ed25519.PublicKey)
				multicodecKey := append([]byte{0xed, 0x01}, ed25519PubKey...)
				ed25519DIDKey := "did:key:z" + base58.Encode(multicodecKey)

				go func() {
					if err := pds.UpdatePLCDocument(
						context.Background(), plcURL, ownDID, rotKey,
						map[string]pds.PLCService{
							"dina_messaging": {
								Type:     "DinaMsgBox",
								Endpoint: msgboxURL,
							},
						},
						map[string]string{
							"dina_signing": ed25519DIDKey,
						},
					); err != nil {
						slog.Warn("PLC update: failed to update DID document", "error", err)
					}
				}()
			}
		}
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

	// Load service peer keys for signature verification.
	// Brain is required (30s retry). Admin and connector are optional
	// (loaded if provisioned, skipped otherwise).
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

	// 6b. Auth — register all available service keys.
	tokenValidator := auth.NewTokenValidator(map[string]string{})
	tokenValidator.RegisterServiceKey(brainDID, []byte(brainPub), "brain")
	slog.Info("Registered service key", "service", "brain", "did", brainDID)

	// Optional service peers: admin, connector. Load if provisioned, skip if not.
	for _, peer := range []string{"admin", "connector"} {
		pub, did, err := coreKey.LoadPeerKey(peer)
		if err != nil {
			slog.Debug("Optional service key not available", "service", peer)
			continue
		}
		tokenValidator.RegisterServiceKey(did, []byte(pub), peer)
		slog.Info("Registered service key", "service", peer, "did", did)
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
	// KNOWN_PEERS: legacy dev/test-only mechanism. Disabled by default.
	// Production uses PLC directory for DID resolution.
	// Enable with DINA_KNOWN_PEERS_MODE=legacy for internal testing only.
	if os.Getenv("DINA_KNOWN_PEERS_MODE") == "legacy" {
		didResolver.SetTTL(365 * 24 * time.Hour)
		if peers := os.Getenv("DINA_KNOWN_PEERS"); peers != "" {
			slog.Warn("KNOWN_PEERS: legacy mode enabled (dev/test only)")
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
					`"service":[{"id":"%s#msg","type":"DinaMsgBox","serviceEndpoint":"%s"}]`+
					`}`, did, did, did, pubKeyMultibase, did, endpoint)
				didResolver.AddDocument(did, []byte(doc))
			}
		}
	}

	// Wire PLC directory as remote fetcher for unknown DIDs.
	// KNOWN_PEERS are resolved from cache; everything else falls through to PLC.
	plcResolver := pds.NewPLCResolver(cfg.PLCURL)
	didResolver.SetFetcher(func(did string) ([]byte, error) {
		raw, err := plcResolver.ResolveDID(context.Background(), did)
		if err != nil {
			return nil, err
		}
		return raw, nil
	})
	didResolver.SetTTL(10 * time.Minute) // cache PLC results, not forever
	// Re-add KNOWN_PEERS with long TTL (they don't expire).
	// The global TTL is now 10min for PLC results, but KNOWN_PEERS
	// are pre-populated and refreshed on each restart.

	didResolverPort := transport.NewDIDResolverPort(didResolver)
	// SQLite-backed durable outbox (survives restarts). Falls back to in-memory
	// when CGO is unavailable.
	outboxMgr := newD2DOutboxManager(vaultMgr)
	// SQLite-backed scenario policy manager (survives restarts). nil in no-CGO mode.
	scenarioPolicyMgr := newScenarioPolicyManager(vaultMgr)
	inboxMgr := transport.NewInboxManager(transport.DefaultInboxConfig())
	transporter := transport.NewTransporter(didResolver)

	// 8b. MsgBox client — wire the resolved msgbox URL (env + KV override from Phase A/B).
	if msgboxURL != "" {
		transporter.SetMsgBoxURL(msgboxURL)
	}

	// 9. Task Queue
	taskQueue := taskqueue.NewTaskQueue()
	watchdog := taskqueue.NewWatchdog(taskQueue)
	reminderSched := newReminderScheduler(vaultMgr)

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

	// 11. Pairing (with persistence so devices survive restart)
	pairer := pairing.NewManager(pairing.DefaultConfig())
	devicePersistPath := filepath.Join(cfg.VaultPath, "paired_devices.json")
	if err := pairer.SetPersistPath(devicePersistPath); err != nil {
		slog.Warn("pairing: failed to load persisted devices", "error", err)
	}

	// 12. Brain Client (service-key auth only).
	brain := brainclient.New(cfg.BrainURL, coreKey)
	brain.Tracer = tracer

	// Wire approval → Brain push (now that brain client exists).
	// The OnApprovalNeeded callback was partially set above (WebSocket broadcast).
	// Here we add the Brain push for Telegram delivery.
	origOnApproval := personaMgr.OnApprovalNeeded
	personaMgr.OnApprovalNeeded = func(req domain.ApprovalRequest) {
		if origOnApproval != nil {
			origOnApproval(req)
		}
		// Resolve device name from token ID for human-readable notifications.
		agentName := req.ClientDID
		if devices, err := pairer.ListDevices(context.Background()); err == nil {
			for _, d := range devices {
				if d.TokenID == req.ClientDID {
					agentName = d.Name
					break
				}
			}
		}
		go func() {
			_ = brain.Process(context.Background(), domain.TaskEvent{
				Type: "approval_needed",
				Payload: map[string]interface{}{
					"id":         req.ID,
					"persona":    req.PersonaID,
					"client_did": agentName,
					"session":    req.SessionID,
					"reason":     req.Reason,
					"preview":    req.Preview,
				},
			})
		}()
	}

	// 12b. Reminder Loop — fires reminders on schedule, delegates to Brain.
	// The full Reminder (including Kind, SourceItemID, Source, Persona) is
	// passed to Brain so it can compose contextual notifications.
	reminderLoop := reminder.NewLoop(reminderSched, clk)
	onReminderFire := func(ctx context.Context, rem domain.Reminder) {
		event := domain.TaskEvent{
			Type: "reminder_fired",
			Payload: map[string]interface{}{
				"reminder_id":    rem.ID,
				"reminder_type":  rem.Type,
				"kind":           rem.Kind,
				"message":        rem.Message,
				"metadata":       rem.Metadata,
				"source_item_id": rem.SourceItemID,
				"source":         rem.Source,
				"persona":        rem.Persona,
			},
		}
		if err := brain.Process(ctx, event); err != nil {
			slog.Error("reminder: brain process", "id", rem.ID, "error", err)
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
	exportMgr.SetVersion(handler.Version)
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
	vaultSvc.Tracer = tracer

	transportSvc := service.NewTransportService(
		nacl, identitySigner, converter, didResolverPort,
		outboxMgr, inboxMgr, clk,
	)
	transportSvc.SetDeliverer(transporter)
	transportSvc.SetVerifier(signer)
	transportSvc.SetEgress(gkSvc) // SEC-HIGH-04: enforce egress policy on outbound D2D
	// D2D v1: 4-gate egress — contact check + scenario policy + audit trail.
	if scenarioPolicyMgr != nil {
		transportSvc.SetScenarioPolicy(scenarioPolicyMgr)
	}
	transportSvc.SetContacts(contactDir)
	transportSvc.SetAuditor(auditLogger)
	transportSvc.SetRecipientKeys(
		signingPrivKey.Public().(ed25519.PublicKey),
		[]byte(signingPrivKey),
	)
	// Set sender DID for outbound D2D messages — use config override or
	// the DID restored from identity metadata (the normal path).
	if cfg.OwnDID != "" {
		ownDID = cfg.OwnDID
	}
	if ownDID != "" {
		transportSvc.SetSenderDID(ownDID)
		slog.Info("D2D sender DID configured", "did", ownDID)
	}

	// Start MsgBox client if configured. The client:
	//   - Connects outbound WebSocket to the msgbox (this node's mailbox)
	//   - Receives inbound D2D messages pushed by the msgbox
	//   - Provides ForwardToMsgBox() for outbound DID-routed delivery
	if mboxURL := transporter.GetMsgBoxURL(); mboxURL != "" && ownDID != "" {
		msgboxClient := transport.NewMsgBoxClient(mboxURL+"/ws", ownDID, signingPrivKey)
		transporter.SetMsgBoxClient(msgboxClient)
		transportSvc.SetMsgBoxForwarder(msgboxClient) // DinaMsgBox routing in service layer
		slog.Info("MsgBox client created", "url", mboxURL, "did", ownDID)
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
	// stageD2DMemory is set after stagingInbox is created (late binding).
	// Stages memory-producing D2D content into the staging inbox for Brain
	// classification + enrichment. Real-time signals (arrival, greeting,
	// typing) are NOT staged.
	var stageD2DMemory func(ctx context.Context, msg *domain.DinaMessage)

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
				auditD2DIngress(auditLogger, "d2d_ingress_drop", msg.From, string(msg.Type), "blocked_contact")
				return
			case domain.IngressQuarantine:
				msg.Quarantined = true
				slog.Info("sweeper: quarantined message from unknown DID", "did", msg.From)
				auditD2DIngress(auditLogger, "d2d_ingress_quarantine", msg.From, string(msg.Type), "unknown_sender")
			}
		}
		// D2D v1: Inbound scenario policy — only for accepted contacts (not quarantined).
		if !msg.Quarantined && scenarioPolicyMgr != nil {
			scenario := domain.MsgTypeToScenario(msg.Type)
			if scenario != "" {
				tier, _ := scenarioPolicyMgr.GetScenarioTier(context.Background(), msg.From, scenario)
				if tier == domain.ScenarioDenyByDefault && scenario != "safety" {
					slog.Info("sweeper: D2D scenario denied", "from", msg.From, "scenario", scenario)
					auditD2DIngress(auditLogger, "d2d_inbound_policy_denied", msg.From, string(msg.Type), "deny_by_default")
					return
				}
			}
		}
		transportSvc.StoreInbound(msg)
		auditD2DIngress(auditLogger, "d2d_ingress_accept", msg.From, string(msg.Type), "stored")
		// Stage memory-producing D2D content for vault persistence.
		if stageD2DMemory != nil {
			stageD2DMemory(context.Background(), msg)
		}
		// Push to Brain for nudge assembly / handler routing.
		go func() {
			bodyStr := string(msg.Body)
			_ = brain.Process(context.Background(), domain.TaskEvent{
				Type: string(msg.Type),
				Payload: map[string]interface{}{
					"from":         msg.From,
					"body":         bodyStr,
					"id":           msg.ID,
					"created_time": msg.CreatedTime,
					"type":         string(msg.Type),
				},
			})
		}()
	})
	ingressSweeper.SetTransport(transportSvc)
	ingressRouter := ingress.NewRouter(vaultMgr, inboxMgr, deadDrop, ingressSweeper, ingressLimiter)
	ingressRouter.SetOnEnvelope(func(ctx context.Context, envelope []byte) error {
		msg, err := transportSvc.ProcessInbound(ctx, envelope)
		if err != nil {
			// D2D v1: ErrUnknownMessageType is a benign drop — not an error,
			// prevents dead-drop fallback.
			if errors.Is(err, domain.ErrUnknownMessageType) {
				slog.Info("ingress: non-v1 message type dropped", "error", err)
				return nil
			}
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
				auditD2DIngress(auditLogger, "d2d_ingress_drop", msg.From, string(msg.Type), "blocked_contact")
				return nil // Not an error — intentionally discarded
			case domain.IngressQuarantine:
				msg.Quarantined = true
				slog.Info("ingress: quarantined message from unknown DID", "did", msg.From)
				auditD2DIngress(auditLogger, "d2d_ingress_quarantine", msg.From, string(msg.Type), "unknown_sender")
			}
		}
		// D2D v1: Inbound scenario policy — only for accepted contacts (not quarantined).
		if !msg.Quarantined && scenarioPolicyMgr != nil {
			scenario := domain.MsgTypeToScenario(msg.Type)
			if scenario != "" {
				tier, _ := scenarioPolicyMgr.GetScenarioTier(ctx, msg.From, scenario)
				if tier == domain.ScenarioDenyByDefault && scenario != "safety" {
					slog.Info("ingress: D2D scenario denied", "from", msg.From, "scenario", scenario)
					auditD2DIngress(auditLogger, "d2d_inbound_policy_denied", msg.From, string(msg.Type), "deny_by_default")
					return nil // Not an error — intentionally discarded
				}
			}
		}
		transportSvc.StoreInbound(msg)
		auditD2DIngress(auditLogger, "d2d_ingress_accept", msg.From, string(msg.Type), "stored")

		// Extract _correlation_id from decrypted body for end-to-end tracing.
		// The sender's Brain embeds this so both sides can trace the message.
		bodyStr := string(msg.Body)
		var correlationID string
		{
			var bodyMap map[string]interface{}
			if json.Unmarshal(msg.Body, &bodyMap) == nil {
				if cid, ok := bodyMap["_correlation_id"].(string); ok && cid != "" {
					correlationID = cid
				}
			}
		}
		if correlationID != "" {
			slog.Info("ingress: D2D correlation", "correlation_id", correlationID, "from", msg.From, "type", msg.Type)
			// Write to trace store so dina-admin trace <correlation_id> works.
			if traceStore != nil {
				_ = traceStore.Append(correlationID, "d2d_received", "core",
					fmt.Sprintf(`{"from":"%s","type":"%s"}`, msg.From, msg.Type))
				_ = traceStore.Append(correlationID, "d2d_decrypted", "core",
					fmt.Sprintf(`{"body_len":%d}`, len(msg.Body)))
			}
		}

		// Stage memory-producing D2D content for vault persistence.
		if stageD2DMemory != nil {
			stageD2DMemory(ctx, msg)
		}
		// Push to Brain for nudge assembly / handler routing.
		// Pass correlation_id so receiver Brain can bind it for tracing.
		go func() {
			if correlationID != "" && traceStore != nil {
				_ = traceStore.Append(correlationID, "d2d_brain_forward", "core",
					`{"step":"pushing to brain for nudge"}`)
			}
			payload := map[string]interface{}{
				"from":         msg.From,
				"body":         bodyStr,
				"id":           msg.ID,
				"created_time": msg.CreatedTime,
				"type":         string(msg.Type),
			}
			if correlationID != "" {
				payload["_correlation_id"] = correlationID
			}
			_ = brain.Process(context.Background(), domain.TaskEvent{
				Type:    string(msg.Type),
				Payload: payload,
			})
		}()
		slog.Info("ingress: fast-path message decrypted and stored", "type", msg.Type)
		return nil
	})

	// Wire MsgBox client inbound: messages from msgbox → ingress pipeline.
	if rc := transporter.GetMsgBoxClient(); rc != nil {
		rc.SetOnMessage(func(payload []byte) {
			if err := ingressRouter.Ingest(context.Background(), "msgbox", payload); err != nil {
				slog.Warn("msgbox_client.ingest_failed", "error", err)
			}
		})
		go rc.Start(context.Background())
		slog.Info("MsgBox client started", "url", transporter.GetMsgBoxURL())
	}

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
			if n, err := outboxMgr.DeleteExpired(context.Background(), 86400); err == nil && n > 0 {
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

	// Reload persisted device keys into the auth validator so that
	// paired devices survive Core restarts. Without this, device
	// registrations persist to disk but signed requests fail after restart.
	{
		ctx := context.Background()
		devices, err := pairer.ListDevices(ctx)
		if err == nil {
			reloaded := 0
			for _, d := range devices {
				if d.DID != "" && !d.Revoked {
					// Extract raw public key from did:key multibase
					multibase := strings.TrimPrefix(d.DID, "did:key:")
					if len(multibase) > 1 && multibase[0] == 'z' {
						raw, decErr := base58.Decode(multibase[1:])
						if decErr == nil && len(raw) == 34 && raw[0] == 0xed && raw[1] == 0x01 {
							tokenValidator.RegisterDeviceKey(d.DID, raw[2:], d.TokenID)
							reloaded++
						}
					}
				}
			}
			if reloaded > 0 {
				slog.Info("pairing: reloaded device keys into auth validator", "count", reloaded)
			}
		}
	}

	estateSvc := service.NewEstateService(
		estateMgr, vaultMgr, recoveryMgr, notifier, clk,
	)

	migrationSvc := service.NewMigrationService(
		exportMgr, importMgr, backupMgr, vaultMgr, personaMgr, clk,
	)

	_ = service.NewSyncService(
		vaultMgr, vaultMgr, vaultMgr, wsHub, notifier, clk,
	)

	// SV4: Start the watchdog background loop. Runs every 30 seconds:
	// checks health, purges old audit/crash logs, monitors disk usage.
	watchdogSvc := service.NewWatchdogService(
		healthChecker, brain, crashLogger, auditLogger, clk,
	)
	go watchdogSvc.Start(context.Background(), func(report *domain.WatchdogReport, err error) {
		if err != nil {
			slog.Warn("watchdog tick error", "error", err)
		} else if report != nil {
			slog.Debug("watchdog tick",
				"audit_purged", report.AuditEntriesPurged,
				"crash_purged", report.CrashEntriesPurged,
				"brain_healthy", report.BrainHealthy)
		}
	})

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
	agentBrain.Tracer = tracer
	agentH := &handler.AgentHandler{Brain: agentBrain}

	// Staging inbox (connector ingestion pipeline).
	// CGO builds use durable SQLite (identity.sqlite). Non-CGO uses in-memory.
	stagingInbox := newStagingInbox(
		vaultMgr,
		func(persona string) bool {
			p, err := domain.NewPersonaName(persona)
			if err != nil {
				return false
			}
			return vaultMgr.IsOpen(p)
		},
		func(ctx context.Context, persona string, item domain.VaultItem) (string, error) {
			p, err := domain.NewPersonaName(persona)
			if err != nil {
				return "", err
			}
			return vaultSvc.Store(ctx, "staging", p, item)
		},
	)
	stagingH := &handler.StagingHandler{
		Staging:   stagingInbox,
		Devices:   deviceSvc,
		Brain:     brain,
		Personas:  personaMgr,
		Approvals: personaMgr,
		EnsureVaultOpen: func(ctx context.Context, persona string) error {
			p, err := domain.NewPersonaName(persona)
			if err != nil {
				return err
			}
			if vaultMgr.IsOpen(p) {
				return nil
			}
			personaID := "persona-" + persona
			tier, _ := personaMgr.GetTier(ctx, personaID)
			if tier == "locked" {
				return domain.ErrPersonaLocked
			}
			dekVersion, dvErr := personaMgr.GetDEKVersion(ctx, personaID)
			if dvErr != nil || dekVersion == 0 {
				dekVersion = 1
			}
			dek, dErr := keyDeriver.DerivePersonaDEKVersioned(masterSeed, p, dekVersion)
			if dErr != nil {
				return fmt.Errorf("staging auto-open: DEK derivation failed: %w", dErr)
			}
			return vaultMgr.Open(ctx, p, dek)
		},
	}

	// Wire late-binding D2D staging function now that stagingInbox exists.
	stageD2DMemory = func(ctx context.Context, msg *domain.DinaMessage) {
		vaultType, isMemory := domain.D2DMemoryTypes[msg.Type]
		if !isMemory {
			return
		}

		// Phase 5: Scenario-driven staging — only stage if scenario is not denied.
		// Carry scenario_tier + origin_contact in metadata for resolve decisions.
		scenarioTier := string(domain.ScenarioStandingPolicy) // default if no policy mgr
		if scenarioPolicyMgr != nil {
			scenario := domain.MsgTypeToScenario(msg.Type)
			if scenario != "" {
				tier, tierErr := scenarioPolicyMgr.GetScenarioTier(ctx, msg.From, scenario)
				if tierErr == nil && tier == domain.ScenarioDenyByDefault {
					slog.Info("ingress: D2D staging skipped — scenario denied",
						"type", string(msg.Type), "from", msg.From, "scenario", scenario)
					return
				}
				if tierErr == nil {
					scenarioTier = string(tier)
				}
			}
		}

		body := string(msg.Body)
		summary := body
		if len(summary) > 200 {
			summary = summary[:200]
		}
		// Preserve original DIDComm type, timestamp, scenario_tier, and
		// origin_contact in metadata so Brain's staging processor and
		// resolve logic can use them.
		meta := fmt.Sprintf(`{"didcomm_type":%q,"timestamp":%d,"scenario_tier":%q,"origin_contact":%q}`,
			string(msg.Type), msg.CreatedTime, scenarioTier, msg.From)
		item := domain.StagingItem{
			Source:         "d2d",
			SourceID:       msg.ID,
			Type:           vaultType,
			Summary:        summary,
			Body:           body,
			Sender:         msg.From,
			Metadata:       meta,
			IngressChannel: domain.IngressD2D,
			OriginDID:      msg.From,
			OriginKind:     domain.OriginRemoteDina,
			ProducerID:     "d2d:" + msg.From,
		}
		if _, err := stagingInbox.Ingest(ctx, item); err != nil {
			slog.Warn("ingress: D2D staging failed", "type", string(msg.Type), "error", err)
		} else {
			slog.Info("ingress: D2D memory content staged", "type", string(msg.Type), "from", msg.From)
		}
	}

	// Post-publication hook: when pending_unlock items are drained to vault,
	// push an event to Brain for event extraction (reminders, contacts).
	// Without this, items that were pending_unlock would never have their
	// derived artifacts (reminders, contact updates) created.
	type drainHookable interface {
		SetOnDrain(func(ctx context.Context, persona string, item domain.VaultItem))
	}
	if hookable, ok := stagingInbox.(drainHookable); ok {
		hookable.SetOnDrain(func(ctx context.Context, persona string, item domain.VaultItem) {
			go func() {
				// post_publish: lightweight event for derived artifacts (reminders,
				// contacts). NOT document_ingest which runs a full LLM pipeline.
				_ = brain.Process(context.Background(), domain.TaskEvent{
					Type: "post_publish",
					Payload: map[string]interface{}{
						"persona":        persona,
						"vault_item_id":  item.ID,
						"source":         item.Source,
						"type":           item.Type,
						"summary":        item.Summary,
						"body_text":      item.BodyText,
						"sender":         item.Sender,
						"contact_did":    item.ContactDID,
						"connector_id":   item.ConnectorID,
						"staging_origin": "drain",
					},
				})
			}()
		})
	}

	// Auto-open persona vaults on authorized access.
	// v1: sensitive personas are policy-gated (AccessPersona), not passphrase-unlocked.
	// The running node derives DEK from master seed and opens the vault on demand.
	// Locked-tier personas remain blocked — they require explicit manual unlock.
	vaultSvc.SetAutoUnlock(func(ctx context.Context, persona domain.PersonaName) error {
		personaID := "persona-" + string(persona)
		tier, _ := personaMgr.GetTier(ctx, personaID)
		if tier == "locked" {
			// Locked tier: explicit manual unlock only. Never auto-open.
			return domain.ErrPersonaLocked
		}
		dekVersion, dvErr := personaMgr.GetDEKVersion(ctx, personaID)
		if dvErr != nil || dekVersion == 0 {
			dekVersion = 1
		}
		dek, dErr := keyDeriver.DerivePersonaDEKVersioned(masterSeed, persona, dekVersion)
		if dErr != nil {
			return fmt.Errorf("auto-open: DEK derivation failed: %w", dErr)
		}
		if oErr := vaultMgr.Open(ctx, persona, dek); oErr != nil {
			return fmt.Errorf("auto-open: vault open failed: %w", oErr)
		}
		slog.Info("Persona vault auto-opened on authorized access",
			"persona", string(persona), "tier", tier)
		if n, drainErr := stagingInbox.DrainPending(ctx, string(persona)); drainErr != nil {
			slog.Warn("auto-open: staging drain failed", "persona", string(persona), "error", drainErr)
		} else if n > 0 {
			slog.Info("auto-open: drained pending staging", "persona", string(persona), "drained", n)
		}
		return nil
	})

	// Staging sweep: expire old items + revert expired classifying leases.
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			if n, err := stagingInbox.Sweep(context.Background()); err == nil && n > 0 {
				slog.Info("staging sweep", "cleaned", n)
			}
		}
	}()


	pendingReasonStore := newPendingReasonStore(vaultMgr)

	// Pending reason sweep: expire old entries.
	if pendingReasonStore != nil {
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				if n, err := pendingReasonStore.Sweep(context.Background()); err == nil && n > 0 {
					slog.Info("pending_reason sweep", "cleaned", n)
				}
			}
		}()
	}

	personaH := &handler.PersonaHandler{Identity: identitySvc, Personas: personaMgr, Approvals: personaMgr, VaultManager: vaultMgr, KeyDeriver: keyDeriver, Seed: masterSeed, StagingInbox: stagingInbox, PendingReasons: pendingReasonStore, Brain: brain}
	sessionH := &handler.SessionHandler{Sessions: personaMgr}
	trustH := &handler.TrustHandler{Trust: trustSvc, OwnDID: cfg.OwnDID}
	contactH := &handler.ContactHandler{Contacts: contactDir, Sharing: sharingMgr, ScenarioPolicies: scenarioPolicyMgr}
	piiH := &handler.PIIHandler{Scrubber: scrubber, Brain: brain}
	notifyH := &handler.NotifyHandler{Notifier: notifier}
	exportH := &handler.ExportHandler{Migration: migrationSvc}
	reminderH := &handler.ReminderHandler{
		Scheduler: reminderSched,
		Loop:      reminderLoop,
		OnFire: func(id, typ string) {
			rem, err := reminderSched.GetByID(context.Background(), id)
			if err != nil || rem == nil {
				onReminderFire(context.Background(), domain.Reminder{ID: id, Type: typ})
				return
			}
			onReminderFire(context.Background(), *rem)
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
	mux.HandleFunc("/v1/vault/item/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/enrich") {
			vaultH.HandleEnrich(w, r)
			return
		}
		routeByMethod(vaultH.HandleGetItem, vaultH.HandleDeleteItem)(w, r)
	})
	mux.HandleFunc("/v1/vault/kv/", routeByMethod(vaultH.HandleGetKV, vaultH.HandlePutKV))

	// Staging API (connector ingestion pipeline)
	mux.HandleFunc("/v1/staging/ingest", stagingH.HandleIngest)
	mux.HandleFunc("/v1/staging/claim", stagingH.HandleClaim)
	mux.HandleFunc("/v1/staging/resolve", stagingH.HandleResolve)
	mux.HandleFunc("/v1/staging/fail", stagingH.HandleFail)
	mux.HandleFunc("/v1/staging/extend-lease", stagingH.HandleExtendLease)
	mux.HandleFunc("/v1/staging/status/", stagingH.HandleStatus)

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

	// Trace API (admin-only)
	mux.HandleFunc("/v1/trace/", traceH.HandleQuery)

	// Task API
	mux.HandleFunc("/v1/task/ack", taskH.HandleAck)

	// Persona API
	mux.HandleFunc("/v1/personas", routeByMethod(personaH.HandleListPersonas, personaH.HandleCreatePersona))
	mux.HandleFunc("/v1/persona/edit", personaH.HandleEditPersona)
	mux.HandleFunc("/v1/persona/unlock", personaH.HandleUnlockPersona)
	mux.HandleFunc("/v1/persona/lock", personaH.HandleLockPersona)
	mux.HandleFunc("/v1/persona/approve", personaH.HandleApprove)
	mux.HandleFunc("/v1/persona/deny", personaH.HandleDeny)
	mux.HandleFunc("/v1/persona/approvals", personaH.HandleListApprovals)

	// Unified Approval API — type-agnostic, ID in URL path.
	// Old /v1/persona/ routes above remain as aliases.
	approvalH := &handler.ApprovalHandler{Persona: personaH}
	mux.HandleFunc("/v1/approvals", approvalH.HandleList)
	mux.HandleFunc("/v1/approvals/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/approve"):
			approvalH.HandleApprove(w, r)
		case strings.HasSuffix(path, "/deny"):
			approvalH.HandleDeny(w, r)
		default:
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		}
	})

	// Session API
	mux.HandleFunc("/v1/session/start", sessionH.HandleStartSession)
	mux.HandleFunc("/v1/session/end", sessionH.HandleEndSession)
	mux.HandleFunc("/v1/sessions", sessionH.HandleListSessions)

	// Contact API
	mux.HandleFunc("/v1/contacts", routeByMethod(contactH.HandleListContacts, contactH.HandleAddContact))
	mux.HandleFunc("/v1/contacts/by-name/", contactH.HandleDeleteContactByName)
	mux.HandleFunc("/v1/contacts/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/policy") {
			// /v1/contacts/{did}/policy → policy handlers
			routeByMethod(contactH.HandleGetPolicy, contactH.HandleSetPolicy)(w, r)
		} else if strings.HasSuffix(r.URL.Path, "/scenarios") {
			// /v1/contacts/{did}/scenarios → scenario policy handlers
			routeByMethod(contactH.HandleListScenarios, contactH.HandleSetScenarios)(w, r)
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
	mux.HandleFunc("/v1/trust/search", trustH.HandleSearch)

	// Device Pairing API
	mux.HandleFunc("/v1/pair/initiate", deviceH.HandleInitiatePairing)
	mux.HandleFunc("/v1/pair/complete", deviceH.HandleCompletePairing)
	mux.HandleFunc("/v1/devices", deviceH.HandleListDevices)
	mux.HandleFunc("/v1/devices/", deviceH.HandleRevokeDevice)

	// Agent Safety Layer — proxies to brain's guardian
	mux.HandleFunc("/v1/agent/validate", agentH.HandleValidate)

	// Intent proposal lifecycle — approve/deny/status/list
	intentProposalH := &handler.IntentProposalHandler{Brain: agentBrain, BrainHTTP: agentBrain}
	mux.HandleFunc("/v1/intent/proposals/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/approve"):
			intentProposalH.HandleApprove(w, r)
		case strings.HasSuffix(path, "/deny"):
			intentProposalH.HandleDeny(w, r)
		case strings.HasSuffix(path, "/status"):
			intentProposalH.HandleStatus(w, r)
		default:
			intentProposalH.HandleList(w, r)
		}
	})

	// Notification API
	mux.HandleFunc("/v1/notify", notifyH.HandleNotify)

	// Reminder API
	mux.HandleFunc("/v1/reminder", reminderH.HandleStoreReminder)
	mux.HandleFunc("/v1/reminder/", reminderH.HandleDelete)
	mux.HandleFunc("/v1/reminders/pending", reminderH.HandleListPending)

	// Brain reasoning proxy — agents interact with Brain via Core.
	// Core re-signs the request with its own service key (agents have device keys).
	// Session validator — checks session is real and active for agent callers.
	validateSession := handler.SessionValidator(func(sessionID, agentDID string) bool {
		s, err := personaMgr.GetSession(context.Background(), agentDID, sessionID)
		return err == nil && s != nil
	})

	reasonH := &handler.ReasonHandler{Brain: brain, PendingReasons: pendingReasonStore, ValidateSession: validateSession}
	mux.HandleFunc("/api/v1/ask", reasonH.HandleReason)        // POST /api/v1/ask
	mux.HandleFunc("/api/v1/ask/", reasonH.HandleReasonStatus) // GET /api/v1/ask/{id}/status

	// User-facing solicited memory write — wraps staging with synchronous completion.
	rememberH := &handler.RememberHandler{StagingHandler: stagingH, Staging: stagingInbox, Brain: brain, ValidateSession: validateSession}
	mux.HandleFunc("/api/v1/remember", rememberH.HandleRemember)
	mux.HandleFunc("/api/v1/remember/", rememberH.HandleRememberStatus) // GET /api/v1/remember/{id}
	mux.HandleFunc("/v1/reason/", reasonH.HandleReasonResult)     // POST /v1/reason/{id}/result (Brain callback)

	// Admin proxy
	// CXH6: sync-status moved to /v1/ prefix so it goes through auth middleware.
	mux.HandleFunc("/v1/admin/sync-status", adminH.HandleSyncStatus)
	mux.HandleFunc("/admin/", adminH.HandleAdmin)

	// Export/Import API
	mux.HandleFunc("/v1/export", exportH.HandleExport)
	mux.HandleFunc("/v1/import", exportH.HandleImport)

	// WebSocket endpoint (CORE-MED-07)
	// Auth is Ed25519-only: the upgrade request must be signed with a device key.
	// The auth middleware verifies the signature before the upgrade reaches here.
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		var wsOpts []ws.UpgraderOption
		if cfg.AllowedOrigins != "" {
			wsOpts = append(wsOpts, ws.WithOriginPatterns(strings.Split(cfg.AllowedOrigins, ",")...))
		}
		wsUpgrader := ws.NewUpgrader(wsOpts...)
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
		wsHandlerWS := ws.NewWSHandler(wsBrainRouter)
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
		// Register a service key at runtime (test-only — for connector auth tests).
		mux.HandleFunc("/v1/test/register-service-key", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
				return
			}
			var req struct {
				DID       string `json:"did"`
				PublicKey string `json:"public_key"` // hex-encoded 32-byte Ed25519 public key
				ServiceID string `json:"service_id"` // "connector", "admin", etc.
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DID == "" || req.PublicKey == "" || req.ServiceID == "" {
				http.Error(w, `{"error":"did, public_key (hex), and service_id required"}`, http.StatusBadRequest)
				return
			}
			pubBytes, err := hex.DecodeString(req.PublicKey)
			if err != nil || len(pubBytes) != 32 {
				http.Error(w, `{"error":"public_key must be 64-char hex (32 bytes)"}`, http.StatusBadRequest)
				return
			}
			tokenValidator.RegisterServiceKey(req.DID, pubBytes, req.ServiceID)
			slog.Warn("TEST: registered service key", "did", req.DID, "service", req.ServiceID)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"status": "registered", "service_id": req.ServiceID})
		})
	}

	// ---------- Apply middleware chain ----------

	authMW := &middleware.Auth{Tokens: tokenValidator, ScopeResolver: tokenValidator}
	authzMW := middleware.NewAuthzMiddleware(auth.NewAdminEndpointChecker())
	rateLimitMW := &middleware.RateLimit{Limiter: rateLimiter, TrustedProxies: parseCIDRs(cfg.TrustedProxies)}
	recovery := &middleware.Recovery{Emitter: tracer}
	logging := &middleware.Logging{Emitter: tracer}
	timeout := &middleware.Timeout{Duration: 30 * time.Second}
	cors := &middleware.CORS{AllowOrigin: cfg.AllowedOrigins}

	// Chain: CORS → BodyLimit → Recovery → Logging → RateLimit → Auth → Authz → Timeout → Router
	var chain http.Handler = mux
	chain = timeout.Handler(chain)
	chain = authzMW(chain)
	chain = logging.Handler(chain) // after auth so caller/did context is available
	chain = authMW.Handler(chain)
	chain = rateLimitMW.Handler(chain)
	chain = recovery.Handler(chain)
	chain = middleware.BodyLimit(1 << 20)(chain) // 1 MB default body limit
	chain = middleware.RequestIDMiddleware(chain) // cross-service audit correlation
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
		socketChain = middleware.RequestIDMiddleware(socketChain)

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

// auditD2DIngress writes a D2D ingress event to the audit log.
// Best-effort: audit failure never blocks the ingress pipeline.
func auditD2DIngress(auditor port.VaultAuditLogger, action, fromDID, msgType, reason string) {
	if auditor == nil {
		return
	}
	metadata := fmt.Sprintf(`{"from":%q,"msg_type":%q,"reason":%q}`,
		fromDID, msgType, reason)
	entry := domain.VaultAuditEntry{
		Timestamp: time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		Action:    action,
		Requester: fromDID,
		QueryType: msgType,
		Reason:    reason,
		Metadata:  metadata,
	}
	_, _ = auditor.Append(context.Background(), entry)
}
