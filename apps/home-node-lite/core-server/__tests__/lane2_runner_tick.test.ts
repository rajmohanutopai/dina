/**
 * The runner tick the server boots (notes M2: "The Lane 1 runner's tick also
 * runs Lane 2's sweep"; notes M1a: "Each runner tick runs ... separately,
 * and a tick never rejects"). A Lane 1 step that throws must not stop Lane
 * 2's work that tick: the inbound sweep and its review-card repair, the
 * spent-nonce purge and the bound-DID re-check.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  A2AReleaseLog,
  A2AStore,
  IDENTITY_MIGRATIONS,
  PrincipalBudgets,
  SQLiteServiceConfigRepository,
  SQLiteWorkflowRepository,
  WorkflowService,
  a2aWorkflowHooks,
  applyMigrations,
  bindRunner,
  createA2AClient,
  createA2ARuntime,
  ingressSendMessage,
  installA2A,
  installA2AReleaseLog,
  setNodeDID,
  setServiceConfigDurable,
  setServiceConfigRepository,
  setWorkflowService,
  type A2ARuntime,
} from '@dina/core';
import { registerDevice, resetDeviceRegistry } from '@dina/core/devices';
import { SQLiteServiceGrantRepository, setServiceGrantRepository } from '@dina/core/storage';
import { A2ADispatchRunner } from '@dina/home-node';
import { NodeSQLiteAdapter } from '@dina/storage-node';

const ETA_PARAMS = { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } };
const ETA_RESULT = { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } };

let dir: string;
let db: NodeSQLiteAdapter;
let store: A2AStore;
let rt: A2ARuntime;
let log: A2AReleaseLog;
let clock: number;

beforeEach(async () => {
  clock = Date.now();
  dir = mkdtempSync(path.join(tmpdir(), 'lane2-tick-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'ad'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new A2AStore(db);
  installA2A({ store, nowMs: () => clock });
  log = new A2AReleaseLog(db, () => clock);
  installA2AReleaseLog(log);
  const repo = new SQLiteWorkflowRepository(db);
  // No decision handler: an approved review card is left for the sweep to repair.
  const hooks = a2aWorkflowHooks(() => rt);
  const workflow = new WorkflowService({ repository: repo, nowMsFn: () => clock, responseEgressGate: hooks.responseEgressGate });
  setWorkflowService(workflow);
  rt = createA2ARuntime({ store, workflow, nowMs: () => clock });
  setServiceConfigRepository(new SQLiteServiceConfigRepository(db));
  setServiceGrantRepository(new SQLiteServiceGrantRepository(db));
  resetDeviceRegistry();
  // Set at boot, as on every node: an execution child names its listing under it.
  setNodeDID('did:plc:lanetwotickprovider');
  const runner = registerDevice('Transit runner', 'z6MkLaneTwoTickRunner', 'agent', 'runner').did;
  bindRunner(store, { lane: 'transit', device_did: runner }, clock);
  await setServiceConfigDurable(
    {
      isDiscoverable: true,
      discoverability: 'public',
      status: 'active',
      name: 'Bus 42',
      capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'review', category: 'transit' } },
      capabilitySchemas: { eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h' } },
    },
    'bus',
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  installA2AReleaseLog(null);
  installA2A(null);
  setWorkflowService(null);
  setServiceConfigRepository(null);
  setServiceGrantRepository(null);
  resetDeviceRegistry();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An outside call under review whose card the owner approved, with no execution minted yet. */
function approvedReviewCall(): number {
  const client = createA2AClient(store, { display_name: 'Outside agent' }, clock);
  if (!client.ok) throw new Error(client.reason);
  const answer = ingressSendMessage(
    { a2a: rt, grants: new SQLiteServiceGrantRepository(db), budgets: new PrincipalBudgets() },
    {
      request: {
        method: 'POST',
        path: '/a2a/v1',
        query: '',
        version: '1.0',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { messageId: 'tick-1', role: 'ROLE_USER', parts: [{ data: { skill: 'eta_query', params: { route_id: '1' } } }] } },
        }),
      },
      client_auth: { authorization: `Bearer ${client.token}` },
    },
  );
  const id = ((answer.body as { result: { task: { id: string } } }).result.task).id;
  const op = store.getTaskByExternal('inbound', `a2a:${client.client.client_id}`, id);
  if (op === null || op.internal_id === null) throw new Error('no review card');
  rt.workflow.approve(op.internal_id);
  return op.id;
}

describe('one runner tick with a failing Lane 1 step (notes M1a, M2)', () => {
  // Extra X-20
  it.each([
    ['outbound sweep', 'a2a.sweep_failed'],
    ['held-result notice', 'a2a.notice_sweep_failed'],
    ['release-log purge', 'a2a.release_log_sweep_failed'],
  ])(
    'when the %s throws, its own catch logs %s; Lane 2’s sweep, nonce purge and DID re-check still run, and the tick resolves',
    async (failing, expectedEvent) => {
      const opId = approvedReviewCall();
      expect(store.getTask(opId)?.internal_id).toMatch(/^a2a-in-review-/);
      db.execute('INSERT INTO a2a_request_nonces (did, nonce, expires_at) VALUES (?, ?, ?)', ['did:key:z6MkOld', 'n-old', 1]);
      const realList = store.listTasksInStates.bind(store);
      if (failing === 'outbound sweep') {
        // Only the sweep's own read throws; the claim loop's read later in the tick runs as normal.
        let thrown = false;
        jest.spyOn(store, 'listTasksInStates').mockImplementation((direction, states) => {
          if (direction === 'outbound' && !thrown) {
            thrown = true;
            throw new Error('lane 1 broke');
          }
          return realList(direction, states);
        });
      } else if (failing === 'held-result notice') {
        jest.spyOn(store, 'guardJobsAwaitingNotice').mockImplementation(() => {
          throw new Error('lane 1 broke');
        });
      } else {
        jest.spyOn(log, 'purgeExpired').mockImplementation(() => {
          throw new Error('lane 1 broke');
        });
      }
      const sql: string[] = [];
      const realQuery = db.query.bind(db);
      jest.spyOn(db, 'query').mockImplementation(((text: string, params?: unknown[]) => {
        sql.push(text);
        return realQuery(text, params);
      }) as typeof db.query);
      const entries: Record<string, unknown>[] = [];
      const runner = new A2ADispatchRunner({ runtime: () => rt, runnerDid: 'did:key:z6MkTickRunner', log: (e) => entries.push(e) });
      await expect(runner.tick()).resolves.toBeUndefined();
      await runner.flush();
      // Lane 2's sweep repaired the approved card: its execution exists.
      expect(store.getTask(opId)?.internal_id).toMatch(/^a2a-in-exec-/);
      // The spent nonce whose time is past is gone.
      expect(db.query('SELECT 1 FROM a2a_request_nonces')).toHaveLength(0);
      // The bound-DID re-check ran.
      expect(sql.some((q) => q.includes('bound_did IS NOT NULL'))).toBe(true);
      // The failing step was logged by its own event and error class, nothing more; the tick itself never failed.
      expect(entries).toContainEqual({ event: expectedEvent, error: 'Error' });
      expect(entries.filter((e) => e.error !== undefined)).toEqual([{ event: expectedEvent, error: 'Error' }]);
      expect(JSON.stringify(entries)).not.toContain('lane 1 broke');
      await runner.stop();
    },
  );
});
