// Package testutil defines contracts (interfaces) for all dina-core subsystems.
// Source packages implement these implicitly via Go's structural typing.
// Tests use mock implementations initially; swap to real when code arrives.
package testutil

// ---------- §2 Key Derivation & Cryptography ----------

// MnemonicGenerator — contract for BIP-39 mnemonic operations (§2.1).
type MnemonicGenerator interface {
	// Generate creates a new 24-word BIP-39 mnemonic and its derived seed.
	Generate() (mnemonic string, seed []byte, err error)
	// Validate checks a mnemonic for word count, wordlist membership, and checksum.
	Validate(mnemonic string) error
	// ToSeed converts a mnemonic + optional passphrase to a 512-bit seed (PBKDF2-HMAC-SHA512).
	ToSeed(mnemonic string, passphrase string) ([]byte, error)
}

// KeyDeriver — contract for HKDF-SHA256 DEK derivation and Argon2id passphrase hashing (§2.3, §2.4).
type KeyDeriver interface {
	// DeriveVaultDEK derives a per-persona 256-bit DEK via HKDF-SHA256.
	// info string format: "dina:vault:<persona>:v1", salt is user_salt.
	DeriveVaultDEK(masterSeed []byte, personaID string, userSalt []byte) ([]byte, error)
	// DerivePassphraseKEK hashes a passphrase via Argon2id (128MB/3iter/4parallel) to produce a KEK.
	DerivePassphraseKEK(passphrase string, salt []byte) ([]byte, error)
}

// HDKeyDeriver — contract for SLIP-0010 Ed25519 hardened derivation (§2.2).
type HDKeyDeriver interface {
	// DerivePath derives an Ed25519 keypair from seed at the given SLIP-0010 path.
	// Only hardened paths (e.g. m/9999'/0') are accepted.
	DerivePath(seed []byte, path string) (pub, priv []byte, err error)
}

// Signer — contract for Ed25519 signing and verification (§2.5).
type Signer interface {
	// GenerateFromSeed creates an Ed25519 keypair from a 32-byte seed.
	GenerateFromSeed(seed []byte) (pub, priv []byte, err error)
	// Sign produces an Ed25519 signature.
	Sign(privateKey, message []byte) ([]byte, error)
	// Verify checks an Ed25519 signature.
	Verify(publicKey, message, signature []byte) (bool, error)
}

// KeyConverter — contract for Ed25519→X25519 conversion (§2.6).
type KeyConverter interface {
	// Ed25519ToX25519Private converts an Ed25519 private key to X25519.
	Ed25519ToX25519Private(ed25519Priv []byte) ([]byte, error)
	// Ed25519ToX25519Public converts an Ed25519 public key to X25519.
	Ed25519ToX25519Public(ed25519Pub []byte) ([]byte, error)
}

// BoxSealer — contract for NaCl crypto_box_seal (§2.7).
type BoxSealer interface {
	// Seal encrypts plaintext for the recipient's X25519 public key (anonymous sender).
	Seal(plaintext, recipientPub []byte) ([]byte, error)
	// Open decrypts a sealed message using the recipient's keypair.
	Open(ciphertext, recipientPub, recipientPriv []byte) ([]byte, error)
}

// KeyWrapper — contract for AES-256-GCM key wrapping (§2.8).
type KeyWrapper interface {
	// Wrap encrypts a DEK with a KEK using AES-256-GCM.
	Wrap(dek, kek []byte) ([]byte, error)
	// Unwrap decrypts a wrapped DEK using the KEK.
	Unwrap(wrapped, kek []byte) ([]byte, error)
}

// ---------- §3 Identity (DID) ----------

// DIDManager — contract for DID document lifecycle (§3.1).
type DIDManager interface {
	// Create generates a new DID from an Ed25519 public key.
	Create(publicKey []byte) (did string, err error)
	// Resolve returns the DID Document as JSON.
	Resolve(did string) ([]byte, error)
	// Rotate updates the DID's signing key via a signed rotation operation.
	Rotate(did string, oldPrivKey, newPubKey []byte) error
}

// PersonaManager — contract for persona CRUD and tier enforcement (§3.2, §3.3).
type PersonaManager interface {
	// Create creates a new persona with a name and tier (open/restricted/locked).
	Create(name, tier string) (personaID string, err error)
	// List returns all persona IDs.
	List() ([]string, error)
	// Unlock loads the persona's DEK into RAM for the given TTL (seconds).
	Unlock(personaID, passphrase string, ttlSeconds int) error
	// Lock zeroes the persona's DEK from RAM.
	Lock(personaID string) error
	// IsLocked reports whether the persona's DEK is currently in RAM.
	IsLocked(personaID string) (bool, error)
	// Delete securely wipes the persona's vault and keys.
	Delete(personaID string) error
}

// ContactDirectory — contract for contact management (§3.4).
type ContactDirectory interface {
	// Add adds a contact with a DID, display name, and trust level.
	Add(did, name, trustLevel string) error
	// Resolve looks up a contact by display name and returns the DID.
	Resolve(name string) (did string, err error)
	// UpdateTrust changes a contact's trust level.
	UpdateTrust(did, trustLevel string) error
	// Delete removes a contact.
	Delete(did string) error
	// List returns all contacts.
	List() ([]Contact, error)
}

// Contact holds contact directory data.
type Contact struct {
	DID           string
	Name          string
	Alias         string
	TrustLevel    string // "blocked", "unknown", "trusted"
	SharingPolicy string // JSON
}

// DeviceRegistry — contract for device management (§3.5).
type DeviceRegistry interface {
	// Register adds a device with its CLIENT_TOKEN hash.
	Register(name string, tokenHash []byte) (deviceID string, err error)
	// List returns all registered devices.
	List() ([]Device, error)
	// Revoke disables a device's CLIENT_TOKEN.
	Revoke(deviceID string) error
}

// Device holds device registry data.
type Device struct {
	ID        string
	Name      string
	TokenHash []byte
	Revoked   bool
	LastSeen  int64
}

// RecoveryManager — contract for Shamir's Secret Sharing (§3.6).
type RecoveryManager interface {
	// Split divides a secret into N shares with threshold K.
	Split(secret []byte, k, n int) ([][]byte, error)
	// Combine reconstructs the secret from K shares.
	Combine(shares [][]byte) ([]byte, error)
}

// ---------- §4 Vault (SQLCipher) ----------

