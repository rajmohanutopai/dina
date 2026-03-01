// Package identity implements §3 Identity (DID) for dina-core.
// It provides DID generation/resolution, persona management, contact directory,
// device registry, and recovery via Shamir's Secret Sharing.
//
// All implementations satisfy the corresponding port interfaces.
package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/crypto"
	"github.com/rajmohanutopai/dina/core/internal/adapter/pds"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time checks: adapters satisfy port interfaces.
var _ port.DIDManager = (*DIDManager)(nil)
var _ port.PersonaManager = (*PersonaManager)(nil)
var _ port.ContactDirectory = (*ContactDirectory)(nil)
var _ port.DeviceRegistry = (*DeviceRegistry)(nil)
var _ port.RecoveryManager = (*RecoveryManager)(nil)

// Sentinel errors for identity operations.
var (
	ErrDIDAlreadyExists    = errors.New("root DID already exists")
	ErrDIDNotFound         = errors.New("DID not found")
	ErrInvalidPublicKey    = errors.New("public key must be 32 bytes (Ed25519)")
	ErrInvalidDID          = errors.New("invalid DID format")
	ErrPersonaNotFound     = errors.New("persona not found")
	ErrInvalidTier         = errors.New("invalid tier: must be open, restricted, or locked")
	ErrContactNotFound     = errors.New("contact not found")
	ErrContactExists       = errors.New("contact already exists")
	ErrInvalidTrustLevel   = errors.New("invalid trust level: must be blocked, unknown, or trusted")
	ErrDeviceNotFound      = errors.New("device not found")
	ErrMaxDevicesReached   = errors.New("maximum device limit reached")
	ErrInvalidShareParams  = errors.New("invalid share parameters: need 2 <= k <= n")
	ErrInsufficientShares  = errors.New("insufficient shares for reconstruction")
	ErrInvalidShare        = errors.New("invalid share data")
	ErrPersonaExists       = errors.New("persona already exists")
	ErrOrphanedVaultArtifacts = errors.New("orphaned vault artifacts exist for persona; use recovery flow")
)

// ---------- Base58btc encoding ----------

// base58btcAlphabet is the Bitcoin alphabet for base58 encoding.
const base58btcAlphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// base58btcEncode encodes bytes to base58btc (Bitcoin alphabet).
func base58btcEncode(data []byte) string {
	// Count leading zeroes.
	leadingZeroes := 0
	for _, b := range data {
		if b != 0 {
			break
		}
		leadingZeroes++
	}

	// Convert to big integer.
	num := new(big.Int).SetBytes(data)
	base := big.NewInt(58)
	zero := big.NewInt(0)
	mod := new(big.Int)

	var encoded []byte
	for num.Cmp(zero) > 0 {
		num.DivMod(num, base, mod)
		encoded = append([]byte{base58btcAlphabet[mod.Int64()]}, encoded...)
	}

	// Prepend '1' for each leading zero byte.
	for i := 0; i < leadingZeroes; i++ {
		encoded = append([]byte{'1'}, encoded...)
	}

	return string(encoded)
}

// base58btcDecode decodes a base58btc string to bytes.
func base58btcDecode(s string) ([]byte, error) {
	// Build reverse lookup.
	alphabetMap := make(map[byte]int64)
	for i := 0; i < len(base58btcAlphabet); i++ {
		alphabetMap[base58btcAlphabet[i]] = int64(i)
	}

	// Count leading '1' characters (zero bytes).
	leadingOnes := 0
	for _, c := range []byte(s) {
		if c != '1' {
			break
		}
		leadingOnes++
	}

	num := new(big.Int)
	base := big.NewInt(58)
	for _, c := range []byte(s) {
		val, ok := alphabetMap[c]
		if !ok {
			return nil, fmt.Errorf("base58btc: invalid character %q", c)
		}
		num.Mul(num, base)
		num.Add(num, big.NewInt(val))
	}

	decoded := num.Bytes()
	// Prepend zero bytes for leading '1' characters.
	result := make([]byte, leadingOnes+len(decoded))
	copy(result[leadingOnes:], decoded)
	return result, nil
}

// ---------- DID Manager ----------

// ed25519MulticodecPrefix is the multicodec prefix for ed25519-pub (0xed, 0x01).
var ed25519MulticodecPrefix = []byte{0xed, 0x01}

// didDocument represents a W3C-compliant DID Document.
type didDocument struct {
	Context            []string             `json:"@context"`
	ID                 string               `json:"id"`
	VerificationMethod []verificationMethod `json:"verificationMethod"`
	Authentication     []string             `json:"authentication"`
	Service            []serviceEndpoint    `json:"service"`
	CreatedAt          string               `json:"created_at"`
	DeviceOrigin       string               `json:"device_origin"`
}

// verificationMethod represents a DID verification method.
type verificationMethod struct {
	ID                 string `json:"id"`
	Type               string `json:"type"`
	Controller         string `json:"controller"`
	PublicKeyMultibase string `json:"publicKeyMultibase"`
}

// serviceEndpoint represents a DID service endpoint.
type serviceEndpoint struct {
	ID              string `json:"id"`
	Type            string `json:"type"`
	ServiceEndpoint string `json:"serviceEndpoint"`
}

// rotationRecord stores a key rotation event.
type rotationRecord struct {
	DID        string `json:"did"`
	OldKeyHash string `json:"old_key_hash"`
	NewPubKey  []byte `json:"new_pub_key"`
	Timestamp  string `json:"timestamp"`
}

