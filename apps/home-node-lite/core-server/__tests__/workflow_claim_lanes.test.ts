/**
 * Cross-implementation CONTRACT test for delegation-claim runner routing —
 * the same scenarios run against the REAL SQLite-backed
 * `SQLiteWorkflowRepository` (better-sqlite3 via `NodeSQLiteAdapter`, the
 * thing production actually executes) AND the `InMemoryWorkflowRepository`
 * twin that packages/core's unit tests use.
 *
 * Why here: packages/core's jest only exercises the in-memory twin (its
 * `InMemoryDatabaseAdapter` can't run SELECTs), so SQL-only drift in the
 * claim WHERE-clause was previously invisible to every suite. This file is
 * the drift gate.
 *
 * Lane rules under test (docs/SERVICE_PROVIDER_TIERS.md):
 *   - '' (claim-any)        → any task EXCEPT requested_runner='dina.local'
 *   - non-empty filter      → unset/'' requested_runner OR exact match
 *   - 'dina.local' filter   → its own lane (plus unset, like any filter)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SQLiteWorkflowRepository,
  InMemoryWorkflowRepository,
  IDENTITY_MIGRATIONS,
  applyMigrations,
  type WorkflowRepository,
  type WorkflowTask,
} from '@dina/core';
import { LOCAL_RUNNER_NAME } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

const AGENT = 'did:plc:claim-lane-agent';
const NOW_MS = 1_700_000_000_000;
const LEASE_MS = 30_000;

function delegation(id: string, requested_runner?: string, created_at = 1000): WorkflowTask {
  return {
    id,
    kind: 'delegation',
    status: 'queued',
    priority: 'normal',
    description: 'claim-lane contract test',
    payload: JSON.stringify({ type: 'service_query_execution', capability: 'x', params: {} }),
    policy: '{}',
    result_summary: '',
    created_at,
    updated_at: created_at,
    ...(requested_runner !== undefined ? { requested_runner } : {}),
  } as WorkflowTask;
}

interface RepoCase {
  name: string;
  build: () => { repo: WorkflowRepository; cleanup: () => void };
}

const tmpRoots: string[] = [];

const CASES: RepoCase[] = [
  {
    name: 'SQLiteWorkflowRepository (real better-sqlite3)',
    build: () => {
      const dir = mkdtempSync(join(tmpdir(), 'dina-claim-lanes-'));
      tmpRoots.push(dir);
      const db = new NodeSQLiteAdapter({
        path: join(dir, 'identity.sqlite'),
        passphraseHex: 'ab'.repeat(32), // throwaway DEK — encrypted-at-rest like production
      });
      applyMigrations(db, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteWorkflowRepository(db),
        cleanup: () => {
          try {
            db.close();
          } catch {
            /* already closed */
          }
        },
      };
    },
  },
  {
    name: 'InMemoryWorkflowRepository (unit-test twin)',
    build: () => ({ repo: new InMemoryWorkflowRepository(), cleanup: () => undefined }),
  },
];

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.each(CASES)('claim runner-routing contract — $name', ({ build }) => {
  let repo: WorkflowRepository;
  let cleanup: () => void;

  beforeEach(() => {
    const built = build();
    repo = built.repo;
    cleanup = built.cleanup;
  });

  afterEach(() => cleanup());

  it("claim-any ('') takes an untagged task", () => {
    repo.create(delegation('d-untagged'));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, '')?.id).toBe('d-untagged');
  });

  it("claim-any ('') takes an agent-routed task", () => {
    repo.create(delegation('d-agent', 'openclaw'));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, '')?.id).toBe('d-agent');
  });

  it(`claim-any ('') NEVER takes a ${LOCAL_RUNNER_NAME} task`, () => {
    repo.create(delegation('d-tier1', LOCAL_RUNNER_NAME));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, '')).toBeNull();
  });

  it(`a foreign filter NEVER takes a ${LOCAL_RUNNER_NAME} task`, () => {
    repo.create(delegation('d-tier1', LOCAL_RUNNER_NAME));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, 'openclaw')).toBeNull();
  });

  it(`the '${LOCAL_RUNNER_NAME}' filter claims its own lane`, () => {
    repo.create(delegation('d-tier1', LOCAL_RUNNER_NAME));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, LOCAL_RUNNER_NAME)?.id).toBe(
      'd-tier1',
    );
  });

  it(`the reserved filter is EXACT-match: it NEVER takes an untagged task (free_form_task protection)`, () => {
    // delegate_to_agent free-form delegations carry NO requested_runner —
    // they belong to the paired external agent. The always-on in-process
    // runner claiming one would insta-fail it ("runner only handles
    // service_query_execution") before the agent ever saw it.
    repo.create(delegation('d-freeform'));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, LOCAL_RUNNER_NAME)).toBeNull();
  });

  it(`the reserved filter does NOT take an empty-string-runner task`, () => {
    repo.create(delegation('d-empty', ''));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, LOCAL_RUNNER_NAME)).toBeNull();
  });

  it(`empty-string requested_runner behaves like untagged for '' and foreign filters`, () => {
    repo.create(delegation('d-empty', ''));
    // Foreign filter takes it (single-runner back-compat)...
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, 'stub_eta')?.id).toBe('d-empty');
    // ...and claim-any takes a second one too.
    repo.create(delegation('d-empty-2', '', 2000));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, '')?.id).toBe('d-empty-2');
  });

  it('a filtered claim takes a matching task and skips a foreign one', () => {
    repo.create(delegation('d-eta', 'stub_eta', 1000));
    repo.create(delegation('d-price', 'stub_price', 2000));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, 'stub_price')?.id).toBe('d-price');
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, 'stub_price')).toBeNull();
  });

  it('a filtered claim still takes an untagged task (single-runner back-compat)', () => {
    repo.create(delegation('d-legacy'));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, 'stub_eta')?.id).toBe('d-legacy');
  });

  it(`claim-any skips ${LOCAL_RUNNER_NAME} but takes the next claimable (FIFO otherwise)`, () => {
    repo.create(delegation('d-tier1', LOCAL_RUNNER_NAME, 1000)); // older — would win FIFO
    repo.create(delegation('d-agent', 'openclaw', 2000));
    expect(repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, '')?.id).toBe('d-agent');
  });

  it('claimed task transitions to running with agent + lease stamped', () => {
    repo.create(delegation('d-tier1', LOCAL_RUNNER_NAME));
    const claimed = repo.claimDelegationTask(AGENT, NOW_MS, LEASE_MS, LOCAL_RUNNER_NAME);
    expect(claimed?.status).toBe('running');
    expect(claimed?.agent_did).toBe(AGENT);
    expect(claimed?.lease_expires_at).toBe(NOW_MS + LEASE_MS);
  });
});