// VaultManager — contract for per-persona SQLCipher vault (§4).
type VaultManager interface {
	// Open opens (or creates) a persona's vault with the given DEK.
	Open(personaID string, dek []byte) error
	// Close closes a persona's vault and zeroes the DEK.
	Close(personaID string) error
	// Store inserts or upserts an item. Returns the item ID.
	Store(personaID string, item VaultItem) (string, error)
	// StoreBatch atomically stores a batch of items.
	StoreBatch(personaID string, items []VaultItem) error
	// Retrieve fetches a single item by ID.
	Retrieve(personaID, itemID string) (*VaultItem, error)
	// Delete removes an item.
	Delete(personaID, itemID string) error
	// Search performs FTS5, semantic, or hybrid search.
	Search(personaID string, query SearchQuery) ([]VaultItem, error)
}

// VaultItem represents an item in the vault.
type VaultItem struct {
	ID         string
	Type       string // email, message, event, note, photo
	Source     string
	SourceID   string
	ContactDID string
	Summary    string
	BodyText   string
	Timestamp  int64
	IngestedAt int64
	Metadata   string // JSON
}

// SearchQuery holds search parameters.
type SearchQuery struct {
	Mode           string // "fts5", "semantic", "hybrid"
	Query          string
	Embedding      []float32
	Types          []string
	After          int64
	Before         int64
	IncludeContent bool
	Limit          int
	Offset         int
}

// ScratchpadManager — contract for brain cognitive checkpointing (§4.4).
type ScratchpadManager interface {
	// Write stores a checkpoint for a task.
	Write(taskID string, step int, context []byte) error
	// Read retrieves the latest checkpoint for a task.
	Read(taskID string) (step int, context []byte, err error)
	// Delete removes a task's checkpoint.
	Delete(taskID string) error
}

// StagingManager — contract for Tier 4 ephemeral staging (§4.5).
type StagingManager interface {
	// Stage stores an item for review with an expiry time.
	Stage(personaID string, item VaultItem, expiresAt int64) (string, error)
	// Approve promotes a staged item to the main vault.
	Approve(personaID, stagingID string) error
	// Reject deletes a staged item.
	Reject(personaID, stagingID string) error
	// Sweep deletes all expired staging items.
	Sweep() (int, error)
}

// BackupManager — contract for encrypted backup (§4.6).
type BackupManager interface {
	// Backup creates an encrypted backup of the persona's vault.
	Backup(personaID, destPath string) error
	// Restore replaces the persona's vault with a backup.
	Restore(personaID, srcPath string) error
}

// SchemaInspector — contract for inspecting vault schema details (§4.2.1, §4.2.2).
type SchemaInspector interface {
	// TableColumns returns column names for a table.
	TableColumns(dbName, tableName string) ([]string, error)
	// IndexExists checks whether a named index exists.
	IndexExists(dbName, indexName string) (bool, error)
	// IndexDDL returns the CREATE INDEX statement for verification.
	IndexDDL(dbName, indexName string) (string, error)
	// TableDDL returns the CREATE TABLE statement for verification.
	TableDDL(dbName, tableName string) (string, error)
	// SchemaVersion returns the stored schema version string.
	SchemaVersion(dbName string) (string, error)
	// ExecSQL executes raw SQL for constraint testing. Returns rows affected.
	ExecSQL(dbName, sql string, args ...interface{}) (int64, error)
	// QuerySQL executes a read query and returns JSON-encoded rows.
	QuerySQL(dbName, sql string, args ...interface{}) ([]byte, error)
}

// EmbeddingMigrator — contract for embedding model migration (§4.3.1).
type EmbeddingMigrator interface {
	// CurrentModel returns the embedding model stored in vault metadata.
	CurrentModel(personaID string) (string, error)
	// DetectMismatch checks if stored model differs from configured model.
	DetectMismatch(personaID, configuredModel string) (bool, error)
	// DropIndex drops the sqlite-vec index for re-embedding.
	DropIndex(personaID string) error
	// RebuildIndex triggers a background re-embed job via brain.
	RebuildIndex(personaID string) error
	// IsReindexing returns true if a re-embed job is in progress.
	IsReindexing(personaID string) (bool, error)
	// SemanticSearchAvailable returns true if semantic search is ready.
	SemanticSearchAvailable(personaID string) (bool, error)
}

// MigrationSafety — contract for pre-flight migration safety (§4.6.1).
type MigrationSafety interface {
	// PreFlightBackup creates an encrypted backup before migration.
	PreFlightBackup(dbName string) (backupPath string, err error)
	// IntegrityCheck runs PRAGMA integrity_check on the database.
	IntegrityCheck(dbName string) (string, error)
	// CommitMigration finalizes a successful migration.
	CommitMigration(dbName string) error
	// RollbackMigration restores the vault from backup after failure.
	RollbackMigration(dbName, backupPath string) error
}

// VaultAuditLogger — contract for append-only audit log (§4.7).
type VaultAuditLogger interface {
	// Append adds an audit entry. Returns the entry ID.
	Append(entry VaultAuditEntry) (int64, error)
	// Query retrieves audit entries matching the given filter.
	Query(filter VaultAuditFilter) ([]VaultAuditEntry, error)
	// VerifyChain validates the hash chain integrity of the audit log.
	VerifyChain() (bool, error)
	// Purge deletes entries older than the configured retention period.
	Purge(retentionDays int) (int64, error)
	// PurgeCrashLog deletes crash_log entries older than the retention period.
	PurgeCrashLog(retentionDays int) (int64, error)
}

// VaultAuditEntry represents a single audit log entry (§4.7).
type VaultAuditEntry struct {
	ID        int64
	Timestamp string
	Persona   string
	Action    string
	Requester string
	QueryType string
	Reason    string
	Metadata  string // JSON
	PrevHash  string // hash of previous entry for chain integrity
}

// VaultAuditFilter holds query parameters for audit log searches.
type VaultAuditFilter struct {
	Action    string
	Persona   string
	After     string // ISO 8601 timestamp
	Before    string // ISO 8601 timestamp
	Requester string
	Limit     int
}

// BootSequencer — contract for boot sequence and vault unlock (§4.8).
type BootSequencer interface {
	// Boot performs the full boot sequence: unlock master seed, derive DEKs, open vaults.
	Boot(cfg BootConfig) error
	// UnlockVault unlocks a specific persona vault at runtime.
	UnlockVault(personaID string) error
	// IsVaultOpen returns whether a persona vault is currently open.
	IsVaultOpen(personaID string) (bool, error)
	// OpenPersonas returns the list of currently open persona vault names.
	OpenPersonas() ([]string, error)
	// NotifyBrain sends vault_unlocked event to brain.
	NotifyBrain() error
	// SwitchMode switches between security and convenience modes.
	SwitchMode(newMode, passphrase string) error
	// CurrentMode returns the current boot mode.
	CurrentMode() string
}