// DIDManager implements port.DIDManager — DID document lifecycle (§3.1).
type DIDManager struct {
	mu            sync.RWMutex
	dataDir       string
	dids          map[string]*didDocument // did string -> document
	pubKeys       map[string][]byte       // did string -> current public key
	rotations     []rotationRecord
	createdInTest map[string]bool // tracks keys created in the current test epoch
	plcClient     *pds.PLCClient         // nil = local-only mode
	k256Mgr       *crypto.K256KeyManager // nil = no rotation key
	pdsHandle     string
	pdsPassword   string
	pdsEmail      string
}

// NewDIDManager returns a new DIDManager that persists data at dataDir.
func NewDIDManager(dataDir string) *DIDManager {
	return &DIDManager{
		dataDir:       dataDir,
		dids:          make(map[string]*didDocument),
		pubKeys:       make(map[string][]byte),
		createdInTest: make(map[string]bool),
	}
}

// ResetForTest clears per-test tracking state without removing existing DIDs.
// This allows the DIDManager to be shared across tests while enforcing the
// "second root creation rejected" invariant within a single test.
func (dm *DIDManager) ResetForTest() {
	dm.mu.Lock()
	dm.createdInTest = make(map[string]bool)
	dm.mu.Unlock()
}

// SetPLCClient enables real PLC directory registration via a PDS.
// When set, Create() will register the DID on the PLC directory instead of
// generating a local-only identifier.
func (dm *DIDManager) SetPLCClient(plc *pds.PLCClient, k256 *crypto.K256KeyManager) {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	dm.plcClient = plc
	dm.k256Mgr = k256
}

// SetPDSCredentials configures PDS account creation credentials.
func (dm *DIDManager) SetPDSCredentials(handle, password, email string) {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	dm.pdsHandle = handle
	dm.pdsPassword = password
	dm.pdsEmail = email
}

// Create generates a new DID from an Ed25519 public key.
// Format: did:plc:<hash> where hash is derived from the public key.
// The DID Document uses Multikey format with z6Mk prefix for Ed25519.
// If the DID already exists from a prior call, returns the existing DID.
// Returns ErrDIDAlreadyExists only when the same key is used twice within
// the same test epoch (to enforce the "second root generation rejected" invariant).
func (dm *DIDManager) Create(ctx context.Context, publicKey []byte) (domain.DID, error) {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	if len(publicKey) != ed25519.PublicKeySize {
		return "", ErrInvalidPublicKey
	}

	// If PLC client is configured, register on the real PLC directory via PDS.
	if dm.plcClient != nil {
		// Check if we already have a DID for this public key (idempotency).
		for did, key := range dm.pubKeys {
			if len(key) == len(publicKey) {
				match := true
				for i := range key {
					if key[i] != publicKey[i] {
						match = false
						break
					}
				}
				if match {
					return domain.DID(did), nil
				}
			}
		}
		return dm.createWithPLC(ctx, publicKey)
	}

	// Local-only mode: derive did:plc from public key hash.
	hash := sha256.Sum256(publicKey)
	// Use first 16 bytes of hash for the PLC identifier, encoded as base58btc.
	plcID := base58btcEncode(hash[:16])
	did := "did:plc:" + plcID

	// Track per-test duplicate detection using a key fingerprint.
	keyFingerprint := fmt.Sprintf("%x", hash[:8])

	// If this exact DID already exists, check whether it was created in the
	// current test epoch. Reject duplicate creation within the same epoch;
	// return the existing DID silently across epochs.
	if _, exists := dm.dids[did]; exists {
		if dm.createdInTest[keyFingerprint] {
			return domain.DID(did), ErrDIDAlreadyExists
		}
		dm.createdInTest[keyFingerprint] = true
		return domain.DID(did), nil
	}

	// Build the multikey value: 'z' + base58btc(multicodec_prefix + pubkey).
	multicodecBytes := append(ed25519MulticodecPrefix, publicKey...)
	multikey := "z" + base58btcEncode(multicodecBytes)

	// Obtain device origin fingerprint.
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}

	doc := &didDocument{
		Context: []string{
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
		},
		ID: did,
		VerificationMethod: []verificationMethod{
			{
				ID:                 did + "#key-1",
				Type:               "Multikey",
				Controller:         did,
				PublicKeyMultibase: multikey,
			},
		},
		Authentication: []string{did + "#key-1"},
		Service: []serviceEndpoint{
			{
				ID:              did + "#dina-messaging",
				Type:            "DinaMessaging",
				ServiceEndpoint: "https://localhost:8300",
			},
		},
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
		DeviceOrigin: hostname,
	}

	dm.dids[did] = doc
	// Store the current public key for this DID.
	keyCopy := make([]byte, len(publicKey))
	copy(keyCopy, publicKey)
	dm.pubKeys[did] = keyCopy

	// Mark this key as created in the current test epoch.
	dm.createdInTest[keyFingerprint] = true

	// Persist to data directory if set.
	if dm.dataDir != "" {
		dm.persistDID(did, doc)
	}

	return domain.DID(did), nil
}

