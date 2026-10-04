/**
 * The requeue observer (A2A design §7.5): told of each task a lapsed lease
 * returns to the queue, inside the move; one slot that the next service
 * replaces; an observer that throws never undoes or blocks the requeue.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  type WorkflowRepository,
} from '../../src/workflow/repository';
import {
  WorkflowService,
  composeWorkflowHooks,
  type WorkflowHooks,
} from '../../src/workflow/service';

import type { WorkflowTask } from '../../src/workflow/domain';

const NOW = 1_800_000_000_000;

function running(id: string, leaseExpiresAt: number): WorkflowTask {
  return {
    id,
    kind: 'delegation',
    status: 'running',
    priority: 'normal',
    description: '',
    payload: '{}',
    result_summary: '',
    policy: '{}',
    agent_did: 'did:key:agent',
    lease_expires_at: leaseExpiresAt,
    created_at: 0,
    updated_at: 0,
  };
}

const repos: [string, () => { repo: WorkflowRepository; close: () => void }][] = [
  ['in memory', () => ({ repo: new InMemoryWorkflowRepository(), close: () => undefined })],
  [
    'SQLite',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'requeue-'));
      const db = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(db, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteWorkflowRepository(db),
        close: () => {
          db.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

describe.each(repos)('%s repository', (_name, make) => {
  let repo: WorkflowRepository;
  let close: () => void;
  beforeEach(() => {
    ({ repo, close } = make());
  });
  afterEach(() => close());

  it('tells the observer of each requeued task, after the move, once', () => {
    repo.create(running('lapsed', NOW - 1));
    repo.create(running('alive', NOW + 60_000));
    const seen: { id: string; stored: string | undefined }[] = [];
    repo.observeRequeues((task) =>
      seen.push({ id: task.id, stored: repo.getById(task.id)?.status }),
    );
    expect(repo.expireLeasedTasks(NOW).map((t) => t.id)).toEqual(['lapsed']);
    expect(seen).toEqual([{ id: 'lapsed', stored: 'queued' }]);
  });

  it('an observer that throws does not undo the requeue', () => {
    repo.create(running('lapsed', NOW - 1));
    repo.observeRequeues(() => {
      throw new Error('observer bug');
    });
    expect(repo.expireLeasedTasks(NOW)).toHaveLength(1);
    expect(repo.getById('lapsed')?.status).toBe('queued');
  });

  it('one slot: the next observer replaces the last, and null clears it', () => {
    const first = jest.fn();
    const second = jest.fn();
    repo.observeRequeues(first);
    repo.observeRequeues(second);
    repo.create(running('a', NOW - 1));
    repo.expireLeasedTasks(NOW);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    repo.observeRequeues(null);
    repo.create(running('b', NOW - 1));
    repo.expireLeasedTasks(NOW);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('the workflow service installs a feature’s observer', () => {
  it('a service given one installs it; a service built without one leaves it in place', () => {
    const repo = new InMemoryWorkflowRepository();
    const observed = jest.fn();
    new WorkflowService({ repository: repo, onTaskRequeued: observed });
    new WorkflowService({ repository: repo });
    repo.create(running('a', NOW - 1));
    repo.expireLeasedTasks(NOW);
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('composed hooks tell every feature that observes, and one throw stops no other', () => {
    const quiet: WorkflowHooks = {
      responseEgressGate: () => ({ kind: 'passthrough' }),
      approvalDecisionHandler: () => undefined,
    };
    const told = jest.fn();
    const hooks = composeWorkflowHooks(
      quiet,
      {
        ...quiet,
        onTaskRequeued: () => {
          throw new Error('x');
        },
      },
      { ...quiet, onTaskRequeued: told },
    );
    hooks.onTaskRequeued?.(running('a', 0));
    expect(told).toHaveBeenCalledTimes(1);
  });
});
