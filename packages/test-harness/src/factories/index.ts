/**
 * Test data factories — TypeScript equivalents of Go testutil fixtures
 * and Python brain/tests/factories.py.
 *
 * Pattern: every factory returns a valid default object. Override any field
 * via the `overrides` parameter. This matches the Python `**overrides` pattern.
 *
 * ID strategy: all factories use a shared sequential counter for
 * deterministic, reproducible IDs. Call `resetFactoryCounters()` in
 * beforeEach to isolate tests. No Math.random() — tests must be
 * reproducible.
 *
 * Timestamp strategy: all factories use a fixed epoch base (1700000000)
 * plus the counter offset. No Date.now() — tests must be deterministic.
 */

import type {
  VaultItem,
  StagingItem,
  Task,
  Reminder,
  Contact,
  AuditEntry,
  OutboxMessage,
  ApprovalRequest,
  Intent,
  DinaMessage,
  TrustEntry,
  PairedDevice,
  ScrubResult,
  PIIEntity,
  SearchQuery,
} from '../ports';

// ---------------------------------------------------------------------------
// Shared counter for deterministic IDs
// ---------------------------------------------------------------------------

let counter = 0;
const BASE_EPOCH = 1700000000; // fixed base — no Date.now()

function nextID(prefix: string): string {
  return `${prefix}-${String(++counter).padStart(4, '0')}`;
}

function nextTimestamp(): number {
  return BASE_EPOCH + counter;
}

// ---------------------------------------------------------------------------
// Event type (typed replacement for Record<string, unknown>)
// ---------------------------------------------------------------------------