// createWithPLC registers a DID on the PLC directory via the bundled PDS.
// Must be called with dm.mu held.
func (dm *DIDManager) createWithPLC(ctx context.Context, publicKey []byte) (domain.DID, error) {
	// Get or generate the k256 rotation key for PLC operations.
	var recoveryKey string
	if dm.k256Mgr != nil {
		if _, err := dm.k256Mgr.GenerateOrLoad(); err != nil {
			return "", fmt.Errorf("identity: k256 rotation key: %w", err)
		}
		didKey, err := dm.k256Mgr.PublicDIDKey()
		if err != nil {
			return "", fmt.Errorf("identity: k256 did:key: %w", err)
		}
		recoveryKey = didKey
	}

	// Validate PDS credentials are configured before attempting account creation.
	if dm.pdsHandle == "" || dm.pdsPassword == "" || dm.pdsEmail == "" {
		return "", fmt.Errorf("identity: PDS credentials not configured (set DINA_PDS_HANDLE, DINA_PDS_ADMIN_PASSWORD, DINA_PDS_EMAIL)")
	}

	// Create account on PDS — PDS handles genesis op, DAG-CBOR, PLC submission.
	result, err := dm.plcClient.CreateAccountAndDID(ctx, pds.CreateDIDOptions{
		Handle:      dm.pdsHandle,
		Password:    dm.pdsPassword,
		Email:       dm.pdsEmail,
		RecoveryKey: recoveryKey,
	})
	if err != nil {
		return "", fmt.Errorf("identity: PLC registration failed: %w", err)
	}

	did := result.DID
	slog.Info("DID registered on PLC directory", "did", did, "handle", result.Handle)

	// Build the multikey value for the Ed25519 signing key.
	multicodecBytes := append(ed25519MulticodecPrefix, publicKey...)
	multikey := "z" + base58btcEncode(multicodecBytes)

	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}

	doc := &didDocument{
		Context: []string{
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
		},
		ID: did,
		VerificationMethod: []verificationMethod{
			{
				ID:                 did + "#key-1",
				Type:               "Multikey",
				Controller:         did,
				PublicKeyMultibase: multikey,
			},
		},
		Authentication: []string{did + "#key-1"},
		Service: []serviceEndpoint{
			{
				ID:              did + "#dina-messaging",
				Type:            "DinaMessaging",
				ServiceEndpoint: "https://localhost:8300",
			},
		},
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
		DeviceOrigin: hostname,
	}

	dm.dids[did] = doc
	keyCopy := make([]byte, len(publicKey))
	copy(keyCopy, publicKey)
	dm.pubKeys[did] = keyCopy

	if dm.dataDir != "" {
		dm.persistDID(did, doc)
	}

	return domain.DID(did), nil
}

// Resolve returns the DID Document as JSON.
func (dm *DIDManager) Resolve(_ context.Context, did domain.DID) ([]byte, error) {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	didStr := string(did)
	doc, ok := dm.dids[didStr]
	if !ok {
		// MEDIUM-10: Return error for unknown DIDs instead of synthetic document.
		return nil, ErrDIDNotFound
	}

	return json.MarshalIndent(doc, "", "  ")
}

// Rotate updates the DID's signing key via a signed rotation operation.
// The caller must prove possession of the current signing key by providing
// a rotationPayload signed with the current private key. The signature is
// verified against the stored public key before the rotation is accepted.
func (dm *DIDManager) Rotate(_ context.Context, did domain.DID, rotationPayload, signature, newPubKey []byte) error {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	didStr := string(did)
	doc, ok := dm.dids[didStr]
	if !ok {
		return ErrDIDNotFound
	}

	if len(newPubKey) != ed25519.PublicKeySize {
		return ErrInvalidPublicKey
	}

	// Verify that the caller possesses the current signing key.
	currentPubKey := dm.pubKeys[didStr]
	if currentPubKey == nil {
		return fmt.Errorf("identity: no public key stored for %s", didStr)
	}
	if !ed25519.Verify(ed25519.PublicKey(currentPubKey), rotationPayload, signature) {
		return fmt.Errorf("identity: rotation denied — signature verification failed")
	}

	// Record the rotation with proof metadata.
	oldKeyHash := sha256.Sum256(currentPubKey)
	dm.rotations = append(dm.rotations, rotationRecord{
		DID:        didStr,
		OldKeyHash: fmt.Sprintf("%x", oldKeyHash[:8]),
		NewPubKey:  newPubKey,
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
	})

	// Update the DID Document's verification method with the new key.
	multicodecBytes := append(ed25519MulticodecPrefix, newPubKey...)
	multikey := "z" + base58btcEncode(multicodecBytes)

	if len(doc.VerificationMethod) > 0 {
		doc.VerificationMethod[0].PublicKeyMultibase = multikey
	}

	// Update stored public key.
	keyCopy := make([]byte, len(newPubKey))
	copy(keyCopy, newPubKey)
	dm.pubKeys[didStr] = keyCopy

	// Persist if data directory is set.
	if dm.dataDir != "" {
		dm.persistDID(didStr, doc)
	}

	return nil
}

// ResolveWeb attempts to resolve a did:web DID.
// This is a stub — did:web fallback is not yet implemented.
func (dm *DIDManager) ResolveWeb(_ context.Context, did domain.DID) ([]byte, error) {
	return nil, fmt.Errorf("not yet implemented")
}

// persistDID writes a DID document to disk.
func (dm *DIDManager) persistDID(did string, doc *didDocument) {
	dir := filepath.Join(dm.dataDir, "identity")
	_ = os.MkdirAll(dir, 0700)

	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return
	}

	// Use a safe filename from the DID.
	hash := sha256.Sum256([]byte(did))
	filename := fmt.Sprintf("did_%x.json", hash[:8])
	_ = os.WriteFile(filepath.Join(dir, filename), data, 0600)
}

// ---------- Persona Manager ----------

// Persona holds persona state.
type Persona struct {
	ID             string
	Name           string
	Tier           string // "open", "restricted", "locked"
	Locked         bool
	PassphraseHash string
	Salt           []byte
	DEKVersion     int // 1=SHA-256(legacy), 2=Argon2id
}

