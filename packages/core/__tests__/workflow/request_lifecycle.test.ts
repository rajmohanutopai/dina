/**
 * REQ-06, REQ-07, REQ-12, REQ-13, REQ-18: retries with a bound and an order, on
 * the SQLite repository both hosts use.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { LocalDelegationRunner } from '../../src/workflow/local_delegation_runner';
import { SQLiteWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const AGENT = 'did:plc:agent';

function openDB(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-wf-life-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return adapter;
}

type Sender = ConstructorParameters<typeof WorkflowService>[0]['responseBridgeSender'];

function wire(sender?: Sender): { repo: SQLiteWorkflowRepository; service: WorkflowService } {
  const repo = new SQLiteWorkflowRepository(openDB());
  setWorkflowRepository(repo);
  const service = new WorkflowService({ repository: repo, ...(sender ? { responseBridgeSender: sender } : {}) });
  setWorkflowService(service);
  return { repo, service };
}

const execPayload = (from: string, query: string, capability = 'eta_query', ttl = 60): string =>
  JSON.stringify({
    type: 'service_query_execution',
    from_did: from,
    query_id: query,
    capability,
    params: {},
    ttl_seconds: ttl,
    service_name: 'x',
  });

function delegation(service: WorkflowService, id: string, payload: string, extra: object = {}): void {
  service.create({ id, kind: 'delegation', description: 'd', payload, initialState: 'queued', ...extra } as never);
}

function runToCompletion(repo: SQLiteWorkflowRepository, service: WorkflowService, id: string): void {
  const claimed = repo.claimDelegationTask(AGENT, Date.now(), 60_000)!;
  expect(claimed.id).toBe(id);
  service.complete(claimed.id, '{"ok":true}', 'done', AGENT, claimed.claim_id);
}

const stashOf = (repo: SQLiteWorkflowRepository, id: string): string =>
  repo.getById(id)?.internal_stash ?? '';

describe('REQ-06: bridge retries', () => {
  it('a full batch of dead stashes does not starve the next answer', async () => {
    const sent: string[] = [];
    let healthy = false;
    const sender: Sender = async (ctx) => {
      sent.push(ctx.taskId);
      if (ctx.fromDID.startsWith('did:plc:dead') || !healthy) throw new Error('send refused');
    };
    const { repo, service } = wire(sender);
    for (let i = 0; i < 4; i += 1) {
      const id = `t${i}`;
      delegation(service, id, execPayload(i < 3 ? `did:plc:dead${i}` : 'did:plc:live', `q-${id}`));
      runToCompletion(repo, service, id);
      await new Promise((r) => setTimeout(r, 2));
    }
    await service.flushBridgeInFlight();
    healthy = true;
    sent.length = 0;

    // A batch of 3 against 3 dead stashes, as 50 against 50 in production.
    await service.retryPendingBridges(3);
    await service.retryPendingBridges(3);

    expect(sent).toContain('t3');
    expect(stashOf(repo, 't3')).toBe('');
    expect(stashOf(repo, 't0')).toMatch(/^bridge_pending:/);
  });

  it('a stash past the requester TTL is cleared without a send', async () => {
    const sent: string[] = [];
    let now = 1_000_000_000;
    const repo = new SQLiteWorkflowRepository(openDB());
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => now,
      responseBridgeSender: async (ctx: { taskId: string }) => {
        sent.push(ctx.taskId);
        throw new Error('down');
      },
    });
    delegation(service, 'late', execPayload('did:plc:r', 'q', 'eta_query', 60));
    const claimed = repo.claimDelegationTask(AGENT, now, 60_000)!;
    service.complete(claimed.id, '{"ok":true}', 'done', AGENT, claimed.claim_id);
    await service.flushBridgeInFlight();
    sent.length = 0;

    now += 60 * 1000 + 10 * 60 * 1000;
    await service.retryPendingBridges();

    expect(sent).toEqual([]);
    expect(stashOf(repo, 'late')).toBe('');
  });

  it('a send the egress gate refuses is final: no retry', async () => {
    const sent: string[] = [];
    const { repo, service } = wire(async (ctx) => {
      sent.push(ctx.taskId);
      throw Object.assign(new Error('denied at sharing'), { permanent: true });
    });
    delegation(service, 'denied', execPayload('did:plc:r', 'q'));
    runToCompletion(repo, service, 'denied');
    await service.flushBridgeInFlight();

    expect(stashOf(repo, 'denied')).toBe('');
    await service.retryPendingBridges();
    expect(sent).toEqual(['denied']);
  });
});

describe('REQ-07: lease loss on a delegation', () => {
  const lose = (repo: SQLiteWorkflowRepository, at: number): string | undefined => {
    const claimed = repo.claimDelegationTask(AGENT, at, 10);
    repo.expireLeasedTasks(at + 100);
    return claimed?.id;
  };

  it('a capability the catalog does not mark read never runs twice', () => {
    const { repo, service } = wire();
    delegation(service, 'book', execPayload('did:plc:r', 'q', 'book_table'));
    lose(repo, 1000);
    expect(repo.getById('book')?.status).toBe('outcome_unknown');
    expect(repo.claimDelegationTask(AGENT, 2000, 10)).toBeNull();
  });

  it('a generic delegation requeues to a limit, then fails', () => {
    const { repo, service } = wire();
    service.create({
      id: 'gen',
      kind: 'delegation',
      description: 'd',
      payload: JSON.stringify({ prompt: 'x' }),
      initialState: 'queued',
    } as never);
    let at = 1000;
    let runs = 0;
    while (lose(repo, at) !== undefined) {
      runs += 1;
      at += 1000;
      expect(runs).toBeLessThan(10);
    }
    expect(runs).toBe(3);
    expect(repo.getById('gen')?.status).toBe('failed');
  });

  it('the runner runs a booking once, and keeps the late result as evidence', async () => {
    const { repo, service } = wire();
    service.create({
      id: 'w6',
      kind: 'delegation',
      description: 'd',
      payload: execPayload('did:plc:r', 'q6', 'book_table'),
      initialState: 'queued',
      requestedRunner: 'dina.local',
    } as never);
    let runs = 0;
    let release: () => void = () => undefined;
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: 'did:plc:self',
      leaseMs: 10,
      heartbeatIntervalMs: 1e7,
      onError: () => undefined,
      runner: async () => {
        runs += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return { status: 'success', result: { booked: runs } };
      },
    } as never);
    const tick = runner.runTick();
    await new Promise((r) => setTimeout(r, 30));
    repo.expireLeasedTasks(Date.now() + 100); // the sweep, during a stalled heartbeat
    release();
    await tick;
    await runner.runTick();

    expect(runs).toBe(1);
    expect(repo.getById('w6')?.status).toBe('outcome_unknown');
    const kinds = repo.listEventsForTask('w6').map((e) => e.event_kind);
    expect(kinds).toContain('late_report');
  });

  it('a runner completes with its claim, so a stale run cannot land', async () => {
    const { repo, service } = wire();
    service.create({
      id: 'r1',
      kind: 'delegation',
      description: 'd',
      payload: execPayload('did:plc:r', 'q1'),
      initialState: 'queued',
      requestedRunner: 'dina.local',
    } as never);
    const complete = jest.spyOn(service, 'complete');
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: 'did:plc:self',
      runner: async () => ({ status: 'success', result: {} }),
    } as never);
    await runner.runTick();
    expect(complete).toHaveBeenCalled();
    expect(complete.mock.calls[0]![4]).toBeTruthy();
    expect(repo.getById('r1')?.status).toBe('completed');
  });
});

describe('REQ-12: the bridge record commits with the completion', () => {
  it('a failed stash write and a restart still answer the requester, once', async () => {
    const sent: string[] = [];
    let up = false;
    const sender: Sender = async (ctx) => {
      sent.push(ctx.taskId);
      if (!up) throw new Error('down');
    };
    const { repo, service } = wire(sender);
    delegation(service, 'w4', execPayload('did:plc:r', 'q4'));
    const claimed = repo.claimDelegationTask(AGENT, Date.now(), 60_000)!;
    const spy = jest.spyOn(repo, 'setInternalStash').mockImplementation(() => {
      throw new Error('crash window');
    });
    service.complete('w4', '{"ok":1}', 's', AGENT, claimed.claim_id);
    await service.flushBridgeInFlight();
    spy.mockRestore();
    up = true;
    sent.length = 0;

    const restarted = new WorkflowService({ repository: repo, responseBridgeSender: sender });
    await restarted.retryPendingBridges();
    await restarted.flushBridgeInFlight();
    await restarted.retryPendingBridges();
    await restarted.flushBridgeInFlight();

    expect(sent).toEqual(['w4']);
    expect(stashOf(repo, 'w4')).toBe('');
  });

  it('a crash right after a failure commits: the error reply still goes', async () => {
    const sent: string[] = [];
    const sender: Sender = async (ctx) => {
      sent.push(ctx.resultJSON);
    };
    const repo = new SQLiteWorkflowRepository(openDB());
    const service = new WorkflowService({ repository: repo, responseBridgeSender: sender });
    delegation(service, 'f1', execPayload('did:plc:r', 'qf'));
    const claimed = repo.claimDelegationTask(AGENT, Date.now(), 60_000)!;
    // The commit alone, as if the process died before the service went on.
    repo.fail('f1', AGENT, 'boom', Date.now(), claimed.claim_id, 'bridge_pending:unbuilt');

    const restarted = new WorkflowService({ repository: repo, responseBridgeSender: sender });
    await restarted.retryPendingBridges();
    await restarted.flushBridgeInFlight();

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('an answer the egress gate withholds leaves no record behind', async () => {
    const repo = new SQLiteWorkflowRepository(openDB());
    const sent: string[] = [];
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: async (ctx: { taskId: string }) => {
        sent.push(ctx.taskId);
      },
      responseEgressGate: () => ({ kind: 'withhold', reason: 'test' }),
    } as never);
    delegation(service, 'held', execPayload('did:plc:r', 'qh'));
    const claimed = repo.claimDelegationTask(AGENT, Date.now(), 60_000)!;
    service.complete('held', '{"ok":1}', 's', AGENT, claimed.claim_id);
    await service.flushBridgeInFlight();
    expect(stashOf(repo, 'held')).toBe('');
    await service.retryPendingBridges();
    expect(sent).toEqual([]);
  });
});

describe('REQ-13: a stale completion with no token', () => {
  it('becomes a late report; the newer claim lands', () => {
    const { repo, service } = wire();
    delegation(service, 'w2', execPayload('did:plc:r', 'q2'));
    repo.claimDelegationTask(AGENT, 1000, 10);
    repo.expireLeasedTasks(2000);
    const b = repo.claimDelegationTask(AGENT, 3000, 600_000)!;

    expect(() => service.complete('w2', '{"from":"A-stale"}', 's', AGENT)).toThrow(/claim/);
    expect(() => service.fail('w2', 'A-stale', AGENT)).toThrow(/claim/);
    expect(repo.getById('w2')?.status).toBe('running');
    expect(repo.listEventsForTask('w2').map((e) => e.event_kind)).toContain('late_report');

    service.complete('w2', '{"from":"B"}', 's', AGENT, b.claim_id);
    expect(repo.getById('w2')?.result).toBe('{"from":"B"}');
  });

  it('a Core-side completer, with no agent, is unaffected', () => {
    const { repo, service } = wire();
    delegation(service, 'n2', execPayload('did:plc:r', 'q4'));
    repo.claimDelegationTask(AGENT, Date.now(), 60_000);
    service.fail('n2', 'Core stopped it'); // no agent: not a stale run
    expect(repo.getById('n2')?.status).toBe('failed');
  });
});

describe('REQ-18: cancelling a provider task', () => {
  it('tells the requester, once', async () => {
    const sent: string[] = [];
    const { repo, service } = wire(async (ctx) => {
      sent.push(ctx.resultJSON);
    });
    delegation(service, 'c1', execPayload('did:plc:r', 'q5'));
    service.cancel('c1', 'owner');
    await service.flushBridgeInFlight();

    expect(repo.getById('c1')?.status).toBe('cancelled');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).status).toBe('unavailable');
    expect(stashOf(repo, 'c1')).toBe('');
  });

  it('a task that is no service execution sends nothing', async () => {
    const sent: string[] = [];
    const { service } = wire(async (ctx) => {
      sent.push(ctx.taskId);
    });
    service.create({
      id: 'plain',
      kind: 'delegation',
      description: 'd',
      payload: JSON.stringify({ prompt: 'x' }),
      initialState: 'queued',
    } as never);
    service.cancel('plain', 'owner');
    await service.flushBridgeInFlight();
    expect(sent).toEqual([]);
  });
});