// BootConfig holds configuration for the boot sequence.
type BootConfig struct {
	Mode            string // "security" or "convenience"
	KeyfilePath     string
	WrappedSeedPath string
	VaultPath       string
	Personas        []string // persona names to manage
	Passphrase      string   // for security mode
}

// ---------- §5 PII Scrubber (Tier 1 — Go Regex) ----------

// PIIEntity represents a detected PII occurrence.
type PIIEntity struct {
	Type  string // EMAIL, PHONE, SSN, CREDIT_CARD, ADDRESS
	Value string
	Start int
	End   int
}

// PIIScrubber — contract for Tier 1 regex-based PII detection (§5).
type PIIScrubber interface {
	// Scrub replaces PII with numbered tokens and returns the scrubbed text + entities.
	Scrub(text string) (scrubbed string, entities []PIIEntity, err error)
	// AddPattern registers a custom PII pattern.
	AddPattern(name, pattern string) error
}

// ---------- §6 Gatekeeper ----------

// Intent represents an agent's intended action.
type Intent struct {
	AgentDID    string
	Action      string // e.g. "send_email", "read_vault", "transfer_money"
	Target      string
	PersonaID   string
	TrustLevel  string
	Constraints map[string]bool
}

// Decision is the gatekeeper's response to an intent.
type Decision struct {
	Allowed bool
	Reason  string
	Audit   bool // whether an audit entry was created
}

// Gatekeeper — contract for request authorization and egress control (§6).
type Gatekeeper interface {
	// EvaluateIntent decides whether an agent's action should proceed.
	EvaluateIntent(intent Intent) (Decision, error)
	// CheckEgress checks whether data may leave the Home Node to a destination.
	CheckEgress(destination string, data []byte) (bool, error)
}

// SharingPolicy holds per-category sharing tiers for a contact.
type SharingPolicy struct {
	ContactDID string
	Categories map[string]string // category → tier: "none", "summary", "full" (or domain-specific like "eta_only", "free_busy", "exact_location")
}

// TieredPayload holds the brain's tiered output for a single category.
type TieredPayload struct {
	Summary string
	Full    string
}

// EgressPayload is the brain's outbound data with tiered categories.
type EgressPayload struct {
	RecipientDID string
	Categories   map[string]interface{} // category → TieredPayload or raw value
}

// EgressResult is the filtered payload after policy enforcement.
type EgressResult struct {
	RecipientDID string
	Filtered     map[string]string // category → selected tier value (or empty if denied)
	Denied       []string          // categories that were denied
	AuditEntries []AuditEntry
}

// AuditEntry records an egress decision.
type AuditEntry struct {
	Action     string // "egress_check"
	ContactDID string
	Category   string
	Decision   string // "allowed", "denied"
	Reason     string // "tier_none", "tier_summary", "tier_full", "malformed"
}

// SharingPolicyManager — contract for sharing policy CRUD and egress filtering (§6.1, §6.2, §6.3).
type SharingPolicyManager interface {
	// GetPolicy returns the sharing policy for a contact DID.
	GetPolicy(contactDID string) (*SharingPolicy, error)
	// SetPolicy sets one or more category tiers for a contact.
	SetPolicy(contactDID string, categories map[string]string) error
	// SetBulkPolicy applies a policy to contacts matching a filter.
	SetBulkPolicy(filter map[string]string, categories map[string]string) (int, error)
	// FilterEgress applies sharing policy to an outbound payload.
	FilterEgress(payload EgressPayload) (*EgressResult, error)
}

// ---------- §7 Transport ----------

// Transporter — contract for Dina-to-Dina messaging (§7).
type Transporter interface {
	// Send encrypts and delivers an envelope to the recipient's DID endpoint.
	Send(recipientDID string, envelope []byte) error
	// Receive returns the next inbound message from the inbox.
	Receive() ([]byte, error)
	// ResolveEndpoint resolves a DID to its service endpoint URL.
	ResolveEndpoint(did string) (string, error)
}

// OutboxMessage represents a message in the outbox table (§7.1).
type OutboxMessage struct {
	ID        string
	ToDID     string
	Payload   []byte
	CreatedAt int64
	NextRetry int64
	Retries   int
	Status    string // "pending", "sending", "delivered", "failed"
	Priority  int    // higher = more important (fiduciary > normal)
}

// OutboxManager — contract for reliable outbox delivery (§7.1).
type OutboxManager interface {
	// Enqueue adds a message to the outbox. Returns the message ID (ULID).
	Enqueue(msg OutboxMessage) (string, error)
	// MarkDelivered marks a message as delivered.
	MarkDelivered(msgID string) error
	// MarkFailed marks a message as failed and schedules retry with backoff.
	MarkFailed(msgID string) error
	// Requeue re-enqueues a failed message with fresh retry count.
	Requeue(msgID string) error
	// PendingCount returns the number of pending messages.
	PendingCount() (int, error)
	// GetByID retrieves a message by ID.
	GetByID(msgID string) (*OutboxMessage, error)
	// DeleteExpired removes messages older than TTL.
	DeleteExpired(ttlSeconds int64) (int, error)
}

// InboxManager — contract for inbox 3-valve ingress (§7.2).
type InboxManager interface {
	// CheckIPRate checks if an IP is within rate limits (Valve 1).
	CheckIPRate(ip string) bool
	// CheckGlobalRate checks if total requests are within global limits (Valve 1).
	CheckGlobalRate() bool
	// CheckPayloadSize returns true if the payload is within 256KB cap (Valve 1).
	CheckPayloadSize(payload []byte) bool
	// Spool stores a message to disk when persona is locked (Valve 2).
	Spool(payload []byte) (string, error)
	// SpoolSize returns the current spool size in bytes (Valve 2).
	SpoolSize() (int64, error)
	// ProcessSpool processes all spooled messages FIFO by ULID (Valve 3).
	ProcessSpool() (int, error)
	// CheckDIDRate checks per-DID rate limit — only when unlocked (fast path).
	CheckDIDRate(did string) bool
}

// DIDResolver — contract for DID resolution and caching (§7.3).
type DIDResolver interface {
	// Resolve fetches or returns cached DID Document.
	Resolve(did string) ([]byte, error)
	// InvalidateCache removes a DID from cache.
	InvalidateCache(did string)
}

// D2DMessage represents a DIDComm-compatible plaintext message (§7.4).
type D2DMessage struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"`
	From        string   `json:"from"`
	To          []string `json:"to"`
	CreatedTime int64    `json:"created_time"`
	Body        []byte   `json:"body"`
}

