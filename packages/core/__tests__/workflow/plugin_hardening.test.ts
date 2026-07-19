/**
 * PLG-2 — workflow hardening for the plugin substrate
 * (docs/PLUGIN_ARCHITECTURE.md §9.1, §9.5).
 *
 * Runs the SAME scenario set against BOTH repository implementations —
 * the SQLite/in-memory pair must never diverge on lease-token or
 * outcome_unknown semantics (that divergence is exactly how a test
 * passes in memory and double-books in production).
 *
 * Covers:
 *   (1) claim mints claim_id, advances attempt, anchors first_claimed_at
 *   (2) terminal CAS on (task_id, claim_id, running): stale claim loses,
 *       report retained as late_report evidence — never applied
 *   (3) heartbeat/progress claim_id guard
 *   (4) lease-loss classification: legacy requeue / idempotent retry
 *       with backoff + budget / effectful → outcome_unknown /
 *       declared-read → failed
 *   (5) owner cancel of running effectful plugin task → outcome_unknown
 *   (6) deadline expiry mid-run on effectful plugin task → outcome_unknown
 *   (7) outcome_unknown is terminal: complete/fail/cancel bounce off
 *   (8) retry-backoff eligibility: requeued task invisible until due
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  PLUGIN_INVOCATION_PAYLOAD_TYPE,
  PLUGIN_RETRY,
  parsePluginEnvelope,
} from '../../src/workflow/plugin_envelope';
import {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  type WorkflowRepository,
} from '../../src/workflow/repository';

import type { WorkflowTask } from '../../src/workflow/domain';

// ---------------------------------------------------------------------------
// Harness — the outbox_repository.test.ts dual-store pattern: the REAL
// better-sqlite3-multiple-ciphers engine + the in-memory mirror run the
// same matrix.
// ---------------------------------------------------------------------------

const T0 = 1_750_000_000_000; // fixed epoch ms
const LEASE_MS = 30_000;

interface Ctx {
  repo: WorkflowRepository;
  cleanup: () => void;
}

function makeSqliteCtx(): Ctx {
  const dir = mkdtempSync(path.join(tmpdir(), 'plg2-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    repo: new SQLiteWorkflowRepository(adapter),
    cleanup: () => {
      try {
        adapter.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function makeMemoryCtx(): Ctx {
  return { repo: new InMemoryWorkflowRepository(), cleanup: () => {} };
}

let seq = 0;

function pluginPayload(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
    install_id: 'inst_1',
    capability_id: 'com.acme.flightwatch.watch',
    params: { flight: 'BA117' },
    context: [],
    manifest_cid: 'bafyreidummycid',
    approved_scope_hash: 'a'.repeat(64),
    schema_snapshot: { type: 'object' },
    config_revision: 1,
    execution_id: `exec_${++seq}`,
    idempotency_key: `idem_${seq}`,
    action_class: 'booking',
    effects_idempotency: 'unsupported',
    ...overrides,
  });
}

function baseTask(payload: string, id?: string): WorkflowTask {
  seq += 1;
  return {
    id: id ?? `task_${seq}`,
    kind: 'delegation',
    status: 'queued',
    priority: 'normal',
    description: 'plg2 test task',
    payload,
    result_summary: '',
    policy: '',
    requested_runner: 'plugin:inst_1',
    created_at: T0,
    updated_at: T0,
  };
}

function claim(repo: WorkflowRepository, nowMs = T0): WorkflowTask {
  const t = repo.claimDelegationTask('did:key:zrunner', nowMs, LEASE_MS, 'plugin:inst_1');
  if (t === null) throw new Error('expected a claimable task');
  return t;
}

// ---------------------------------------------------------------------------
// The dual-store scenario matrix
// ---------------------------------------------------------------------------

describe.each([
  ['SQLiteWorkflowRepository', makeSqliteCtx],
  ['InMemoryWorkflowRepository', makeMemoryCtx],
] as const)('%s — PLG-2 hardening', (_name, makeCtx) => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.cleanup();
  });

  // ── (1) claim token ──────────────────────────────────────────────────

  it('claim mints a claim_id, advances attempt, anchors first_claimed_at once', () => {
    ctx.repo.create(baseTask(pluginPayload({ effects_idempotency: 'supported' })));
    const first = claim(ctx.repo);
    expect(first.claim_id).toMatch(/^[0-9a-f]{32}$/);
    expect(first.attempt).toBe(1);
    expect(first.first_claimed_at).toBe(T0);

    // Lease lapses → idempotent task requeues → second claim is a NEW
    // attempt with a NEW token but the SAME first-dispatch anchor.
    ctx.repo.expireLeasedTasks(T0 + LEASE_MS + 1);
    const backoffDue = T0 + PLUGIN_RETRY.BACKOFF_BASE_MS * 2 + 1_000;
    const second = claim(ctx.repo, backoffDue);
    expect(second.attempt).toBe(2);
    expect(second.claim_id).toMatch(/^[0-9a-f]{32}$/);
    expect(second.claim_id).not.toBe(first.claim_id);
    expect(second.first_claimed_at).toBe(T0);
  });

  // ── (2) terminal CAS + late_report ───────────────────────────────────

  it('a stale claim_id loses the completion CAS; its report is evidence, never a result', () => {
    ctx.repo.create(baseTask(pluginPayload({ effects_idempotency: 'supported' })));
    const first = claim(ctx.repo);
    ctx.repo.expireLeasedTasks(T0 + LEASE_MS + 1);
    const reclaimTime = T0 + PLUGIN_RETRY.BACKOFF_BASE_MS * 2 + 1_000;
    const second = claim(ctx.repo, reclaimTime);

    // The FIRST (zombie) execution posts its completion with its stale token.
    const staleEvent = ctx.repo.completeWithDetails(
      second.id,
      'did:key:zrunner',
      'zombie summary',
      '{"booked":true}',
      '{}',
      reclaimTime + 10,
      first.claim_id,
    );
    expect(staleEvent).toBe(0); // lost the CAS — not applied

    const task = ctx.repo.getById(second.id);
    expect(task?.status).toBe('running'); // newer attempt untouched
    expect(task?.result).toBeUndefined();

    // …but the report is retained as reconciliation evidence.
    const late = ctx.repo
      .listEventsForTask(second.id)
      .filter((e) => e.event_kind === 'late_report');
    expect(late).toHaveLength(1);
    expect(JSON.parse(late[0]!.details)).toMatchObject({
      claim_id: first.claim_id,
      verb: 'complete',
    });
    // F11: the reported PAYLOAD is retained as evidence — a booking
    // confirmation on an outcome_unknown effect must not be discarded.
    expect(JSON.parse(late[0]!.details).report).toBe('{"booked":true}');
    expect(late[0]!.needs_delivery).toBe(false); // evidence, not the result pipeline

    // The live claim completes normally.
    const liveEvent = ctx.repo.completeWithDetails(
      second.id,
      'did:key:zrunner',
      'real summary',
      '{"booked":true}',
      '{}',
      reclaimTime + 20,
      second.claim_id,
    );
    expect(liveEvent).toBeGreaterThan(0);
    expect(ctx.repo.getById(second.id)?.status).toBe('completed');
  });

  it('fail with a stale claim_id is also evidence-only', () => {
    ctx.repo.create(baseTask(pluginPayload()));
    const t = claim(ctx.repo);
    const wrong = 'f'.repeat(32);
    expect(ctx.repo.fail(t.id, 'did:key:zrunner', 'boom', T0 + 5, wrong)).toBe(0);
    expect(ctx.repo.getById(t.id)?.status).toBe('running');
    const late = ctx.repo.listEventsForTask(t.id).filter((e) => e.event_kind === 'late_report');
    expect(late).toHaveLength(1);
    expect(JSON.parse(late[0]!.details)).toMatchObject({ verb: 'fail' });
    expect(JSON.parse(late[0]!.details).report).toBe('boom'); // F11: error retained
  });

  // ── (3) heartbeat/progress guard ─────────────────────────────────────

  it('heartbeat and progress honor the claim_id guard when presented', () => {
    ctx.repo.create(baseTask(pluginPayload()));
    const t = claim(ctx.repo);
    const wrong = '0'.repeat(32);
    expect(ctx.repo.heartbeatTask(t.id, 'did:key:zrunner', T0 + 5, LEASE_MS, wrong)).toBe(false);
    expect(ctx.repo.heartbeatTask(t.id, 'did:key:zrunner', T0 + 5, LEASE_MS, t.claim_id)).toBe(
      true,
    );
    expect(ctx.repo.updateTaskProgress(t.id, 'did:key:zrunner', 'step 1', T0 + 6, wrong)).toBe(
      false,
    );
    expect(ctx.repo.updateTaskProgress(t.id, 'did:key:zrunner', 'step 1', T0 + 6, t.claim_id)).toBe(
      true,
    );
    // Legacy callers omitting claimId keep the agent_did-only guard.
    expect(ctx.repo.heartbeatTask(t.id, 'did:key:zrunner', T0 + 7, LEASE_MS)).toBe(true);
  });

  // ── (4) lease-loss classification ────────────────────────────────────

  it('a NON-plugin task keeps the legacy requeue on lease loss', () => {
    const t = baseTask(JSON.stringify({ type: 'free_form_task', text: 'do things' }));
    t.requested_runner = undefined;
    ctx.repo.create(t);
    const claimed = ctx.repo.claimDelegationTask('did:key:zagent', T0, LEASE_MS, '');
    expect(claimed).not.toBeNull();
    const reverted = ctx.repo.expireLeasedTasks(T0 + LEASE_MS + 1);
    expect(reverted).toHaveLength(1);
    expect(reverted[0]!.status).toBe('queued');
  });

  it('declared-effectful without idempotency → outcome_unknown on lease loss (§9.5)', () => {
    ctx.repo.create(
      baseTask(pluginPayload({ action_class: 'booking', effects_idempotency: 'unsupported' })),
    );
    const t = claim(ctx.repo);
    const swept = ctx.repo.expireLeasedTasks(T0 + LEASE_MS + 1);
    expect(swept).toHaveLength(1);
    expect(swept[0]!.status).toBe('outcome_unknown');
    const after = ctx.repo.getById(t.id);
    expect(after?.status).toBe('outcome_unknown');
    const events = ctx.repo
      .listEventsForTask(t.id)
      .filter((e) => e.event_kind === 'outcome_unknown');
    expect(events).toHaveLength(1);
    expect(events[0]!.needs_delivery).toBe(true); // owner must see it
  });

  it('round-9 #8: declared-payment without idempotency → outcome_unknown on lease loss (money MAY have moved)', () => {
    // Before round-9, `payment` was absent from EFFECTFUL_CLASSES, so a lost
    // payment lease classified as the quietly-safe `failed` — hiding that funds
    // may have moved. It must park as outcome_unknown for owner review.
    ctx.repo.create(
      baseTask(pluginPayload({ action_class: 'payment', effects_idempotency: 'unsupported' })),
    );
    const t = claim(ctx.repo);
    const swept = ctx.repo.expireLeasedTasks(T0 + LEASE_MS + 1);
    expect(swept).toHaveLength(1);
    expect(swept[0]!.status).toBe('outcome_unknown');
    expect(ctx.repo.getById(t.id)?.status).toBe('outcome_unknown');
  });

  it('declared-read without idempotency → plain failed on lease loss (retry trusts nothing, §9.1)', () => {
    ctx.repo.create(
      baseTask(pluginPayload({ action_class: 'read', effects_idempotency: 'unsupported' })),
    );
    const t = claim(ctx.repo);
    ctx.repo.expireLeasedTasks(T0 + LEASE_MS + 1);
    expect(ctx.repo.getById(t.id)?.status).toBe('failed');
  });

  it('idempotent-supported requeues with exponential backoff, then exhausts the budget', () => {
    ctx.repo.create(
      baseTask(pluginPayload({ action_class: 'booking', effects_idempotency: 'supported' })),
    );
    let now = T0;
    for (let attempt = 1; attempt <= PLUGIN_RETRY.MAX_ATTEMPTS; attempt++) {
      const t = claim(ctx.repo, now);
      expect(t.attempt).toBe(attempt);
      now += LEASE_MS + 1;
      const swept = ctx.repo.expireLeasedTasks(now);
      expect(swept).toHaveLength(1);
      if (attempt < PLUGIN_RETRY.MAX_ATTEMPTS) {
        expect(swept[0]!.status).toBe('queued');
        // (8) backoff: not claimable until next_run_at comes due.
        expect(
          ctx.repo.claimDelegationTask('did:key:zrunner', now, LEASE_MS, 'plugin:inst_1'),
        ).toBeNull();
        const dueAt = (swept[0]!.next_run_at ?? 0) * 1000;
        expect(dueAt).toBeGreaterThan(now);
        now = dueAt + 1_000;
      } else {
        // Budget exhausted without a terminal report → outcome_unknown
        // (declared-effectful), never a fourth dispatch.
        expect(swept[0]!.status).toBe('outcome_unknown');
      }
    }
  });

  it('idempotent retry stops at the 24h window even with attempts left', () => {
    ctx.repo.create(
      baseTask(pluginPayload({ action_class: 'booking', effects_idempotency: 'supported' })),
    );
    claim(ctx.repo, T0);
    const pastWindow = T0 + PLUGIN_RETRY.RETRY_WINDOW_MS + 60_000;
    const swept = ctx.repo.expireLeasedTasks(pastWindow);
    expect(swept[0]!.status).toBe('outcome_unknown');
  });

  // ── (5) owner cancel mid-run ─────────────────────────────────────────

  it('cancelling a RUNNING declared-effectful plugin task parks as outcome_unknown', () => {
    ctx.repo.create(baseTask(pluginPayload({ action_class: 'booking' })));
    const t = claim(ctx.repo);
    const eventId = ctx.repo.cancel(t.id, 'changed my mind', T0 + 5);
    expect(eventId).toBeGreaterThan(0);
    const after = ctx.repo.getById(t.id);
    expect(after?.status).toBe('outcome_unknown');
    expect(after?.error).toContain('cancelled by owner');
  });

  it('cancelling a QUEUED effectful plugin task is a plain cancel (never executed)', () => {
    const t = baseTask(pluginPayload({ action_class: 'booking' }));
    ctx.repo.create(t);
    ctx.repo.cancel(t.id, 'nevermind', T0 + 5);
    expect(ctx.repo.getById(t.id)?.status).toBe('cancelled');
  });

  it('cancelling a RUNNING declared-read plugin task is a plain cancel', () => {
    ctx.repo.create(baseTask(pluginPayload({ action_class: 'read' })));
    const t = claim(ctx.repo);
    ctx.repo.cancel(t.id, 'nevermind', T0 + 5);
    expect(ctx.repo.getById(t.id)?.status).toBe('cancelled');
  });

  // ── (6) deadline expiry mid-run ──────────────────────────────────────

  it('TTL expiry on a RUNNING effectful plugin task with a dead lease → outcome_unknown', () => {
    const t = baseTask(pluginPayload({ action_class: 'booking' }));
    t.expires_at = Math.floor(T0 / 1000) + 60;
    ctx.repo.create(t);
    claim(ctx.repo);
    // Past both the lease AND the TTL; expireTasks runs first this tick.
    const expired = ctx.repo.expireTasks(Math.floor(T0 / 1000) + 120, T0 + 120_000);
    expect(expired).toHaveLength(1);
    expect(ctx.repo.getById(t.id)?.status).toBe('outcome_unknown');
  });

  it('TTL expiry on a QUEUED plugin task stays plain failed (never executed)', () => {
    const t = baseTask(pluginPayload({ action_class: 'booking' }));
    t.expires_at = Math.floor(T0 / 1000) + 60;
    ctx.repo.create(t);
    ctx.repo.expireTasks(Math.floor(T0 / 1000) + 120, T0 + 120_000);
    expect(ctx.repo.getById(t.id)?.status).toBe('failed');
  });

  // ── (7) outcome_unknown is terminal ──────────────────────────────────

  it('nothing transitions out of outcome_unknown', () => {
    ctx.repo.create(baseTask(pluginPayload({ action_class: 'booking' })));
    const t = claim(ctx.repo);
    ctx.repo.markOutcomeUnknown(t.id, 'test park', T0 + 5);
    expect(ctx.repo.getById(t.id)?.status).toBe('outcome_unknown');

    expect(ctx.repo.completeWithDetails(t.id, 'did:key:zrunner', 's', '{}', '{}', T0 + 10)).toBe(0);
    expect(ctx.repo.fail(t.id, 'did:key:zrunner', 'e', T0 + 10)).toBe(0);
    expect(ctx.repo.cancel(t.id, 'r', T0 + 10)).toBe(0);
    expect(ctx.repo.getById(t.id)?.status).toBe('outcome_unknown');
  });

  it('markOutcomeUnknown only fires from running (§9.5 legal entry)', () => {
    const t = baseTask(pluginPayload());
    ctx.repo.create(t);
    expect(ctx.repo.markOutcomeUnknown(t.id, 'nope', T0 + 5)).toBe(0);
    expect(ctx.repo.getById(t.id)?.status).toBe('queued');
  });

  it('AUDIT D3: every event gets a UNIQUE event_id (claim + complete must not collide)', () => {
    ctx.repo.create(baseTask(pluginPayload()));
    const t = claim(ctx.repo); // emits a 'claimed' event
    ctx.repo.completeWithDetails(t.id, 'did:key:zrunner', 's', '{}', '{}', T0 + 5, t.claim_id);
    const events = ctx.repo.listEventsForTask(t.id);
    const ids = events.map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    // The 'completed' event must be independently addressable for delivery.
    const completed = events.find((e) => e.event_kind === 'completed');
    expect(completed).toBeDefined();
    expect(ctx.repo.markEventDelivered(completed!.event_id, T0 + 6)).toBe(true);
  });

  it('AUDIT D3: a plugin task can NEVER be completed without a claim token (defense-in-depth)', () => {
    ctx.repo.create(baseTask(pluginPayload()));
    const t = claim(ctx.repo);
    // No claimId → refused even though the task is running (state-only
    // guard must not apply to plugin tasks).
    expect(ctx.repo.completeWithDetails(t.id, 'did:key:zrunner', 's', '{}', '{}', T0 + 5)).toBe(0);
    expect(ctx.repo.getById(t.id)?.status).toBe('running');
    // A non-plugin task still completes without a token (legacy agents).
    const legacy = baseTask(JSON.stringify({ type: 'free_form_task', text: 'x' }), 'legacy_1');
    legacy.requested_runner = undefined;
    ctx.repo.create(legacy);
    const c = ctx.repo.claimDelegationTask('did:key:zagent', T0, LEASE_MS, '');
    expect(
      ctx.repo.completeWithDetails(c!.id, 'did:key:zagent', 's', '{}', '{}', T0 + 5),
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Envelope unit coverage (pure)
// ---------------------------------------------------------------------------

describe('parsePluginEnvelope', () => {
  it('rejects malformed envelopes rather than defaulting (closed-default)', () => {
    expect(parsePluginEnvelope('not json')).toBeNull();
    expect(parsePluginEnvelope('{}')).toBeNull();
    expect(parsePluginEnvelope(JSON.stringify({ type: 'plugin_invocation' }))).toBeNull();
    // Missing effects_idempotency — the §9.1 contract field is required.
    const missing = JSON.parse(pluginPayload());
    delete missing.effects_idempotency;
    expect(parsePluginEnvelope(JSON.stringify(missing))).toBeNull();
  });

  it('accepts the canonical envelope', () => {
    const env = parsePluginEnvelope(pluginPayload());
    expect(env).not.toBeNull();
    expect(env?.install_id).toBe('inst_1');
  });

  it('round-15 #7: rejects an envelope carrying an UNKNOWN top-level field', () => {
    // A faulty producer stamps an extra top-level key (unbounded/sensitive data).
    // The claim guard only inspects params/context, so this would otherwise ride
    // the raw payload to the runner un-inspected. Fail closed on unknown keys.
    const smuggled = pluginPayload({ exfil: 'x'.repeat(10000) });
    expect(parsePluginEnvelope(smuggled)).toBeNull();
    // The same envelope WITHOUT the extra key still parses.
    expect(parsePluginEnvelope(pluginPayload())).not.toBeNull();
  });

  it('round-16 #20: a CARD envelope carrying grant provenance is rejected', () => {
    // grant_id / invocation_digest are grant-authorization artifacts; the claim
    // guard only validates them under kind:'grant'. On a card envelope they're
    // unverifiable → forged/ambiguous provenance in receipts. Quarantine both.
    expect(
      parsePluginEnvelope(pluginPayload({ authorization_kind: 'card', grant_id: 'plg_x' })),
    ).toBeNull();
    expect(
      parsePluginEnvelope(pluginPayload({ authorization_kind: 'card', invocation_digest: 'd' })),
    ).toBeNull();
    // grant provenance without any authorization_kind is likewise incoherent.
    expect(parsePluginEnvelope(pluginPayload({ grant_id: 'plg_x' }))).toBeNull();
    // A clean card envelope (no grant fields) and a grant+grant_id one both parse.
    expect(parsePluginEnvelope(pluginPayload({ authorization_kind: 'card' }))).not.toBeNull();
    expect(
      parsePluginEnvelope(pluginPayload({ authorization_kind: 'grant', grant_id: 'plg_x' })),
    ).not.toBeNull();
  });

  it('PLG-29 #13: a too-deep schema_snapshot quarantines the envelope', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { nested: deep }; // > MAX_SCHEMA_SNAPSHOT_DEPTH (32)
    expect(parsePluginEnvelope(pluginPayload({ schema_snapshot: deep }))).toBeNull();
    // A shallow snapshot still parses.
    expect(
      parsePluginEnvelope(pluginPayload({ schema_snapshot: { type: 'object' } })),
    ).not.toBeNull();
  });

  it('PLG-29 #14: an action_class outside the catalog enum quarantines the envelope', () => {
    expect(parsePluginEnvelope(pluginPayload({ action_class: 'sudo' }))).toBeNull();
    expect(parsePluginEnvelope(pluginPayload({ action_class: 'read' }))).not.toBeNull();
  });

  it('PLG-29 #14: an oversized or control-char identity field quarantines the envelope', () => {
    expect(parsePluginEnvelope(pluginPayload({ install_id: 'i'.repeat(257) }))).toBeNull();
    expect(parsePluginEnvelope(pluginPayload({ capability_id: 'cap‮evil' }))).toBeNull();
    expect(parsePluginEnvelope(pluginPayload({ manifest_cid: 'c d' }))).toBeNull();
    expect(parsePluginEnvelope(pluginPayload({ execution_id: 'e'.repeat(1000) }))).toBeNull();
  });

  it('PLG-29 #4: resource/value ride ONLY on a grant envelope + must be well-formed', () => {
    // Valid on a grant envelope.
    expect(
      parsePluginEnvelope(
        pluginPayload({
          authorization_kind: 'grant',
          grant_id: 'plg_x',
          resource: 'restaurant:luigi',
          value: 50,
        }),
      ),
    ).not.toBeNull();
    // Rejected on a card/absent envelope (reverse coherence — unverifiable there).
    expect(
      parsePluginEnvelope(pluginPayload({ authorization_kind: 'card', resource: 'r' })),
    ).toBeNull();
    expect(parsePluginEnvelope(pluginPayload({ value: 5 }))).toBeNull();
    // A non-finite value is refused even under a grant.
    expect(
      parsePluginEnvelope(
        pluginPayload({ authorization_kind: 'grant', grant_id: 'plg_x', value: 'lots' }),
      ),
    ).toBeNull();
  });
});

describe('round-20 (PLG-30) hardening', () => {
  it('#16: schema_snapshot cap counts UTF-8 BYTES, not UTF-16 units', () => {
    // 50k CJK chars: UTF-16 length ~50k (< 128 KB) but UTF-8 ~150 KB (> 128 KB).
    // The old `.length` check let this through; the byte cap rejects it.
    const big = { x: '\u4e2d'.repeat(50000) };
    expect(JSON.stringify(big).length).toBeLessThan(128 * 1024); // UTF-16 under cap
    expect(parsePluginEnvelope(pluginPayload({ schema_snapshot: big }))).toBeNull();
    // A small multi-byte snapshot still parses.
    expect(
      parsePluginEnvelope(pluginPayload({ schema_snapshot: { x: '\u4e2d\u6587' } })),
    ).not.toBeNull();
  });
});
