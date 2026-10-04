/**
 * One reserved-lane rule (A2A plan §4.2a): trimmed, without ASCII case, and
 * a reserved prefix with nothing after it counts. The create route, the
 * save, the ingress and both task stores' generic claims agree on it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { isReservedLane, namesReservedLane } from '../../src/service/reserved_lanes';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository, SQLiteWorkflowRepository, type WorkflowRepository } from '../../src/workflow/repository';

const LOOKALIKES = ['dina.local', 'DINA.LOCAL', ' dina.local ', 'plugin:x', 'PLUGIN:x', 'plugin:', 'a2a:r', 'A2A:r', 'a2a:', 'reasoning:claude', 'Reasoning:', 'reasoning:'];

describe('the rule', () => {
  it.each(LOOKALIKES)('%j is reserved', (lane) => {
    expect(isReservedLane(lane)).toBe(true);
    expect(namesReservedLane({ responsePolicy: 'auto', mcpServer: lane, mcpTool: 't' })).toBe(true);
  });

  it.each(['transit', 'dina.localx', 'plugins', 'a2a', 'my-plugin:x'])('%j is not', (lane) => {
    expect(isReservedLane(lane)).toBe(false);
  });
});

describe('both stores’ generic claims take no reserved lane', () => {
  let dir: string;
  let db: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'reserved-lanes-'));
    db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'dd'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
    applyMigrations(db, IDENTITY_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(repo: WorkflowRepository): void {
    LOOKALIKES.forEach((lane, i) =>
      repo.create({
        id: `t-${i}`,
        kind: 'delegation',
        status: 'queued',
        priority: 'normal',
        description: '',
        payload: '{}',
        result_summary: '',
        policy: '{}',
        requested_runner: lane,
        created_at: i,
        updated_at: i,
      }),
    );
  }

  it.each([
    ['SQLite', () => new SQLiteWorkflowRepository(db)],
    ['in-memory', () => new InMemoryWorkflowRepository()],
  ] as const)('%s', (_name, make) => {
    const repo = make();
    seed(repo);
    expect(repo.claimDelegationTask('did:key:agent', 30_000, 1_000, '')).toBeNull();
  });
});