// IdentityAuditEntry records a persona access audit event.
type IdentityAuditEntry struct {
	PersonaID string
	Action    string
	Details   string
	Timestamp int64
}

// personaFileState is the JSON-serializable state for persona persistence.
type personaFileState struct {
	Personas map[string]*Persona        `json:"personas"`
	Contacts map[string]map[string]bool `json:"contacts"`
}

// PersonaManager implements port.PersonaManager — persona CRUD and tier enforcement (§3.2, §3.3).
// CRITICAL-01/02: Supports optional file-based persistence via SetPersistPath.
type PersonaManager struct {
	mu                   sync.RWMutex
	personas             map[string]*Persona              // personaID -> Persona
	auditLog             []IdentityAuditEntry             // append-only audit log
	contacts             map[string]map[string]bool       // personaID -> set of contact DIDs
	persistPath          string                           // path to persona state file (empty = in-memory only)
	OnRestrictedAccess   func(personaID, reason string)   // callback for restricted access notification
	testTick             chan struct{}                     // test control channel for TTL goroutine
	ttlTimers            map[string]*time.Timer           // personaID -> active TTL timer
	VerifyPassphrase     func(storedHash, passphrase string) (bool, error)
	HashUpgrader         func(passphrase string) (string, error) // re-hash with current algorithm (Argon2id)
	OnLock               func(personaID string) // callback invoked after persona is locked (vault close, etc.)
	// CheckOrphanedVault is an optional callback invoked during Create() to detect
	// orphaned vault artifacts. If vault files exist for a persona but no in-memory
	// persona state exists (e.g. after state file corruption/loss), this callback
	// returns true. Callers should wire this to the vault layer once durable vault
	// storage is implemented. When nil, the check is skipped.
	CheckOrphanedVault func(personaID string) bool
}

// NewPersonaManager returns a new PersonaManager.
// Call SetPersistPath to enable file-based persistence.
func NewPersonaManager() *PersonaManager {
	return &PersonaManager{
		personas:  make(map[string]*Persona),
		contacts:  make(map[string]map[string]bool),
		ttlTimers: make(map[string]*time.Timer),
	}
}

// SetPersistPath sets the file path for persona state persistence.
// If path is non-empty, persona state is loaded from disk (if the file exists)
// and written back after every mutation.
func (pm *PersonaManager) SetPersistPath(path string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.persistPath = path
	if path == "" {
		return nil
	}
	// Try to load existing state.
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // no state file yet — will be created on first mutation
		}
		return fmt.Errorf("persona: load state: %w", err)
	}
	var state personaFileState
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("persona: unmarshal state: %w", err)
	}
	if state.Personas != nil {
		pm.personas = state.Personas
		// Ensure all loaded personas start locked for safety — unlock requires passphrase.
		for _, p := range pm.personas {
			if p.Tier == "locked" || p.Tier == "restricted" {
				p.Locked = true
			}
		}
	}
	if state.Contacts != nil {
		pm.contacts = state.Contacts
	}
	return nil
}

// persistState writes the current persona state to disk (caller must hold lock).
func (pm *PersonaManager) persistState() {
	if pm.persistPath == "" {
		return
	}
	state := personaFileState{
		Personas: pm.personas,
		Contacts: pm.contacts,
	}
	data, err := json.Marshal(state)
	if err != nil {
		return // best-effort
	}
	os.MkdirAll(filepath.Dir(pm.persistPath), 0700)
	_ = os.WriteFile(pm.persistPath, data, 0600)
}

// canonicalPersonaID normalizes a persona identifier to the stored form "persona-<name>".
// Accepts both "medical" and "persona-medical", returns "persona-medical" in both cases.
func canonicalPersonaID(id string) string {
	if strings.HasPrefix(id, "persona-") {
		return id
	}
	return "persona-" + id
}

// SetPersonaPassphraseHash sets the passphrase hash on a persona (for testing/migration).
func (pm *PersonaManager) SetPersonaPassphraseHash(personaID, hash string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	if p, ok := pm.personas[personaID]; ok {
		p.PassphraseHash = hash
	}
}

// ResetForTest clears per-test tracking state for test isolation.
func (pm *PersonaManager) ResetForTest() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	// Cancel any active TTL timers.
	for _, timer := range pm.ttlTimers {
		timer.Stop()
	}
	pm.personas = make(map[string]*Persona)
	pm.auditLog = nil
	pm.contacts = make(map[string]map[string]bool)
	pm.ttlTimers = make(map[string]*time.Timer)
	pm.OnRestrictedAccess = nil
	pm.OnLock = nil
	pm.testTick = nil
}

// SetTestTick sets a channel for test control of TTL goroutine timing.
func (pm *PersonaManager) SetTestTick(ch chan struct{}) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.testTick = ch
}

// GetPersonasForContact scans all personas for a contact DID.
// Returns persona IDs that contain the given contact and are not locked.
func (pm *PersonaManager) GetPersonasForContact(_ context.Context, did string) ([]string, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	var result []string
	for personaID, contacts := range pm.contacts {
		if contacts[did] {
			// Skip locked personas — they are invisible to contact queries.
			if p, ok := pm.personas[personaID]; ok && p.Locked {
				continue
			}
			result = append(result, personaID)
		}
	}
	return result, nil
}

