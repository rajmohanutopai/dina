/**
 * Port interfaces — TypeScript equivalents of Go core/internal/port/*.go.
 *
 * These define the contracts that both real implementations and test mocks
 * must satisfy. Method signatures match the Go originals exactly (adapted
 * for TypeScript idioms: async instead of context.Context, Error instead
 * of error return).
 *
 * Source of truth: /dina/core/internal/port/
 */

// ---------------------------------------------------------------------------
// Domain types (shared across all ports)
// ---------------------------------------------------------------------------

export type PersonaName = string;
export type DID = string;

export interface VaultItem {
  id: string;
  type: string;
  source: string;
  source_id: string;
  contact_did: string;
  summary: string;
  body: string;
  metadata: string;
  embedding?: Uint8Array;
  tags: string;
  timestamp: number;
  created_at: number;
  updated_at: number;
  deleted: number;
  sender: string;
  sender_trust: string;
  source_type: string;
  confidence: string;
  retrieval_policy: string;
  contradicts: string;
  content_l0: string;
  content_l1: string;
  enrichment_status: string;
  enrichment_version: string;
}

export interface SearchQuery {
  mode: 'fts5' | 'semantic' | 'hybrid';
  text: string;
  embedding?: Float32Array;
  limit: number;
  filters?: Record<string, string>;
  /** Filter by vault item type(s). Only items with matching type are returned. */
  types?: string[];
  /** Filter by timestamp: only items after this Unix ms timestamp. */
  after?: number;
  /** Filter by timestamp: only items before this Unix ms timestamp. */
  before?: number;
  /** Skip first N results (pagination). Applied after scoring/sorting. */
  offset?: number;
}

export interface StagingItem {
  id: string;
  connector_id: string;
  source: string;
  source_id: string;
  source_hash: string;
  type: string;
  summary: string;
  body: string;
  sender: string;
  metadata: string;
  status: 'received' | 'classifying' | 'stored' | 'pending_unlock' | 'failed';
  target_persona: string;
  classified_item: string;
  error: string;
  retry_count: number;
  claimed_at: number;
  lease_until: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
  ingress_channel: string;
  origin_did: string;
  origin_kind: string;
  producer_id: string;
}

export interface Task {
  id: string;
  type: string;
  payload: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  scheduled_at: number;
  started_at?: number;
  completed_at?: number;
  error: string;
  created_at: number;
}

export interface Reminder {
  id: string;
  message: string;
  due_at: number;
  recurring: '' | 'daily' | 'weekly' | 'monthly';
  completed: number;
  created_at: number;
  source_item_id: string;
  source: string;
  persona: string;
  timezone: string;
  kind: string;
  status: string;
}

