/**
 * A2A durable state (migration v53, design §9): remote agents, credential
 * references, skill bindings, operations, their workflow children, permits,
 * guard jobs and cancellation requests.
 *
 * SQLite only, and on the SAME connection as the workflow repository. Lane 1's
 * invariants span both — a consent card and its staged operation are created
 * together, a permit and its dispatch child are minted together, a permit is
 * consumed in the same transaction that moves the operation to `transmitting`
 * — and only one connection can make those writes one commit. An in-memory
 * twin could not, so there is none; tests run on real SQLCipher files.
 *
 * Every state change here is a compare-and-set on the row's current state, so
 * a raced writer changes nothing and learns it from the returned count. All
 * timestamps are Unix milliseconds.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type RemoteAgentStatus = 'candidate' | 'active' | 'changed' | 'revoked';
export type SignatureState = 'verified' | 'unsigned' | 'invalid';
export type CredentialKind = 'none' | 'api_key' | 'bearer' | 'oauth2_client';
export type OutboundActionClass = 'read' | 'quote' | 'write' | 'booking' | 'agentic';
export type SubmissionPhase = 'built' | 'transmitting' | 'acknowledged' | 'terminal';
export type ChildRole = 'approval' | 'execution' | 'dispatch';

/**
 * An original behind a placeholder, kept only for a single provable source
 * (A2A-I9): sealed under the source persona's DEK, or — for the owner's own
 * words — kept in this SQLCipher file like every other owner secret.
 */
export interface EntityRow {
  operation_ref: number;
  placeholder: string;
  seal: 'persona_dek' | 'identity_db';
  persona: string | null;
  sealed: Uint8Array;
  created_at: number;
  /** A hard end, whatever happens to the operation (§9: "and expires_at"). */
  expires_at: number;
}
export type PermitState = 'minted' | 'consumed' | 'void';
export type GuardJobState = 'pending' | 'claimed' | 'passed' | 'blocked';
export type CancelState = 'requested' | 'attempting' | 'confirmed' | 'refused';

/**
 * An outbound operation's life (design §6.2–§6.5). `pending_decision` waits on
 * the consent card; `queued` holds a minted permit and a queued dispatch
 * child; `running` has transmitted; `quarantined` holds a result the guard has
 * not cleared. The rest are terminal.
 */
export const OUTBOUND_OPERATION_STATES = [
  'pending_decision',
  'queued',
  'running',
  'quarantined',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'refused',
  'expired',
  'stale_authority',
  'outcome_unknown',
] as const;
export type OutboundOperationState = (typeof OUTBOUND_OPERATION_STATES)[number];

/** An inbound operation is `open` until it ends, once (design §7.4). */
export const INBOUND_OPERATION_STATES = ['open', 'rejected', 'completed', 'failed', 'canceled', 'outcome_unknown'] as const;
export type InboundOperationState = (typeof INBOUND_OPERATION_STATES)[number];
export const TERMINAL_INBOUND_STATES: ReadonlySet<InboundOperationState> = new Set(
  INBOUND_OPERATION_STATES.filter((s) => s !== 'open'),
);

export const TERMINAL_OUTBOUND_STATES: ReadonlySet<OutboundOperationState> = new Set([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'refused',
  'expired',
  'stale_authority',
  'outcome_unknown',
]);

