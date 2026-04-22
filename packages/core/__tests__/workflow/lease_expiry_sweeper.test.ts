/**
 * LeaseExpirySweeper tests — OPENCLAW-002.
 *
 * Covers: construction validation, single-tick mechanics (empty result,
 * observers fire per reverted task, observer errors are isolated,
 * repository errors surface via onError), start/stop lifecycle
 * (immediate tick, recurring tick, idempotency), and end-to-end
 * integration with `InMemoryWorkflowRepository.expireLeasedTasks`.
 */

import {
  LeaseExpirySweeper,
  type LeaseExpirySweepResult,
} from '../../src/workflow/lease_expiry_sweeper';
import { InMemoryWorkflowRepository, type WorkflowRepository } from '../../src/workflow/repository';
import type { WorkflowTask } from '../../src/workflow/domain';

/** Deterministic interval scheduler — tests advance time explicitly. */
function fakeScheduler() {
  let nextHandle = 1;
  const timers = new Map<number, { everyMs: number; fn: () => void; nextFireMs: number }>();
  let nowMs = 1_700_000_000_000;

  return {
    nowMs: () => nowMs,
    setInterval: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { everyMs: ms, fn, nextFireMs: nowMs + ms });
      return handle as unknown;
    },
    clearInterval: (h: unknown) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      nowMs += ms;
      let anyFired = true;
      while (anyFired) {
        anyFired = false;
        for (const [, t] of timers) {
          if (t.nextFireMs <= nowMs) {
            t.fn();
            t.nextFireMs += t.everyMs;
            anyFired = true;
          }
        }
      }
    },
  };
}

/** Create an in-memory repo pre-seeded with a running delegation task. */
function seedRunningDelegation(
  repo: WorkflowRepository,
  id: string,
  leaseExpiresAt: number,
  agentDID = 'did:plc:agent-a',
): void {
  const task: WorkflowTask = {
    id,
    kind: 'delegation',
    status: 'running',
    priority: 'normal',
    description: '',
    payload: '{}',
    result_summary: '',
    policy: '{}',
    agent_did: agentDID,
    lease_expires_at: leaseExpiresAt,
    created_at: 0,
    updated_at: 0,
  };
  repo.create(task);
}

describe('LeaseExpirySweeper — construction', () => {
  it('rejects missing repository', () => {
    expect(
      () =>
        new LeaseExpirySweeper({
          repository: undefined as unknown as WorkflowRepository,
        }),
    ).toThrow(/repository/);
  });

  it('rejects non-positive intervalMs', () => {
    const repo = new InMemoryWorkflowRepository();
    expect(() => new LeaseExpirySweeper({ repository: repo, intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => new LeaseExpirySweeper({ repository: repo, intervalMs: -1 })).toThrow(
      /intervalMs/,
    );
  });
});

describe('LeaseExpirySweeper.runTick', () => {
  it('returns empty result when no leases are expired', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    // Task's lease is still in the future — nothing to revert.
    seedRunningDelegation(repo, 'd-1', sched.nowMs() + 30_000);
    const sweeper = new LeaseExpirySweeper({ repository: repo, nowMsFn: sched.nowMs });

    const result = await sweeper.runTick();
    expect(result.reverted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    // Task is still running, lease still set.
    const t = repo.getById('d-1');
    expect(t?.status).toBe('running');
    expect(t?.lease_expires_at).toBeDefined();
  });

  it('reverts tasks whose lease has expired and returns them', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    seedRunningDelegation(repo, 'd-expired', sched.nowMs() - 1_000);
    seedRunningDelegation(repo, 'd-fresh', sched.nowMs() + 60_000);
    const sweeper = new LeaseExpirySweeper({ repository: repo, nowMsFn: sched.nowMs });

    const result = await sweeper.runTick();
    expect(result.reverted.map((t) => t.id)).toEqual(['d-expired']);
    expect(repo.getById('d-expired')?.status).toBe('queued');
    expect(repo.getById('d-expired')?.agent_did).toBeUndefined();
    expect(repo.getById('d-expired')?.lease_expires_at).toBeUndefined();
    // Fresh task untouched.
    expect(repo.getById('d-fresh')?.status).toBe('running');
  });

  it('fires onReverted exactly once per reverted task', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    seedRunningDelegation(repo, 'a', sched.nowMs() - 5_000, 'did:plc:agent-a');
    seedRunningDelegation(repo, 'b', sched.nowMs() - 5_000, 'did:plc:agent-b');
    seedRunningDelegation(repo, 'c', sched.nowMs() + 60_000);

    const observed: Array<{ id: string; priorAgent?: string }> = [];
    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      onReverted: (t) => observed.push({ id: t.id, priorAgent: t.agent_did }),
    });

    await sweeper.runTick();
    // Repository returns reverted tasks with agent_did already cleared, so
    // that's what the observer sees. The `lease_expired` audit event still
    // carries the prior agent for diagnostics.
    expect(observed).toEqual([
      { id: 'a', priorAgent: undefined },
      { id: 'b', priorAgent: undefined },
    ]);
  });

  it('isolates observer errors — sweep continues + surfaces via onError', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    seedRunningDelegation(repo, 'a', sched.nowMs() - 1_000);
    seedRunningDelegation(repo, 'b', sched.nowMs() - 1_000);
    const errors: unknown[] = [];
    const seen: string[] = [];
    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      onReverted: (t) => {
        seen.push(t.id);
        if (t.id === 'a') throw new Error('observer crashed');
      },
      onError: (err) => errors.push(err),
    });

    const result = await sweeper.runTick();
    // Both tasks were still observed — observer error for `a` did not
    // short-circuit the loop.
    expect(seen).toEqual(['a', 'b']);
    expect(result.reverted.map((t) => t.id)).toEqual(['a', 'b']);
    expect(result.errors).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('observer crashed');
  });

  it('surfaces repository errors via onError and returns empty reverted list', async () => {
    const sched = fakeScheduler();
    const repo: WorkflowRepository = {
      ...new InMemoryWorkflowRepository(),
      expireLeasedTasks: () => {
        throw new Error('db locked');
      },
    } as unknown as WorkflowRepository;

    const errors: unknown[] = [];
    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      onError: (err) => errors.push(err),
    });

    const result = await sweeper.runTick();
    expect(result.reverted).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('db locked');
  });

  it('invokes repository.expireLeasedTasks with the sweeper clock', async () => {
    const sched = fakeScheduler();
    const seenNow: number[] = [];
    const repo: WorkflowRepository = {
      ...new InMemoryWorkflowRepository(),
      expireLeasedTasks: (nowMs: number) => {
        seenNow.push(nowMs);
        return [];
      },
    } as unknown as WorkflowRepository;

    const sweeper = new LeaseExpirySweeper({ repository: repo, nowMsFn: sched.nowMs });
    await sweeper.runTick();
    expect(seenNow).toEqual([sched.nowMs()]);
  });
});