// D2DEnvelope represents the encrypted envelope (§7.4).
type D2DEnvelope struct {
	Typ        string `json:"typ"`        // "application/dina-encrypted+json"
	FromKID    string `json:"from_kid"`   // "did:plc:...#key-1"
	ToKID      string `json:"to_kid"`     // "did:plc:...#key-1"
	Ciphertext string `json:"ciphertext"` // base64url
	Sig        string `json:"sig"`        // Ed25519 signature
}

// ---------- §8 Task Queue ----------

// Task represents an async task.
type Task struct {
	ID        string
	Type      string
	Priority  int
	Payload   []byte
	Status    string // pending, running, completed, failed, dead, cancelled
	Retries   int
	Error     string
	TimeoutAt int64
}

// TaskQueuer — contract for persistent task queue (§8).
type TaskQueuer interface {
	// Enqueue adds a task. Returns the task ID.
	Enqueue(task Task) (string, error)
	// Dequeue returns the highest-priority pending task and marks it running.
	Dequeue() (*Task, error)
	// Complete marks a task as completed.
	Complete(taskID string) error
	// Fail marks a task as failed with a reason.
	Fail(taskID, reason string) error
	// Retry re-enqueues a failed task with exponential backoff.
	Retry(taskID string) error
}

// WatchdogRunner — contract for task queue watchdog (§8.2).
type WatchdogRunner interface {
	// ScanTimedOut finds tasks with status="processing" and expired timeout_at.
	ScanTimedOut() ([]Task, error)
	// ResetTask moves a timed-out task back to pending and increments attempts.
	ResetTask(taskID string) error
}

// Reminder represents a scheduled reminder (§8.4).
type Reminder struct {
	ID        string
	Message   string
	TriggerAt int64
	Fired     bool
}

// ReminderScheduler — contract for the reminder loop (§8.4).
type ReminderScheduler interface {
	// StoreReminder saves a reminder with a trigger time.
	StoreReminder(r Reminder) (string, error)
	// NextPending returns the next unfired reminder ordered by trigger_at.
	NextPending() (*Reminder, error)
	// MarkFired marks a reminder as fired so it is not re-triggered.
	MarkFired(reminderID string) error
}

// ---------- §9 WebSocket ----------

// WSHub — contract for WebSocket connection management (§9).
type WSHub interface {
	// Register adds a client connection.
	Register(clientID string, conn interface{}) error
	// Unregister removes a client connection.
	Unregister(clientID string) error
	// Broadcast sends a message to all connected clients.
	Broadcast(message []byte) error
	// Send sends a message to a specific client.
	Send(clientID string, message []byte) error
	// ConnectedClients returns a count of active connections.
	ConnectedClients() int
}

// WSHandler — contract for WebSocket message handling and auth (§9.1, §9.2, §9.3).
type WSHandler interface {
	// Authenticate validates a client's auth frame and returns the device name.
	Authenticate(token string) (deviceName string, err error)
	// HandleMessage parses and routes an incoming JSON message envelope.
	// Returns the response envelope (JSON) or an error.
	HandleMessage(clientID string, message []byte) (response []byte, err error)
	// IsAuthenticated reports whether the given client has completed auth.
	IsAuthenticated(clientID string) bool
	// AuthTimeout returns the auth timeout duration in seconds.
	AuthTimeout() int
}

// HeartbeatManager — contract for WebSocket heartbeat/ping-pong protocol (§9.4).
type HeartbeatManager interface {
	// SendPing sends a ping message to the specified client with the given timestamp.
	SendPing(clientID string, ts int64) error
	// RecordPong records that a pong was received from the client.
	RecordPong(clientID string, ts int64) error
	// MissedPongs returns the number of consecutive missed pongs for the client.
	MissedPongs(clientID string) int
	// ResetPongCounter resets the missed pong counter for the client to zero.
	ResetPongCounter(clientID string)
	// PingInterval returns the ping interval in seconds.
	PingInterval() int
	// PongTimeout returns the pong timeout in seconds.
	PongTimeout() int
	// MaxMissedPongs returns the max missed pongs before disconnect.
	MaxMissedPongs() int
}

// MessageBuffer — contract for per-device missed message buffer (§9.5).
type MessageBuffer interface {
	// Buffer stores a message for a disconnected device.
	Buffer(deviceID string, message []byte) error
	// Flush returns all buffered messages for the device in FIFO order and clears the buffer.
	Flush(deviceID string) ([][]byte, error)
	// Count returns the number of buffered messages for the device.
	Count(deviceID string) int
	// AckMessage removes a specific message from the buffer by event ID.
	AckMessage(deviceID string, eventID string) error
	// MaxMessages returns the max number of messages per device buffer.
	MaxMessages() int
	// TTL returns the buffer TTL in seconds.
	TTL() int
	// IsExpired reports whether the device's buffer has exceeded its TTL.
	IsExpired(deviceID string) bool
}

// ---------- §10 Pairing ----------

// PairingManager — contract for device pairing (§10).
type PairingManager interface {
	// GenerateCode creates a new pairing code (QR or numeric).
	GenerateCode() (code string, secret []byte, err error)
	// CompletePairing verifies the code and registers the device.
	CompletePairing(code string, deviceName string) (clientToken string, err error)
	// CompletePairingFull verifies the code and returns full pair response.
	CompletePairingFull(code string, deviceName string) (*PairResponse, error)
	// ListDevices returns all paired devices.
	ListDevices() ([]PairedDevice, error)
	// RevokeDevice disables a device by token ID.
	RevokeDevice(tokenID string) error
}

// PairResponse is the full response from a successful pairing.
type PairResponse struct {
	ClientToken string
	NodeDID     string
	WsURL       string
}

// PairedDevice holds metadata for a paired device.
type PairedDevice struct {
	TokenID   string
	Name      string
	LastSeen  int64
	CreatedAt int64
	Revoked   bool
}

// ---------- §11 Brain Client ----------

// BrainClient — contract for typed HTTP calls to brain (§11).
type BrainClient interface {
	// ProcessEvent sends an event to brain's guardian loop.
	ProcessEvent(event []byte) ([]byte, error)
	// Health checks brain's health endpoint.
	Health() error
	// IsAvailable returns true if the circuit breaker is closed.
	IsAvailable() bool
}

// ---------- §14 Config ----------

// Config holds all typed configuration for dina-core (§14).
type Config struct {
	ListenAddr    string
	AdminAddr     string
	VaultPath     string
	BrainURL      string
	BrainToken    string
	SecurityMode  string // "security" or "convenience"
	SessionTTL    int    // seconds
	RateLimit     int    // requests per minute per IP
	SpoolMax      int    // max buffered messages when locked
	BackupInterval int   // hours
}