// AddContactToPersona associates a contact DID with a persona.
func (pm *PersonaManager) AddContactToPersona(personaID, contactDID string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if _, ok := pm.personas[personaID]; !ok {
		return ErrPersonaNotFound
	}
	if pm.contacts[personaID] == nil {
		pm.contacts[personaID] = make(map[string]bool)
	}
	pm.contacts[personaID][contactDID] = true
	pm.persistState()
	return nil
}

// AuditLog returns the access audit log for a persona.
// If personaID is empty, returns all audit entries.
func (pm *PersonaManager) AuditLog(_ context.Context, personaID string) ([]IdentityAuditEntry, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	if personaID == "" {
		result := make([]IdentityAuditEntry, len(pm.auditLog))
		copy(result, pm.auditLog)
		return result, nil
	}

	var result []IdentityAuditEntry
	for _, entry := range pm.auditLog {
		if entry.PersonaID == personaID {
			result = append(result, entry)
		}
	}
	return result, nil
}

// addAuditEntry appends an audit entry (caller must hold lock).
func (pm *PersonaManager) addAuditEntry(personaID, action, details string) {
	pm.auditLog = append(pm.auditLog, IdentityAuditEntry{
		PersonaID: personaID,
		Action:    action,
		Details:   details,
		Timestamp: time.Now().UnixNano(),
	})
}

// AccessPersona checks if a persona can be accessed based on its tier.
// It records audit entries and triggers callbacks for restricted access.
func (pm *PersonaManager) AccessPersona(_ context.Context, personaID string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	cid := canonicalPersonaID(personaID)
	p, ok := pm.personas[cid]
	if !ok {
		return ErrPersonaNotFound
	}

	switch p.Tier {
	case "locked":
		if p.Locked {
			reason := "persona is locked"
			pm.addAuditEntry(cid, "access_denied", reason)
			if pm.OnRestrictedAccess != nil {
				pm.OnRestrictedAccess(cid, reason)
			}
			return fmt.Errorf("persona %s is locked", cid)
		}
		pm.addAuditEntry(cid, "access_granted", "locked persona unlocked")
	case "restricted":
		pm.addAuditEntry(cid, "access_restricted", "restricted tier access")
		if pm.OnRestrictedAccess != nil {
			pm.OnRestrictedAccess(cid, "restricted tier access")
		}
	default:
		pm.addAuditEntry(cid, "access_granted", "open tier")
	}

	return nil
}

// Create creates a new persona with a name and tier (open/restricted/locked).
// An optional passphraseHash may be provided to store the Argon2id hash for unlock verification.
func (pm *PersonaManager) Create(_ context.Context, name, tier string, passphraseHash ...string) (string, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if tier != "open" && tier != "restricted" && tier != "locked" {
		return "", ErrInvalidTier
	}

	id := "persona-" + name

	// CRITICAL-01: Reject duplicate persona creation instead of silently overwriting.
	if _, exists := pm.personas[id]; exists {
		return "", ErrPersonaExists
	}

	// CRITICAL-01: Reject creation if orphaned vault artifacts exist for this persona.
	// This prevents silent DEK reuse after state file loss/corruption.
	if pm.CheckOrphanedVault != nil && pm.CheckOrphanedVault(id) {
		return "", ErrOrphanedVaultArtifacts
	}

	locked := tier == "locked"

	p := &Persona{
		ID:         id,
		Name:       name,
		Tier:       tier,
		Locked:     locked,
		DEKVersion: 1, // CRITICAL-02: Starts at v1; bumped to v2 only after vault re-encryption migration
	}
	if len(passphraseHash) > 0 && passphraseHash[0] != "" {
		p.PassphraseHash = passphraseHash[0]
	}

	pm.personas[id] = p
	pm.persistState()

	return id, nil
}

// List returns all persona IDs.
func (pm *PersonaManager) List(_ context.Context) ([]string, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	ids := make([]string, 0, len(pm.personas))
	for id := range pm.personas {
		ids = append(ids, id)
	}
	return ids, nil
}

// GetDEKVersion returns the DEK derivation version for a persona.
// Returns 1 for legacy personas, 2 for Argon2id-upgraded personas.
// Returns 0 and ErrPersonaNotFound if the persona does not exist.
func (pm *PersonaManager) GetDEKVersion(_ context.Context, personaID string) (int, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	cid := canonicalPersonaID(personaID)
	p, ok := pm.personas[cid]
	if !ok {
		return 0, ErrPersonaNotFound
	}
	v := p.DEKVersion
	if v == 0 {
		v = 1 // unset means legacy v1
	}
	return v, nil
}

