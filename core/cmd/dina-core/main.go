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
	"net"
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
	trustadapter "github.com/rajmohanutopai/dina/core/internal/adapter/trust"
	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
	"github.com/rajmohanutopai/dina/core/internal/adapter/ws"
	"github.com/mr-tron/base58"
	"github.com/rajmohanutopai/dina/core/internal/config"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/internal/ingress"
	"github.com/rajmohanutopai/dina/core/internal/reminder"
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

	if err := cfgLoader.Validate(cfg); err != nil {
		slog.Error("invalid configuration", "error", err)
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
	// Priority: 1) DINA_IDENTITY_SEED env var, 2) wrapped seed file (.wrapped), 3) plaintext seed file (.hex), 4) generate new.
	bootstrapSeed := make([]byte, 32)
	seedPath := filepath.Join(cfg.VaultPath, "identity_seed.hex")
	wrappedSeedPath := filepath.Join(cfg.VaultPath, "identity_seed.wrapped")
	saltPath := filepath.Join(cfg.VaultPath, "identity_seed.salt")
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

	// SEC-CRITICAL-03: Early production guard — refuse plaintext seed paths before any file I/O.
	// DINA_IDENTITY_SEED env var is acceptable (no file written), but no-password paths are not.
	dinaEnv := os.Getenv("DINA_ENV")
	isDevOrTest := dinaEnv == "test" || dinaEnv == "development" || dinaEnv == "migration"
	if seedPassword == "" && os.Getenv("DINA_IDENTITY_SEED") == "" && !isDevOrTest {
		log.Fatal("SECURITY: DINA_SEED_PASSWORD or DINA_IDENTITY_SEED is required when DINA_ENV is not test/development/migration")
	}

	// Derive KEK from seed password if configured.
	// SEC-HIGH-07: Use Argon2id with random persisted salt (not deterministic from path).
	var seedKEK []byte
	var legacySHA256KEK []byte // migration path for existing SHA-256 wrapped seeds
	var saltMigrationNeeded bool
	if seedPassword != "" {
		// Load persisted random salt, or fall back to deterministic salt for migration.
		var argon2Salt []byte
		if data, err := os.ReadFile(saltPath); err == nil && len(data) == 16 {
			argon2Salt = data
		} else {
			// No salt file yet. If a wrapped seed exists, it was created with the
			// old deterministic salt. Use that to unwrap, then migrate to random salt.
			saltMigrationNeeded = true
			legacySaltHash := sha256.Sum256([]byte(filepath.Dir(wrappedSeedPath)))
			argon2Salt = legacySaltHash[:16]
		}
		var kekErr error
		seedKEK, kekErr = argon2Deriver.DeriveKEK(seedPassword, argon2Salt)
		if kekErr != nil {
			slog.Error("Failed to derive Argon2id KEK from seed password", "error", kekErr)
			os.Exit(1)
		}
		// Keep SHA-256 KEK for migration from legacy wrapped seeds.
		legacyHash := sha256.Sum256([]byte(seedPassword))
		legacySHA256KEK = legacyHash[:]
	}

	// migrateSalt generates a random salt, re-derives KEK, re-wraps the seed, and persists both.
	migrateSalt := func(seed, currentKEK []byte) {
		newSalt := make([]byte, 16)
		if _, err := crypto_rand.Read(newSalt); err != nil {
			slog.Error("Failed to generate random Argon2id salt", "error", err)
			os.Exit(1)
		}
		newKEK, err := argon2Deriver.DeriveKEK(seedPassword, newSalt)
		if err != nil {
			slog.Error("Failed to derive Argon2id KEK with new salt", "error", err)
			os.Exit(1)
		}
		rewrapped, err := keyWrapper.Wrap(seed, newKEK)
		if err != nil {
			slog.Error("Failed to re-wrap seed with new salt KEK", "error", err)
			os.Exit(1)
		}
		os.MkdirAll(filepath.Dir(wrappedSeedPath), 0700)
		if err := os.WriteFile(wrappedSeedPath, rewrapped, 0600); err != nil {
			slog.Warn("Could not persist re-wrapped identity seed", "error", err)
		}
		if err := os.WriteFile(saltPath, newSalt, 0600); err != nil {
			slog.Warn("Could not persist Argon2id salt", "error", err)
		} else {
			slog.Info("Argon2id salt migrated to random persisted value", "path", saltPath)
		}
		// Update seedKEK to the new one for remainder of bootstrap.
		copy(currentKEK, newKEK)
	}

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
	} else if seedKEK != nil {
		// Try wrapped seed first.
		if data, err := os.ReadFile(wrappedSeedPath); err == nil {
			// SEC-HIGH-07: Try Argon2id KEK first, then fall back to legacy SHA-256 KEK.
			unwrapped, err := keyWrapper.Unwrap(data, seedKEK)
			if err != nil {
				// Migration path: try legacy SHA-256 KEK.
				unwrapped, err = keyWrapper.Unwrap(data, legacySHA256KEK)
				if err != nil {
					slog.Error("Failed to unwrap identity seed — wrong DINA_SEED_PASSWORD?", "error", err)
					os.Exit(1)
				}
				if len(unwrapped) != 32 {
					slog.Error("Unwrapped seed has wrong length", "got_bytes", len(unwrapped))
					os.Exit(1)
				}
				copy(bootstrapSeed, unwrapped)
				// Re-wrap with Argon2id KEK + random salt.
				migrateSalt(bootstrapSeed, seedKEK)
				slog.Info("seed KEK upgraded from SHA-256 to Argon2id with random salt", "path", wrappedSeedPath)
			} else {
				if len(unwrapped) != 32 {
					slog.Error("Unwrapped seed has wrong length", "got_bytes", len(unwrapped))
					os.Exit(1)
				}
				copy(bootstrapSeed, unwrapped)
				// SEC-HIGH-07: If unwrapped with deterministic salt, migrate to random salt.
				if saltMigrationNeeded {
					migrateSalt(bootstrapSeed, seedKEK)
				} else {
					slog.Info("Loaded wrapped identity seed", "path", wrappedSeedPath)
				}
			}
		} else if data, err := os.ReadFile(seedPath); err == nil {
			// Auto-migrate from plaintext .hex to .wrapped
			decoded, err := hex.DecodeString(strings.TrimSpace(string(data)))
			if err != nil || len(decoded) != 32 {
				slog.Error("Corrupt identity seed file — refusing to start", "path", seedPath, "error", err)
				os.Exit(1)
			}
			copy(bootstrapSeed, decoded)
			// Wrap with random salt (new installation path, skip deterministic salt entirely).
			migrateSalt(bootstrapSeed, seedKEK)
			// SEC-HIGH-06: Delete plaintext .hex file after successful migration.
			if err := os.Remove(seedPath); err != nil {
				slog.Warn("Could not delete plaintext seed file after migration", "path", seedPath, "error", err)
			} else {
				slog.Info("Deleted plaintext seed file after migration to wrapped", "path", seedPath)
			}
		} else {
			// Generate new seed and wrap it with random salt.
			if _, err := crypto_rand.Read(bootstrapSeed); err != nil {
				slog.Error("Failed to generate random seed", "error", err)
				os.Exit(1)
			}
			migrateSalt(bootstrapSeed, seedKEK)
			slog.Info("Generated and wrapped new identity seed with random salt", "path", wrappedSeedPath)
		}
	} else if isDevOrTest {
		// SEC-CRITICAL-03: Plaintext seed paths only allowed in dev/test/migration.
		// The early production guard above already prevents reaching here in production.
		if data, err := os.ReadFile(seedPath); err == nil {
			decoded, err := hex.DecodeString(strings.TrimSpace(string(data)))
			if err != nil || len(decoded) != 32 {
				slog.Error("Corrupt identity seed file — refusing to start", "path", seedPath, "error", err)
				os.Exit(1)
			}
			copy(bootstrapSeed, decoded)
			slog.Warn("Identity seed loaded from PLAINTEXT file (dev/test only)", "path", seedPath)
		} else {
			if _, err := crypto_rand.Read(bootstrapSeed); err != nil {
				slog.Error("Failed to generate random seed", "error", err)
				os.Exit(1)
			}
			os.MkdirAll(filepath.Dir(seedPath), 0700)
			if err := os.WriteFile(seedPath, []byte(hex.EncodeToString(bootstrapSeed)), 0600); err != nil {
				slog.Warn("Could not persist identity seed", "error", err)
			} else {
				slog.Warn("Generated new identity seed in PLAINTEXT (dev/test only)", "path", seedPath)
			}
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
	// CRITICAL-01: Wire orphan-guard callback. If vault DB files exist on disk for
	// a persona that has no in-memory state, reject creation to prevent DEK reuse.
	personaMgr.CheckOrphanedVault = func(personaID string) bool {
		name := strings.TrimPrefix(personaID, "persona-")
		dbFile := filepath.Join(cfg.VaultPath, name+".sqlite")
		_, err := os.Stat(dbFile)
		return err == nil // file exists → orphaned vault artifact
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
	// Format: did=endpoint=seedhex (3 parts) or did=endpoint (2 parts, legacy).
	if peers := os.Getenv("DINA_KNOWN_PEERS"); peers != "" {
		for i, entry := range strings.Split(peers, ",") {
			parts := strings.SplitN(entry, "=", 3)
			if len(parts) < 2 {
				// MEDIUM-09: Log bad entries instead of silently skipping.
				slog.Warn("KNOWN_PEERS: skipping malformed entry", "index", i, "entry", entry)
				continue
			}
			did := strings.TrimSpace(parts[0])
			endpoint := strings.TrimSpace(parts[1])

			var pubKeyMultibase string
			if len(parts) == 3 {
				// Real key exchange: derive peer's Ed25519 public key from their seed.
				peerSeedHex := strings.TrimSpace(parts[2])
				peerSeedBytes, seedErr := hex.DecodeString(peerSeedHex)
				if seedErr != nil {
					slog.Warn("KNOWN_PEERS: skipping entry with invalid seed hex", "index", i, "did", did, "error", seedErr)
					continue
				}
				if len(peerSeedBytes) != 32 {
					slog.Warn("KNOWN_PEERS: skipping entry with invalid seed length", "index", i, "did", did, "got", len(peerSeedBytes), "expected", 32)
					continue
				}
				_, peerKeyBytes, deriveErr := slip0010.DerivePath(peerSeedBytes, "m/9999'/0'")
				if deriveErr != nil {
					slog.Warn("KNOWN_PEERS: skipping entry with key derivation failure", "index", i, "did", did, "error", deriveErr)
					continue
				}
				var peerPrivKey ed25519.PrivateKey
				if len(peerKeyBytes) == ed25519.SeedSize {
					peerPrivKey = ed25519.NewKeyFromSeed(peerKeyBytes)
				} else {
					peerPrivKey = ed25519.PrivateKey(peerKeyBytes)
				}
				peerPubKey := peerPrivKey.Public().(ed25519.PublicKey)
				// HIGH-05: Encode as proper multibase (z + base58btc(0xed01 + pubkey)).
				multicodecKey := append([]byte{0xed, 0x01}, peerPubKey...)
				pubKeyMultibase = "z" + base58.Encode(multicodecKey)
			} else {
				// Legacy: deterministic placeholder pubkey from the DID.
				peerSeed := sha256.Sum256([]byte(did))
				multicodecKey := append([]byte{0xed, 0x01}, peerSeed[:]...)
				pubKeyMultibase = "z" + base58.Encode(multicodecKey)
				slog.Warn("KNOWN_PEERS: using SHA-256 placeholder key — provide seed for real key exchange", "did", did)
			}

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

	// 11. Pairing
	pairer := pairing.NewManager(pairing.DefaultConfig())

	// 12. Brain Client
	brain := brainclient.New(cfg.BrainURL, cfg.BrainToken)

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
		// Check 1: config must have a valid client/brain token
		if cfg.BrainToken == "" {
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
	exportMgr := portability.NewExportManager()
	importMgr := portability.NewImportManager(false)

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
	deviceSvc.SetTokenRegistrar(tokenValidator)
	deviceSvc.SetTokenRevoker(tokenValidator)


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

	// SEC-HIGH-03: Use a separate internal token for brain proxy communication.
	internalToken := os.Getenv("DINA_INTERNAL_TOKEN")
	if internalToken == "" {
		env := os.Getenv("DINA_ENV")
		if env != "test" && env != "development" {
			log.Fatal("SECURITY: DINA_INTERNAL_TOKEN must be set in production (required for brain proxy)")
		}
		slog.Warn("SECURITY: DINA_INTERNAL_TOKEN not set — admin proxy will return 503")
	}

	healthH := &handler.HealthHandler{Health: healthChecker}
	adminH := &handler.AdminHandler{ProxyURL: cfg.BrainURL, Token: cfg.ClientToken, InternalToken: internalToken}
	vaultH := &handler.VaultHandler{Vault: vaultSvc, PII: scrubber}
	identityH := &handler.IdentityHandler{Identity: identitySvc, DID: didMgr, Signer: identitySigner}
	messageH := &handler.MessageHandler{Transport: transportSvc, IngressRouter: ingressRouter}
	taskH := &handler.TaskHandler{Task: taskSvc}
	deviceH := &handler.DeviceHandler{Device: deviceSvc}
	// Agent validation proxy uses DINA_INTERNAL_TOKEN (same as admin proxy),
	// not cfg.BrainToken. This separates the internal proxy credential from
	// the machine-to-machine Brain token used by Core's own BrainClient.
	// In dev/test where DINA_INTERNAL_TOKEN may be unset, fall back to BrainToken.
	agentProxyToken := internalToken
	if agentProxyToken == "" {
		agentProxyToken = cfg.BrainToken
	}
	agentBrain := brainclient.New(cfg.BrainURL, agentProxyToken)
	agentH := &handler.AgentHandler{Brain: agentBrain}

	personaH := &handler.PersonaHandler{Identity: identitySvc, Personas: personaMgr, VaultManager: vaultMgr, KeyDeriver: keyDeriver, Seed: bootstrapSeed}
	trustH := &handler.TrustHandler{Trust: trustSvc, OwnDID: cfg.OwnDID}
	contactH := &handler.ContactHandler{Contacts: contactDir, Sharing: sharingMgr}
	piiH := &handler.PIIHandler{Scrubber: scrubber}
	notifyH := &handler.NotifyHandler{Notifier: notifier}
	exportH := &handler.ExportHandler{}
	reminderH := &handler.ReminderHandler{
		Scheduler: reminderSched,
		Loop:      reminderLoop,
		OnFire: func(id, typ string) {
			onReminderFire(context.Background(), id, typ)
		},
	}
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