export interface RemoteAgentRow {
  agent_id: string;
  name: string;
  card_url: string;
  card_json: string;
  card_hash: string;
  endpoint: string;
  /** The interface's `tenant`, sent on every request; '' when the card names none. */
  endpoint_tenant: string;
  auth_endpoints_json: string | null;
  schemes_json: string;
  signature_state: SignatureState;
  signature_detail: string;
  status: RemoteAgentStatus;
  approved_at: number | null;
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RemoteCredentialRow {
  credential_ref: string;
  remote_agent_id: string;
  kind: CredentialKind;
  audience: string | null;
  scope_json: string;
  scope_hash: string;
  revision: number;
  status: 'active' | 'revoked';
  created_at: number;
  revoked_at: number | null;
  /** The reference a rotation replaced this one with; reads after a send follow it. */
  replaced_by?: string | null;
}

export interface SkillBindingRow {
  remote_agent_id: string;
  card_hash: string;
  skill: string;
  action_class: OutboundActionClass;
  result_schema_json: string | null;
  credential_ref: string;
  revision: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

export interface A2ATaskRow {
  id: number;
  external_id: string;
  direction: 'inbound' | 'outbound';
  principal: string;
  internal_id: string | null;
  context_id: string | null;
  state: string;
  reason_code: string | null;
  result_json: string | null;
  result_quarantine: string | null;
  quarantine_digest: string | null;
  guard_receipt_id: string | null;
  message_id: string | null;
  request_hash: string | null;
  card_hash: string | null;
  submission_phase: SubmissionPhase | null;
  effect_phase: string | null;
  continuation_generation: number;
  input_required_json: string | null;
  snapshot_json: string | null;
  consent_json: string | null;
  reply_to: string | null;
  /** The conversation an outbound proposal was made in (§6.2 step 0); null for older rows. */
  release_session_id: string | null;
  remote_agent_id: string | null;
  remote_task_id: string | null;
  remote_context_id: string | null;
  /** Outbound only (§6.4): when the dispatch entered \`transmitting\`, just before its SendMessage. */
  sent_at: number | null;
  status_updated_at: number;
  created_at: number;
  /** Inbound only (§7.5): how many task events have been recorded. */
  event_seq: number;
  /** Inbound only: the client-visible state the last event reported (`inboundViewKey`); null before the first record. */
  event_state: string | null;
}

/** A task as created: event bookkeeping starts empty, and only `setEventCursor` moves it; nothing is sent yet. */
export type NewA2ATask = Omit<A2ATaskRow, 'id' | 'event_seq' | 'event_state' | 'sent_at'>;

/** A webhook an inbound client asked task events be POSTed to (A2A §3.1.7). */
export interface PushConfigRow {
  id: string;
  operation_ref: number;
  url: string;
  token: string | null;
  /** `{scheme, credentials?}` as JSON, or null. */
  auth_json: string | null;
  created_at: number;
}

export type OutboxStatus = 'pending' | 'claimed' | 'delivered' | 'failed' | 'suppressed';

/** One task event for one target: the task's streams (`''`) or one webhook config. */
export interface OutboxRow {
  id: number;
  operation_ref: number;
  source_event_id: string;
  seq: number;
  target_kind: 'sse' | 'webhook';
  target_id: string;
  event_json: string;
  status: OutboxStatus;
  claim_id: string | null;
  claimed_by: string | null;
  claimed_until: number | null;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
}

/** The outbox's columns, for queries that compute more than they return. */
const OUTBOX_COLUMNS =
  'id, operation_ref, source_event_id, seq, target_kind, target_id, event_json, status, claim_id, claimed_by, claimed_until, attempts, next_attempt_at, created_at';

/**
 * The two claim queries (design §7.5), named so a test can check their plans:
 * each NOT EXISTS must search the per-target index, or a backlog makes every
 * claim scan the outbox once per due row.
 */
export const DUE_STREAM_ROWS_SQL = `SELECT o.* FROM a2a_push_outbox o
          WHERE o.target_kind = 'sse'
            AND ((o.status = 'pending' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?))
              OR (o.status = 'claimed' AND o.claimed_until < ?))
            AND NOT EXISTS (
              SELECT 1 FROM a2a_push_outbox e
               WHERE e.operation_ref = o.operation_ref AND e.target_kind = 'sse' AND e.target_id = ''
                 AND e.id < o.id
                 AND ((e.status = 'claimed' AND e.claimed_until >= ?)
                   OR (e.status = 'pending' AND e.next_attempt_at IS NOT NULL AND e.next_attempt_at > ?)))
          ORDER BY o.id LIMIT ?`;
export const DUE_WEBHOOK_HEADS_SQL = `SELECT ${OUTBOX_COLUMNS} FROM (
           SELECT o.*, ROW_NUMBER() OVER (PARTITION BY t.principal ORDER BY o.id) AS turn
             FROM a2a_push_outbox o JOIN a2a_tasks t ON t.id = o.operation_ref
            WHERE o.target_kind = 'webhook'
              AND ((o.status = 'pending' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?))
                OR (o.status = 'claimed' AND o.claimed_until < ?))
              AND NOT EXISTS (
                SELECT 1 FROM a2a_push_outbox e
                 WHERE e.operation_ref = o.operation_ref AND e.target_kind = 'webhook'
                   AND e.target_id = o.target_id AND e.id < o.id AND e.status IN ('pending','claimed')))
          ORDER BY turn, id LIMIT ?`;

export interface TaskChildRow {
  child_task_id: string;
  operation_ref: number;
  generation: number;
  role: ChildRole;
  created_at: number;
  /** Inbound children run by an external runner: the only DID that may claim them (§7.3). */
  pep_did?: string | null;
}

export interface PermitRow {
  permit_id: string;
  direction: 'outbound' | 'inbound';
  operation_ref: number;
  execution_child_id: string;
  approval_task_id: string | null;
  payload_hash: string;
  action_class: string;
  pep_did: string | null;
  authority_snapshot_json: string;
  state: PermitState;
  void_reason: string | null;
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
}

export interface GuardJobRow {
  job_id: string;
  operation_ref: number;
  quarantine_digest: string;
  scanner_version: string;
  state: GuardJobState;
  claim_id: string | null;
  claimed_until: number | null;
  verdict_json: string | null;
  held_notice_at: number | null;
  created_at: number;
  resolved_at: number | null;
}

export interface CancelRequestRow {
  operation_ref: number;
  state: CancelState;
  resolving_claim_id: string | null;
  requested_at: number;
  resolved_at: number | null;
}

/** Columns an operation update may set. `id`, `external_id`, `direction`, `principal`, `created_at` never change. */
export type A2ATaskPatch = Partial<
  Omit<A2ATaskRow, 'id' | 'external_id' | 'direction' | 'principal' | 'created_at'>
>;

const TASK_PATCHABLE: ReadonlySet<string> = new Set([
  'internal_id',
  'context_id',
  'state',
  'reason_code',
  'result_json',
  'result_quarantine',
  'quarantine_digest',
  'guard_receipt_id',
  'message_id',
  'request_hash',
  'card_hash',
  'submission_phase',
  'effect_phase',
  'continuation_generation',
  'input_required_json',
  'snapshot_json',
  'consent_json',
  'reply_to',
  'remote_agent_id',
  'remote_task_id',
  'remote_context_id',
  'sent_at',
  'status_updated_at',
]);

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** SQLite hands back numbers and strings; the row types above name them. */
/** What an inbound call was accepted under, as its snapshot pins it: the columns `completedInboundAuthorities` names. */
export interface InboundAuthority {
  rkey: string | null;
  configured_key: string | null;
  grant_id: string | null;
  listing_created_at: number | null;
}

/** Each authority column and the snapshot member it is read from. */
const SNAPSHOT_AUTHORITY: readonly (readonly [keyof InboundAuthority, string])[] = [
  ['rkey', 'rkey'],
  ['configured_key', 'configured_key'],
  ['grant_id', 'grant_id'],
  ['listing_created_at', 'listing_created_at'],
];

function rows<T>(found: DBRow[]): T[] {
  return found as unknown as T[];
}

function first<T>(found: DBRow[]): T | null {
  return found.length === 0 ? null : (found[0] as unknown as T);
}

export class A2AStore {
  constructor(readonly db: DatabaseAdapter) {}

  /**
   * One commit for everything `fn` writes, including writes the workflow
   * repository makes on the same connection (they nest as savepoints).
   */
  transaction<T>(fn: () => T): T {
    let out: { value: T } | null = null;
    this.db.transaction(() => {
      const value = fn();
      // A promise here would mean the body went on writing after the commit.
      // Throwing inside the transaction rolls back whatever it wrote before
      // its first await. What runs after that await cannot be stopped here:
      // this is a trap for a programming mistake, not a way to run async work.
      if (value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') {
        throw new Error('A2AStore.transaction: the body must be synchronous');
      }
      out = { value };
    });
    if (out === null) throw new Error('A2AStore.transaction: body did not run');
    return (out as { value: T }).value;
  }

