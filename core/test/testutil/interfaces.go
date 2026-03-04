// Package testutil defines contracts (interfaces) for all dina-core subsystems.
// Source packages implement these implicitly via Go's structural typing.
// Tests use mock implementations initially; swap to real when code arrives.
package testutil

import (
	"context"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ---------- §4 Vault (SQLCipher) ----------
//
// VaultManager, ScratchpadManager, StagingManager, and VaultAuditLogger
// are defined in port/ — use port.VaultManager, port.VaultReader, etc.

// VaultItem is an alias for domain.VaultItem.
type VaultItem = domain.VaultItem

// SearchQuery is an alias for domain.SearchQuery.
type SearchQuery = domain.SearchQuery

// BackupManager — contract for encrypted backup (§4.6).
type BackupManager interface {
	// Backup creates an encrypted backup of the persona's vault.
	Backup(ctx context.Context, personaID, destPath string) error
	// Restore replaces the persona's vault with a backup.
	Restore(ctx context.Context, personaID, srcPath string) error
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

// VaultAuditLogger is defined in port/ — use port.VaultAuditLogger.
// PurgeCrashLog is an extra method on the concrete vault.AuditLogger type.

// VaultAuditEntry is an alias for domain.VaultAuditEntry.
type VaultAuditEntry = domain.VaultAuditEntry

// VaultAuditFilter is an alias for domain.VaultAuditFilter.
type VaultAuditFilter = domain.VaultAuditFilter

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

// BootConfig is an alias for domain.BootConfig.
type BootConfig = domain.BootConfig

// ---------- §6 Gatekeeper ----------

// Intent is an alias for domain.Intent.
type Intent = domain.Intent

// Decision is an alias for domain.Decision.
type Decision = domain.Decision

// Gatekeeper is defined in port/ — use port.Gatekeeper.

// SharingTier is an alias for domain.SharingTier.
type SharingTier = domain.SharingTier

// SharingPolicy is an alias for domain.SharingPolicy.
type SharingPolicy = domain.SharingPolicy

// TieredPayload is an alias for domain.TieredPayload.
type TieredPayload = domain.TieredPayload

// EgressPayload is an alias for domain.EgressPayload.
type EgressPayload = domain.EgressPayload

// EgressResult is an alias for domain.EgressResult.
type EgressResult = domain.EgressResult

// AuditEntry is an alias for domain.AuditEntry.
type AuditEntry = domain.AuditEntry

// SharingPolicyManager — contract for sharing policy CRUD and egress filtering (§6.1, §6.2, §6.3).
type SharingPolicyManager interface {
	// GetPolicy returns the sharing policy for a contact DID.
	GetPolicy(ctx context.Context, contactDID string) (*SharingPolicy, error)
	// SetPolicy sets one or more category tiers for a contact.
	SetPolicy(ctx context.Context, contactDID string, categories map[string]SharingTier) error
	// SetBulkPolicy applies a policy to contacts matching a filter.
	SetBulkPolicy(ctx context.Context, filter map[string]string, categories map[string]SharingTier) (int, error)
	// FilterEgress applies sharing policy to an outbound payload.
	FilterEgress(ctx context.Context, payload EgressPayload) (*EgressResult, error)
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
	// SetRelayURL configures the relay fallback URL.
	SetRelayURL(url string)
	// GetRelayURL returns the current relay URL.
	GetRelayURL() string
	// AddEndpoint registers a known DID -> endpoint mapping.
	AddEndpoint(did, endpoint string)
	// SentCount returns the number of sent messages (for testing).
	SentCount() int
}

// OutboxMessage is an alias for domain.OutboxMessage.
type OutboxMessage = domain.OutboxMessage

// OutboxManager — contract for reliable outbox delivery (§7.1).
type OutboxManager interface {
	// Enqueue adds a message to the outbox. Returns the message ID (ULID).
	Enqueue(ctx context.Context, msg OutboxMessage) (string, error)
	// MarkDelivered marks a message as delivered.
	MarkDelivered(ctx context.Context, msgID string) error
	// MarkFailed marks a message as failed and schedules retry with backoff.
	MarkFailed(ctx context.Context, msgID string) error
	// Requeue re-enqueues a failed message with fresh retry count.
	Requeue(ctx context.Context, msgID string) error
	// PendingCount returns the number of pending messages.
	PendingCount(ctx context.Context) (int, error)
	// ListPending returns all pending messages whose retry time has elapsed.
	ListPending(ctx context.Context) ([]OutboxMessage, error)
	// GetByID retrieves a message by ID.
	GetByID(msgID string) (*OutboxMessage, error)
	// DeleteExpired removes messages older than TTL.
	DeleteExpired(ttlSeconds int64) (int, error)
	// GetRetryCount returns the retry count for a message.
	GetRetryCount(msgID string) int
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
	Spool(ctx context.Context, payload []byte) (string, error)
	// SpoolSize returns the current spool size in bytes (Valve 2).
	SpoolSize() (int64, error)
	// ProcessSpool processes all spooled messages FIFO by ULID (Valve 3).
	ProcessSpool(ctx context.Context) (int, error)
	// DrainSpool atomically removes all non-expired spooled payloads for processing.
	DrainSpool(ctx context.Context) ([][]byte, error)
	// CheckDIDRate checks per-DID rate limit — only when unlocked (fast path).
	CheckDIDRate(did string) bool
	// SetSpoolMax sets the maximum spool size in bytes.
	SetSpoolMax(n int64)
	// SetTTL sets the message TTL for expiry enforcement.
	SetTTL(d time.Duration)
	// FlushSpool clears all spooled messages.
	FlushSpool()
	// ResetRateLimits resets all rate limit counters.
	ResetRateLimits()
}

// DIDResolver — contract for DID resolution and caching (§7.3).
type DIDResolver interface {
	// Resolve fetches or returns cached DID Document.
	Resolve(did string) ([]byte, error)
	// InvalidateCache removes a DID from cache.
	InvalidateCache(did string)
	// CacheStats returns cache hit and miss counters.
	CacheStats() (hits, misses int)
	// CacheSize returns the number of cached entries.
	CacheSize() int
	// SetTTL sets the cache TTL duration.
	SetTTL(d time.Duration)
	// AddDocument adds a DID document to the cache.
	AddDocument(did string, doc []byte)
	// SetFetcher sets the remote DID Document fetch function.
	SetFetcher(fn func(did string) ([]byte, error))
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

// Task is an alias for domain.Task.
type Task = domain.Task

// TaskQueuer — contract for persistent task queue (§8).
type TaskQueuer interface {
	// Enqueue adds a task. Returns the task ID.
	Enqueue(ctx context.Context, task Task) (string, error)
	// Dequeue returns the highest-priority pending task and marks it running.
	Dequeue(ctx context.Context) (*Task, error)
	// Complete marks a task as completed.
	Complete(ctx context.Context, taskID string) error
	// Fail marks a task as failed with a reason.
	Fail(ctx context.Context, taskID, reason string) error
	// Retry re-enqueues a failed task with exponential backoff.
	Retry(ctx context.Context, taskID string) error
	// Cancel moves a task to "cancelled" status.
	Cancel(ctx context.Context, taskID string) error
	// RecoverRunning bulk-resets all running tasks back to pending (crash recovery).
	RecoverRunning(ctx context.Context) (int, error)
	// GetByID looks up a task by ID across all states.
	GetByID(ctx context.Context, taskID string) (*Task, error)
	// SetMaxRetries configures the maximum number of retries before dead letter.
	SetMaxRetries(n int)
}

// WatchdogRunner — contract for task queue watchdog (§8.2).
type WatchdogRunner interface {
	// ScanTimedOut finds tasks with status="processing" and expired timeout_at.
	ScanTimedOut(ctx context.Context) ([]Task, error)
	// ResetTask moves a timed-out task back to pending and increments attempts.
	ResetTask(ctx context.Context, taskID string) error
}

// Reminder is an alias for domain.Reminder.
type Reminder = domain.Reminder

// ReminderScheduler — contract for the reminder loop (§8.4).
type ReminderScheduler interface {
	// StoreReminder saves a reminder with a trigger time.
	StoreReminder(ctx context.Context, r Reminder) (string, error)
	// NextPending returns the next unfired reminder ordered by trigger_at.
	NextPending(ctx context.Context) (*Reminder, error)
	// MarkFired marks a reminder as fired so it is not re-triggered.
	MarkFired(ctx context.Context, reminderID string) error
	// ListPending returns all unfired reminders ordered by trigger_at.
	ListPending(ctx context.Context) ([]Reminder, error)
	// GetByID retrieves a reminder by its ID.
	GetByID(ctx context.Context, id string) (*Reminder, error)
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
	Authenticate(ctx context.Context, token string) (deviceName string, err error)
	// HandleMessage parses and routes an incoming JSON message envelope.
	// Returns the response envelope (JSON) or an error.
	HandleMessage(ctx context.Context, clientID string, message []byte) (response []byte, err error)
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
	GenerateCode(ctx context.Context) (code string, secret []byte, err error)
	// CompletePairing verifies the code and registers the device.
	CompletePairing(ctx context.Context, code string, deviceName string) (clientToken string, tokenID string, err error)
	// CompletePairingFull verifies the code and returns full pair response.
	CompletePairingFull(ctx context.Context, code string, deviceName string) (*PairResponse, error)
	// CompletePairingWithKey verifies the code and registers a device using
	// an Ed25519 public key (signature-based auth). No CLIENT_TOKEN generated.
	CompletePairingWithKey(ctx context.Context, code, deviceName, publicKeyMultibase string) (deviceID string, nodeDID string, err error)
	// ListDevices returns all paired devices.
	ListDevices(ctx context.Context) ([]PairedDevice, error)
	// RevokeDevice disables a device by token ID.
	RevokeDevice(ctx context.Context, tokenID string) error
}

// PairResponse is an alias for domain.PairResponse.
type PairResponse = domain.PairResponse

// PairedDevice is an alias for domain.PairedDevice.
type PairedDevice = domain.PairedDevice

// ---------- §11 Brain Client ----------

// BrainClient — contract for typed HTTP calls to brain (§11).
type BrainClient interface {
	// ProcessEvent sends an event to brain's guardian loop.
	ProcessEvent(event []byte) ([]byte, error)
	// Health checks brain's health endpoint.
	Health() error
	// IsAvailable returns true if the circuit breaker is closed.
	IsAvailable() bool
	// SetCooldown sets the circuit breaker cooldown duration (for testing).
	SetCooldown(d time.Duration)
	// SetMaxFailures sets the circuit breaker failure threshold (for testing).
	SetMaxFailures(n int)
	// CircuitState returns the current circuit breaker state.
	CircuitState() string
	// ResetForTest resets the circuit breaker for per-test isolation.
	ResetForTest()
}

// ---------- §14 Config ----------

// Config holds all typed configuration for dina-core (§14).
type Config struct {
	ListenAddr    string
	AdminAddr     string
	VaultPath     string
	BrainURL      string
	BrainToken    string // deprecated: kept for admin proxy fallback
	ServiceKeyDir string
	SecurityMode  string // "security" or "convenience"
	SessionTTL    int    // seconds
	RateLimit     int    // requests per minute per IP
	SpoolMax       int    // max buffered messages when locked
	BackupInterval int    // hours
	PDSURL         string // PDS XRPC endpoint
	PLCURL         string // PLC directory URL
	PDSAdminPassword string // PDS admin password
	PDSHandle        string // AT Protocol handle
	AdminSocketPath  string // Unix socket path for local admin CLI
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
	GetContacts() ([]domain.Contact, error)
	// AddContact performs POST /v1/contacts.
	AddContact(did, name, trustLevel string) error
	// RegisterDevice performs POST /v1/devices.
	RegisterDevice(name string, tokenHash []byte) (string, error)
	// ListDevices performs GET /v1/devices.
	ListDevices() ([]domain.Device, error)
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

// AuthGateway — contract for browser session auth gateway HTTP behaviour (§1.3).
type AuthGateway interface {
	// Login handles POST /login — verifies passphrase, sets session cookie, returns redirect.
	// Returns: statusCode, setCookieHeader, locationHeader, error.
	Login(passphrase string) (statusCode int, setCookie string, location string, err error)
	// LOW-17: ProxyRequest removed — leaked BRAIN_TOKEN.
	// ServeLoginPage returns the login HTML page from embed.FS.
	ServeLoginPage() (body []byte, contentType string, err error)
	// HandleAdminRequest routes an admin request: if Bearer present, pass through;
	// if session cookie present, translate; if neither, serve login page.
	HandleAdminRequest(bearerToken, sessionCookie string) (statusCode int, err error)
}

// AdminEndpointChecker — contract for classifying admin vs. non-admin endpoints (§1.4).
type AdminEndpointChecker interface {
	// IsAdminEndpoint returns true if the given path is an admin-only endpoint.
	IsAdminEndpoint(path string) bool
	// AllowedForTokenKind checks if a token kind (brain/client) can access a path.
	// Optional scope differentiates privilege levels (e.g. "admin" vs "device").
	AllowedForTokenKind(kind, path string, scope ...string) bool
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

// DockerConfig is an alias for domain.DockerConfig.
type DockerConfig = domain.DockerConfig

// APIContractEndpoint is an alias for domain.APIContractEndpoint.
type APIContractEndpoint = domain.APIContractEndpoint

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

// OnboardingStep is an alias for domain.OnboardingStep.
type OnboardingStep = domain.OnboardingStep

// OnboardingSequence — contract for managed onboarding flow (§19).
// BIP-39 mnemonic generation is handled client-side (Python CLI / install.sh).
type OnboardingSequence interface {
	// StartOnboarding initiates the managed onboarding with email and passphrase.
	// Mnemonic generation is client-side; Core returns empty string for mnemonic.
	StartOnboarding(ctx context.Context, email, passphrase string) (mnemonic string, err error)
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

// DockerHealthConfig is an alias for domain.DockerHealthConfig.
type DockerHealthConfig = domain.DockerHealthConfig

// DockerComposeParser — contract for reading docker-compose healthcheck config (§20.2).
type DockerComposeParser interface {
	// ParseService extracts healthcheck config for a named service.
	ParseService(composePath, serviceName string) (*DockerHealthConfig, error)
}

// CrashEntry is an alias for domain.CrashEntry.
type CrashEntry = domain.CrashEntry

// CrashLogger — contract for crash log storage and retrieval (§20.3).
type CrashLogger interface {
	// Store inserts a crash entry into the crash_log table.
	Store(ctx context.Context, entry CrashEntry) error
	// Query returns crash entries within the given time range.
	Query(ctx context.Context, since string) ([]CrashEntry, error)
	// Purge deletes entries older than the given retention period in days.
	Purge(ctx context.Context, retentionDays int) (int64, error)
}

// LogEntry is an alias for domain.LogEntry.
type LogEntry = domain.LogEntry

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

// PDSRecord is an alias for domain.PDSRecord.
type PDSRecord = domain.PDSRecord

// Tombstone is an alias for domain.Tombstone.
type Tombstone = domain.Tombstone

// PDSPublisher — contract for AT Protocol record signing and publishing (§22).
type PDSPublisher interface {
	// SignAndPublish signs a record with the persona key and writes to PDS.
	SignAndPublish(ctx context.Context, record PDSRecord) (string, error)
	// ValidateLexicon checks a record against its Lexicon schema.
	ValidateLexicon(record PDSRecord) error
	// DeleteRecord publishes a signed tombstone for a record.
	DeleteRecord(ctx context.Context, tombstone Tombstone) error
	// QueueForRetry queues a record in the outbox when PDS is unreachable.
	QueueForRetry(ctx context.Context, record PDSRecord) error
}

// ExportManifest is an alias for domain.ExportManifest.
type ExportManifest = domain.ExportManifest

// ExportOptions is an alias for domain.ExportOptions.
type ExportOptions = domain.ExportOptions

// ExportManager — contract for dina export (§23.1).
type ExportManager interface {
	// Export creates an encrypted archive of the Home Node.
	Export(ctx context.Context, opts ExportOptions) (archivePath string, err error)
	// ListArchiveContents returns the file list inside an archive.
	ListArchiveContents(archivePath string) ([]string, error)
	// ReadManifest extracts the manifest from an archive.
	ReadManifest(archivePath string, passphrase string) (*ExportManifest, error)
}

// ImportOptions is an alias for domain.ImportOptions.
type ImportOptions = domain.ImportOptions

// ImportResult is an alias for domain.ImportResult.
type ImportResult = domain.ImportResult

// ImportManager — contract for dina import (§23.2, §23.3).
type ImportManager interface {
	// Import decrypts and restores an archive to the Home Node.
	Import(ctx context.Context, opts ImportOptions) (*ImportResult, error)
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
	// ScoreBot records an outcome and updates the bot's local trust score.
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

// EstatePlan is an alias for domain.EstatePlan.
type EstatePlan = domain.EstatePlan

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

// WatchdogReport is an alias for domain.WatchdogReport.
type WatchdogReport = domain.WatchdogReport

// SystemWatchdog — contract for 1-hour system health ticker (arch §16).
type SystemWatchdog interface {
	// RunTick executes a single watchdog sweep: checks liveness, disk, brain, purges old logs.
	RunTick(ctx context.Context) (*WatchdogReport, error)
	// CheckConnectorLiveness verifies external connectors are responsive.
	CheckConnectorLiveness() (bool, error)
	// CheckDiskUsage returns current disk usage in bytes.
	CheckDiskUsage() (int64, error)
	// CheckBrainHealth verifies brain sidecar is healthy.
	CheckBrainHealth(ctx context.Context) (bool, error)
}