describe('LeaseExpirySweeper — start / stop lifecycle', () => {
  it('fires an immediate tick on start()', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    seedRunningDelegation(repo, 'd-1', sched.nowMs() - 1_000);
    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });

    sweeper.start();
    await sweeper.flush();
    expect(repo.getById('d-1')?.status).toBe('queued');
    sweeper.stop();
  });

  it('fires subsequent ticks every intervalMs', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    const ticks: LeaseExpirySweepResult[] = [];
    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      intervalMs: 60_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
      onReverted: (t) => ticks.push({ reverted: [t], errors: [] }),
    });

    sweeper.start();
    await sweeper.flush();
    // No tasks yet — nothing reverted.
    expect(ticks).toHaveLength(0);

    // Expire a task mid-cycle, then advance exactly one interval.
    seedRunningDelegation(repo, 'd-a', sched.nowMs() - 1_000);
    sched.advance(60_000);
    await sweeper.flush();
    expect(ticks.map((t) => t.reverted[0].id)).toEqual(['d-a']);

    seedRunningDelegation(repo, 'd-b', sched.nowMs() - 1_000);
    sched.advance(60_000);
    await sweeper.flush();
    expect(ticks.map((t) => t.reverted[0].id)).toEqual(['d-a', 'd-b']);

    sweeper.stop();
  });

  it('start is idempotent — second call does not spawn a second interval', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    let tickCount = 0;
    const origExpire = repo.expireLeasedTasks.bind(repo);
    repo.expireLeasedTasks = (nowMs: number) => {
      tickCount += 1;
      return origExpire(nowMs);
    };

    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      intervalMs: 60_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });

    sweeper.start();
    sweeper.start();
    await sweeper.flush();
    sched.advance(60_000);
    await sweeper.flush();
    // 1 immediate tick + 1 interval tick = 2, not 3 or 4.
    expect(tickCount).toBe(2);
    sweeper.stop();
  });

  it('stop prevents future ticks', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    let tickCount = 0;
    const origExpire = repo.expireLeasedTasks.bind(repo);
    repo.expireLeasedTasks = (nowMs: number) => {
      tickCount += 1;
      return origExpire(nowMs);
    };

    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      intervalMs: 60_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });

    sweeper.start();
    await sweeper.flush();
    sweeper.stop();
    sched.advance(60_000);
    await sweeper.flush();
    expect(tickCount).toBe(1); // only the immediate tick
  });

  it('stop is idempotent', () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    const sweeper = new LeaseExpirySweeper({
      repository: repo,
      nowMsFn: sched.nowMs,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    sweeper.start();
    sweeper.stop();
    expect(() => sweeper.stop()).not.toThrow();
  });
});

describe('LeaseExpirySweeper — end-to-end with InMemoryWorkflowRepository', () => {
  it('reverted task is reclaimable by a different agent on the next claim', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    seedRunningDelegation(repo, 'del-1', sched.nowMs() - 1_000, 'did:plc:agent-a');
    const sweeper = new LeaseExpirySweeper({ repository: repo, nowMsFn: sched.nowMs });

    await sweeper.runTick();
    expect(repo.getById('del-1')?.status).toBe('queued');

    // Fresh agent reclaims after the revert — the whole point of the sweeper.
    const claimed = repo.claimDelegationTask('did:plc:agent-b', sched.nowMs(), 30_000);
    expect(claimed?.id).toBe('del-1');
    expect(claimed?.agent_did).toBe('did:plc:agent-b');
  });

  it('appends a `lease_expired` audit event per reverted task', async () => {
    const sched = fakeScheduler();
    const repo = new InMemoryWorkflowRepository();
    seedRunningDelegation(repo, 'del-1', sched.nowMs() - 1_000, 'did:plc:agent-a');
    const sweeper = new LeaseExpirySweeper({ repository: repo, nowMsFn: sched.nowMs });

    await sweeper.runTick();
    const events = repo.listEventsForTask('del-1');
    const leaseExpired = events.filter((e) => e.event_kind === 'lease_expired');
    expect(leaseExpired).toHaveLength(1);
    const details = JSON.parse(leaseExpired[0].details) as { previous_agent_did: string };
    expect(details.previous_agent_did).toBe('did:plc:agent-a');
  });
});
