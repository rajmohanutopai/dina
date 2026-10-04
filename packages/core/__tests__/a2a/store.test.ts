/**
 * Migration v53 and `A2AStore` on a real SQLCipher file (design §9): fresh
 * and upgrade installs, the unique indexes Lane 1 relies on, every
 * compare-and-set, and one commit across the A2A and workflow stores.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  A2AStore,
  type PermitRow,
  type RemoteAgentRow, type NewA2ATask } from '../../src/a2a/store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { SQLiteWorkflowRepository } from '../../src/workflow/repository';

const NOW = 1_800_000_000_000;

function openDb(dir: string): NodeSQLiteAdapter {
  return new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ab'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
}

let dir: string;
let db: NodeSQLiteAdapter;
let store: A2AStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-store-'));
  db = openDb(dir);
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new A2AStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const agent = (over: Partial<RemoteAgentRow> = {}): RemoteAgentRow => ({
  agent_id: 'ra-1',
  name: 'Summarizer',
  card_url: 'https://agent.example/.well-known/agent-card.json',
  card_json: '{}',
  card_hash: 'a'.repeat(64),
  endpoint: 'https://agent.example/rpc',
  endpoint_tenant: '',
  auth_endpoints_json: null,
  schemes_json: '{}',
  signature_state: 'unsigned',
  signature_detail: '',
  status: 'candidate',
  approved_at: null,
  last_verified_at: NOW,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

const operation = (over: Partial<NewA2ATask> = {}): NewA2ATask => ({
  external_id: `op-${randomBytes(4).toString('hex')}`,
  direction: 'outbound',
  principal: 'owner',
  internal_id: null,
  context_id: null,
  state: 'pending_decision',
  reason_code: null,
  result_json: null,
  result_quarantine: null,
  quarantine_digest: null,
  guard_receipt_id: null,
  message_id: null,
  request_hash: 'c'.repeat(64),
  card_hash: 'a'.repeat(64),
  submission_phase: null,
  effect_phase: null,
  continuation_generation: 0,
  input_required_json: null,
  snapshot_json: '{}',
  consent_json: '{}',
  reply_to: 'main',
  release_session_id: 'chat:main',
  remote_agent_id: 'ra-1',
  remote_task_id: null,
  remote_context_id: null,
  status_updated_at: NOW,
  created_at: NOW,
  ...over,
});

const permit = (operationRef: number, over: Partial<PermitRow> = {}): PermitRow => ({
  permit_id: `pm-${randomBytes(4).toString('hex')}`,
  direction: 'outbound',
  operation_ref: operationRef,
  execution_child_id: '',
  approval_task_id: 'appr-1',
  payload_hash: 'c'.repeat(64),
  action_class: 'read',
  pep_did: null,
  authority_snapshot_json: '{}',
  state: 'minted',
  void_reason: null,
  expires_at: NOW + 60_000,
  created_at: NOW,
  consumed_at: null,
  ...over,
});

describe('migration v53', () => {
  it('creates every A2A table (M1a v53, M1b v54–v55, M2 v56, M3 v57, M4 v58, M5 v59) with foreign keys on', () => {
    const tables = db
      .query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'a2a_%' ORDER BY name`)
      .map((r) => r.name);
    expect(tables).toEqual([
      'a2a_cancel_requests',
      'a2a_card_publication',
      'a2a_clients',
      'a2a_credential_bindings',
      'a2a_credential_secrets',
      'a2a_did_challenges',
      'a2a_disclosures',
      'a2a_entities',
      'a2a_guard_jobs',
      'a2a_idempotency_receipts',
      'a2a_permits',
      'a2a_proposal_refusals',
      'a2a_push_configs',
      'a2a_push_outbox',
      'a2a_remote_agents',
      'a2a_remote_credentials',
      'a2a_request_nonces',
      'a2a_runner_bindings',
      'a2a_skill_bindings',
      'a2a_task_children',
      'a2a_tasks',
      'a2a_utterances',
    ]);
    expect(db.query<{ foreign_keys: number }>('PRAGMA foreign_keys')[0]?.foreign_keys).toBe(1);
  });

  it('upgrades a v52 install without touching existing workflow rows', () => {
    const upgradeDir = mkdtempSync(path.join(tmpdir(), 'a2a-upgrade-'));
    const old = openDb(upgradeDir);
    try {
      applyMigrations(old, IDENTITY_MIGRATIONS.filter((m) => m.version <= 52));
      const repo = new SQLiteWorkflowRepository(old);
      repo.create({
        id: 'pre-existing',
        kind: 'delegation',
        status: 'queued',
        priority: 'normal',
        description: 'kept',
        payload: '{}',
        result_summary: '',
        policy: '{}',
        created_at: NOW,
        updated_at: NOW,
      });
      applyMigrations(old, IDENTITY_MIGRATIONS);
      expect(repo.getById('pre-existing')?.description).toBe('kept');
      expect(old.query(`SELECT name FROM sqlite_master WHERE name = 'a2a_tasks'`)).toHaveLength(1);
    } finally {
      old.close();
      rmSync(upgradeDir, { recursive: true, force: true });
    }
  });

  // Cold audit C3-6: v61 gives every sent operation its send time
  it('v61 backfills a running operation’s send time from its status time, and leaves an ended one without', () => {
    const upgradeDir = mkdtempSync(path.join(tmpdir(), 'a2a-v61-'));
    const old = openDb(upgradeDir);
    try {
      applyMigrations(old, IDENTITY_MIGRATIONS.filter((m) => m.version <= 60));
      const before = new A2AStore(old);
      // Running since its send: that status time is the send time.
      const running = before.insertTask(
        operation({ state: 'running', submission_phase: 'acknowledged', message_id: 'm-1', remote_task_id: 'rt-1', status_updated_at: NOW - 5_000 }),
      );
      // Ended: its status time is the end, not the send.
      const ended = before.insertTask(operation({ state: 'completed', submission_phase: 'terminal', message_id: 'm-2', status_updated_at: NOW }));
      const queued = before.insertTask(operation({ state: 'queued', submission_phase: 'built' }));
      applyMigrations(old, IDENTITY_MIGRATIONS);
      const after = new A2AStore(old);
      expect([running, ended, queued].map((o) => after.getTask(o.id)?.sent_at)).toEqual([NOW - 5_000, null, null]);
    } finally {
      old.close();
      rmSync(upgradeDir, { recursive: true, force: true });
    }
  });

  it('v62 stops the delivery of events already queued for an inbound execution child, and only those', () => {
    const upgradeDir = mkdtempSync(path.join(tmpdir(), 'a2a-v62-'));
    const old = openDb(upgradeDir);
    try {
      applyMigrations(old, IDENTITY_MIGRATIONS.filter((m) => m.version <= 61));
      const store = new A2AStore(old);
      const repo = new SQLiteWorkflowRepository(old);
      const task = (id: string) =>
        repo.create({
          id,
          kind: 'delegation',
          status: 'completed',
          priority: 'normal',
          description: id,
          payload: '{}',
          result_summary: '',
          policy: '{}',
          created_at: NOW,
          updated_at: NOW,
        });
      const event = (taskId: string) =>
        repo.appendEvent({ task_id: taskId, at: NOW, event_kind: 'completed', needs_delivery: true, delivery_attempts: 0, delivery_failed: false, details: '{}' });
      const op = store.insertTask(operation({ direction: 'inbound', principal: 'a2a:ac_1', state: 'open' }));
      task('inbound-child');
      store.insertChild({ child_task_id: 'inbound-child', operation_ref: op.id, generation: 0, role: 'execution', created_at: NOW, pep_did: null });
      event('inbound-child');
      task('owner-task');
      event('owner-task');
      applyMigrations(old, IDENTITY_MIGRATIONS);
      const queued = repo.listUndeliveredEvents(Number.MAX_SAFE_INTEGER, 0, 100).map((e) => e.task_id);
      expect(queued).toEqual(['owner-task']);
    } finally {
      old.close();
      rmSync(upgradeDir, { recursive: true, force: true });
    }
  });

  it('no migration drops or renames a table another table references by foreign key', () => {
    // Rebuilding such a table inside the migration transaction (where
    // PRAGMA foreign_keys = OFF has no effect) deletes or orphans its
    // children's rows (design §9).
    const referenced = new Set<string>();
    for (const m of IDENTITY_MIGRATIONS) {
      for (const match of m.sql.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) referenced.add((match[1] ?? '').toLowerCase());
    }
    const offenders: string[] = [];
    for (const m of IDENTITY_MIGRATIONS) {
      for (const match of m.sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)|ALTER\s+TABLE\s+(\w+)\s+RENAME\s+TO/gi)) {
        const table = (match[1] ?? match[2] ?? '').toLowerCase();
        if (referenced.has(table)) offenders.push(`v${m.version}: ${table}`);
      }
    }
    expect(referenced.has('workflow_tasks')).toBe(true);
    expect(referenced.has('a2a_tasks')).toBe(true);
    expect(offenders).toEqual([]);
  });
});

describe('remote agents, credentials, bindings', () => {
  it('allows one live registration per card URL, and a new one after revocation', () => {
    store.insertAgent(agent());
    expect(() => store.insertAgent(agent({ agent_id: 'ra-2' }))).toThrow(/UNIQUE/);
    expect(store.setAgentStatus('ra-1', ['candidate', 'active', 'changed'], 'revoked', NOW + 1)).toBe(true);
    store.insertAgent(agent({ agent_id: 'ra-2' }));
    expect(store.getLiveAgentByUrl(agent().card_url)?.agent_id).toBe('ra-2');
  });

  it('stamps approved_at only when an agent becomes active, and moves only from the named states', () => {
    store.insertAgent(agent());
    expect(store.setAgentStatus('ra-1', ['active'], 'revoked', NOW)).toBe(false);
    expect(store.setAgentStatus('ra-1', ['candidate'], 'active', NOW + 5)).toBe(true);
    expect(store.getAgent('ra-1')?.approved_at).toBe(NOW + 5);
  });

  it('re-pins a changed card and marks the agent changed', () => {
    store.insertAgent(agent({ status: 'active' }));
    const ok = store.repinChangedCard(
      'ra-1',
      { name: 'New', card_json: '{"x":1}', card_hash: 'b'.repeat(64), endpoint: 'https://agent.example/v2', endpoint_tenant: '', schemes_json: '{}', signature_state: 'unsigned', signature_detail: '' },
      NOW + 1,
    );
    expect(ok).toBe(true);
    expect(store.getAgent('ra-1')).toMatchObject({ status: 'changed', card_hash: 'b'.repeat(64) });
  });

  it('refuses a credential or binding for an agent that does not exist', () => {
    expect(() =>
      store.insertCredential({
        credential_ref: 'cr-1',
        remote_agent_id: 'missing',
        kind: 'none',
        audience: null,
        scope_json: '{}',
        scope_hash: 'd'.repeat(64),
        revision: 1,
        status: 'active',
        created_at: NOW,
        revoked_at: null,
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it('bumps the binding revision on every replacement and on revocation', () => {
    store.insertAgent(agent());
    store.insertCredential({
      credential_ref: 'cr-1',
      remote_agent_id: 'ra-1',
      kind: 'none',
      audience: null,
      scope_json: '{}',
      scope_hash: 'd'.repeat(64),
      revision: 1,
      status: 'active',
      created_at: NOW,
      revoked_at: null,
    });
    const key = { remote_agent_id: 'ra-1', card_hash: 'a'.repeat(64), skill: 'summarize' };
    const first = store.upsertBinding({ ...key, action_class: 'read', result_schema_json: null, credential_ref: 'cr-1' }, NOW);
    expect(first.revision).toBe(1);
    const second = store.upsertBinding({ ...key, action_class: 'write', result_schema_json: null, credential_ref: 'cr-1' }, NOW + 1);
    expect(second).toMatchObject({ revision: 2, action_class: 'write' });
    expect(store.revokeBinding('ra-1', key.card_hash, 'summarize', NOW + 2)).toBe(true);
    expect(store.getBinding('ra-1', key.card_hash, 'summarize')).toMatchObject({ revision: 3, revoked_at: NOW + 2 });
    expect(store.revokeBinding('ra-1', key.card_hash, 'summarize', NOW + 3)).toBe(false);
    const third = store.upsertBinding({ ...key, action_class: 'read', result_schema_json: null, credential_ref: 'cr-1' }, NOW + 4);
    expect(third).toMatchObject({ revision: 4, revoked_at: null });
  });
});

describe('operations', () => {
  it('updates only from the named states, and stamps status_updated_at on a state change', () => {
    const op = store.insertTask(operation());
    expect(store.updateTask(op.id, ['queued'], { state: 'running' }, NOW + 1)).toBe(false);
    expect(store.updateTask(op.id, ['pending_decision'], { state: 'queued' }, NOW + 2)).toBe(true);
    expect(store.getTask(op.id)).toMatchObject({ state: 'queued', status_updated_at: NOW + 2 });
    expect(store.updateTask(op.id, ['queued'], { remote_task_id: 'rt-1' }, NOW + 3)).toBe(true);
    expect(store.getTask(op.id)?.status_updated_at).toBe(NOW + 2);
  });

  it('refuses to patch an identity column', () => {
    const op = store.insertTask(operation());
    expect(() =>
      store.updateTask(op.id, ['pending_decision'], { external_id: 'x' } as never, NOW),
    ).toThrow(/not patchable/);
  });

  it('keeps external ids unique per direction and principal', () => {
    store.insertTask(operation({ external_id: 'same' }));
    expect(() => store.insertTask(operation({ external_id: 'same' }))).toThrow(/UNIQUE/);
    expect(store.insertTask(operation({ external_id: 'same', principal: 'a2a:client-1', direction: 'inbound' })).id).toBeGreaterThan(0);
  });

  it('lists newest status first', () => {
    const a = store.insertTask(operation({ status_updated_at: NOW }));
    const b = store.insertTask(operation({ status_updated_at: NOW + 10 }));
    store.updateTask(a.id, ['pending_decision'], { state: 'queued' }, NOW + 20);
    expect(store.listTasks('outbound', 'owner', 10).map((t) => t.id)).toEqual([a.id, b.id]);
  });
});

describe('permits', () => {
  it('lets one consent approval mint one outbound permit, ever, even after voiding', () => {
    const op = store.insertTask(operation());
    const first = permit(op.id);
    store.insertPermit(first);
    expect(() => store.insertPermit(permit(op.id, { execution_child_id: 'other' }))).toThrow(/UNIQUE/);
    expect(store.voidPermit(first.permit_id, 'cancelled')).toBe(true);
    expect(() => store.insertPermit(permit(op.id))).toThrow(/UNIQUE/);
    expect(store.getOutboundPermitByApproval('appr-1')).toMatchObject({ state: 'void', void_reason: 'cancelled' });
  });

  it('consumes a minted, unexpired permit exactly once', () => {
    const op = store.insertTask(operation());
    const p = permit(op.id);
    store.insertPermit(p);
    expect(store.consumePermit(p.permit_id, NOW + 1)).toBe(true);
    expect(store.consumePermit(p.permit_id, NOW + 2)).toBe(false);
    expect(store.voidPermit(p.permit_id, 'late')).toBe(false);
  });

  it('never consumes an expired permit', () => {
    const op = store.insertTask(operation());
    const p = permit(op.id, { expires_at: NOW + 10 });
    store.insertPermit(p);
    expect(store.consumePermit(p.permit_id, NOW + 10)).toBe(false);
  });

  it('refuses a permit for an operation that does not exist', () => {
    expect(() => store.insertPermit(permit(999))).toThrow(/FOREIGN KEY/);
  });
});

describe('guard jobs', () => {
  const job = (operationRef: number) => ({
    job_id: `gj-${operationRef}`,
    operation_ref: operationRef,
    quarantine_digest: 'e'.repeat(64),
    scanner_version: 'guard-v1',
    state: 'pending' as const,
    claim_id: null,
    claimed_until: null,
    verdict_json: null,
    held_notice_at: null,
    created_at: NOW,
    resolved_at: null,
  });

  it('allows one guard job per operation', () => {
    const op = store.insertTask(operation());
    store.insertGuardJob(job(op.id));
    expect(() => store.insertGuardJob({ ...job(op.id), job_id: 'other' })).toThrow(/UNIQUE/);
  });

  it('claims with a lease, lets a lapsed claim be re-claimed, and resolves only under the live claim', () => {
    const op = store.insertTask(operation());
    const j = job(op.id);
    store.insertGuardJob(j);
    expect(store.nextClaimableGuardJob(NOW)?.job_id).toBe(j.job_id);
    expect(store.claimGuardJob(j.job_id, { state: 'pending', claimId: null }, 'c1', NOW + 100)).toBe(true);
    expect(store.nextClaimableGuardJob(NOW + 50)).toBeNull();
    // The lease lapses; a second worker takes over.
    const lapsed = store.nextClaimableGuardJob(NOW + 100);
    expect(lapsed?.claim_id).toBe('c1');
    expect(store.claimGuardJob(j.job_id, { state: 'claimed', claimId: 'c1' }, 'c2', NOW + 300)).toBe(true);
    // The first worker's verdict lost its claim.
    expect(store.resolveGuardJob(j.job_id, 'c1', 'passed', '{}', NOW + 150)).toBe(false);
    expect(store.resolveGuardJob(j.job_id, 'c2', 'passed', '{}', NOW + 150)).toBe(true);
    expect(store.getGuardJob(j.job_id)).toMatchObject({ state: 'passed', resolved_at: NOW + 150 });
    expect(store.nextClaimableGuardJob(NOW + 10_000)).toBeNull();
  });

  it('refuses a verdict after the claim lapsed', () => {
    const op = store.insertTask(operation());
    const j = job(op.id);
    store.insertGuardJob(j);
    store.claimGuardJob(j.job_id, { state: 'pending', claimId: null }, 'c1', NOW + 100);
    expect(store.resolveGuardJob(j.job_id, 'c1', 'passed', '{}', NOW + 100)).toBe(false);
  });

  it('tells the owner about a held job once', () => {
    const op = store.insertTask(operation());
    const j = job(op.id);
    store.insertGuardJob(j);
    expect(store.guardJobsAwaitingNotice(NOW).map((g) => g.job_id)).toEqual([j.job_id]);
    expect(store.markHeldNoticeSent(j.job_id, NOW + 1)).toBe(true);
    expect(store.markHeldNoticeSent(j.job_id, NOW + 2)).toBe(false);
    expect(store.guardJobsAwaitingNotice(NOW + 10)).toEqual([]);
  });
});

describe('cancel requests', () => {
  it('records one request per operation and binds resolution to the claim that attempts it', () => {
    const op = store.insertTask(operation());
    expect(store.requestCancel(op.id, NOW)).toBe(true);
    expect(store.requestCancel(op.id, NOW + 1)).toBe(false);
    expect(store.updateCancelRequest(op.id, ['requested'], 'attempting', { resolvingClaimId: 'claim-a', nowMs: NOW + 2 })).toBe(true);
    // A re-claim re-binds the request; the old claim can no longer resolve it.
    expect(store.updateCancelRequest(op.id, ['attempting'], 'attempting', { resolvingClaimId: 'claim-b', nowMs: NOW + 3 })).toBe(true);
    expect(store.updateCancelRequest(op.id, ['attempting'], 'confirmed', { requireClaimId: 'claim-a', nowMs: NOW + 4 })).toBe(false);
    expect(store.updateCancelRequest(op.id, ['attempting'], 'confirmed', { requireClaimId: 'claim-b', nowMs: NOW + 5 })).toBe(true);
    expect(store.getCancelRequest(op.id)).toMatchObject({ state: 'confirmed', resolved_at: NOW + 5 });
  });
});

describe('one commit across the A2A and workflow stores', () => {
  it('commits both or neither', () => {
    const repo = new SQLiteWorkflowRepository(db);
    const task = {
      id: 'child-1',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'dispatch',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: NOW,
      updated_at: NOW,
    };
    const op = store.insertTask(operation());
    expect(() =>
      store.transaction(() => {
        repo.create(task);
        store.insertChild({ child_task_id: 'child-1', operation_ref: op.id, generation: 0, role: 'dispatch', created_at: NOW });
        throw new Error('crash before commit');
      }),
    ).toThrow('crash before commit');
    expect(repo.getById('child-1')).toBeNull();
    expect(store.getChild('child-1')).toBeNull();

    const value = store.transaction(() => {
      repo.create(task);
      store.insertChild({ child_task_id: 'child-1', operation_ref: op.id, generation: 0, role: 'dispatch', created_at: NOW });
      return 'done';
    });
    expect(value).toBe('done');
    expect(repo.getById('child-1')?.status).toBe('queued');
    expect(store.childrenOf(op.id, 'dispatch').map((c) => c.child_task_id)).toEqual(['child-1']);
  });
});
