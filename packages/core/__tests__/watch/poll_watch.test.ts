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
