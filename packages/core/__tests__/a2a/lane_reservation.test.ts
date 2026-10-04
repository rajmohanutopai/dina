/**
 * A2A design §6.3: `a2a:<remote_agent_id>` lanes are reserved like
 * `plugin:<install_id>` and `dina.local`. Only the host's in-process runner
 * claims one (through the repository, exact match); a generic claim never
 * takes one; no HTTP caller may claim one; and no caller may create a task on
 * a reserved lane through the route (Core's own producers use the service).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { a2aLaneFor, isA2ALane } from '@dina/a2a';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  type WorkflowRepository,
} from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const NOW = 1_800_000_000_000;
const LEASE = 30_000;

function seed(repo: WorkflowRepository, id: string, requestedRunner?: string): void {
  repo.create({
    id,
    kind: 'delegation',
    status: 'queued',
    priority: 'normal',
    description: id,
    payload: '{}',
    result_summary: '',
    policy: '{}',
    ...(requestedRunner !== undefined ? { requested_runner: requestedRunner } : {}),
    created_at: NOW,
    updated_at: NOW,
  });
}

describe('a2a lane helpers', () => {
  it('names and recognizes the lane', () => {
    expect(a2aLaneFor('ra-1')).toBe('a2a:ra-1');
    expect(isA2ALane('a2a:ra-1')).toBe(true);
    expect(isA2ALane('a2a:')).toBe(false);
    expect(isA2ALane('plugin:x')).toBe(false);
    expect(() => a2aLaneFor('')).toThrow();
  });
});

const stores: [string, () => { repo: WorkflowRepository; done: () => void }][] = [
  ['in-memory', () => ({ repo: new InMemoryWorkflowRepository(), done: () => undefined })],
  [
    'SQLite',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'a2a-lane-'));
      const adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteWorkflowRepository(adapter),
        done: () => {
          adapter.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

describe.each(stores)('claim reservation (%s store)', (_name, make) => {
  let repo: WorkflowRepository;
  let done: () => void;
  beforeEach(() => ({ repo, done } = make()));
  afterEach(() => done());

  it('a generic claim never takes an a2a lane task', () => {
    seed(repo, 'a2a-task', 'a2a:ra-1');
    expect(repo.claimDelegationTask('did:key:agent', NOW, LEASE, '')).toBeNull();
    seed(repo, 'plain-task');
    expect(repo.claimDelegationTask('did:key:agent', NOW, LEASE, '')?.id).toBe('plain-task');
  });

  it('an a2a filter claims its own lane exactly, never untagged work or another lane', () => {
    seed(repo, 'untagged');
    seed(repo, 'other-agent', 'a2a:ra-2');
    expect(repo.claimDelegationTask('did:key:runner', NOW, LEASE, 'a2a:ra-1')).toBeNull();
    seed(repo, 'mine', 'a2a:ra-1');
    expect(repo.claimDelegationTask('did:key:runner', NOW, LEASE, 'a2a:ra-1')?.id).toBe('mine');
  });

  it('a plugin lane filter never takes an a2a lane task', () => {
    seed(repo, 'a2a-task', 'a2a:ra-1');
    expect(repo.claimDelegationTask('did:key:runner', NOW, LEASE, 'plugin:inst')).toBeNull();
  });
});

describe('workflow routes refuse reserved lanes', () => {
  let repo: InMemoryWorkflowRepository;
  let router: CoreRouter;
  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
    router = new CoreRouter();
    registerWorkflowRoutes(router);
  });
  afterEach(() => setWorkflowService(null));

  const req = (
    method: CoreRequest['method'],
    p: string,
    body: Record<string, unknown>,
    callerType: string,
  ): CoreRequest => ({
    method,
    path: p,
    query: {},
    headers: { 'x-did': 'did:key:caller' },
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType,
    callerDID: 'did:key:caller',
  });

  it.each(['agent', 'brain', 'admin', 'owner'])(
    'refuses a %s claiming an a2a lane over HTTP',
    async (callerType) => {
      seed(repo, 'mine', 'a2a:ra-1');
      const resp = await router.handle(
        req('POST', '/v1/workflow/tasks/claim', { runner_filter: 'a2a:ra-1' }, callerType),
      );
      expect(resp.status).toBe(403);
      expect(repo.getById('mine')?.status).toBe('queued');
    },
  );

  it.each(['a2a:ra-1', 'plugin:inst_1', 'dina.local', 'reasoning:claude', 'DINA.LOCAL', ' dina.local', 'PLUGIN:x', 'a2a:', 'Reasoning:'])(
    'refuses creating a task on the reserved lane %j',
    async (lane) => {
      const resp = await router.handle(
        req(
          'POST',
          '/v1/workflow/tasks',
          {
            id: 't-reserved',
            kind: 'delegation',
            description: 'x',
            payload: '{}',
            requested_runner: lane,
            initial_state: 'queued',
          },
          'brain',
        ),
      );
      expect(resp.status).toBe(400);
      expect((resp.body as { error?: string }).error).toBe('reserved_runner');
      expect(repo.getById('t-reserved')).toBeNull();
    },
  );

  it.each(['brain', 'agent', 'admin', 'owner'])(
    'refuses a %s a Tier 1 task on dina.local: Core’s service-query ingress fills that lane (plan §4.2a)',
    async (callerType) => {
      const resp = await router.handle(
        req(
          'POST',
          '/v1/workflow/tasks',
          {
            id: 't-local',
            kind: 'delegation',
            description: 'x',
            payload: '{}',
            requested_runner: 'dina.local',
            initial_state: 'queued',
          },
          callerType,
        ),
      );
      expect(resp.status).toBe(400);
      expect((resp.body as { error?: string }).error).toBe('reserved_runner');
      expect(repo.getById('t-local')).toBeNull();
    },
  );

  it('refuses a reasoning task through the route: only the broker makes one', async () => {
    const resp = await router.handle(
      req('POST', '/v1/workflow/tasks', { id: 't-reason', kind: 'reasoning', description: 'x', payload: '{}' }, 'brain'),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error?: string }).error).toBe('reserved_runner');
    expect(repo.getById('t-reason')).toBeNull();
  });

  it.each(['brain', 'agent', 'admin', 'owner'])(
    'refuses a %s a service card or execution: only Core’s service-query ingress mints them',
    async (callerType) => {
      for (const kind of ['approval', 'delegation']) {
        const resp = await router.handle(
          req(
            'POST',
            '/v1/workflow/tasks',
            {
              id: `forged-${kind}`,
              kind,
              description: 'x',
              payload: JSON.stringify({
                type: 'service_query_execution',
                from_did: 'did:plc:attacker',
                query_id: 'q',
                capability: 'appointment_book',
                params: { anything: 'goes' },
                ttl_seconds: 60,
                mcp_server: 'a2a:ra-1',
              }),
              initial_state: kind === 'approval' ? 'pending_approval' : 'queued',
            },
            callerType,
          ),
        );
        expect(resp.status).toBe(400);
        expect((resp.body as { error?: string }).error).toBe('reserved_payload_type');
        expect(repo.getById(`forged-${kind}`)).toBeNull();
      }
    },
  );
});