export interface GuardianEvent {
  type: string;
  source: string;
  sender: string;
  subject: string;
  body: string;
  timestamp: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Vault Items
// ---------------------------------------------------------------------------

export function makeVaultItem(overrides: Partial<VaultItem> = {}): VaultItem {
  const id = nextID('item');
  const ts = nextTimestamp();
  return {
    id,
    type: 'email',
    source: 'gmail',
    source_id: `msg-${id}`,
    contact_did: 'did:key:z6MkTestContact',
    summary: `Meeting reminder for ${id}`,
    body: `Hi, just a reminder about our meeting. ${id}.`,
    metadata: '{"labels": ["inbox", "primary"]}',
    tags: '[]',
    timestamp: ts,
    created_at: ts + 1,
    updated_at: ts + 1,
    deleted: 0,
    sender: 'alice@example.com',
    sender_trust: 'unknown',
    source_type: '',
    confidence: 'medium',
    retrieval_policy: 'normal',
    contradicts: '',
    content_l0: '',
    content_l1: '',
    enrichment_status: 'pending',
    enrichment_version: '',
    ...overrides,
  };
}

export function makeVaultItems(n: number, overrides: Partial<VaultItem> = {}): VaultItem[] {
  return Array.from({ length: n }, () => makeVaultItem(overrides));
}

// ---------------------------------------------------------------------------
// Staging Items
// ---------------------------------------------------------------------------

export function makeStagingItem(overrides: Partial<StagingItem> = {}): StagingItem {
  const id = nextID('stg');
  const ts = nextTimestamp();
  return {
    id,
    connector_id: '',
    source: 'gmail',
    source_id: `src-${id}`,
    source_hash: '',
    type: 'email',
    summary: `Staging item ${id}`,
    body: `Body of staging item ${id}`,
    sender: 'sender@example.com',
    metadata: '{}',
    status: 'received',
    target_persona: '',
    classified_item: '{}',
    error: '',
    retry_count: 0,
    claimed_at: 0,
    lease_until: 0,
    expires_at: ts + 7 * 86400,
    created_at: ts,
    updated_at: ts,
    ingress_channel: 'chat',
    origin_did: '',
    origin_kind: 'user',
    producer_id: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function makeTask(overrides: Partial<Task> = {}): Task {
  const id = nextID('task');
  const ts = nextTimestamp();
  return {
    id,
    type: 'sync_gmail',
    payload: '{"connector": "gmail"}',
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    scheduled_at: ts,
    error: '',
    created_at: ts,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  const id = nextID('rem');
  const ts = nextTimestamp();
  return {
    id,
    message: 'License renewal due',
    due_at: ts + 86400,
    recurring: '',
    completed: 0,
    created_at: ts,
    source_item_id: '',
    source: '',
    persona: 'general',
    timezone: '',
    kind: 'deadline',
    status: 'pending',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function makeContact(overrides: Partial<Contact> = {}): Contact {
  const ts = nextTimestamp();
  return {
    did: 'did:key:z6MkAliceFriend',
    display_name: 'Alice',
    trust_level: 'verified',
    sharing_tier: 'summary',
    notes: '',
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Outbox Messages
// ---------------------------------------------------------------------------

export function makeOutboxMessage(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  const id = nextID('out');
  const ts = nextTimestamp();
  return {
    id,
    recipient_did: 'did:plc:recipient456',
    payload: new Uint8Array([0xca, 0xfe]),
    status: 'pending',
    retry_count: 0,
    next_retry_at: ts + 30,
    created_at: ts,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Approval Requests
// ---------------------------------------------------------------------------

export function makeApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const id = nextID('apr');
  const ts = nextTimestamp();
  return {
    id,
    action: 'access_health_vault',
    requester_did: 'did:key:z6MkAgent',
    persona: 'health',
    reason: 'Agent needs health data for analysis',
    preview: 'Lab results from Dr. Smith',
    status: 'pending',
    created_at: ts,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Intents (Gatekeeper)
// ---------------------------------------------------------------------------

export function makeSafeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    action: 'search',
    agent_did: 'did:key:z6MkAgent',
    trust_level: 'verified',
    ...overrides,
  };
}

export function makeRiskyIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    action: 'send_large',
    agent_did: 'did:key:z6MkAgent',
    trust_level: 'verified',
    ...overrides,
  };
}

export function makeBlockedIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    action: 'credential_export',
    agent_did: 'did:key:z6MkAgent',
    trust_level: 'unknown',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// D2D Messages
// ---------------------------------------------------------------------------

export function makeDinaMessage(overrides: Partial<DinaMessage> = {}): DinaMessage {
  const id = nextID('msg');
  const ts = nextTimestamp();
  return {
    id,
    type: 'social.update',
    from: 'did:plc:sender123',
    to: 'did:plc:recipient456',
    created_time: ts,
    body: JSON.stringify({ text: 'I am arriving in 15 minutes' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Trust Entries
// ---------------------------------------------------------------------------

export function makeTrustEntry(overrides: Partial<TrustEntry> = {}): TrustEntry {
  const ts = nextTimestamp();
  return {
    did: 'did:key:z6MkTrustedBot',
    display_name: 'ChairBot',
    trust_score: 72.5,
    trust_ring: 2,
    relationship: 'contact',
    source: 'appview_sync',
    last_verified_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Events (Guardian Loop — matches Python factories.py)
// ---------------------------------------------------------------------------

export function makeEvent(overrides: Partial<GuardianEvent> = {}): GuardianEvent {
  const ts = nextTimestamp();
  return {
    type: 'message',
    source: 'gmail',
    sender: 'friend@example.com',
    subject: 'Hello',
    body: 'Just checking in',
    timestamp: ts,
    ...overrides,
  };
}

export function makeFiduciaryEvent(overrides: Partial<GuardianEvent> = {}): GuardianEvent {
  return makeEvent({
    source: 'bank',
    subject: 'Security Alert: Unusual login detected',
    ...overrides,
  });
}

export function makeSolicitedEvent(overrides: Partial<GuardianEvent> = {}): GuardianEvent {
  return makeEvent({ type: 'reminder', subject: 'Meeting in 15 minutes', ...overrides });
}

export function makeEngagementEvent(overrides: Partial<GuardianEvent> = {}): GuardianEvent {
  return makeEvent({
    type: 'notification',
    source: 'social',
    subject: 'New follower',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Search Queries
// ---------------------------------------------------------------------------

export function makeSearchQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    mode: 'fts5',
    text: 'meeting thursday',
    limit: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------

export function makePIIText(types: string[] = ['email', 'phone']): string {
  const fragments: Record<string, string> = {
    email: 'Contact john@example.com',
    phone: 'Call 555-123-4567',
    ssn: 'SSN 123-45-6789',
    credit_card: 'Card 4111-1111-1111-1111',
    aadhaar: 'Aadhaar 1234-5678-9012',
  };
  return types.map((t) => fragments[t] ?? `Unknown PII type: ${t}`).join('. ');
}

export function makeScrubResult(overrides: Partial<ScrubResult> = {}): ScrubResult {
  // Default matches makePIIText(['email', 'phone']):
  // "Contact john@example.com. Call 555-123-4567"
  //  01234567890123456789012345678901234567890123
  //          ^8             ^24      ^31        ^43
  return {
    scrubbed: 'Contact [EMAIL_1]. Call [PHONE_1]',
    entities: [
      { type: 'EMAIL', start: 8, end: 24, value: 'john@example.com', token: '[EMAIL_1]' },
      { type: 'PHONE', start: 31, end: 43, value: '555-123-4567', token: '[PHONE_1]' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Paired Devices
// ---------------------------------------------------------------------------

export function makePairedDevice(overrides: Partial<PairedDevice> = {}): PairedDevice {
  const id = nextID('dev');
  const ts = nextTimestamp();
  return {
    device_id: id,
    public_key_multibase: 'z6MkTestDevicePublicKey' + id,
    device_name: 'iPhone 15',
    role: 'client',
    last_seen: ts,
    created_at: ts,
    revoked: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Counter reset (for test isolation)
// ---------------------------------------------------------------------------

/** Reset all factory counters. Call in beforeEach for test isolation. */
export function resetFactoryCounters(): void {
  counter = 0;
}