// ConfigLoader — contract for loading configuration (§14).
type ConfigLoader interface {
	// Load reads config from env vars, config.json, and Docker secrets.
	Load() (*Config, error)
	// Validate checks config values for sanity.
	Validate(cfg *Config) error
}

// ---------- §15 Server ----------

// Server — contract for the HTTP server (§15).
type Server interface {
	// ListenAndServe starts the server.
	ListenAndServe() error
	// Shutdown gracefully stops the server.
	Shutdown() error
	// Routes returns all registered route patterns.
	Routes() []string
}

// HealthChecker — contract for health and readiness probes (§15.1).
type HealthChecker interface {
	// Liveness returns nil if the HTTP server is responding (GET /healthz).
	Liveness() error
	// Readiness returns nil if the vault is queryable (GET /readyz).
	Readiness() error
	// IsVaultHealthy reports whether db.PingContext() succeeds on identity.sqlite.
	IsVaultHealthy() bool
}

// VaultAPI — contract for vault HTTP endpoints (§15.2).
type VaultAPI interface {
	// Search performs POST /v1/vault/query with persona, q, mode, filters.
	Search(persona, query, mode string) ([]VaultItem, error)
	// StoreItem performs POST /v1/vault/store.
	StoreItem(persona string, item VaultItem) (string, error)
	// GetItem performs GET /v1/vault/item/:id.
	GetItem(id string) (*VaultItem, error)
	// DeleteItem performs DELETE /v1/vault/item/:id.
	DeleteItem(id string) error
	// StoreCrash performs POST /v1/vault/crash.
	StoreCrash(errMsg, traceback, taskID string) error
	// AckTask performs POST /v1/task/ack.
	AckTask(taskID string) error
	// PutKV performs PUT /v1/vault/kv/:key.
	PutKV(key, value string) error
	// GetKV performs GET /v1/vault/kv/:key.
	GetKV(key string) (string, error)
	// StoreBatch performs POST /v1/vault/store/batch.
	StoreBatch(persona string, items []VaultItem) error
}

// IdentityAPI — contract for identity HTTP endpoints (§15.3).
type IdentityAPI interface {
	// GetDID performs GET /v1/did.
	GetDID() ([]byte, error)
	// CreatePersona performs POST /v1/personas.
	CreatePersona(name, tier string) (string, error)
	// ListPersonas performs GET /v1/personas.
	ListPersonas() ([]string, error)
	// GetContacts performs GET /v1/contacts.
	GetContacts() ([]Contact, error)
	// AddContact performs POST /v1/contacts.
	AddContact(did, name, trustLevel string) error
	// RegisterDevice performs POST /v1/devices.
	RegisterDevice(name string, tokenHash []byte) (string, error)
	// ListDevices performs GET /v1/devices.
	ListDevices() ([]Device, error)
}

// MessagingAPI — contract for messaging HTTP endpoints (§15.4).
type MessagingAPI interface {
	// SendMessage performs POST /v1/msg/send.
	SendMessage(recipientDID string, payload []byte) error
	// GetInbox performs GET /v1/msg/inbox.
	GetInbox() ([][]byte, error)
	// AckMessage performs POST /v1/msg/{id}/ack.
	AckMessage(id string) error
}

// PairingAPI — contract for pairing HTTP endpoints (§15.5).
type PairingAPI interface {
	// Initiate performs POST /v1/pair/initiate and returns a pairing code and expiry.
	Initiate() (code string, expiresIn int, err error)
	// Complete performs POST /v1/pair/complete with code and device name.
	// Returns client_token, node_did, ws_url.
	Complete(code, deviceName string) (clientToken, nodeDID, wsURL string, err error)
	// IsPending reports whether a pairing code is still pending.
	IsPending(code string) bool
}

// ATProtoDiscovery — contract for AT Protocol discovery endpoint (§15.6).
type ATProtoDiscovery interface {
	// GetATProtoDID performs GET /.well-known/atproto-did.
	GetATProtoDID() (string, error)
	// HasRootDID reports whether a root DID is available.
	HasRootDID() bool
}

// ---------- Auth helpers ----------

// TokenValidator — contract for BRAIN_TOKEN and CLIENT_TOKEN auth (§1).
type TokenValidator interface {
	// ValidateBrainToken checks a BRAIN_TOKEN (constant-time comparison).
	ValidateBrainToken(token string) bool
	// ValidateClientToken checks a CLIENT_TOKEN (SHA-256 hash lookup).
	ValidateClientToken(token string) (deviceID string, ok bool)
	// IdentifyToken classifies a token as brain or client.
	IdentifyToken(token string) (kind string, identity string, err error)
}

// SessionManager — contract for browser session management (§1.3).
type SessionManager interface {
	// Create creates a new session after successful passphrase auth.
	Create(deviceID string) (sessionID, csrfToken string, err error)
	// Validate checks a session ID and returns the associated device.
	Validate(sessionID string) (deviceID string, err error)
	// ValidateCSRF checks a CSRF token against the session.
	ValidateCSRF(sessionID, csrfToken string) (bool, error)
	// Destroy invalidates a session.
	Destroy(sessionID string) error
	// ActiveSessions returns the number of active sessions.
	ActiveSessions() int
	// GetCSRFToken returns the CSRF token associated with a session.
	GetCSRFToken(sessionID string) (string, error)
}

// PassphraseVerifier — contract for Argon2id passphrase verification (§1.3).
type PassphraseVerifier interface {
	// Verify checks a passphrase against a stored Argon2id hash.
	Verify(passphrase string) (bool, error)
}

// AuthGateway — contract for browser session auth gateway HTTP behaviour (§1.3).
type AuthGateway interface {
	// Login handles POST /login — verifies passphrase, sets session cookie, returns redirect.
	// Returns: statusCode, setCookieHeader, locationHeader, error.
	Login(passphrase string) (statusCode int, setCookie string, location string, err error)
	// ProxyRequest translates a session cookie into a Bearer token for downstream.
	// Returns the Authorization header injected into the proxied request and
	// whether the Cookie header was stripped.
	ProxyRequest(sessionCookie string) (authHeader string, cookieStripped bool, err error)
	// ServeLoginPage returns the login HTML page from embed.FS.
	ServeLoginPage() (body []byte, contentType string, err error)
	// HandleAdminRequest routes an admin request: if Bearer present, pass through;
	// if session cookie present, translate; if neither, serve login page.
	HandleAdminRequest(bearerToken, sessionCookie string) (statusCode int, err error)
}

