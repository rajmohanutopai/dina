/**
 * PSVC-0 — poll-mode watch: WatchService lifecycle + WatchPollSweeper fire loop
 * (PUSH_SERVICES_ARCHITECTURE.md Phase 0 / §3.2; DINA_WORKFLOW_CONTROL_PLANE §6).
 *
 * Runs the full contract against BOTH the InMemory workflow repo (Map) and the
 * real SQLite engine (`NodeSQLiteAdapter` + the v3 workflow_tasks migration) so
 * the net-new `setWatchNextRun` SQL and its InMemory parity are validated.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { parseWatchPollPayload } from '../../src/watch/payload';
import { WatchPollSweeper, type WatchPollHandler } from '../../src/watch/poll_sweeper';
import { WatchService, type CreatePollWatchInput } from '../../src/watch/service';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../../src/workflow/domain';
import {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  type WorkflowRepository,
} from '../../src/workflow/repository';

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const INTERVAL_SEC = 300;

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected non-null');
  return v;
}

function input(over: Partial<CreatePollWatchInput> = {}): CreatePollWatchInput {
  return {
    subscription_id: 'sub-1',
    persona: 'general',
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    capability: 'flight_status',
    query: { flight: 'BA117' },
    poll_interval_sec: INTERVAL_SEC,
    ...over,
  };
}

function runSuite(label: string, makeRepo: () => WorkflowRepository): void {
  describe(label, () => {
    let repo: WorkflowRepository;
    let clockMs: number;
    const svc = (): WatchService =>
      new WatchService({ repository: repo, nowMsFn: () => clockMs });

    beforeEach(() => {
      repo = makeRepo();
      clockMs = NOW_MS;
    });

    describe('WatchService', () => {
      it('creates a running watch scheduled one interval out', () => {
        const w = svc().createPollWatch(input());
        expect(w.kind).toBe(WorkflowTaskKind.Watch);
        expect(w.status).toBe(WorkflowTaskState.Running);
        expect(w.next_run_at).toBe(NOW_SEC + INTERVAL_SEC);
        const payload = need(parseWatchPollPayload(w.payload));
        expect(payload.subscription_id).toBe('sub-1');
        expect(payload.persona).toBe('general');
        expect(payload.poll_interval_sec).toBe(INTERVAL_SEC);
      });

      it('create is idempotent on subscription_id (returns the live watch)', () => {
        const a = svc().createPollWatch(input());
        const b = svc().createPollWatch(input({ capability: 'DIFFERENT' }));
        expect(b.id).toBe(a.id);
        // the original watch is unchanged (no second row, no re-schedule)
        expect(need(parseWatchPollPayload(b.payload)).capability).toBe('flight_status');
        expect(svc().listActive().length).toBe(1);
      });

      it('clamps a sub-floor interval up to the minimum', () => {
        const w = svc().createPollWatch(input({ poll_interval_sec: 1 }));
        expect(need(parseWatchPollPayload(w.payload)).poll_interval_sec).toBeGreaterThanOrEqual(60);
        expect(need(w.next_run_at)).toBeGreaterThan(NOW_SEC + 1);
      });

      it('pause clears next_run_at; resume reschedules; cancel is terminal', () => {
        const w = svc().createPollWatch(input());
        expect(svc().pause(w.id)).toBe(true);
        expect(need(repo.getById(w.id)).next_run_at ?? 0).toBe(0);

        clockMs = NOW_MS + 60_000;
        expect(svc().resume(w.id)).toBe(true);
        expect(repo.getById(w.id)?.next_run_at).toBe(Math.floor(clockMs / 1000) + INTERVAL_SEC);

        expect(svc().cancel(w.id)).toBe(true);
        expect(repo.getById(w.id)?.status).toBe(WorkflowTaskState.Cancelled);
        // pause/resume/cancel on a cancelled watch are all no-ops
        expect(svc().pause(w.id)).toBe(false);
        expect(svc().resume(w.id)).toBe(false);
        expect(svc().cancel(w.id)).toBe(false);
      });

      it('re-creating a watch for a subscription after cancel succeeds (fresh row, no PK collision)', () => {
        const first = svc().createPollWatch(input());
        expect(svc().cancel(first.id)).toBe(true);
        // A resubscribe reuses the terminal row's natural key; the task PK is
        // decoupled (random), so create mints a NEW running watch, not a throw.
        const second = svc().createPollWatch(input());
        expect(second.id).not.toBe(first.id);
        expect(second.status).toBe(WorkflowTaskState.Running);
        expect(svc().listActive().map((t) => t.id)).toEqual([second.id]);
      });

      it('createPollWatch round-trips the wake filter into the payload (R2-04)', () => {
        const w = svc().createPollWatch(input({ filter: { contains: 'delayed' } }));
        expect(need(parseWatchPollPayload(w.payload)).filter).toEqual({ contains: 'delayed' });
      });

      it('deliveryPolicyFor: fails CLOSED for an unknown subscription (R3-02)', () => {
        // No watch created → exact idempotency-key lookup misses → suppress.
        expect(svc().deliveryPolicyFor('never-created')).toEqual({ active: false });
      });

      it('deliveryPolicyFor: an active watch is {active:true} and carries its filter (R3-02/R2-04)', () => {
        svc().createPollWatch(input({ filter: { contains: 'delayed' } }));
        expect(svc().deliveryPolicyFor('sub-1')).toEqual({ active: true, filter: { contains: 'delayed' } });
      });

      it('deliveryPolicyFor: an active UNFILTERED watch omits filter (R3-02)', () => {
        svc().createPollWatch(input());
        expect(svc().deliveryPolicyFor('sub-1')).toEqual({ active: true });
      });

      it('deliveryPolicyFor: a cancelled watch reverts to {active:false} — fail closed (R3-02)', () => {
        const w = svc().createPollWatch(input({ filter: { contains: 'delayed' } }));
        expect(svc().deliveryPolicyFor('sub-1')).toEqual({ active: true, filter: { contains: 'delayed' } });
        svc().cancel(w.id);
        // A delivery arriving after cancel must NOT fire-always; it fails closed.
        expect(svc().deliveryPolicyFor('sub-1')).toEqual({ active: false });
      });

      it('deliveryPolicyFor: a PAUSED watch reports inactive — a late response is suppressed (R4-04)', () => {
        const w = svc().createPollWatch(input({ filter: { contains: 'delayed' } }));
        svc().pause(w.id);
        expect(svc().deliveryPolicyFor('sub-1')).toEqual({ active: false });
        // resume restores the active policy (with its filter)
        clockMs = NOW_MS + 60_000;
        svc().resume(w.id);
        expect(svc().deliveryPolicyFor('sub-1')).toEqual({ active: true, filter: { contains: 'delayed' } });
      });

      it('setWatchNextRun never perturbs a non-watch task', () => {
        // A delegation whose retry-backoff next_run_at must not be touchable.
        const deleg: WorkflowTask = {
          id: 'deleg-1',
          kind: WorkflowTaskKind.Delegation,
          status: WorkflowTaskState.Running,
          priority: 'normal',
          description: 'x',
          payload: '{}',
          result_summary: '',
          policy: '{}',
          next_run_at: NOW_SEC + 999,
          created_at: NOW_MS,
          updated_at: NOW_MS,
        };
        repo.create(deleg);
        expect(repo.setWatchNextRun('deleg-1', 5, NOW_MS)).toBe(false);
        expect(repo.getById('deleg-1')?.next_run_at).toBe(NOW_SEC + 999);
      });
    });

    describe('WatchPollSweeper', () => {
      function sweeper(onPoll?: WatchPollHandler, over: Partial<{ onError: (e: unknown) => void }> = {}) {
        return new WatchPollSweeper({
          repository: repo,
          onPoll,
          nowMsFn: () => clockMs,
          ...over,
        });
      }

      it('fires a due watch through onPoll and reschedules one interval out', async () => {
        const w = svc().createPollWatch(input());
        const seen: string[] = [];
        const sw = sweeper((task, payload) => {
          seen.push(`${task.id}:${payload.capability}`);
        });

        // not yet due
        expect((await sw.runTick()).polled).toHaveLength(0);
        expect(seen).toHaveLength(0);

        // advance past the cadence → fires once, reschedules
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000;
        const r = await sw.runTick();
        expect(r.polled.map((t) => t.id)).toEqual([w.id]);
        expect(seen).toEqual([`${w.id}:flight_status`]);
        const after = need(repo.getById(w.id));
        expect(after.next_run_at).toBe(Math.floor(clockMs / 1000) + INTERVAL_SEC);

        // immediately re-ticking does not double-fire (rescheduled into the future)
        expect((await sw.runTick()).polled).toHaveLength(0);
      });

      it('never fires a paused watch (next_run_at null)', async () => {
        const w = svc().createPollWatch(input());
        svc().pause(w.id);
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000;
        const seen: string[] = [];
        const r = await sweeper((t) => void seen.push(t.id)).runTick();
        expect(r.polled).toHaveLength(0);
        expect(seen).toHaveLength(0);
      });

      it('never fires a cancelled watch', async () => {
        const w = svc().createPollWatch(input());
        svc().cancel(w.id);
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000;
        const seen: string[] = [];
        const r = await sweeper((t) => void seen.push(t.id)).runTick();
        expect(r.polled).toHaveLength(0);
        expect(seen).toHaveLength(0);
      });

      it('reschedules on now, not on the stale deadline (no backlog burst after downtime)', async () => {
        const w = svc().createPollWatch(input());
        // asleep for many intervals
        clockMs = NOW_MS + INTERVAL_SEC * 10 * 1000;
        let fires = 0;
        const sw = sweeper(() => void fires++);
        await sw.runTick();
        expect(fires).toBe(1); // ONE fire on wake, not ten
        expect(need(repo.getById(w.id)).next_run_at).toBe(Math.floor(clockMs / 1000) + INTERVAL_SEC);
      });

      it('is single-flight: timer fires during a slow poll coalesce onto one tick (81B-08)', async () => {
        svc().createPollWatch(input());
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000; // due
        let invocations = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const timer: { fire: (() => void) | null } = { fire: null };
        const sw = new WatchPollSweeper({
          repository: repo,
          nowMsFn: () => clockMs,
          onPoll: async () => {
            invocations++;
            await gate; // hold the poll open so overlapping fires can be observed
          },
          setInterval: (fn) => {
            timer.fire = fn;
            return 1 as unknown as ReturnType<typeof setInterval>;
          },
          clearInterval: () => {
            /* no-op for the fake timer */
          },
        });

        sw.start(); // first tick starts + blocks in onPoll #1
        await Promise.resolve();
        expect(invocations).toBe(1);
        // Two more timer fires WHILE the first poll is unresolved → must coalesce.
        timer.fire?.();
        timer.fire?.();
        await Promise.resolve();
        expect(invocations).toBe(1); // single-flight — no overlapping second poll

        release(); // unblock the in-flight poll
        await sw.flush(); // drains to quiescence (teardown contract)
      });

      it('an onPoll throw is isolated and the watch is STILL rescheduled (never wedged)', async () => {
        const w = svc().createPollWatch(input());
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000;
        const errors: unknown[] = [];
        const sw = sweeper(
          () => {
            throw new Error('send failed');
          },
          { onError: (e) => errors.push(e) },
        );
        const r = await sw.runTick();
        expect(r.polled).toHaveLength(0); // the fire failed
        expect(errors).toHaveLength(1);
        // but the watch was rescheduled, so the next interval retries
        expect(need(repo.getById(w.id)).next_run_at).toBe(Math.floor(clockMs / 1000) + INTERVAL_SEC);
      });

      it('R4-04: a pause during an in-flight poll is NOT undone by the post-poll reschedule', async () => {
        const w = svc().createPollWatch(input());
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000; // due
        // The owner pauses WHILE the poll is in flight (the classic race).
        const sw = sweeper(() => {
          svc().pause(w.id);
        });
        await sw.runTick();
        // The reschedule CAS is anchored on the value the tick fired; the pause
        // cleared next_run_at in the interim, so the CAS misses and the pause holds.
        expect(need(repo.getById(w.id)).next_run_at ?? 0).toBe(0);
        // And it stays paused on the next tick (never silently resumes).
        expect((await sw.runTick()).polled).toHaveLength(0);
      });

      it('R4-05: a due watch fires even when the batch page is full of paused/future watches', async () => {
        // Codex R4-05: the old sweeper fetched the oldest N running rows by
        // created_at then filtered due AFTER, so paused/future rows inside that
        // fixed page permanently hid later due watches. Create batchLimit paused
        // watches BEFORE the due one; with a due-time query the due watch fires.
        const s = svc();
        for (let i = 0; i < 5; i += 1) {
          const p = s.createPollWatch(input({ subscription_id: `paused-${i}` }));
          s.pause(p.id); // next_run_at cleared → excluded from the due query
        }
        const dueWatch = s.createPollWatch(input({ subscription_id: 'due-1' }));
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000;
        const seen: string[] = [];
        const sw = new WatchPollSweeper({
          repository: repo,
          onPoll: (t) => void seen.push(t.id),
          nowMsFn: () => clockMs,
          batchLimit: 5, // a created_at page of 5 would be ALL the paused watches
        });
        const r = await sw.runTick();
        expect(seen).toEqual([dueWatch.id]);
        expect(r.polled.map((t) => t.id)).toEqual([dueWatch.id]);
      });

      it('skips (does not fire) a malformed-payload watch and reports it', async () => {
        // A due watch row whose payload is corrupt (a foreign/legacy row) must
        // be reported + skipped, never fired.
        const badWatch: WorkflowTask = {
          id: 'watch-bad',
          kind: WorkflowTaskKind.Watch,
          status: WorkflowTaskState.Running,
          priority: 'background',
          description: 'corrupt',
          payload: 'not-json',
          result_summary: '',
          policy: '{}',
          idempotency_key: 'watch:bad',
          next_run_at: NOW_SEC, // already due
          created_at: NOW_MS,
          updated_at: NOW_MS,
        };
        repo.create(badWatch);
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000;
        const skipped: string[] = [];
        const fired: string[] = [];
        const r = await new WatchPollSweeper({
          repository: repo,
          onPoll: (t) => void fired.push(t.id),
          nowMsFn: () => clockMs,
          onMalformed: (t) => skipped.push(t.id),
        }).runTick();
        expect(r.skipped.map((t) => t.id)).toEqual(['watch-bad']);
        expect(skipped).toEqual(['watch-bad']);
        expect(fired).not.toContain('watch-bad');
      });

      it('R5-06: a malformed batch at the head does NOT permanently starve a later valid due watch', async () => {
        // Two malformed rows due EARLIER than the valid watch; batchLimit 2 so a
        // single tick's due page is entirely malformed. Without pausing them they
        // would re-occupy the head every tick and the valid watch would never fire.
        const mkBad = (id: string, dueSec: number): void => {
          const bad: WorkflowTask = {
            id,
            kind: WorkflowTaskKind.Watch,
            status: WorkflowTaskState.Running,
            priority: 'background',
            description: 'corrupt',
            payload: 'not-json',
            result_summary: '',
            policy: '{}',
            idempotency_key: `watch:${id}`,
            next_run_at: dueSec,
            created_at: NOW_MS,
            updated_at: NOW_MS,
          };
          repo.create(bad);
        };
        mkBad('bad-1', NOW_SEC);
        mkBad('bad-2', NOW_SEC + 1);
        const good = svc().createPollWatch(input({ subscription_id: 'good' })); // due latest
        clockMs = NOW_MS + (INTERVAL_SEC + 1) * 1000;
        const seen: string[] = [];
        const sweep = (): WatchPollSweeper =>
          new WatchPollSweeper({
            repository: repo,
            onPoll: (t) => void seen.push(t.id),
            nowMsFn: () => clockMs,
            batchLimit: 2,
          });

        await sweep().runTick(); // page = [bad-1, bad-2] → both paused; good not reached
        expect(seen).toHaveLength(0);
        expect(need(repo.getById('bad-1')).next_run_at ?? 0).toBe(0); // paused out of the due query
        expect(need(repo.getById('bad-2')).next_run_at ?? 0).toBe(0);

        await sweep().runTick(); // the valid watch is now at the head → it fires
        expect(seen).toEqual([good.id]);
      });
    });
  });
}

runSuite('InMemory', () => new InMemoryWorkflowRepository());

describe('SQLite', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  runSuite('engine', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'psvc0-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    return new SQLiteWorkflowRepository(adapter);
  });
  afterEach(() => {
    adapter?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