  // ---------------------------------------------------------------- agents

  insertAgent(row: RemoteAgentRow): void {
    this.db.execute(
      `INSERT INTO a2a_remote_agents (agent_id, name, card_url, card_json, card_hash, endpoint,
         endpoint_tenant, auth_endpoints_json, schemes_json, signature_state, signature_detail,
         status, approved_at, last_verified_at, created_at, updated_at)
       VALUES (${placeholders(16)})`,
      [
        row.agent_id,
        row.name,
        row.card_url,
        row.card_json,
        row.card_hash,
        row.endpoint,
        row.endpoint_tenant,
        row.auth_endpoints_json,
        row.schemes_json,
        row.signature_state,
        row.signature_detail,
        row.status,
        row.approved_at,
        row.last_verified_at,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  getAgent(agentId: string): RemoteAgentRow | null {
    return first(this.db.query(`SELECT * FROM a2a_remote_agents WHERE agent_id = ?`, [agentId]));
  }

  /** The live (non-revoked) registration for a card URL, if any. */
  getLiveAgentByUrl(cardUrl: string): RemoteAgentRow | null {
    return first(
      this.db.query(`SELECT * FROM a2a_remote_agents WHERE card_url = ? AND status != 'revoked'`, [
        cardUrl,
      ]),
    );
  }

  listAgents(status?: RemoteAgentStatus): RemoteAgentRow[] {
    return status === undefined
      ? rows(this.db.query(`SELECT * FROM a2a_remote_agents ORDER BY created_at DESC`))
      : rows(
          this.db.query(
            `SELECT * FROM a2a_remote_agents WHERE status = ? ORDER BY created_at DESC`,
            [status],
          ),
        );
  }

  setAgentStatus(
    agentId: string,
    from: readonly RemoteAgentStatus[],
    to: RemoteAgentStatus,
    nowMs: number,
  ): boolean {
    return (
      this.db.run(
        `UPDATE a2a_remote_agents
            SET status = ?, updated_at = ?,
                approved_at = CASE WHEN ? = 'active' THEN ? ELSE approved_at END
          WHERE agent_id = ? AND status IN (${placeholders(from.length)})`,
        [to, nowMs, to, nowMs, agentId, ...from],
      ) === 1
    );
  }

  /** Record a re-fetch of an UNCHANGED card. */
  touchAgentVerified(agentId: string, nowMs: number): void {
    this.db.run(
      `UPDATE a2a_remote_agents SET last_verified_at = ?, updated_at = ? WHERE agent_id = ?`,
      [nowMs, nowMs, agentId],
    );
  }

  /**
   * A re-fetch found a DIFFERENT card: pin the new bytes and mark the agent
   * `changed`, which voids every binding (they key on the old card hash).
   */
  repinChangedCard(
    agentId: string,
    card: Pick<
      RemoteAgentRow,
      | 'name'
      | 'card_json'
      | 'card_hash'
      | 'endpoint'
      | 'endpoint_tenant'
      | 'schemes_json'
      | 'signature_state'
      | 'signature_detail'
    >,
    nowMs: number,
  ): boolean {
    return (
      this.db.run(
        `UPDATE a2a_remote_agents
            SET name = ?, card_json = ?, card_hash = ?, endpoint = ?, endpoint_tenant = ?,
                schemes_json = ?, signature_state = ?, signature_detail = ?, status = 'changed',
                last_verified_at = ?, updated_at = ?
          WHERE agent_id = ? AND status IN ('candidate','active','changed')`,
        [
          card.name,
          card.card_json,
          card.card_hash,
          card.endpoint,
          card.endpoint_tenant,
          card.schemes_json,
          card.signature_state,
          card.signature_detail,
          nowMs,
          nowMs,
          agentId,
        ],
      ) === 1
    );
  }

  // ----------------------------------------------------------- credentials

  insertCredential(row: RemoteCredentialRow): void {
    this.db.execute(
      `INSERT INTO a2a_remote_credentials (credential_ref, remote_agent_id, kind, audience,
         scope_json, scope_hash, revision, status, created_at, revoked_at)
       VALUES (${placeholders(10)})`,
      [
        row.credential_ref,
        row.remote_agent_id,
        row.kind,
        row.audience,
        row.scope_json,
        row.scope_hash,
        row.revision,
        row.status,
        row.created_at,
        row.revoked_at,
      ],
    );
  }

  getCredential(ref: string): RemoteCredentialRow | null {
    return first(
      this.db.query(`SELECT * FROM a2a_remote_credentials WHERE credential_ref = ?`, [ref]),
    );
  }

  listCredentials(agentId: string): RemoteCredentialRow[] {
    return rows(
      this.db.query(
        `SELECT * FROM a2a_remote_credentials WHERE remote_agent_id = ? ORDER BY created_at DESC`,
        [agentId],
      ),
    );
  }

  /** Highest revision recorded for an agent's credentials of one kind (0 = none yet). */
  maxCredentialRevision(agentId: string): number {
    const found = this.db.query(
      `SELECT COALESCE(MAX(revision), 0) AS r FROM a2a_remote_credentials WHERE remote_agent_id = ?`,
      [agentId],
    );
    return Number(found[0]?.r ?? 0);
  }

  revokeCredential(ref: string, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE a2a_remote_credentials SET status = 'revoked', revoked_at = ?
          WHERE credential_ref = ? AND status = 'active'`,
        [nowMs, ref],
      ) === 1
    );
  }

  /** Record that a rotation replaced `oldRef` with `newRef`. */
  setCredentialReplacement(oldRef: string, newRef: string): void {
    this.db.run(`UPDATE a2a_remote_credentials SET replaced_by = ? WHERE credential_ref = ?`, [newRef, oldRef]);
  }

  /**
   * The active credential a reference has become through rotations, or null
   * when the chain ends revoked (or loops, which a bounded walk refuses).
   */
  liveSuccessor(ref: string): RemoteCredentialRow | null {
    const start = this.getCredential(ref);
    let current = start;
    for (let hops = 0; current !== null && hops < 64; hops += 1) {
      // A successor of another agent's credential is no successor.
      if (current.remote_agent_id !== start?.remote_agent_id) return null;
      if (current.status === 'active') return current;
      if (current.replaced_by === null || current.replaced_by === undefined) return null;
      current = this.getCredential(current.replaced_by);
    }
    return null;
  }

  // ------------------------------------------------------ credential secrets

  /**
   * The material of a real credential (design §5.3). Written once per
   * credential reference; rotation makes a new reference, never a new value
   * under an old one. Nothing here returns the material except
   * `readCredentialMaterial`, which only `credentials.ts`'s one door calls.
   */
  insertCredentialSecret(ref: string, material: string, nowMs: number): void {
    this.db.execute(`INSERT INTO a2a_credential_secrets (credential_ref, material, created_at) VALUES (?, ?, ?)`, [
      ref,
      material,
      nowMs,
    ]);
  }

  deleteCredentialSecret(ref: string): boolean {
    return this.db.run(`DELETE FROM a2a_credential_secrets WHERE credential_ref = ?`, [ref]) === 1;
  }

  /** The material of an ACTIVE credential, or null. Call only from `useRemoteCredentialSecret`. */
  readCredentialMaterial(ref: string): string | null {
    const found = this.db.query(
      `SELECT s.material AS material FROM a2a_credential_secrets s
         JOIN a2a_remote_credentials c ON c.credential_ref = s.credential_ref
        WHERE s.credential_ref = ? AND c.status = 'active'`,
      [ref],
    );
    const material = found[0]?.material;
    return typeof material === 'string' ? material : null;
  }

  /** Move every live binding from one credential to another, bumping each binding's revision. */
  moveBindingsToCredential(fromRef: string, toRef: string, nowMs: number): number {
    return this.db.run(
      `UPDATE a2a_skill_bindings SET credential_ref = ?, revision = revision + 1, updated_at = ?
        WHERE credential_ref = ? AND revoked_at IS NULL`,
      [toRef, nowMs, fromRef],
    );
  }

  // -------------------------------------------------------------- bindings

  getBinding(agentId: string, cardHash: string, skill: string): SkillBindingRow | null {
    return first(
      this.db.query(
        `SELECT * FROM a2a_skill_bindings WHERE remote_agent_id = ? AND card_hash = ? AND skill = ?`,
        [agentId, cardHash, skill],
      ),
    );
  }

  listBindings(agentId: string, cardHash: string): SkillBindingRow[] {
    return rows(
      this.db.query(
        `SELECT * FROM a2a_skill_bindings WHERE remote_agent_id = ? AND card_hash = ? ORDER BY skill`,
        [agentId, cardHash],
      ),
    );
  }

  /**
   * Create or replace the binding for one skill of one pinned card. A
   * replacement bumps the revision, so a permit minted under the old one
   * fails its dispatch re-check.
   */
  upsertBinding(
    row: Omit<SkillBindingRow, 'revision' | 'created_at' | 'updated_at' | 'revoked_at'>,
    nowMs: number,
  ): SkillBindingRow {
    this.db.execute(
      `INSERT INTO a2a_skill_bindings (remote_agent_id, card_hash, skill, action_class,
         result_schema_json, credential_ref, revision, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
       ON CONFLICT (remote_agent_id, card_hash, skill) DO UPDATE SET
         action_class = excluded.action_class,
         result_schema_json = excluded.result_schema_json,
         credential_ref = excluded.credential_ref,
         revision = a2a_skill_bindings.revision + 1,
         updated_at = excluded.updated_at,
         revoked_at = NULL`,
      [
        row.remote_agent_id,
        row.card_hash,
        row.skill,
        row.action_class,
        row.result_schema_json,
        row.credential_ref,
        nowMs,
        nowMs,
      ],
    );
    const stored = this.getBinding(row.remote_agent_id, row.card_hash, row.skill);
    if (stored === null) throw new Error('A2AStore.upsertBinding: row vanished');
    return stored;
  }

  /** Revoking also bumps the revision, so an outstanding permit cannot outlive it. */
  revokeBinding(agentId: string, cardHash: string, skill: string, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE a2a_skill_bindings
            SET revoked_at = ?, updated_at = ?, revision = revision + 1
          WHERE remote_agent_id = ? AND card_hash = ? AND skill = ? AND revoked_at IS NULL`,
        [nowMs, nowMs, agentId, cardHash, skill],
      ) === 1
    );
  }

  // ------------------------------------------------------------ operations

  /** Insert an operation and return it with its row id. */
  insertTask(row: NewA2ATask): A2ATaskRow {
    const columns = Object.keys(row);
    this.db.execute(
      `INSERT INTO a2a_tasks (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`,
      columns.map((c) => (row as Record<string, unknown>)[c]),
    );
    const stored = this.getTaskByExternal(row.direction, row.principal, row.external_id);
    if (stored === null) throw new Error('A2AStore.insertTask: row vanished');
    return stored;
  }

  getTask(id: number): A2ATaskRow | null {
    return first(this.db.query(`SELECT * FROM a2a_tasks WHERE id = ?`, [id]));
  }

  getTaskByExternal(
    direction: 'inbound' | 'outbound',
    principal: string,
    externalId: string,
  ): A2ATaskRow | null {
    return first(
      this.db.query(
        `SELECT * FROM a2a_tasks WHERE direction = ? AND principal = ? AND external_id = ?`,
        [direction, principal, externalId],
      ),
    );
  }

  listTasks(direction: 'inbound' | 'outbound', principal: string, limit: number): A2ATaskRow[] {
    return rows(
      this.db.query(
        `SELECT * FROM a2a_tasks WHERE direction = ? AND principal = ?
          ORDER BY status_updated_at DESC, id DESC LIMIT ?`,
        [direction, principal, limit],
      ),
    );
  }

  /** A principal's inbound tasks in one state, oldest first. */
  inboundTasksOf(principal: string, state: string): A2ATaskRow[] {
    return rows(
      this.db.query(`SELECT * FROM a2a_tasks WHERE direction = 'inbound' AND principal = ? AND state = ? ORDER BY id`, [
        principal,
        state,
      ]),
    );
  }

  /**
   * The distinct authorities a principal's completed inbound tasks were
   * accepted under (listing, capability, grant, listing pin, read from each
   * task's snapshot), each with one task under it. Tasks whose snapshot is
   * not JSON are left out (`completedInboundUnreadable`).
   */
  completedInboundAuthorities(principal: string): (InboundAuthority & { sample: number })[] {
    return rows(
      this.db.query(
        `SELECT ${SNAPSHOT_AUTHORITY.map(([col, path]) => `json_extract(snapshot_json, '$.${path}') AS ${col}`).join(', ')}, MIN(id) AS sample
           FROM a2a_tasks
          WHERE direction = 'inbound' AND principal = ? AND state = 'completed' AND json_valid(snapshot_json)
          GROUP BY ${SNAPSHOT_AUTHORITY.map(([col]) => col).join(', ')}`,
        [principal],
      ),
    );
  }

  /** A principal's completed inbound tasks accepted under one authority. */
  completedInboundUnder(principal: string, authority: InboundAuthority): A2ATaskRow[] {
    return rows(
      this.db.query(
        `SELECT * FROM a2a_tasks
          WHERE direction = 'inbound' AND principal = ? AND state = 'completed' AND json_valid(snapshot_json)
            AND ${SNAPSHOT_AUTHORITY.map(([, path]) => `json_extract(snapshot_json, '$.${path}') IS ?`).join(' AND ')}
          ORDER BY id`,
        [principal, ...SNAPSHOT_AUTHORITY.map(([col]) => authority[col])],
      ),
    );
  }

  /** A principal's completed inbound tasks whose snapshot cannot be read. */
  completedInboundUnreadable(principal: string): A2ATaskRow[] {
    return rows(
      this.db.query(
        `SELECT * FROM a2a_tasks
          WHERE direction = 'inbound' AND principal = ? AND state = 'completed' AND NOT json_valid(COALESCE(snapshot_json, ''))
          ORDER BY id`,
        [principal],
      ),
    );
  }

  listTasksInStates(direction: 'inbound' | 'outbound', states: readonly string[]): A2ATaskRow[] {
    return rows(
      this.db.query(
        `SELECT * FROM a2a_tasks WHERE direction = ? AND state IN (${placeholders(states.length)})
          ORDER BY id`,
        [direction, ...states],
      ),
    );
  }

  /** Outbound operations created after `after`, in any state. */
  countOutboundCreatedAfter(after: number): number {
    const row = this.db.query(
      `SELECT COUNT(*) AS n FROM a2a_tasks WHERE direction = 'outbound' AND created_at > ?`,
      [after],
    )[0] as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Ended outbound operations whose last state change is at or before `endedBefore`, oldest first. */
  listEndedTasksBefore(direction: 'inbound' | 'outbound', endedBefore: number, limit: number): A2ATaskRow[] {
    const ended: string[] = [...(direction === 'outbound' ? TERMINAL_OUTBOUND_STATES : TERMINAL_INBOUND_STATES)];
    return rows(
      this.db.query(
        `SELECT * FROM a2a_tasks
          WHERE direction = ? AND state IN (${placeholders(ended.length)}) AND status_updated_at <= ?
          ORDER BY status_updated_at, id LIMIT ?`,
        [direction, ...ended, endedBefore, limit],
      ),
    );
  }

  /**
   * Delete one operation and every row that references it. Child rows go
   * first: their foreign keys have no ON DELETE rule (design §9). Call
   * inside a transaction that has re-checked the operation has ended.
   */
  deleteTaskWithChildren(id: number): void {
    const op = this.getTask(id);
    if (op === null) return;
    for (const table of [
      'a2a_entities',
      'a2a_guard_jobs',
      'a2a_cancel_requests',
      'a2a_permits',
      'a2a_task_children',
      'a2a_push_outbox',
      'a2a_push_configs',
    ]) {
      this.db.run(`DELETE FROM ${table} WHERE operation_ref = ?`, [id]);
    }
    if (op.direction === 'inbound') {
      // The receipt answers a replay with this task; with the task gone, it
      // would answer with one GetTask cannot find.
      this.db.run(`DELETE FROM a2a_idempotency_receipts WHERE principal = ? AND mapped_external_id = ?`, [
        op.principal,
        op.external_id,
      ]);
    }
    this.db.run(`DELETE FROM a2a_tasks WHERE id = ?`, [id]);
  }

  /**
   * Compare-and-set update: applies `patch` only while the operation is in
   * one of `fromStates`. A `state` change also stamps `status_updated_at`
   * unless the patch sets it. Returns whether the row changed.
   */
  updateTask(
    id: number,
    fromStates: readonly string[],
    patch: A2ATaskPatch,
    nowMs: number,
  ): boolean {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    for (const [key] of entries) {
      if (!TASK_PATCHABLE.has(key)) throw new Error(`A2AStore.updateTask: ${key} is not patchable`);
    }
    if (patch.state !== undefined && patch.status_updated_at === undefined) {
      entries.push(['status_updated_at', nowMs]);
    }
    if (entries.length === 0) throw new Error('A2AStore.updateTask: empty patch');
    return (
      this.db.run(
        `UPDATE a2a_tasks SET ${entries.map(([k]) => `${k} = ?`).join(', ')}
          WHERE id = ? AND state IN (${placeholders(fromStates.length)})`,
        [...entries.map(([, v]) => v), id, ...fromStates],
      ) === 1
    );
  }

  // -------------------------------------------------------------- children

  insertChild(row: TaskChildRow): void {
    this.db.execute(
      `INSERT INTO a2a_task_children (child_task_id, operation_ref, generation, role, created_at, pep_did)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.child_task_id, row.operation_ref, row.generation, row.role, row.created_at, row.pep_did ?? null],
    );
  }

  getChild(childTaskId: string): TaskChildRow | null {
    return first(
      this.db.query(`SELECT * FROM a2a_task_children WHERE child_task_id = ?`, [childTaskId]),
    );
  }

  childrenOf(operationRef: number, role?: ChildRole): TaskChildRow[] {
    return role === undefined
      ? rows(
          this.db.query(
            `SELECT * FROM a2a_task_children WHERE operation_ref = ? ORDER BY created_at, child_task_id`,
            [operationRef],
          ),
        )
      : rows(
          this.db.query(
            `SELECT * FROM a2a_task_children WHERE operation_ref = ? AND role = ?
              ORDER BY created_at, child_task_id`,
            [operationRef, role],
          ),
        );
  }

  // --------------------------------------------------------------- permits

  insertPermit(row: PermitRow): void {
    this.db.execute(
      `INSERT INTO a2a_permits (permit_id, direction, operation_ref, execution_child_id,
         approval_task_id, payload_hash, action_class, pep_did, authority_snapshot_json, state,
         void_reason, expires_at, created_at, consumed_at)
       VALUES (${placeholders(14)})`,
      [
        row.permit_id,
        row.direction,
        row.operation_ref,
        row.execution_child_id,
        row.approval_task_id,
        row.payload_hash,
        row.action_class,
        row.pep_did,
        row.authority_snapshot_json,
        row.state,
        row.void_reason,
        row.expires_at,
        row.created_at,
        row.consumed_at,
      ],
    );
  }

  getPermit(permitId: string): PermitRow | null {
    return first(this.db.query(`SELECT * FROM a2a_permits WHERE permit_id = ?`, [permitId]));
  }

  /** The outbound permit an approval minted, in any state. */
  getOutboundPermitByApproval(approvalTaskId: string): PermitRow | null {
    return first(
      this.db.query(
        `SELECT * FROM a2a_permits WHERE direction = 'outbound' AND approval_task_id = ?`,
        [approvalTaskId],
      ),
    );
  }

  permitsOf(operationRef: number): PermitRow[] {
    return rows(
      this.db.query(`SELECT * FROM a2a_permits WHERE operation_ref = ? ORDER BY created_at`, [
        operationRef,
      ]),
    );
  }

  consumePermit(permitId: string, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE a2a_permits SET state = 'consumed', consumed_at = ?
          WHERE permit_id = ? AND state = 'minted' AND expires_at > ?`,
        [nowMs, permitId, nowMs],
      ) === 1
    );
  }

  voidPermit(permitId: string, reason: string): boolean {
    return (
      this.db.run(
        `UPDATE a2a_permits SET state = 'void', void_reason = ?
          WHERE permit_id = ? AND state = 'minted'`,
        [reason, permitId],
      ) === 1
    );
  }

  // ------------------------------------------------------------ guard jobs

  insertGuardJob(row: GuardJobRow): void {
    this.db.execute(
      `INSERT INTO a2a_guard_jobs (job_id, operation_ref, quarantine_digest, scanner_version,
         state, claim_id, claimed_until, verdict_json, held_notice_at, created_at, resolved_at)
       VALUES (${placeholders(11)})`,
      [
        row.job_id,
        row.operation_ref,
        row.quarantine_digest,
        row.scanner_version,
        row.state,
        row.claim_id,
        row.claimed_until,
        row.verdict_json,
        row.held_notice_at,
        row.created_at,
        row.resolved_at,
      ],
    );
  }

  getGuardJob(jobId: string): GuardJobRow | null {
    return first(this.db.query(`SELECT * FROM a2a_guard_jobs WHERE job_id = ?`, [jobId]));
  }

  getGuardJobForOperation(operationRef: number): GuardJobRow | null {
    return first(
      this.db.query(`SELECT * FROM a2a_guard_jobs WHERE operation_ref = ?`, [operationRef]),
    );
  }

  /** Oldest job that is pending, or claimed with a lapsed lease. */
  /**
   * The next job to hand out: every job never claimed, oldest first, before
   * any whose claim lapsed, and those by the oldest lapse. A result the guard
   * cannot finish within its lease (a slow model, an answer it cannot read)
   * so never holds back the results behind it.
   */
  nextClaimableGuardJob(nowMs: number): GuardJobRow | null {
    return first(
      this.db.query(
        `SELECT * FROM a2a_guard_jobs
          WHERE state = 'pending' OR (state = 'claimed' AND claimed_until <= ?)
          ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, claimed_until, created_at, job_id LIMIT 1`,
        [nowMs],
      ),
    );
  }

  claimGuardJob(
    jobId: string,
    expect: { state: GuardJobState; claimId: string | null },
    claimId: string,
    claimedUntil: number,
  ): boolean {
    return (
      this.db.run(
        `UPDATE a2a_guard_jobs SET state = 'claimed', claim_id = ?, claimed_until = ?
          WHERE job_id = ? AND state = ? AND claim_id IS ?`,
        [claimId, claimedUntil, jobId, expect.state, expect.claimId],
      ) === 1
    );
  }

  resolveGuardJob(
    jobId: string,
    claimId: string,
    verdict: 'passed' | 'blocked',
    verdictJSON: string,
    nowMs: number,
  ): boolean {
    return (
      this.db.run(
        `UPDATE a2a_guard_jobs SET state = ?, verdict_json = ?, resolved_at = ?
          WHERE job_id = ? AND state = 'claimed' AND claim_id = ? AND claimed_until > ?`,
        [verdict, verdictJSON, nowMs, jobId, claimId, nowMs],
      ) === 1
    );
  }

  /** Close an unresolved job as blocked without a worker (its quarantine cannot be released). */
  abandonGuardJob(jobId: string, verdictJSON: string, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE a2a_guard_jobs SET state = 'blocked', verdict_json = ?, resolved_at = ?
          WHERE job_id = ? AND state IN ('pending','claimed')`,
        [verdictJSON, nowMs, jobId],
      ) === 1
    );
  }

  /** Unresolved jobs created at or before `createdBefore` whose owner has not been told. */
  guardJobsAwaitingNotice(createdBefore: number): GuardJobRow[] {
    return rows(
      this.db.query(
        `SELECT * FROM a2a_guard_jobs
          WHERE state IN ('pending','claimed') AND held_notice_at IS NULL AND created_at <= ?
          ORDER BY created_at`,
        [createdBefore],
      ),
    );
  }

  markHeldNoticeSent(jobId: string, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE a2a_guard_jobs SET held_notice_at = ? WHERE job_id = ? AND held_notice_at IS NULL`,
        [nowMs, jobId],
      ) === 1
    );
  }

