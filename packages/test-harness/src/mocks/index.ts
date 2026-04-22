/**
 * Mock implementations — TypeScript equivalents of Go testutil/mocks.go.
 *
 * Each mock records call history for assertion and allows configuring
 * return values/errors. Thread-safety is not needed in JS (single-threaded),
 * but the API matches the Go mock patterns for consistency.
 *
 * Pattern:
 *   const mock = new MockSigner();
 *   mock.signResult = new Uint8Array([...]);
 *   await mock.sign(key, msg);
 *   expect(mock.signCalls).toHaveLength(1);
 */

import type {
  Signer,
  HDKeyDeriver,
  KeyWrapper,
  KEKDeriver,
  VaultDEKDeriver,
  Encryptor,
  KeyConverter,
  VaultReader,
  VaultWriter,
  VaultManagerPort,
  VaultAuditLogger,
  ScratchpadManager,
  StagingInbox,
  PersonaManager,
  ContactDirectory,
  DeviceRegistry,
  DIDManager,
  SignatureValidator,
  RateLimiter,
  Gatekeeper,
  SharingPolicyManager,
  ScenarioPolicyManager,
  OutboxManagerPort,
  InboxManager,
  TaskQueue,
  ReminderScheduler,
  PIIScrubber,
  PIIDeSanitizer,
  BrainClient,
  WSHub,
  CrashLogger,
  ApprovalManager,
  TrustCache,
  ContactAliasStore,
  ServiceKeyRegistrar,
  DeviceKeyRegistrar,
  VaultItem,
  StagingItem,
  Task,
  Reminder,
  Contact,
  AuditEntry,
  OutboxMessage,
  ApprovalRequest,
  Intent,
  Decision,
  ScrubResult,
  PIIEntity,
  TrustEntry,
  PairedDevice,
  PersonaName,
  DID,
  TokenType,
  SearchQuery,
  SharingPolicy,
  ScenarioTier,
} from '../ports';

// Sentinel errors re-exported from shared errors module
import { NotFoundError, PersonaLockedError } from '../errors';
export { NotImplementedError, PersonaLockedError, NotFoundError, ForbiddenError } from '../errors';

// ---------------------------------------------------------------------------
// Crypto Mocks
// ---------------------------------------------------------------------------

export class MockSigner implements Signer {
  generateResult: { publicKey: Uint8Array; privateKey: Uint8Array } = {
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(64),
  };
  generateError?: Error;
  signResult: Uint8Array = new Uint8Array(64);
  signError?: Error;
  verifyResult = true;
  verifyError?: Error;

  generateCalls: Uint8Array[] = [];
  signCalls: Array<{ privateKey: Uint8Array; message: Uint8Array }> = [];
  verifyCalls: Array<{ publicKey: Uint8Array; message: Uint8Array; signature: Uint8Array }> = [];

  async generateFromSeed(seed: Uint8Array) {
    this.generateCalls.push(seed);
    if (this.generateError) throw this.generateError;
    return this.generateResult;
  }
  async sign(privateKey: Uint8Array, message: Uint8Array) {
    this.signCalls.push({ privateKey, message });
    if (this.signError) throw this.signError;
    return this.signResult;
  }
  async verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) {
    this.verifyCalls.push({ publicKey, message, signature });
    if (this.verifyError) throw this.verifyError;
    return this.verifyResult;
  }
}

export class MockHDKeyDeriver implements HDKeyDeriver {
  result: { publicKey: Uint8Array; privateKey: Uint8Array } = {
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
  };
  error?: Error;
  calls: Array<{ seed: Uint8Array; path: string }> = [];

  async derivePath(seed: Uint8Array, path: string) {
    this.calls.push({ seed, path });
    if (this.error) throw this.error;
    return this.result;
  }
}

export class MockVaultDEKDeriver implements VaultDEKDeriver {
  result: Uint8Array = new Uint8Array(32);
  error?: Error;
  calls: Array<{ masterSeed: Uint8Array; personaID: string; userSalt: Uint8Array }> = [];