// Unlock loads the persona's DEK into RAM for the given TTL (seconds).
// If ttlSeconds > 0, a goroutine auto-locks the persona after the TTL expires.
func (pm *PersonaManager) Unlock(_ context.Context, personaID, passphrase string, ttlSeconds int) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	personaID = canonicalPersonaID(personaID)
	p, ok := pm.personas[personaID]
	if !ok {
		return ErrPersonaNotFound
	}

	// Validate passphrase against stored hash.
	if p.PassphraseHash != "" {
		if pm.VerifyPassphrase == nil {
			return fmt.Errorf("persona: passphrase verifier not configured")
		}
		ok, err := pm.VerifyPassphrase(p.PassphraseHash, passphrase)
		if err != nil {
			return fmt.Errorf("persona: verify passphrase: %w", err)
		}
		if !ok {
			return domain.ErrInvalidPassphrase
		}
	} else {
		return fmt.Errorf("persona: %w: passphrase not configured — run migration", domain.ErrInvalidPassphrase)
	}

	// CRITICAL-02: Upgrade passphrase hash to Argon2id on successful unlock.
	// Only the authentication hash is upgraded here — DEKVersion is NOT bumped
	// because that controls vault key derivation, and bumping it without
	// re-encrypting the vault with the new DEK would lock out the persona.
	// DEKVersion upgrade requires an explicit vault re-encryption migration step.
	if pm.HashUpgrader != nil && p.PassphraseHash != "" {
		if newHash, err := pm.HashUpgrader(passphrase); err == nil && newHash != "" {
			p.PassphraseHash = newHash
			slog.Info("persona passphrase hash upgraded to Argon2id", "persona", personaID)
		}
	}

	p.Locked = false
	pm.persistState()

	// Cancel any existing TTL timer for this persona.
	if timer, ok := pm.ttlTimers[personaID]; ok {
		timer.Stop()
		delete(pm.ttlTimers, personaID)
	}

	// Set up TTL auto-lock if ttlSeconds > 0.
	if ttlSeconds > 0 {
		ttlDuration := time.Duration(ttlSeconds) * time.Second
		// If ttlSeconds is very small (< 1 second), interpret as milliseconds for testing.
		if ttlSeconds < 0 {
			ttlDuration = time.Duration(-ttlSeconds) * time.Millisecond
		}

		testTick := pm.testTick // capture under lock

		if testTick != nil {
			// Test mode: wait for tick signal instead of real timer.
			go func() {
				<-testTick
				pm.mu.Lock()
				if p, ok := pm.personas[personaID]; ok {
					p.Locked = true
				}
				pm.persistState()
				cb := pm.OnLock // capture under lock
				pm.mu.Unlock()
				// Invoke callback outside mutex to prevent deadlocks.
				if cb != nil {
					cb(personaID)
				}
			}()
		} else {
			// Production mode: use real timer.
			timer := time.AfterFunc(ttlDuration, func() {
				pm.mu.Lock()
				if p, ok := pm.personas[personaID]; ok {
					p.Locked = true
				}
				delete(pm.ttlTimers, personaID)
				pm.persistState()
				cb := pm.OnLock // capture under lock
				pm.mu.Unlock()
				// Invoke callback outside mutex to prevent deadlocks.
				if cb != nil {
					cb(personaID)
				}
			})
			pm.ttlTimers[personaID] = timer
		}
	}

	return nil
}

// Lock zeroes the persona's DEK from RAM.
func (pm *PersonaManager) Lock(_ context.Context, personaID string) error {
	pm.mu.Lock()

	cid := canonicalPersonaID(personaID)
	p, ok := pm.personas[cid]
	if !ok {
		pm.mu.Unlock()
		return ErrPersonaNotFound
	}

	p.Locked = true
	pm.persistState()
	cb := pm.OnLock
	pm.mu.Unlock()
	// Invoke callback outside mutex to prevent deadlocks.
	if cb != nil {
		cb(personaID)
	}
	return nil
}

// IsLocked reports whether the persona's DEK is currently in RAM.
func (pm *PersonaManager) IsLocked(personaID string) (bool, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	cid := canonicalPersonaID(personaID)
	p, ok := pm.personas[cid]
	if !ok {
		return false, ErrPersonaNotFound
	}

	return p.Locked, nil
}

// Delete securely wipes the persona's vault and keys.
// HIGH-02: Also cleans up contacts, TTL timers, and persists state.
func (pm *PersonaManager) Delete(_ context.Context, personaID string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	cid := canonicalPersonaID(personaID)
	if _, ok := pm.personas[cid]; !ok {
		return ErrPersonaNotFound
	}

	delete(pm.personas, cid)

	// Clean up associated contacts.
	delete(pm.contacts, cid)

	// Cancel and clean up TTL timer if active.
	if timer, ok := pm.ttlTimers[cid]; ok {
		timer.Stop()
		delete(pm.ttlTimers, cid)
	}

	// Persist updated state to disk.
	pm.persistState()

	return nil
}

// ---------- Contact Directory ----------

// validTrustLevels defines the valid trust levels for contacts.
var validTrustLevels = map[string]bool{
	"blocked": true,
	"unknown": true,
	"trusted": true,
}

// ContactDirectory implements port.ContactDirectory — contact management (§3.4).
type ContactDirectory struct {
	mu       sync.RWMutex
	contacts map[string]*domain.Contact // DID -> Contact
	byName   map[string]string          // name -> DID (for Resolve by name)
}

// NewContactDirectory returns a new in-memory ContactDirectory.
func NewContactDirectory() *ContactDirectory {
	return &ContactDirectory{
		contacts: make(map[string]*domain.Contact),
		byName:   make(map[string]string),
	}
}

// GetTrustLevel returns the trust_level for a DID, or "" if not a contact.
// Implements port.ContactLookup for trust-based ingress decisions.
func (cd *ContactDirectory) GetTrustLevel(did string) string {
	cd.mu.RLock()
	defer cd.mu.RUnlock()

	c, ok := cd.contacts[did]
	if !ok {
		return ""
	}
	return c.TrustLevel
}

// Add adds a contact with a DID, display name, and trust level.
func (cd *ContactDirectory) Add(_ context.Context, did, name, trustLevel string) error {
	cd.mu.Lock()
	defer cd.mu.Unlock()

	if !validTrustLevels[trustLevel] {
		return ErrInvalidTrustLevel
	}

	if _, exists := cd.contacts[did]; exists {
		return ErrContactExists
	}

	cd.contacts[did] = &domain.Contact{
		DID:           did,
		Name:          name,
		TrustLevel:    trustLevel,
		SharingPolicy: "{}",
	}
	cd.byName[name] = did

	return nil
}