  // -------------------------------------------------------------- entities

  insertEntity(row: EntityRow): void {
    this.db.execute(
      `INSERT INTO a2a_entities (operation_ref, placeholder, seal, persona, sealed, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.operation_ref, row.placeholder, row.seal, row.persona, row.sealed, row.created_at, row.expires_at],
    );
  }

  entitiesOf(operationRef: number): EntityRow[] {
    return rows(this.db.query(`SELECT * FROM a2a_entities WHERE operation_ref = ? ORDER BY placeholder`, [operationRef]));
  }

  /**
   * Forget originals past their hard end, and those of operations that ended
   * at or before `endedBefore` (§9: terminal + 7 days, and `expires_at`).
   */
  purgeEntities(nowMs: number, endedBefore: number): number {
    const ended = [...TERMINAL_OUTBOUND_STATES];
    return (
      this.db.run(`DELETE FROM a2a_entities WHERE expires_at <= ?`, [nowMs]) +
      this.db.run(
        `DELETE FROM a2a_entities WHERE operation_ref IN (
           SELECT id FROM a2a_tasks WHERE state IN (${placeholders(ended.length)}) AND status_updated_at <= ?)`,
        [...ended, endedBefore],
      )
    );
  }

  // ------------------------------------------------------ proposal refusals

  /** A refused proposal counts toward the hourly cap, so refusals are no free oracle. */
  noteProposalRefusal(nowMs: number, windowMs: number): void {
    this.db.run(`DELETE FROM a2a_proposal_refusals WHERE refused_at <= ?`, [nowMs - windowMs]);
    this.db.run(`INSERT INTO a2a_proposal_refusals (refused_at) VALUES (?)`, [nowMs]);
  }

  countProposalRefusalsAfter(after: number): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM a2a_proposal_refusals WHERE refused_at > ?`, [after])[0] as
      | { n?: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  // ---------------------------------------------------------- cancellation

  /** Record the owner's cancel request once; a second request is the same request. */
  requestCancel(operationRef: number, nowMs: number): boolean {
    return (
      this.db.run(
        `INSERT INTO a2a_cancel_requests (operation_ref, state, resolving_claim_id, requested_at, resolved_at)
         VALUES (?, 'requested', NULL, ?, NULL)
         ON CONFLICT (operation_ref) DO NOTHING`,
        [operationRef, nowMs],
      ) === 1
    );
  }

  getCancelRequest(operationRef: number): CancelRequestRow | null {
    return first(
      this.db.query(`SELECT * FROM a2a_cancel_requests WHERE operation_ref = ?`, [operationRef]),
    );
  }

  /**
   * Move a cancel request on. `resolvingClaimId` binds `attempting` to the
   * runner claim that is trying the remote cancel; a later claim re-binds it
   * (the request survives re-claim), and only the bound claim may resolve.
   */
  updateCancelRequest(
    operationRef: number,
    from: readonly CancelState[],
    to: CancelState,
    opts: { resolvingClaimId?: string | null; requireClaimId?: string; nowMs: number },
  ): boolean {
    const sets = ['state = ?'];
    const params: unknown[] = [to];
    if (opts.resolvingClaimId !== undefined) {
      sets.push('resolving_claim_id = ?');
      params.push(opts.resolvingClaimId);
    }
    if (to === 'confirmed' || to === 'refused') {
      sets.push('resolved_at = ?');
      params.push(opts.nowMs);
    }
    let where = `operation_ref = ? AND state IN (${placeholders(from.length)})`;
    params.push(operationRef, ...from);
    if (opts.requireClaimId !== undefined) {
      where += ' AND resolving_claim_id = ?';
      params.push(opts.requireClaimId);
    }
    return (
      this.db.run(`UPDATE a2a_cancel_requests SET ${sets.join(', ')} WHERE ${where}`, params) === 1
    );
  }

  // ------------------------------------------------------------- delivery

  /** Move an inbound task's event cursor (§7.5): the count of events recorded, and the state the last one reported. */
  setEventCursor(id: number, seq: number, state: string): void {
    this.db.run(`UPDATE a2a_tasks SET event_seq = ?, event_state = ? WHERE id = ?`, [seq, state, id]);
  }

  insertPushConfig(row: PushConfigRow): void {
    this.db.execute(
      `INSERT INTO a2a_push_configs (id, operation_ref, url, token, auth_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.operation_ref, row.url, row.token, row.auth_json, row.created_at],
    );
  }

  getPushConfig(operationRef: number, id: string): PushConfigRow | null {
    return first(this.db.query(`SELECT * FROM a2a_push_configs WHERE operation_ref = ? AND id = ?`, [operationRef, id]));
  }

  pushConfigsOf(operationRef: number): PushConfigRow[] {
    return rows(
      this.db.query(`SELECT * FROM a2a_push_configs WHERE operation_ref = ? ORDER BY created_at, id`, [operationRef]),
    );
  }

  /**
   * Remove one webhook config and every event still waiting for it, in one
   * step (A2A §3.1.10: nothing more is sent once deleted). Returns whether
   * the config existed.
   */
  deletePushConfig(operationRef: number, id: string): boolean {
    this.db.run(
      `UPDATE a2a_push_outbox SET status = 'suppressed', claim_id = NULL, claimed_by = NULL, claimed_until = NULL
        WHERE operation_ref = ? AND target_kind = 'webhook' AND target_id = ? AND status IN ('pending','claimed')`,
      [operationRef, id],
    );
    return this.db.run(`DELETE FROM a2a_push_configs WHERE operation_ref = ? AND id = ?`, [operationRef, id]) === 1;
  }

  /** Add one event row; a row already there for the same (event, target) stays as it is. */
  insertOutboxRow(row: Omit<OutboxRow, 'id' | 'status' | 'claim_id' | 'claimed_by' | 'claimed_until' | 'attempts' | 'next_attempt_at'>): void {
    this.db.execute(
      `INSERT OR IGNORE INTO a2a_push_outbox
         (operation_ref, source_event_id, seq, target_kind, target_id, event_json, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      [row.operation_ref, row.source_event_id, row.seq, row.target_kind, row.target_id, row.event_json, row.created_at],
    );
  }

  getOutboxRow(id: number): OutboxRow | null {
    return first(this.db.query(`SELECT * FROM a2a_push_outbox WHERE id = ?`, [id]));
  }

  outboxOf(operationRef: number): OutboxRow[] {
    return rows(this.db.query(`SELECT * FROM a2a_push_outbox WHERE operation_ref = ? ORDER BY id`, [operationRef]));
  }

  /**
   * Stream rows a claim may take, oldest first: pending and due, or claimed
   * under a lease that lapsed. A row waits while an earlier row of its task's
   * streams is still held under a live lease or deferred, so the events leave
   * in order. Webhook rows have their own query, so no webhook backlog can
   * fill a stream claim.
   */
  dueStreamRows(nowMs: number, limit: number): OutboxRow[] {
    return rows(
      this.db.query(
        DUE_STREAM_ROWS_SQL,
        [nowMs, nowMs, nowMs, nowMs, limit],
      ),
    );
  }

  /**
   * The webhook rows a claim may start: only the head of each webhook (no
   * earlier row of it still pending or held), and only if due. Heads are
   * taken in turn across clients (each client's oldest first, then each
   * one's next), so one client's backlog cannot hold every POST slot while
   * another's events wait.
   */
  dueWebhookHeads(nowMs: number, limit: number): OutboxRow[] {
    return rows(
      this.db.query(
        DUE_WEBHOOK_HEADS_SQL,
        [nowMs, nowMs, limit],
      ),
    );
  }

  /** Take a due row under a lease; false when another claim got it first. */
  claimOutboxRow(id: number, claimId: string, claimant: string, untilMs: number, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE a2a_push_outbox
            SET status = 'claimed', claim_id = ?, claimed_by = ?, claimed_until = ?, attempts = attempts + 1
          WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claimed_until < ?))`,
        [claimId, claimant, untilMs, id, nowMs],
      ) === 1
    );
  }

  /**
   * Settle a claimed row, compare-and-set on its claim: only the claim that
   * holds it may report it. `pending` puts it back with a retry time.
   */
  settleOutboxRow(
    id: number,
    claim: { claimId: string; claimant: string },
    to: { status: 'delivered' | 'failed' } | { status: 'pending'; nextAttemptAt: number },
  ): boolean {
    return (
      this.db.run(
        `UPDATE a2a_push_outbox
            SET status = ?, next_attempt_at = ?, claim_id = NULL, claimed_by = NULL, claimed_until = NULL
          WHERE id = ? AND status = 'claimed' AND claim_id = ? AND claimed_by = ?`,
        [to.status, to.status === 'pending' ? to.nextAttemptAt : null, id, claim.claimId, claim.claimant],
      ) === 1
    );
  }

  /**
   * Hold every waiting event of one task until `untilMs` (its client cannot
   * authenticate for now): pending rows leave the due set, in order, and a
   * row already waiting longer (a webhook's retry) keeps its own time. A
   * claim whose lease lapsed by `nowMs` is given back and held with them, or
   * it would stay due and be read again by every claim; a live claim stays
   * with the gateway that holds it.
   */
  deferOutbox(operationRef: number, untilMs: number, nowMs: number): number {
    return this.db.run(
      `UPDATE a2a_push_outbox
          SET status = 'pending', next_attempt_at = ?, claim_id = NULL, claimed_by = NULL, claimed_until = NULL
        WHERE operation_ref = ?
          AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at < ?))
            OR (status = 'claimed' AND claimed_until < ?))`,
      [untilMs, operationRef, untilMs, nowMs],
    );
  }

  /** Suppress every event of one task still waiting or held (§7.3: its authority went). */
  suppressOutbox(operationRef: number): number {
    return this.db.run(
      `UPDATE a2a_push_outbox SET status = 'suppressed', claim_id = NULL, claimed_by = NULL, claimed_until = NULL
        WHERE operation_ref = ? AND status IN ('pending','claimed')`,
      [operationRef],
    );
  }

  /** The clients whose stream fence still holds at `nowMs`, with their current credential generation. */
  streamFences(nowMs: number): { client_id: string; credential_gen: number }[] {
    return this.db.query(
      `SELECT client_id, credential_gen FROM a2a_clients WHERE streams_fence_until IS NOT NULL AND streams_fence_until > ? ORDER BY client_id`,
      [nowMs],
    ) as unknown as { client_id: string; credential_gen: number }[];
  }

  /** A client's credential generation: 0 until one of its credentials ends, and for no such client. */
  credentialGen(clientId: string): number {
    const rows = this.db.query(`SELECT credential_gen FROM a2a_clients WHERE client_id = ?`, [clientId]) as unknown as {
      credential_gen: number;
    }[];
    return rows[0]?.credential_gen ?? 0;
  }

  /** Suppress one row (its webhook config is gone). */
  suppressOutboxRow(id: number): void {
    this.db.run(
      `UPDATE a2a_push_outbox SET status = 'suppressed', claim_id = NULL, claimed_by = NULL, claimed_until = NULL
        WHERE id = ? AND status IN ('pending','claimed')`,
      [id],
    );
  }
}