// RateLimiter — contract for per-IP request rate limiting (§1.3).
type RateLimiter interface {
	// Allow checks whether a request from the given IP is allowed.
	Allow(ip string) bool
	// Reset clears rate limit state for an IP (for testing).
	Reset(ip string)
}

// AdminEndpointChecker — contract for classifying admin vs. non-admin endpoints (§1.4).
type AdminEndpointChecker interface {
	// IsAdminEndpoint returns true if the given path is an admin-only endpoint.
	IsAdminEndpoint(path string) bool
	// AllowedForTokenKind checks if a token kind (brain/client) can access a path.
	AllowedForTokenKind(kind, path string) bool
}

// ---------- §12-19 Interfaces ----------

// AdminProxy — contract for reverse-proxying admin UI traffic to brain (§12).
type AdminProxy interface {
	// ProxyHTTP proxies an HTTP request to the brain admin UI.
	// Returns the status code and response body from the proxied request.
	ProxyHTTP(method, path string, headers map[string]string, body []byte) (statusCode int, respBody []byte, respHeaders map[string]string, err error)
	// ProxyWebSocket upgrades and proxies a WebSocket connection.
	// Returns true if the upgrade was successful.
	ProxyWebSocket(path string, headers map[string]string) (upgraded bool, err error)
	// TargetURL returns the brain admin backend URL being proxied to.
	TargetURL() string
}

// RateLimitResult holds rate limit check results with header information.
type RateLimitResult struct {
	Allowed   bool
	Remaining int
	ResetAt   int64 // Unix timestamp
}

// RateLimitChecker — extended contract for rate limiting with header info (§13).
type RateLimitChecker interface {
	// Check returns a detailed rate limit result for the given IP.
	Check(ip string) RateLimitResult
	// Allow checks whether a request from the given IP is allowed.
	Allow(ip string) bool
	// Reset clears rate limit state for an IP (for testing).
	Reset(ip string)
}

// ErrorHandler — contract for HTTP error handling and edge cases (§16).
type ErrorHandler interface {
	// HandleRequest processes an HTTP request and returns the appropriate status code
	// and response body. Used to verify error handling for malformed input, oversized
	// payloads, unknown endpoints, wrong methods, and content-type enforcement.
	HandleRequest(method, path, contentType string, body []byte) (statusCode int, respBody []byte, err error)
	// MaxBodySize returns the maximum allowed request body size in bytes.
	MaxBodySize() int64
	// RecoverFromPanic returns true if the server recovers from handler panics.
	RecoverFromPanic() bool
}

// SecurityAuditor — contract for security hardening verification (§17).
type SecurityAuditor interface {
	// AuditSourceCode scans source code for disallowed patterns and returns violations.
	// pattern is a regex or literal string to search for (e.g., "VACUUM INTO").
	AuditSourceCode(pattern string) ([]string, error)
	// AuditSQLQueries checks that all SQL queries use parameterized statements.
	// Returns any queries that use string concatenation.
	AuditSQLQueries() ([]string, error)
	// ValidatePathTraversal checks if a path is safe (no traversal components).
	ValidatePathTraversal(path string) (safe bool, normalized string, err error)
	// ValidateHeaderValue checks if a header value is safe (no injection).
	ValidateHeaderValue(value string) (safe bool, err error)
	// UsesConstantTimeCompare returns true if all token comparisons use crypto/subtle.
	UsesConstantTimeCompare() bool
	// InspectDockerConfig returns Docker configuration details for validation.
	InspectDockerConfig() (*DockerConfig, error)
}

// DockerConfig holds Docker deployment configuration for security auditing.
type DockerConfig struct {
	ExposedPorts     []string          // host ports mapped
	Networks         map[string]bool   // network name -> internal flag
	SecretsMountPath string            // e.g., "/run/secrets/"
	EnvVars          []string          // environment variable names
	ImageDigests     map[string]string // image name -> digest
}

// APIContractEndpoint describes a single API endpoint for contract testing.
type APIContractEndpoint struct {
	Method     string
	Path       string
	TokenType  string // "brain", "client", "admin"
	StatusCode int
}

// APIContract — contract for verifying core-brain API surface (§18).
type APIContract interface {
	// CallEndpoint sends a request to the given endpoint with the specified token.
	// Returns status code and response body.
	CallEndpoint(method, path, token string, body []byte) (statusCode int, respBody []byte, err error)
	// ListEndpoints returns all registered API endpoints.
	ListEndpoints() []APIContractEndpoint
	// IsBrainCallable returns true if the endpoint accepts BRAIN_TOKEN.
	IsBrainCallable(path string) bool
	// IsAdminOnly returns true if the endpoint requires admin/client access.
	IsAdminOnly(path string) bool
}

// OnboardingStep represents a single step in the onboarding sequence.
type OnboardingStep struct {
	Name      string
	Completed bool
	Data      map[string]interface{}
}

// OnboardingSequence — contract for managed onboarding flow (§19).
type OnboardingSequence interface {
	// StartOnboarding initiates the managed onboarding with email and passphrase.
	// Returns the generated mnemonic (for backup) and any error.
	StartOnboarding(email, passphrase string) (mnemonic string, err error)
	// GetMnemonic returns the BIP-39 mnemonic generated during onboarding.
	GetMnemonic() (string, error)
	// GetRootDID returns the root DID created during onboarding.
	GetRootDID() (string, error)
	// GetPersonas returns the list of personas created during onboarding.
	GetPersonas() ([]string, error)
	// GetSharingRules returns the sharing policies configured during onboarding.
	GetSharingRules() (map[string]interface{}, error)
	// GetSecurityMode returns "convenience" or "security" based on hosting type.
	GetSecurityMode() (string, error)
	// GetSteps returns the completed onboarding steps.
	GetSteps() ([]OnboardingStep, error)
	// IsMnemonicBackupDeferred returns true if backup prompt is deferred (not shown during onboarding).
	IsMnemonicBackupDeferred() bool
}

// ---------- §20-24 Interfaces ----------

// DockerHealthConfig holds parsed docker healthcheck settings for a service.
type DockerHealthConfig struct {
	ServiceName string
	Test        []string
	Interval    string
	Timeout     string
	Retries     int
	StartPeriod string
	Restart     string
	DependsOn   map[string]string // service -> condition
	Profiles    []string
}

// DockerComposeParser — contract for reading docker-compose healthcheck config (§20.2).
type DockerComposeParser interface {
	// ParseService extracts healthcheck config for a named service.
	ParseService(composePath, serviceName string) (*DockerHealthConfig, error)
}

// CrashEntry holds a crash log row.
type CrashEntry struct {
	ID        int64
	Timestamp string
	Error     string
	Traceback string
	TaskID    string
}