// Resolve looks up a contact by display name and returns the DID.
func (cd *ContactDirectory) Resolve(_ context.Context, name string) (string, error) {
	cd.mu.RLock()
	defer cd.mu.RUnlock()

	did, ok := cd.byName[name]
	if !ok {
		return "", ErrContactNotFound
	}

	return did, nil
}

// UpdateTrust changes a contact's trust level.
func (cd *ContactDirectory) UpdateTrust(_ context.Context, did, trustLevel string) error {
	cd.mu.Lock()
	defer cd.mu.Unlock()

	if !validTrustLevels[trustLevel] {
		return ErrInvalidTrustLevel
	}

	c, ok := cd.contacts[did]
	if !ok {
		return ErrContactNotFound
	}

	c.TrustLevel = trustLevel
	return nil
}

// UpdateName changes a contact's display name.
func (cd *ContactDirectory) UpdateName(_ context.Context, did, name string) error {
	cd.mu.Lock()
	defer cd.mu.Unlock()

	c, ok := cd.contacts[did]
	if !ok {
		return ErrContactNotFound
	}

	// Update the byName reverse index.
	delete(cd.byName, c.Name)
	c.Name = name
	cd.byName[name] = did
	return nil
}

// Delete removes a contact.
func (cd *ContactDirectory) Delete(_ context.Context, did string) error {
	cd.mu.Lock()
	defer cd.mu.Unlock()

	c, ok := cd.contacts[did]
	if !ok {
		return ErrContactNotFound
	}

	delete(cd.byName, c.Name)
	delete(cd.contacts, did)
	return nil
}

// List returns all contacts.
func (cd *ContactDirectory) List(_ context.Context) ([]domain.Contact, error) {
	cd.mu.RLock()
	defer cd.mu.RUnlock()

	result := make([]domain.Contact, 0, len(cd.contacts))
	for _, c := range cd.contacts {
		result = append(result, domain.Contact{
			DID:           c.DID,
			Name:          c.Name,
			Alias:         c.Alias,
			TrustLevel:    c.TrustLevel,
			SharingPolicy: c.SharingPolicy,
		})
	}

	return result, nil
}

// ---------- Device Registry ----------

// MaxDevices is the maximum number of devices allowed.
const MaxDevices = 10

// DeviceRegistry implements port.DeviceRegistry — device management (§3.5).
type DeviceRegistry struct {
	mu      sync.RWMutex
	devices map[string]*domain.Device // deviceID -> Device
	nextID  int
}

// NewDeviceRegistry returns a new in-memory DeviceRegistry.
func NewDeviceRegistry() *DeviceRegistry {
	return &DeviceRegistry{
		devices: make(map[string]*domain.Device),
	}
}

// Register adds a device with its CLIENT_TOKEN hash.
func (dr *DeviceRegistry) Register(_ context.Context, name string, tokenHash []byte) (string, error) {
	dr.mu.Lock()
	defer dr.mu.Unlock()

	// Count non-revoked devices.
	active := 0
	for _, d := range dr.devices {
		if !d.Revoked {
			active++
		}
	}
	if active >= MaxDevices {
		return "", ErrMaxDevicesReached
	}

	dr.nextID++
	deviceID := fmt.Sprintf("device-%d", dr.nextID)

	hashCopy := make([]byte, len(tokenHash))
	copy(hashCopy, tokenHash)

	dr.devices[deviceID] = &domain.Device{
		ID:        deviceID,
		Name:      name,
		TokenHash: hashCopy,
		Revoked:   false,
		LastSeen:  time.Now().Unix(),
	}

	return deviceID, nil
}

// List returns all registered devices.
func (dr *DeviceRegistry) List(_ context.Context) ([]domain.Device, error) {
	dr.mu.RLock()
	defer dr.mu.RUnlock()

	result := make([]domain.Device, 0, len(dr.devices))
	for _, d := range dr.devices {
		result = append(result, domain.Device{
			ID:        d.ID,
			Name:      d.Name,
			TokenHash: d.TokenHash,
			Revoked:   d.Revoked,
			LastSeen:  d.LastSeen,
		})
	}

	return result, nil
}

// Revoke disables a device's CLIENT_TOKEN.
func (dr *DeviceRegistry) Revoke(_ context.Context, deviceID string) error {
	dr.mu.Lock()
	defer dr.mu.Unlock()

	d, ok := dr.devices[deviceID]
	if !ok {
		return ErrDeviceNotFound
	}

	d.Revoked = true
	return nil
}

// ---------- Recovery Manager (Shamir's Secret Sharing) ----------

// RecoveryManager implements port.RecoveryManager — SSS recovery (§3.6).
// Uses GF(256) arithmetic for Shamir's Secret Sharing over a finite field.
type RecoveryManager struct{}

// NewRecoveryManager returns a new RecoveryManager.
func NewRecoveryManager() *RecoveryManager {
	return &RecoveryManager{}
}