export interface Contact {
  did: string;
  display_name: string;
  trust_level: 'blocked' | 'unknown' | 'verified' | 'trusted';
  sharing_tier: 'none' | 'summary' | 'full' | 'locked';
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface AuditEntry {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  resource: string;
  detail: string;
  prev_hash: string;
  entry_hash: string;
}

export interface OutboxMessage {
  id: string;
  recipient_did: string;
  payload: Uint8Array;
  status: string;
  retry_count: number;
  next_retry_at?: number;
  created_at: number;
}

export interface ApprovalRequest {
  id: string;
  action: string;
  requester_did: string;
  persona: string;
  reason: string;
  preview: string;
  status: 'pending' | 'approved' | 'denied';
  scope?: 'single' | 'session';
  created_at: number;
}

export interface Intent {
  action: string;
  agent_did?: string;
  trust_level?: string;
}

export interface Decision {
  allowed: boolean;
  reason: string;
  requires_approval: boolean;
  audit_required: boolean;
}

export interface DinaMessage {
  id: string;
  type: string;
  from: string;
  to: string;
  created_time: number;
  body: string;
}

export interface ScrubResult {
  scrubbed: string;
  entities: PIIEntity[];
}

export interface PIIEntity {
  type: string;
  start: number;
  end: number;
  value: string;
  token: string;
}

export type TokenType = 'service' | 'client' | 'device' | 'unknown';

export interface TrustEntry {
  did: string;
  display_name: string;
  trust_score: number;
  trust_ring: 1 | 2 | 3;
  relationship: string;
  source: string;
  last_verified_at: number;
  updated_at: number;
}

/**
 * PairedDevice — mobile model.
 *
 * The server schema has `device_tokens` with `token_hash` (CLIENT_TOKEN hash).
 * Mobile uses Ed25519 device keys instead — no CLIENT_TOKEN. The
 * `public_key_multibase` field stores the device's Ed25519 public key in
 * multibase format (z-prefixed base58btc).
 */
export interface PairedDevice {
  device_id: string;
  public_key_multibase: string;
  device_name: string;
  role: string;
  last_seen: number;
  created_at: number;
  revoked: number;
}

export interface SharingPolicy {
  [category: string]: 'none' | 'summary' | 'full' | 'locked';
}

export type ScenarioTier = 'allow' | 'deny' | 'approval_required';

// ---------------------------------------------------------------------------
// Crypto ports (core/internal/port/crypto.go)
// ---------------------------------------------------------------------------

export interface HDKeyDeriver {
  derivePath(
    seed: Uint8Array,
    path: string,
  ): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
}

export interface KeyConverter {
  ed25519ToX25519Private(ed25519Priv: Uint8Array): Promise<Uint8Array>;
  ed25519ToX25519Public(ed25519Pub: Uint8Array): Promise<Uint8Array>;
}

export interface Encryptor {
  sealAnonymous(plaintext: Uint8Array, recipientPub: Uint8Array): Promise<Uint8Array>;
  openAnonymous(
    ciphertext: Uint8Array,
    recipientPub: Uint8Array,
    recipientPriv: Uint8Array,
  ): Promise<Uint8Array>;
}

export interface KeyWrapper {
  wrap(dek: Uint8Array, kek: Uint8Array): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, kek: Uint8Array): Promise<Uint8Array>;
}

export interface KEKDeriver {
  deriveKEK(passphrase: string, salt: Uint8Array): Promise<Uint8Array>;
}

export interface VaultDEKDeriver {
  deriveVaultDEK(
    masterSeed: Uint8Array,
    personaID: string,
    userSalt: Uint8Array,
  ): Promise<Uint8Array>;
}