// CrashLogger — contract for crash log storage and retrieval (§20.3).
type CrashLogger interface {
	// Store inserts a crash entry into the crash_log table.
	Store(entry CrashEntry) error
	// Query returns crash entries within the given time range.
	Query(since string) ([]CrashEntry, error)
	// Purge deletes entries older than the given retention period in days.
	Purge(retentionDays int) (int, error)
}

// LogEntry holds a structured log line.
type LogEntry struct {
	Time   string
	Level  string
	Msg    string
	Module string
	Fields map[string]string
}

// LogAuditor — contract for log auditing and PII exclusion enforcement (§21).
type LogAuditor interface {
	// ParseLine parses a structured JSON log line.
	ParseLine(line string) (*LogEntry, error)
	// ContainsPII checks whether a log line contains PII.
	ContainsPII(line string) (bool, string, error)
	// MatchesBannedPattern checks a code line against CI banned log patterns.
	MatchesBannedPattern(codeLine string) (bool, string, error)
	// SanitizeCrash returns a one-liner suitable for stdout from a full traceback.
	SanitizeCrash(traceback string) string
}

// PDSRecord holds a signed AT Protocol record.
type PDSRecord struct {
	Collection string
	RecordKey  string
	Payload    map[string]interface{}
	Signature  []byte
	AuthorDID  string
}

// Tombstone represents a signed deletion marker.
type Tombstone struct {
	Target    string
	AuthorDID string
	Signature []byte
}

// PDSPublisher — contract for AT Protocol record signing and publishing (§22).
type PDSPublisher interface {
	// SignAndPublish signs a record with the persona key and writes to PDS.
	SignAndPublish(record PDSRecord) (string, error)
	// ValidateLexicon checks a record against its Lexicon schema.
	ValidateLexicon(record PDSRecord) error
	// DeleteRecord publishes a signed tombstone for a record.
	DeleteRecord(tombstone Tombstone) error
	// QueueForRetry queues a record in the outbox when PDS is unreachable.
	QueueForRetry(record PDSRecord) error
}

// ExportManifest holds metadata for an exported archive.
type ExportManifest struct {
	Version   string
	Timestamp string
	Checksums map[string]string // filename -> SHA-256 hex
}

// ExportOptions configures the export process.
type ExportOptions struct {
	Passphrase string
	DestPath   string
}

// ExportManager — contract for dina export (§23.1).
type ExportManager interface {
	// Export creates an encrypted archive of the Home Node.
	Export(opts ExportOptions) (archivePath string, err error)
	// ListArchiveContents returns the file list inside an archive.
	ListArchiveContents(archivePath string) ([]string, error)
	// ReadManifest extracts the manifest from an archive.
	ReadManifest(archivePath string, passphrase string) (*ExportManifest, error)
}

// ImportOptions configures the import process.
type ImportOptions struct {
	ArchivePath string
	Passphrase  string
	Force       bool // overwrite existing data
}

// ImportResult holds the outcome of an import.
type ImportResult struct {
	FilesRestored  int
	DID            string
	PersonaCount   int
	RequiresRepair bool
}

// ImportManager — contract for dina import (§23.2, §23.3).
type ImportManager interface {
	// Import decrypts and restores an archive to the Home Node.
	Import(opts ImportOptions) (*ImportResult, error)
	// VerifyArchive checks archive integrity without restoring.
	VerifyArchive(archivePath, passphrase string) error
	// CheckCompatibility verifies the archive version is compatible.
	CheckCompatibility(archivePath string) error
}

// ZKProof holds a zero-knowledge proof for identity verification.
type ZKProof struct {
	ProofType   string // "government_id", "credential"
	Proof       []byte
	PublicInput []byte
	Ring        int // 1=unverified, 2=verified, 3=skin-in-game
}

// TrustScore holds a computed trust score.
type TrustScore struct {
	RingLevel          int
	TimeAlive          int64 // seconds
	TransactionAnchors int
	OutcomeData        int
	PeerAttestations   int
	CredentialCount    int
	Score              float64
}

// ZKPVerifier — contract for ZKP trust ring verification (§24.1).
type ZKPVerifier interface {
	// VerifyProof verifies a zero-knowledge proof.
	VerifyProof(proof ZKProof) (bool, error)
	// ComputeTrustScore computes the composite trust score.
	ComputeTrustScore(did string) (*TrustScore, error)
	// GetRingLevel returns the current trust ring for a DID.
	GetRingLevel(did string) (int, error)
	// CheckDuplicate checks if a government ID has already been verified.
	CheckDuplicate(proofHash []byte) (bool, error)
}

// HSMKeyInfo holds metadata about a hardware-generated key.
type HSMKeyInfo struct {
	KeyType   string // "secure_enclave", "strongbox", "tpm", "software"
	KeyID     string
	PublicKey []byte
	Hardware  bool
}

// HSMProvider — contract for HSM/Secure Enclave key generation (§24.2).
type HSMProvider interface {
	// GenerateKey generates a key using the best available hardware.
	GenerateKey() (*HSMKeyInfo, error)
	// Sign signs data using the hardware-stored key.
	Sign(keyID string, data []byte) ([]byte, error)
	// IsHardwareBacked returns true if hardware key storage is available.
	IsHardwareBacked() bool
	// GetKeyInfo returns metadata about a stored key.
	GetKeyInfo(keyID string) (*HSMKeyInfo, error)
}

// ArchiveConfig holds deep archive configuration.
type ArchiveConfig struct {
	Frequency     string // "weekly", "daily", etc.
	Destination   string // "s3", "local"
	RetentionDays int
	EncryptionKey []byte
}

// ArchiveEntry holds metadata for one archive snapshot.
type ArchiveEntry struct {
	ID          string
	Timestamp   string
	Destination string
	Size        int64
	Checksum    string
	Tiers       []int // which data tiers are included
}

// ArchiveManager — contract for Tier 5 deep archive (§24.3).
type ArchiveManager interface {
	// CreateArchive creates a deep archive snapshot.
	CreateArchive(config ArchiveConfig) (*ArchiveEntry, error)
	// ListArchives lists existing archive snapshots.
	ListArchives() ([]ArchiveEntry, error)
	// VerifyArchive checks an archive's integrity.
	VerifyArchive(archiveID string) (bool, error)
	// GetIncludedTiers returns which data tiers are in the archive.
	GetIncludedTiers(archiveID string) ([]int, error)
}

// SnapshotInfo holds metadata about a filesystem snapshot.
type SnapshotInfo struct {
	Name      string
	Timestamp string
	Dataset   string
	Size      int64
}