  async deriveVaultDEK(masterSeed: Uint8Array, personaID: string, userSalt: Uint8Array) {
    this.calls.push({ masterSeed, personaID, userSalt });
    if (this.error) throw this.error;
    return this.result;
  }
}

export class MockEncryptor implements Encryptor {
  sealResult: Uint8Array = new Uint8Array([0xca, 0xfe]);
  sealError?: Error;
  openResult: Uint8Array = new Uint8Array([0xde, 0xad]);
  openError?: Error;

  sealCalls: Array<{ plaintext: Uint8Array; recipientPub: Uint8Array }> = [];
  openCalls: Array<{
    ciphertext: Uint8Array;
    recipientPub: Uint8Array;
    recipientPriv: Uint8Array;
  }> = [];

  async sealAnonymous(plaintext: Uint8Array, recipientPub: Uint8Array) {
    this.sealCalls.push({ plaintext, recipientPub });
    if (this.sealError) throw this.sealError;
    return this.sealResult;
  }
  async openAnonymous(ciphertext: Uint8Array, recipientPub: Uint8Array, recipientPriv: Uint8Array) {
    this.openCalls.push({ ciphertext, recipientPub, recipientPriv });
    if (this.openError) throw this.openError;
    return this.openResult;
  }
}

// ---------------------------------------------------------------------------
// Identity Mocks
// ---------------------------------------------------------------------------

export class MockDIDManager implements DIDManager {
  createDID: DID = 'did:plc:test123';
  createError?: Error;
  resolveDoc: Uint8Array = new Uint8Array(0);
  resolveError?: Error;
  createCalls: Uint8Array[] = [];
  resolveCalls: DID[] = [];

  async create(publicKey: Uint8Array) {
    this.createCalls.push(publicKey);
    if (this.createError) throw this.createError;
    return this.createDID;
  }
  async resolve(did: DID) {
    this.resolveCalls.push(did);
    if (this.resolveError) throw this.resolveError;
    return this.resolveDoc;
  }
  async rotate() {
    /* no-op in mock */
  }
}

export class MockPersonaManager implements PersonaManager {
  personas = new Map<string, { tier: string; locked: boolean; description: string }>();
  createError?: Error;

  async create(name: string, tier: string) {
    if (this.createError) throw this.createError;
    const id = `persona-${name}`;
    this.personas.set(id, {
      tier,
      locked: tier === 'locked' || tier === 'sensitive',
      description: '',
    });
    return id;
  }
  async list() {
    return Array.from(this.personas.keys());
  }
  async unlock(personaID: string) {
    const p = this.personas.get(personaID);
    if (!p) throw new NotFoundError(personaID);
    p.locked = false;
  }
  async lock(personaID: string) {
    const p = this.personas.get(personaID);
    if (!p) throw new NotFoundError(personaID);
    p.locked = true;
  }
  async isLocked(personaID: string) {
    const p = this.personas.get(personaID);
    if (!p) throw new NotFoundError(personaID);
    return p.locked;
  }
  async accessPersona(personaID: string) {
    const p = this.personas.get(personaID);
    if (!p) throw new NotFoundError(personaID);
    if (p.locked) throw new PersonaLockedError(personaID);
  }
  async getTier(personaID: string) {
    const p = this.personas.get(personaID);
    if (!p) throw new NotFoundError(personaID);
    return p.tier;
  }
  async setDescription(personaID: string, description: string) {
    const p = this.personas.get(personaID);
    if (!p) throw new NotFoundError(personaID);
    p.description = description;
  }
}

// ---------------------------------------------------------------------------
// Vault Mocks
// ---------------------------------------------------------------------------

export class MockVaultManager implements VaultManagerPort {
  private openVaults = new Set<PersonaName>();
  openError?: Error;