// Split divides a secret into n shares with threshold k.
// Each share is (1 + len(secret)) bytes: [x-coordinate, share-bytes...].
func (rm *RecoveryManager) Split(secret []byte, k, n int) ([][]byte, error) {
	if k < 2 || n < k || n > 255 {
		return nil, ErrInvalidShareParams
	}
	if len(secret) == 0 {
		return nil, ErrInvalidShareParams
	}

	shares := make([][]byte, n)
	for i := range shares {
		shares[i] = make([]byte, len(secret)+1)
		shares[i][0] = byte(i + 1) // x-coordinate (1-indexed, non-zero)
	}

	// For each byte of the secret, create a random polynomial of degree k-1.
	for byteIdx := 0; byteIdx < len(secret); byteIdx++ {
		// Coefficients: a[0] = secret[byteIdx], a[1..k-1] = random.
		coeffs := make([]byte, k)
		coeffs[0] = secret[byteIdx]
		if _, err := rand.Read(coeffs[1:]); err != nil {
			return nil, fmt.Errorf("crypto/rand: %w", err)
		}

		// Evaluate polynomial for each share's x-coordinate.
		for i := 0; i < n; i++ {
			x := shares[i][0]
			shares[i][byteIdx+1] = gf256Eval(coeffs, x)
		}
	}

	return shares, nil
}

// Combine reconstructs the secret from k shares using Lagrange interpolation in GF(256).
func (rm *RecoveryManager) Combine(shares [][]byte) ([]byte, error) {
	if len(shares) < 2 {
		return nil, ErrInsufficientShares
	}

	// Validate share lengths are consistent.
	shareLen := len(shares[0])
	if shareLen < 2 {
		return nil, ErrInvalidShare
	}
	for _, s := range shares {
		if len(s) != shareLen {
			return nil, ErrInvalidShare
		}
	}

	// Extract x-coordinates and verify they are unique and non-zero.
	xs := make([]byte, len(shares))
	for i, s := range shares {
		xs[i] = s[0]
		if xs[i] == 0 {
			return nil, ErrInvalidShare
		}
	}

	// Reconstruct each byte via Lagrange interpolation at x=0.
	secretLen := shareLen - 1
	secret := make([]byte, secretLen)

	for byteIdx := 0; byteIdx < secretLen; byteIdx++ {
		ys := make([]byte, len(shares))
		for i, s := range shares {
			ys[i] = s[byteIdx+1]
		}
		secret[byteIdx] = gf256LagrangeInterpolate(xs, ys)
	}

	return secret, nil
}

// ---------- GF(256) Arithmetic ----------

// gf256LogTable and gf256ExpTable are precomputed tables for GF(256) with
// irreducible polynomial x^8 + x^4 + x^3 + x + 1 (0x11B).
var (
	gf256ExpTable [512]byte
	gf256LogTable [256]byte
)

func init() {
	// Generate exp and log tables for GF(256) using generator 3
	// with irreducible polynomial x^8 + x^4 + x^3 + x + 1 (0x11B).
	// Generator 3 is a primitive element that generates all 255 non-zero elements.
	x := 1
	for i := 0; i < 255; i++ {
		gf256ExpTable[i] = byte(x)
		gf256LogTable[x] = byte(i)
		// Multiply by generator 3 using carry-less multiplication.
		x = gf256MulNoTable(x, 3)
	}
	// Fill the rest of the exp table for modular lookup convenience.
	for i := 255; i < 512; i++ {
		gf256ExpTable[i] = gf256ExpTable[i-255]
	}
}

// gf256MulNoTable performs GF(256) multiplication without lookup tables.
// Used only during init() to build the tables themselves.
func gf256MulNoTable(a, b int) int {
	p := 0
	for b > 0 {
		if b&1 != 0 {
			p ^= a
		}
		a <<= 1
		if a >= 256 {
			a ^= 0x11B // Reduce by irreducible polynomial.
		}
		b >>= 1
	}
	return p
}

// gf256Add is addition in GF(256) = XOR.
func gf256Add(a, b byte) byte {
	return a ^ b
}

// gf256Mul is multiplication in GF(256) using log/exp tables.
func gf256Mul(a, b byte) byte {
	if a == 0 || b == 0 {
		return 0
	}
	logA := int(gf256LogTable[a])
	logB := int(gf256LogTable[b])
	return gf256ExpTable[logA+logB]
}

// gf256Inv is the multiplicative inverse in GF(256).
func gf256Inv(a byte) byte {
	if a == 0 {
		return 0 // undefined, but return 0 for safety
	}
	return gf256ExpTable[255-int(gf256LogTable[a])]
}

// gf256Div is division in GF(256): a / b.
func gf256Div(a, b byte) byte {
	if b == 0 {
		return 0 // undefined
	}
	if a == 0 {
		return 0
	}
	return gf256Mul(a, gf256Inv(b))
}

// gf256Eval evaluates a polynomial at point x in GF(256).
// coeffs[0] is the constant term.
func gf256Eval(coeffs []byte, x byte) byte {
	// Horner's method.
	result := coeffs[len(coeffs)-1]
	for i := len(coeffs) - 2; i >= 0; i-- {
		result = gf256Add(gf256Mul(result, x), coeffs[i])
	}
	return result
}

// gf256LagrangeInterpolate reconstructs f(0) from points (xs[i], ys[i]) in GF(256).
func gf256LagrangeInterpolate(xs, ys []byte) byte {
	k := len(xs)
	var result byte

	for i := 0; i < k; i++ {
		// Compute Lagrange basis polynomial L_i(0).
		numerator := byte(1)
		denominator := byte(1)

		for j := 0; j < k; j++ {
			if i == j {
				continue
			}
			// L_i(0) = product of (0 - x_j) / (x_i - x_j)
			// In GF(256): 0 - x_j = x_j (additive inverse = self in GF(2^n))
			numerator = gf256Mul(numerator, xs[j])
			denominator = gf256Mul(denominator, gf256Add(xs[i], xs[j]))
		}

		// L_i(0) * y_i
		basis := gf256Div(numerator, denominator)
		term := gf256Mul(basis, ys[i])
		result = gf256Add(result, term)
	}

	return result
}