// SnapshotManager — contract for ZFS/Btrfs filesystem snapshots (§24.4).
type SnapshotManager interface {
	// CreateSnapshot creates a copy-on-write snapshot.
	CreateSnapshot(dataset string) (*SnapshotInfo, error)
	// ListSnapshots lists snapshots for a dataset.
	ListSnapshots(dataset string) ([]SnapshotInfo, error)
	// Rollback reverts a dataset to a snapshot.
	Rollback(snapshotName string) error
	// ApplyRetention prunes snapshots according to the retention policy.
	ApplyRetention(dataset string) (int, error)
}

// CacheConfig holds client cache sync configuration.
type CacheConfig struct {
	DeviceType    string // "phone", "laptop", "thin"
	CacheDuration string // "6months", "everything", "none"
	EncryptionKey []byte
}

// CacheStatus holds the current state of a device's cache.
type CacheStatus struct {
	DeviceType  string
	CachedItems int
	OldestItem  string
	Encrypted   bool
	SyncKeyUsed bool
}

// CacheSyncer — contract for client cache sync (§24.5).
type CacheSyncer interface {
	// ConfigureCache sets up cache for a device type.
	ConfigureCache(config CacheConfig) error
	// GetCacheStatus returns the current cache state.
	GetCacheStatus(deviceID string) (*CacheStatus, error)
	// SyncCache pushes/pulls updates between Home Node and device.
	SyncCache(deviceID string) error
	// ClearCache removes all cached data from a device.
	ClearCache(deviceID string) error
}

// ---------- §25 Bot Interface ----------

// BotQuery represents a sanitized query sent to an external bot.
type BotQuery struct {
	Query       string
	RequesterID string // anonymized, never raw DID
	Category    string
	Timestamp   int64
}

// BotResponse represents a bot's response to a query.
type BotResponse struct {
	Answer      string
	Attribution string // deep link to source
	BotDID      string
	Signature   []byte
	Confidence  float64
}

// BotOutcome records the result of a bot interaction for scoring.
type BotOutcome struct {
	BotDID      string
	QueryID     string
	Helpful     bool
	Attribution bool // was attribution preserved?
	Timestamp   int64
}

// BotQueryHandler — contract for bot query sanitization and routing (arch §10).
type BotQueryHandler interface {
	// SanitizeQuery strips DID, medical, and financial data from outbound queries.
	SanitizeQuery(query string, userDID string) (string, error)
	// SendQuery sends a sanitized query to a bot and returns the response.
	SendQuery(botDID string, query BotQuery) (*BotResponse, error)
	// ScoreBot records an outcome and updates the bot's local reputation score.
	ScoreBot(botDID string, outcome BotOutcome) error
	// ValidateAttribution checks that the bot response includes valid attribution.
	ValidateAttribution(resp BotResponse) (bool, error)
}

// ---------- §26 Client Sync Protocol ----------

// ClientSyncManager — contract for checkpoint-based client sync (arch §13).
type ClientSyncManager interface {
	// Sync returns items changed since the given checkpoint and the new checkpoint.
	Sync(deviceID string, checkpoint int64) ([]VaultItem, int64, error)
	// PushUpdate pushes a new vault item to all connected sync clients.
	PushUpdate(item VaultItem) error
	// ResolveConflict resolves a conflict between local and remote versions using last-write-wins.
	ResolveConflict(local, remote VaultItem) VaultItem
	// FullSync returns all vault items for a new device (checkpoint=0).
	FullSync(deviceID string) ([]VaultItem, int64, error)
	// QueueOfflineChange queues a change made while the device was offline.
	QueueOfflineChange(deviceID string, change []byte) error
	// FlushOfflineQueue sends all queued offline changes and returns the count flushed.
	FlushOfflineQueue(deviceID string) (int, error)
}

// ---------- §27 Digital Estate ----------

// EstatePlan holds the digital estate configuration.
type EstatePlan struct {
	Trigger       string                 // "custodian_threshold" (only valid value — no timer)
	Custodians    []string               // DIDs of custodian contacts
	Threshold     int                    // k-of-n threshold for activation
	Beneficiaries map[string][]string    // beneficiary DID → list of persona names
	DefaultAction string                 // "destroy" or "archive"
	Notifications []string               // DIDs to notify on activation
	AccessTypes   map[string]string      // beneficiary DID → access type (e.g., "read_only_90_days", "full")
	CreatedAt     int64
	UpdatedAt     int64
}

// EstateManager — contract for digital estate planning (arch §14).
type EstateManager interface {
	// StorePlan persists the estate plan in Tier 0 (identity.sqlite).
	StorePlan(plan EstatePlan) error
	// GetPlan retrieves the current estate plan.
	GetPlan() (*EstatePlan, error)
	// Activate triggers estate recovery when custodian threshold is met.
	Activate(trigger string, custodianShares [][]byte) error
	// DeliverKeys sends per-beneficiary DEKs via Dina-to-Dina encrypted channel.
	DeliverKeys(beneficiaryDID string) error
	// NotifyContacts sends activation notifications to all contacts in the notification list.
	NotifyContacts() error
	// EnforceDefaultAction applies destroy/archive to non-assigned data.
	EnforceDefaultAction(action string) error
	// CheckExpiry checks if a time-limited access grant has expired.
	CheckExpiry(accessType string, grantedAt int64) (bool, error)
}

// ---------- §20 System Watchdog ----------

// WatchdogReport holds the results of a system health check tick.
type WatchdogReport struct {
	Timestamp          int64
	ConnectorAlive     bool
	DiskUsageBytes     int64
	DiskUsagePercent   float64
	BrainHealthy       bool
	AuditEntriesPurged int64
	CrashEntriesPurged int64
}

// SystemWatchdog — contract for 1-hour system health ticker (arch §16).
type SystemWatchdog interface {
	// RunTick executes a single watchdog sweep: checks liveness, disk, brain, purges old logs.
	RunTick() (*WatchdogReport, error)
	// CheckConnectorLiveness verifies external connectors are responsive.
	CheckConnectorLiveness() (bool, error)
	// CheckDiskUsage returns current disk usage in bytes.
	CheckDiskUsage() (int64, error)
	// CheckBrainHealth verifies brain sidecar is healthy.
	CheckBrainHealth() (bool, error)
}

// ---------- §5 PII De-Sanitizer ----------

// PIIDeSanitizer — contract for restoring PII tokens from replacement map (arch §11).
type PIIDeSanitizer interface {
	// DeSanitize restores original PII values from scrubbed text using the entity map.
	DeSanitize(scrubbed string, entities []PIIEntity) (string, error)
}