  async open(persona: PersonaName) {
    if (this.openError) throw this.openError;
    this.openVaults.add(persona);
  }
  async close(persona: PersonaName) {
    this.openVaults.delete(persona);
  }
  isOpen(persona: PersonaName) {
    return this.openVaults.has(persona);
  }
  openPersonas() {
    return Array.from(this.openVaults);
  }
  async checkpoint() {
    /* no-op */
  }
}

export class MockVaultReader implements VaultReader {
  items: VaultItem[] = [];
  queryError?: Error;

  async query(_persona: PersonaName, q: SearchQuery) {
    if (this.queryError) throw this.queryError;
    const results = this.items.filter(
      (item) =>
        item.summary.toLowerCase().includes(q.text.toLowerCase()) ||
        item.body.toLowerCase().includes(q.text.toLowerCase()),
    );
    return results.slice(0, q.limit);
  }
  async getItem(_persona: PersonaName, id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }
  async vectorSearch(_persona: PersonaName, _vector: Float32Array, topK: number) {
    return this.items.slice(0, topK);
  }
}

export class MockVaultWriter implements VaultWriter {
  stored: VaultItem[] = [];
  storeError?: Error;

  async store(_persona: PersonaName, item: VaultItem) {
    if (this.storeError) throw this.storeError;
    this.stored.push(item);
    return item.id;
  }
  async storeBatch(_persona: PersonaName, items: VaultItem[]) {
    if (this.storeError) throw this.storeError;
    this.stored.push(...items);
    return items.map((i) => i.id);
  }
  async delete(_persona: PersonaName, id: string) {
    this.stored = this.stored.filter((i) => i.id !== id);
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper Mocks
// ---------------------------------------------------------------------------

export class MockGatekeeper implements Gatekeeper {
  decision: Decision = {
    allowed: true,
    reason: 'mock-allowed',
    requires_approval: false,
    audit_required: false,
  };
  egressAllowed = true;
  evaluateCalls: Intent[] = [];

  async evaluateIntent(intent: Intent) {
    this.evaluateCalls.push(intent);
    return this.decision;
  }
  async checkEgress() {
    return this.egressAllowed;
  }
}

// ---------------------------------------------------------------------------
// Auth Mocks
// ---------------------------------------------------------------------------

/**
 * Mock Ed25519 signature validator — mobile model (no CLIENT_TOKEN).
 *
 * By default, accepts all signatures and derives caller identity from the
 * presented DID. Register known DIDs with `register()` for precise
 * kind/identity mapping. Set `verifyError` to reject all signatures.
 */
export class MockSignatureValidator implements SignatureValidator {
  verifyError?: Error;
  verifyCalls: Array<{ did: string; method: string; path: string }> = [];

  /** Registered DID → identity mappings. Checked before fallback. */
  private registrations = new Map<string, { kind: TokenType; identity: string }>();

  /** Register a known DID with its kind and identity. */
  register(did: string, kind: TokenType, identity: string): void {
    this.registrations.set(did, { kind, identity });
  }

  verifySignature(
    did: string,
    method: string,
    path: string,
    _query: string,
    _timestamp: string,
    _nonce: string,
    _body: Uint8Array,
    _signatureHex: string,
  ) {
    this.verifyCalls.push({ did, method, path });
    if (this.verifyError) throw this.verifyError;

    // Check registered DIDs first
    const registered = this.registrations.get(did);
    if (registered) return registered;

    // Fallback: derive identity from DID string.
    // "did:key:z6MkBrainService" → kind=service, identity=brain
    // "did:key:z6Mkadmin" → kind=service, identity=admin
    // "did:key:z6Mkdev-0001" → kind=device, identity=dev-0001
    const suffix = did.replace(/^did:key:z6Mk/, '');
    const isService = ['brain', 'admin', 'connector', 'BrainService', 'CoreService'].some((s) =>
      suffix.toLowerCase().startsWith(s.toLowerCase()),
    );
    if (isService) {
      const identity = suffix.replace(/Service$/i, '').toLowerCase();
      return { kind: 'service' as TokenType, identity };
    }
    return { kind: 'device' as TokenType, identity: suffix };
  }
}

export class MockRateLimiter implements RateLimiter {
  allowed = true;
  calls: string[] = [];

  allow(key: string) {
    this.calls.push(key);
    return this.allowed;
  }
  reset(_key: string) {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// PII Mocks
// ---------------------------------------------------------------------------

export class MockPIIScrubber implements PIIScrubber {
  /** Configure custom result. If null, passthrough (no scrubbing). */
  configuredResult: ScrubResult | null = null;
  scrubCalls: string[] = [];

  async scrub(text: string) {
    this.scrubCalls.push(text);
    if (this.configuredResult) return this.configuredResult;
    return { scrubbed: text, entities: [] as PIIEntity[] };
  }
}

// ---------------------------------------------------------------------------
// Brain Client Mock
// ---------------------------------------------------------------------------

export class MockBrainClient implements BrainClient {
  processEvents: Array<Record<string, unknown>> = [];
  reasonResult = { answer: 'mock answer', sources: [] as string[] };
  healthy = true;
  scrubResult: ScrubResult = { scrubbed: '', entities: [] };

  async process(event: Record<string, unknown>) {
    this.processEvents.push(event);
  }
  async reason(_query: string) {
    return this.reasonResult;
  }
  async isHealthy() {
    return this.healthy;
  }
  async scrubPII(text: string) {
    if (this.scrubResult.scrubbed) return this.scrubResult;
    return { scrubbed: text, entities: [] as PIIEntity[] };
  }
}

// ---------------------------------------------------------------------------
// Outbox Mock
// ---------------------------------------------------------------------------

export class MockOutboxManager implements OutboxManagerPort {
  messages: OutboxMessage[] = [];

  async enqueue(msg: OutboxMessage) {
    this.messages.push(msg);
    return msg.id;
  }
  async markDelivered(msgID: string) {
    this.messages = this.messages.filter((m) => m.id !== msgID);
  }
  async markFailed(msgID: string) {
    const msg = this.messages.find((m) => m.id === msgID);
    if (msg) {
      msg.status = 'failed';
      msg.retry_count++;
    }
  }
  async requeue(msgID: string) {
    const msg = this.messages.find((m) => m.id === msgID);
    if (msg) msg.status = 'pending';
  }
  async listPending() {
    return this.messages.filter((m) => m.status === 'pending');
  }
  async deleteExpired() {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Task Queue Mock
// ---------------------------------------------------------------------------

export class MockTaskQueue implements TaskQueue {
  tasks: Task[] = [];
  private seq = 0;

  async enqueue(task: Partial<Task>) {
    const id = task.id ?? `mock-task-${++this.seq}`;
    const full: Task = {
      id,
      type: 'test',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      max_attempts: 3,
      scheduled_at: 0,
      error: '',
      created_at: 0,
      ...task,
    };
    this.tasks.push(full);
    return id;
  }
  async dequeue() {
    return this.tasks.find((t) => t.status === 'pending') ?? null;
  }
  async acknowledge(taskID: string) {
    const task = this.tasks.find((t) => t.id === taskID);
    if (task) task.status = 'running';
    return task ?? null;
  }
  async complete(taskID: string) {
    const task = this.tasks.find((t) => t.id === taskID);
    if (task) task.status = 'completed';
  }
  async fail(taskID: string, reason: string) {
    const task = this.tasks.find((t) => t.id === taskID);
    if (task) {
      task.status = 'failed';
      task.error = reason;
    }
  }
  async recoverRunning() {
    let count = 0;
    for (const t of this.tasks) {
      if (t.status === 'running') {
        t.status = 'pending';
        count++;
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Crash Logger Mock
// ---------------------------------------------------------------------------

export class MockCrashLogger implements CrashLogger {
  entries: Array<{ id: number; ts: number; component: string; message: string }> = [];
  private seq = 0;

  async store(entry: { component: string; message: string; stack_hash: string }) {
    this.entries.push({
      id: ++this.seq,
      ts: Math.floor(Date.now() / 1000),
      component: entry.component,
      message: entry.message,
    });
  }
  async query(_since: number) {
    return this.entries;
  }
  async purge() {
    const n = this.entries.length;
    this.entries = [];
    return n;
  }
}

// ---------------------------------------------------------------------------
// Trust Cache Mock
// ---------------------------------------------------------------------------

export class MockTrustCache implements TrustCache {
  entries = new Map<string, TrustEntry>();

  async lookup(did: string) {
    return this.entries.get(did) ?? null;
  }
  async list() {
    return Array.from(this.entries.values());
  }
  async upsert(entry: TrustEntry) {
    this.entries.set(entry.did, entry);
  }
  async remove(did: string) {
    this.entries.delete(did);
  }
}

// ---------------------------------------------------------------------------
// WSHub Mock
// ---------------------------------------------------------------------------

export class MockWSHub implements WSHub {
  clients = new Map<string, unknown>();
  broadcasts: Uint8Array[] = [];
  sent: Array<{ clientID: string; message: Uint8Array }> = [];

  register(clientID: string, conn: unknown) {
    this.clients.set(clientID, conn);
  }
  unregister(clientID: string) {
    this.clients.delete(clientID);
  }
  broadcast(message: Uint8Array) {
    this.broadcasts.push(message);
  }
  send(clientID: string, message: Uint8Array) {
    this.sent.push({ clientID, message });
  }
  connectedClients() {
    return this.clients.size;
  }
}

// ---------------------------------------------------------------------------
// Remaining Mocks (17 interfaces that were missing from initial harness)
// ---------------------------------------------------------------------------

export class MockKeyWrapper implements KeyWrapper {
  wrapResult: Uint8Array = new Uint8Array([0x01, 0x02]);
  wrapError?: Error;
  unwrapResult: Uint8Array = new Uint8Array(32);
  unwrapError?: Error;
  wrapCalls: Array<{ dek: Uint8Array; kek: Uint8Array }> = [];
  unwrapCalls: Array<{ wrapped: Uint8Array; kek: Uint8Array }> = [];

  async wrap(dek: Uint8Array, kek: Uint8Array) {
    this.wrapCalls.push({ dek, kek });
    if (this.wrapError) throw this.wrapError;
    return this.wrapResult;
  }
  async unwrap(wrapped: Uint8Array, kek: Uint8Array) {
    this.unwrapCalls.push({ wrapped, kek });
    if (this.unwrapError) throw this.unwrapError;
    return this.unwrapResult;
  }
}

export class MockKEKDeriver implements KEKDeriver {
  result: Uint8Array = new Uint8Array(32);
  error?: Error;
  calls: Array<{ passphrase: string; salt: Uint8Array }> = [];

  async deriveKEK(passphrase: string, salt: Uint8Array) {
    this.calls.push({ passphrase, salt });
    if (this.error) throw this.error;
    return this.result;
  }
}

export class MockKeyConverter implements KeyConverter {
  privateResult: Uint8Array = new Uint8Array(32);
  publicResult: Uint8Array = new Uint8Array(32);
  error?: Error;

  async ed25519ToX25519Private(ed25519Priv: Uint8Array) {
    if (this.error) throw this.error;
    return this.privateResult;
  }
  async ed25519ToX25519Public(ed25519Pub: Uint8Array) {
    if (this.error) throw this.error;
    return this.publicResult;
  }
}

export class MockInboxManager implements InboxManager {
  ipRateAllowed = true;
  globalRateAllowed = true;
  payloadSizeOk = true;
  spooled: Uint8Array[] = [];

  checkIPRate(_ip: string) {
    return this.ipRateAllowed;
  }
  checkGlobalRate() {
    return this.globalRateAllowed;
  }
  async spool(payload: Uint8Array) {
    this.spooled.push(payload);
    return `spool-${this.spooled.length}`;
  }
  async spoolSize() {
    return this.spooled.reduce((sum, p) => sum + p.length, 0);
  }
  async drainSpool() {
    const items = [...this.spooled];
    this.spooled = [];
    return items;
  }
}

export class MockScratchpadManager implements ScratchpadManager {
  data = new Map<string, { step: number; data: Uint8Array }>();

  async write(taskID: string, step: number, data: Uint8Array) {
    this.data.set(taskID, { step, data });
  }
  async read(taskID: string) {
    return this.data.get(taskID) ?? null;
  }
  async delete(taskID: string) {
    this.data.delete(taskID);
  }
}

export class MockVaultAuditLogger implements VaultAuditLogger {
  entries: AuditEntry[] = [];
  private seq = 0;
  chainValid = true;

  async append(entry: Omit<AuditEntry, 'seq' | 'prev_hash' | 'entry_hash'>) {
    const seq = ++this.seq;
    const last = this.entries[this.entries.length - 1];
    const prevHash = last ? last.entry_hash : '';
    const full: AuditEntry = {
      ...entry,
      seq,
      prev_hash: prevHash,
      entry_hash: `hash-${seq}`,
    };
    this.entries.push(full);
    return seq;
  }
  async query(filter: {
    actor?: string;
    action?: string;
    since?: number;
    until?: number;
    limit?: number;
  }) {
    let result = [...this.entries];
    if (filter.actor) result = result.filter((e) => e.actor === filter.actor);
    if (filter.action) result = result.filter((e) => e.action === filter.action);
    if (filter.since) result = result.filter((e) => e.ts >= filter.since!);
    if (filter.until) result = result.filter((e) => e.ts <= filter.until!);
    if (filter.limit) result = result.slice(0, filter.limit);
    return result;
  }
  async verifyChain() {
    return this.chainValid;
  }
  async purge(_retentionDays: number) {
    const n = this.entries.length;
    this.entries = [];
    return n;
  }
}

export class MockStagingInbox implements StagingInbox {
  items: StagingItem[] = [];

  async ingest(item: Partial<StagingItem>) {
    const id = item.id ?? `stg-${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const full: StagingItem = {
      id,
      connector_id: '',
      source: '',
      source_id: '',
      source_hash: '',
      type: '',
      summary: '',
      body: '',
      sender: '',
      metadata: '{}',
      status: 'received',
      target_persona: '',
      classified_item: '{}',
      error: '',
      retry_count: 0,
      claimed_at: 0,
      lease_until: 0,
      expires_at: now + 7 * 86400,
      created_at: now,
      updated_at: now,
      ingress_channel: '',
      origin_did: '',
      origin_kind: '',
      producer_id: '',
      ...item,
    };
    this.items.push(full);
    return id;
  }
  async claim(limit: number, leaseDurationMs: number) {
    const now = Math.floor(Date.now() / 1000);
    const claimed: StagingItem[] = [];
    for (const item of this.items) {
      if (item.status === 'received' && claimed.length < limit) {
        item.status = 'classifying';
        item.claimed_at = now;
        item.lease_until = now + Math.floor(leaseDurationMs / 1000);
        claimed.push(item);
      }
    }
    return claimed;
  }
  async resolve(id: string, targetPersona: string, _classifiedItem: VaultItem) {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = 'stored';
      item.target_persona = targetPersona;
    }
  }
  async extendLease(id: string, extensionMs: number) {
    const item = this.items.find((i) => i.id === id);
    if (item) item.lease_until += Math.floor(extensionMs / 1000);
  }
  async markFailed(id: string, errMsg: string) {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = 'failed';
      item.error = errMsg;
      item.retry_count++;
    }
  }
  async markPendingApproval(id: string, targetPersona: string, _classifiedItem: VaultItem) {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = 'pending_unlock';
      item.target_persona = targetPersona;
    }
  }
  async drainPending(persona: string) {
    let count = 0;
    for (const item of this.items) {
      if (item.status === 'pending_unlock' && item.target_persona === persona) {
        item.status = 'stored';
        count++;
      }
    }
    return count;
  }
  async sweep() {
    const now = Math.floor(Date.now() / 1000);
    const before = this.items.length;
    this.items = this.items.filter((i) => i.expires_at > now);
    return before - this.items.length;
  }
}

export class MockReminderScheduler implements ReminderScheduler {
  reminders: Reminder[] = [];

  async storeReminder(r: Partial<Reminder>) {
    const id = r.id ?? `rem-${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const full: Reminder = {
      id,
      message: '',
      due_at: now + 86400,
      recurring: '',
      completed: 0,
      created_at: now,
      source_item_id: '',
      source: '',
      persona: 'general',
      timezone: '',
      kind: '',
      status: 'pending',
      ...r,
    };
    this.reminders.push(full);
    return id;
  }
  async listPending() {
    return this.reminders.filter((r) => r.status === 'pending' && r.completed === 0);
  }
  async markFired(reminderID: string) {
    const r = this.reminders.find((rem) => rem.id === reminderID);
    if (r) {
      r.status = 'fired';
      r.completed = 1;
    }
  }
  async deleteReminder(id: string) {
    this.reminders = this.reminders.filter((r) => r.id !== id);
  }
}

export class MockContactDirectory implements ContactDirectory {
  contacts = new Map<string, Contact>();

  async add(did: string, name: string, trustLevel: string) {
    const now = Math.floor(Date.now() / 1000);
    this.contacts.set(did, {
      did,
      display_name: name,
      trust_level: trustLevel as Contact['trust_level'],
      sharing_tier: 'none',
      notes: '',
      created_at: now,
      updated_at: now,
    });
  }
  async list() {
    return Array.from(this.contacts.values());
  }
  async resolve(name: string) {
    for (const [did, c] of this.contacts) {
      if (c.display_name === name) return did;
    }
    throw new NotFoundError(name);
  }
  async updateTrust(did: string, trustLevel: string) {
    const c = this.contacts.get(did);
    if (!c) throw new NotFoundError(did);
    c.trust_level = trustLevel as Contact['trust_level'];
  }
  async delete(did: string) {
    this.contacts.delete(did);
  }
}

export class MockContactAliasStore implements ContactAliasStore {
  aliases = new Map<string, Set<string>>(); // DID → aliases

  async addAlias(did: string, alias: string) {
    if (!this.aliases.has(did)) this.aliases.set(did, new Set());
    this.aliases.get(did)!.add(alias);
  }
  async removeAlias(did: string, alias: string) {
    this.aliases.get(did)?.delete(alias);
  }
  async listAliases(did: string) {
    return Array.from(this.aliases.get(did) ?? []);
  }
  async resolveAlias(alias: string) {
    for (const [did, set] of this.aliases) {
      if (set.has(alias)) return did;
    }
    throw new NotFoundError(alias);
  }
}

export class MockDeviceRegistry implements DeviceRegistry {
  devices: PairedDevice[] = [];
  private seq = 0;

  async register(name: string, publicKeyMultibase: string, role = 'client') {
    const id = `dev-${++this.seq}`;
    const now = Math.floor(Date.now() / 1000);
    this.devices.push({
      device_id: id,
      public_key_multibase: publicKeyMultibase,
      device_name: name,
      role,
      last_seen: now,
      created_at: now,
      revoked: 0,
    });
    return id;
  }
  async list() {
    return this.devices.filter((d) => d.revoked === 0);
  }
  async revoke(deviceID: string) {
    const d = this.devices.find((dev) => dev.device_id === deviceID);
    if (d) d.revoked = 1;
  }
  async getByDID(did: string) {
    // DID derived from public key — check if any device's multibase matches
    return this.devices.find((d) => d.public_key_multibase === did && d.revoked === 0) ?? null;
  }
}

export class MockApprovalManager implements ApprovalManager {
  requests: ApprovalRequest[] = [];

  async requestApproval(req: Omit<ApprovalRequest, 'status'>) {
    const id = req.id ?? `apr-${Date.now()}`;
    this.requests.push({ ...req, id, status: 'pending' });
    return id;
  }
  async approveRequest(id: string, scope: string, grantedBy: string) {
    const r = this.requests.find((req) => req.id === id);
    if (!r) throw new NotFoundError(id);
    r.status = 'approved';
    r.scope = scope as 'single' | 'session';
  }
  async denyRequest(id: string) {
    const r = this.requests.find((req) => req.id === id);
    if (!r) throw new NotFoundError(id);
    r.status = 'denied';
  }
  async listPending() {
    return this.requests.filter((r) => r.status === 'pending');
  }
}

export class MockSharingPolicyManager implements SharingPolicyManager {
  policies = new Map<string, SharingPolicy>();

  async getPolicy(contactDID: string) {
    return this.policies.get(contactDID) ?? null;
  }
  async setPolicy(contactDID: string, categories: Record<string, string>) {
    this.policies.set(contactDID, categories as SharingPolicy);
  }
}

export class MockScenarioPolicyManager implements ScenarioPolicyManager {
  policies = new Map<string, Record<string, ScenarioTier>>();

  async getScenarioTier(contactDID: string, scenario: string) {
    return this.policies.get(contactDID)?.[scenario] ?? 'deny';
  }
  async setScenarioPolicy(contactDID: string, scenario: string, tier: ScenarioTier) {
    if (!this.policies.has(contactDID)) this.policies.set(contactDID, {});
    this.policies.get(contactDID)![scenario] = tier;
  }
  async listPolicies(contactDID: string) {
    return this.policies.get(contactDID) ?? {};
  }
  async setDefaultPolicies(contactDID: string) {
    this.policies.set(contactDID, {
      'presence.signal': 'allow',
      'coordination.request': 'allow',
      'social.update': 'allow',
      'safety.alert': 'allow',
      'trust.vouch.request': 'approval_required',
    });
  }
}

export class MockPIIDeSanitizer implements PIIDeSanitizer {
  async deSanitize(scrubbed: string, entities: PIIEntity[]) {
    let result = scrubbed;
    for (const e of entities) {
      result = result.replace(e.token, e.value);
    }
    return result;
  }
}

export class MockServiceKeyRegistrar implements ServiceKeyRegistrar {
  keys = new Map<string, { pubKey: Uint8Array; serviceID: string }>();
  registerServiceKey(did: string, pubKey: Uint8Array, serviceID: string) {
    this.keys.set(did, { pubKey, serviceID });
  }
}

export class MockDeviceKeyRegistrar implements DeviceKeyRegistrar {
  keys = new Map<string, { pubKey: Uint8Array; deviceID: string }>();
  revokedDIDs = new Set<string>();

  registerDeviceKey(did: string, pubKey: Uint8Array, deviceID: string) {
    this.keys.set(did, { pubKey, deviceID });
  }
  revokeDeviceKey(did: string) {
    this.revokedDIDs.add(did);
    this.keys.delete(did);
  }
}

// ---------------------------------------------------------------------------
// CoreClient mock (task 1.34) — lives in a sibling file because the
// CoreClient surface is 13 methods + 14 types, and inlining would
// bloat this already-dense index. The re-export keeps the existing
// import convention (`import { MockCoreClient } from '@dina/test-harness'`).
// ---------------------------------------------------------------------------

export { MockCoreClient } from './core_client';
export type { RecordedCall, CoreClientMethodName } from './core_client';