export interface Signer {
  generateFromSeed(seed: Uint8Array): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Identity ports (core/internal/port/identity.go)
// ---------------------------------------------------------------------------

export interface DIDManager {
  create(publicKey: Uint8Array): Promise<DID>;
  resolve(did: DID): Promise<Uint8Array>;
  rotate(
    did: DID,
    rotationPayload: Uint8Array,
    signature: Uint8Array,
    newPubKey: Uint8Array,
  ): Promise<void>;
}

export interface PersonaManager {
  create(name: string, tier: string, passphraseHash?: string): Promise<string>;
  list(): Promise<string[]>;
  unlock(personaID: string, passphrase: string, ttlSeconds: number): Promise<void>;
  lock(personaID: string): Promise<void>;
  isLocked(personaID: string): Promise<boolean>;
  accessPersona(personaID: string): Promise<void>;
  getTier(personaID: string): Promise<string>;
  setDescription(personaID: string, description: string): Promise<void>;
}

export interface ContactDirectory {
  add(
    did: string,
    name: string,
    trustLevel: string,
    relationship: string,
    dataResponsibility: string,
  ): Promise<void>;
  list(): Promise<Contact[]>;
  resolve(name: string): Promise<string>;
  updateTrust(did: string, trustLevel: string): Promise<void>;
  delete(did: string): Promise<void>;
}

export interface ContactAliasStore {
  addAlias(did: string, alias: string): Promise<void>;
  removeAlias(did: string, alias: string): Promise<void>;
  listAliases(did: string): Promise<string[]>;
  resolveAlias(alias: string): Promise<string>;
}

export interface DeviceRegistry {
  register(name: string, publicKeyMultibase: string, role?: string): Promise<string>;
  list(): Promise<PairedDevice[]>;
  revoke(deviceID: string): Promise<void>;
  getByDID(did: string): Promise<PairedDevice | null>;
}

// ---------------------------------------------------------------------------
// Vault ports (core/internal/port/vault.go)
// ---------------------------------------------------------------------------

export interface VaultReader {
  query(persona: PersonaName, q: SearchQuery): Promise<VaultItem[]>;
  getItem(persona: PersonaName, id: string): Promise<VaultItem | null>;
  vectorSearch(persona: PersonaName, vector: Float32Array, topK: number): Promise<VaultItem[]>;
}

export interface VaultWriter {
  store(persona: PersonaName, item: VaultItem): Promise<string>;
  storeBatch(persona: PersonaName, items: VaultItem[]): Promise<string[]>;
  delete(persona: PersonaName, id: string): Promise<void>;
}

export interface VaultManagerPort {
  open(persona: PersonaName, dek: Uint8Array): Promise<void>;
  close(persona: PersonaName): Promise<void>;
  isOpen(persona: PersonaName): boolean;
  openPersonas(): PersonaName[];
  checkpoint(persona: PersonaName): Promise<void>;
}

export interface VaultAuditLogger {
  append(entry: Omit<AuditEntry, 'seq' | 'prev_hash' | 'entry_hash'>): Promise<number>;
  query(filter: {
    actor?: string;
    action?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<AuditEntry[]>;
  verifyChain(): Promise<boolean>;
  purge(retentionDays: number): Promise<number>;
}

export interface ScratchpadManager {
  write(taskID: string, step: number, data: Uint8Array): Promise<void>;
  read(taskID: string): Promise<{ step: number; data: Uint8Array } | null>;
  delete(taskID: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Staging ports (core/internal/port/staging.go)
// ---------------------------------------------------------------------------

export interface StagingInbox {
  ingest(item: Partial<StagingItem>): Promise<string>;
  claim(limit: number, leaseDurationMs: number): Promise<StagingItem[]>;
  resolve(id: string, targetPersona: string, classifiedItem: VaultItem): Promise<void>;
  extendLease(id: string, extensionMs: number): Promise<void>;
  markFailed(id: string, errMsg: string): Promise<void>;
  markPendingApproval(id: string, targetPersona: string, classifiedItem: VaultItem): Promise<void>;
  drainPending(persona: string): Promise<number>;
  sweep(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Auth ports (core/internal/port/auth.go)
// ---------------------------------------------------------------------------

/**
 * SignatureValidator — mobile auth (Ed25519 only, no CLIENT_TOKEN).
 *
 * The server's TokenValidator also has validateClientToken() and
 * identifyToken() for CLIENT_TOKEN bearer auth. Mobile does not use
 * CLIENT_TOKEN (architecture decision: Ed25519 everywhere). This
 * interface exposes only Ed25519 signature verification.
 */
export interface SignatureValidator {
  verifySignature(
    did: string,
    method: string,
    path: string,
    query: string,
    timestamp: string,
    nonce: string,
    body: Uint8Array,
    signatureHex: string,
  ): { kind: TokenType; identity: string };
}

export interface ServiceKeyRegistrar {
  registerServiceKey(did: string, pubKey: Uint8Array, serviceID: string): void;
}

export interface DeviceKeyRegistrar {
  registerDeviceKey(did: string, pubKey: Uint8Array, deviceID: string): void;
  revokeDeviceKey(did: string): void;
}

export interface RateLimiter {
  allow(key: string): boolean;
  reset(key: string): void;
}

// ---------------------------------------------------------------------------
// Gatekeeper ports (core/internal/port/gatekeeper.go)
// ---------------------------------------------------------------------------

export interface Gatekeeper {
  evaluateIntent(intent: Intent): Promise<Decision>;
  checkEgress(destination: string, data: Uint8Array): Promise<boolean>;
}

export interface SharingPolicyManager {
  getPolicy(contactDID: string): Promise<SharingPolicy | null>;
  setPolicy(contactDID: string, categories: Record<string, string>): Promise<void>;
}

export interface ScenarioPolicyManager {
  getScenarioTier(contactDID: string, scenario: string): Promise<ScenarioTier>;
  setScenarioPolicy(contactDID: string, scenario: string, tier: ScenarioTier): Promise<void>;
  listPolicies(contactDID: string): Promise<Record<string, ScenarioTier>>;
  setDefaultPolicies(contactDID: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Transport ports (core/internal/port/transport.go)
// ---------------------------------------------------------------------------

export interface OutboxManagerPort {
  enqueue(msg: OutboxMessage): Promise<string>;
  markDelivered(msgID: string): Promise<void>;
  markFailed(msgID: string): Promise<void>;
  requeue(msgID: string): Promise<void>;
  listPending(): Promise<OutboxMessage[]>;
  deleteExpired(ttlSeconds: number): Promise<number>;
}

export interface InboxManager {
  checkIPRate(ip: string): boolean;
  checkGlobalRate(): boolean;
  spool(payload: Uint8Array): Promise<string>;
  spoolSize(): Promise<number>;
  drainSpool(): Promise<Uint8Array[]>;
}

// ---------------------------------------------------------------------------
// Task ports (core/internal/port/task.go)
// ---------------------------------------------------------------------------

export interface TaskQueue {
  enqueue(task: Partial<Task>): Promise<string>;
  dequeue(): Promise<Task | null>;
  acknowledge(taskID: string): Promise<Task | null>;
  complete(taskID: string): Promise<void>;
  fail(taskID: string, reason: string): Promise<void>;
  recoverRunning(): Promise<number>;
}

export interface ReminderScheduler {
  storeReminder(r: Partial<Reminder>): Promise<string>;
  listPending(): Promise<Reminder[]>;
  markFired(reminderID: string): Promise<void>;
  deleteReminder(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// PII ports (core/internal/port/pii.go)
// ---------------------------------------------------------------------------

export interface PIIScrubber {
  scrub(text: string): Promise<ScrubResult>;
}

export interface PIIDeSanitizer {
  deSanitize(scrubbed: string, entities: PIIEntity[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// Trust ports (core/internal/port/trust.go)
// ---------------------------------------------------------------------------

export interface TrustCache {
  lookup(did: string): Promise<TrustEntry | null>;
  list(): Promise<TrustEntry[]>;
  upsert(entry: TrustEntry): Promise<void>;
  remove(did: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Approval ports (core/internal/port/approval.go)
// ---------------------------------------------------------------------------

export interface ApprovalManager {
  requestApproval(req: Omit<ApprovalRequest, 'status'>): Promise<string>;
  approveRequest(id: string, scope: string, grantedBy: string): Promise<void>;
  denyRequest(id: string): Promise<void>;
  listPending(): Promise<ApprovalRequest[]>;
}

// ---------------------------------------------------------------------------
// Observability ports (core/internal/port/observability.go)
// ---------------------------------------------------------------------------

export interface CrashLogger {
  store(entry: { component: string; message: string; stack_hash: string }): Promise<void>;
  query(
    since: number,
  ): Promise<Array<{ id: number; ts: number; component: string; message: string }>>;
  purge(retentionDays: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Brain ports (core/internal/port/brain.go)
// ---------------------------------------------------------------------------

export interface BrainClient {
  process(event: Record<string, unknown>): Promise<void>;
  reason(query: string): Promise<{ answer: string; sources: string[] }>;
  isHealthy(): Promise<boolean>;
  scrubPII(text: string): Promise<ScrubResult>;
}

// ---------------------------------------------------------------------------
// WebSocket ports (core/internal/port/websocket.go)
// ---------------------------------------------------------------------------

export interface WSHub {
  register(clientID: string, conn: unknown): void;
  unregister(clientID: string): void;
  broadcast(message: Uint8Array): void;
  send(clientID: string, message: Uint8Array): void;
  connectedClients(): number;
}
