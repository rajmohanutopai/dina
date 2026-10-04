/**
 * The A2A Lane 1 runner (design §6.3–§6.5) against a scripted remote agent
 * behind the outbound port: a bare Message answer, a completed task, a
 * polled task, every remote failure, transport failures before and after
 * sending, the deadline, and the owner's cancel (confirmed and refused).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  A2AReleaseLog,
  A2AStore,
  IDENTITY_MIGRATIONS,
  SQLiteWorkflowRepository,
  WorkflowService,
  a2aWorkflowHooks,
  activateRemoteAgent,
  applyMigrations,
  bindRemoteSkill,
  cancelOutboundOperation,
  createA2ARuntime,
  createNoneCredential,
  createRemoteCredential,
  installA2AReleaseLog,
  outboundOperationView,
  revokeRemoteAgent,
  revokeRemoteCredential,
  rotateRemoteCredential,
  proposeDelegation,
  registerRemoteAgent,
  getA2AHostTransport,
  setA2AHostTransport,
  type A2AHttpRequest,
  type A2AHttpResult,
  type A2ARuntime,
  DID_REFRESH_INTERVAL_MS,
  createA2AClient,
  getA2AClient,
  getPublicKey,
  installA2ADidResolver,
  publicKeyToMultibase,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2ADispatchRunner } from '../src/a2a_runner';

const CARD_URL = 'https://agent.example/.well-known/agent-card.json';
const KEYED_CARD_URL = 'https://keyed.example/.well-known/agent-card.json';
const ENDPOINT = 'https://agent.example/rpc';
const CARD = {
  name: 'Remote',
  description: 'A remote agent.',
  supportedInterfaces: [{ url: ENDPOINT, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  version: '1',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarize.', tags: ['text'] }],
};

interface Rpc { method: string; params: Record<string, unknown>; id: string; headers: Readonly<Record<string, string>> }
type Script = (rpc: Rpc) => A2AHttpResult | Record<string, unknown>;

let dir: string;
let db: NodeSQLiteAdapter;
let runtime: A2ARuntime;
let workflow: WorkflowService;
let clock: number;
let script: Script;
let rpcs: Rpc[];
let agentId: string;

function task(id: string, state: string, artifacts?: unknown[]): Record<string, unknown> {
  return { id, contextId: 'ctx-1', status: { state }, ...(artifacts !== undefined ? { artifacts } : {}) };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-runner-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: '12'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  clock = 1_800_000_000_000;
  const store = new A2AStore(db);
  const hooks = a2aWorkflowHooks(() => runtime);
  workflow = new WorkflowService({ repository: new SQLiteWorkflowRepository(db), nowMsFn: () => clock, approvalDecisionHandler: hooks.approvalDecisionHandler });
  runtime = createA2ARuntime({ store, workflow, nowMs: () => clock });
  rpcs = [];
  script = () => ({ message: { messageId: 'm-r', role: 'ROLE_AGENT', parts: [{ text: 'done' }] } });
  setA2AHostTransport(async (request: A2AHttpRequest): Promise<A2AHttpResult> => {
    if (request.method === 'GET' && request.url === CARD_URL) {
      return { ok: true, status: 200, body: JSON.stringify(CARD), connectedAddress: '203.0.113.9' };
    }
    if (request.method === 'GET' && request.url === KEYED_CARD_URL) {
      const keyed = {
        ...CARD,
        supportedInterfaces: [{ url: 'https://keyed.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X-Api-Key' } } },
        securityRequirements: [{ schemes: { key: { list: [] } } }],
      };
      return { ok: true, status: 200, body: JSON.stringify(keyed), connectedAddress: '203.0.113.10' };
    }
    const body = JSON.parse(request.body ?? '{}') as { id: string; method: string; params: Record<string, unknown> };
    const rpc = { method: body.method, params: body.params, id: body.id, headers: request.headers };
    rpcs.push(rpc);
    const out = script(rpc);
    if ('ok' in out && typeof out.ok === 'boolean') return out as A2AHttpResult;
    const reply = 'error' in out ? { jsonrpc: '2.0', id: body.id, error: out.error } : { jsonrpc: '2.0', id: body.id, result: out };
    return { ok: true, status: 200, body: JSON.stringify(reply), connectedAddress: '203.0.113.9' };
  });
  const d = { store, nowMs: () => clock };
  const reg = await registerRemoteAgent(d, CARD_URL);
  if (!reg.ok) throw new Error(reg.reason);
  agentId = reg.agent.agent_id;
  const cred = createNoneCredential(d, agentId);
  if (!cred.ok) throw new Error(cred.reason);
  bindRemoteSkill(d, agentId, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref });
  activateRemoteAgent(d, agentId);
  // The owner's turn every proposal here belongs to (A2A §6.2 step 0).
  const log = new A2AReleaseLog(db, () => clock);
  installA2AReleaseLog(log);
  log.recordUtterance('chat:main', 'turn-1', 'Summarize this for me.');
});

afterEach(() => {
  setA2AHostTransport(null);
  installA2AReleaseLog(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runner(over: Partial<ConstructorParameters<typeof A2ADispatchRunner>[0]> = {}): A2ADispatchRunner {
  return new A2ADispatchRunner({
    runtime: () => runtime,
    runnerDid: 'did:key:z6MkRunner',
    sleep: async (ms) => {
      clock += ms;
    },
    pollBackoffMs: [1_000],
    pollDeadlineMs: 60_000,
    ...over,
  });
}

function approvedOperation(text = 'Summarize this.'): string {
  const p = proposeDelegation(runtime, { agentId, skill: 'summarize', text, replyTo: 'main', releaseSession: 'chat:main' });
  if (!p.ok) throw new Error(p.reason);
  workflow.approve(p.approvalTaskId);
  return p.operationId;
}

const op = (id: string) => runtime.store.getTaskByExternal('outbound', 'owner', id);

async function runOnce(r = runner()): Promise<void> {
  await r.tick();
  await r.flush();
}

it('sends exactly the approved message, and takes a bare Message answer as the result', async () => {
  const id = approvedOperation();
  await runOnce();
  expect(rpcs).toHaveLength(1);
  const sent = rpcs[0];
  expect(sent?.method).toBe('SendMessage');
  expect(sent?.headers['A2A-Version']).toBe('1.0');
  expect(sent?.params).toEqual({
    message: { messageId: op(id)?.message_id, role: 'ROLE_USER', parts: [{ text: 'Summarize this.' }] },
    configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] },
  });
  expect(op(id)).toMatchObject({ state: 'quarantined', remote_task_id: null, submission_phase: 'terminal' });
});

it('takes a completed task’s artifacts as the result', async () => {
  script = () => ({ task: task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a1', parts: [{ text: 'out' }] }]) });
  const id = approvedOperation();
  await runOnce();
  expect(op(id)?.state).toBe('quarantined');
  expect(op(id)?.result_quarantine).toBe('{"parts":[{"text":"out"}],"version":1}');
});

it('polls a working task with GetTask until it completes, renewing the claim before every call', async () => {
  let polls = 0;
  const renewals: number[] = [];
  const store = runtime.workflow.store();
  const heartbeat = jest.spyOn(store, 'heartbeatTask').mockImplementation((...args) => {
    renewals.push(rpcs.length);
    return SQLiteWorkflowRepository.prototype.heartbeatTask.apply(store, args);
  });
  script = (rpc) => {
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    polls += 1;
    if (JSON.stringify(rpc.params) !== '{"id":"rt-1"}') throw new Error('GetTask params');
    // GetTask answers with a bare Task, not a SendMessage-style wrapper.
    return polls < 3 ? task('rt-1', 'TASK_STATE_WORKING') : task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ data: { n: 1 } }] }]);
  };
  const id = approvedOperation();
  await runOnce();
  heartbeat.mockRestore();
  expect(polls).toBe(3);
  expect(op(id)).toMatchObject({ state: 'quarantined', remote_task_id: 'rt-1', remote_context_id: 'ctx-1' });
  // One renewal before each GetTask: after the send (1 call made), then after each poll.
  expect(renewals).toEqual([1, 2, 3]);
});

it('renews the claim between a cancel attempt and the next GetTask', async () => {
  let id = '';
  const order: string[] = [];
  const store = runtime.workflow.store();
  const heartbeat = jest.spyOn(store, 'heartbeatTask').mockImplementation((...args) => {
    order.push('renew');
    return SQLiteWorkflowRepository.prototype.heartbeatTask.apply(store, args);
  });
  script = (rpc) => {
    order.push(rpc.method);
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    if (rpc.method === 'CancelTask') return { error: { code: -32002, message: 'Task cannot be canceled' } };
    if (order.filter((m) => m === 'GetTask').length === 1) cancelOutboundOperation(runtime, id);
    return order.filter((m) => m === 'GetTask').length < 3
      ? task('rt-1', 'TASK_STATE_WORKING')
      : task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
  };
  id = approvedOperation();
  await runOnce();
  heartbeat.mockRestore();
  expect(order).toEqual(['SendMessage', 'renew', 'GetTask', 'renew', 'CancelTask', 'renew', 'GetTask', 'renew', 'GetTask']);
});

it('refuses a lease no longer than one call plus the longest sleep', () => {
  expect(() => runner({ leaseMs: 30_000, pollBackoffMs: [1_000] })).toThrow(/leaseMs/);
  expect(() => runner({ leaseMs: 45_000, pollBackoffMs: [15_000] })).toThrow(/leaseMs/);
  expect(() => runner({ leaseMs: 60_000, pollBackoffMs: [15_000] })).not.toThrow();
});

it.each([
  ['INPUT_REQUIRED', 'TASK_STATE_INPUT_REQUIRED', 'failed', 'remote_needs_input'],
  ['AUTH_REQUIRED', 'TASK_STATE_AUTH_REQUIRED', 'failed', 'remote_needs_auth'],
  ['FAILED', 'TASK_STATE_FAILED', 'failed', 'remote_failed'],
  ['REJECTED', 'TASK_STATE_REJECTED', 'failed', 'remote_rejected'],
  ['CANCELED', 'TASK_STATE_CANCELED', 'cancelled', 'cancelled_by_remote'],
])('maps a remote %s to its outcome', async (_name, state, opState, reason) => {
  script = () => ({ task: task('rt-1', state) });
  const id = approvedOperation();
  await runOnce();
  expect(op(id)).toMatchObject({ state: opState, reason_code: reason });
});

it('reads a JSON-RPC error to SendMessage by its code (Core weighs it against the action class)', async () => {
  script = () => ({ error: { code: -32602, message: 'Invalid parameters' } });
  const refused = approvedOperation('a');
  await runOnce();
  expect(op(refused)).toMatchObject({ state: 'failed', reason_code: 'remote_rejected' });
  script = () => ({ error: { code: -32603, message: 'Internal error' } });
  const internal = approvedOperation('b');
  await runOnce();
  // A read cannot change anything remotely, so its internal error is a plain failure.
  expect(op(internal)).toMatchObject({ state: 'failed', reason_code: 'remote_error' });
});

// Cold audit C6-1: JSON-RPC 2.0 §5 has a server that could not read the id answer with id null
it('a parse error or invalid request answered with a null id was refused unread: remote_rejected, never outcome_unknown', async () => {
  for (const [n, code] of [[1, -32700], [2, -32600]] as const) {
    script = () => ({ ok: true, status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message: 'x' } }), connectedAddress: '1' });
    const id = approvedOperation(`refused ${n}`);
    await runOnce();
    expect(op(id)).toMatchObject({ state: 'failed', reason_code: 'remote_rejected' });
  }
  // Control: any other answer with a null id still answers no call of Dina's.
  script = () => ({ ok: true, status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'x' } }), connectedAddress: '1' });
  const other = approvedOperation('other');
  await runOnce();
  expect(op(other)).toMatchObject({ state: 'outcome_unknown', reason_code: 'response_malformed' });
});

it('a transport failure before the handshake is not_sent; after it, outcome_unknown', async () => {
  script = () => ({ ok: false, error: 'connect_failed', sent: false });
  const a = approvedOperation('a');
  await runOnce();
  expect(op(a)).toMatchObject({ state: 'failed', reason_code: 'remote_unreachable:connect_failed' });
  script = () => ({ ok: false, error: 'timeout', sent: true });
  const b = approvedOperation('b');
  await runOnce();
  expect(op(b)).toMatchObject({ state: 'outcome_unknown', reason_code: 'transport_timeout' });
});

it('a malformed or invalid answer leaves the outcome unknown', async () => {
  script = () => ({ ok: true, status: 200, body: '{"jsonrpc":"2.0","id":"x","result":{}}', connectedAddress: '1' });
  const id = approvedOperation();
  await runOnce();
  expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'response_malformed' });
  script = () => ({ task: { id: 'rt', status: { state: 'TASK_STATE_FROZEN' } } });
  const other = approvedOperation('again');
  await runOnce();
  expect(op(other)).toMatchObject({ state: 'outcome_unknown', reason_code: 'response_invalid' });
});

it('gives up polling at the deadline as outcome_unknown', async () => {
  let gets = 0;
  script = (rpc) => {
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    gets += 1;
    return task('rt-1', 'TASK_STATE_WORKING');
  };
  const id = approvedOperation();
  await runOnce(runner({ pollDeadlineMs: 5_000 }));
  expect(gets).toBe(5);
  expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'deadline' });
});

// Cold audit C3-6: the poll's deadline is set by the send, and a resume inherits it (§6.4)
describe('a resume after a lost lease polls only until the deadline the send set', () => {
  /** Send, poll twice, then stop the runner's process; its lease lapses and the dispatch is queued again. */
  async function sentThenStopped(deadlineMs: number): Promise<{ id: string; sentAt: number; gets: () => number }> {
    const first = runner({ pollDeadlineMs: deadlineMs });
    let gets = 0;
    let sentAt = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') {
        sentAt = clock;
        return { task: task('rt-1', 'TASK_STATE_WORKING') };
      }
      gets += 1;
      if (gets === 2) void first.stop();
      return task('rt-1', 'TASK_STATE_WORKING');
    };
    const id = approvedOperation();
    await runOnce(first);
    expect(op(id)).toMatchObject({ state: 'running', submission_phase: 'acknowledged' });
    clock += 60_001; // past the claim's lease
    expect(workflow.store().expireLeasedTasks(clock).length).toBe(1);
    return { id, sentAt, gets: () => gets };
  }

  it('within the window: polling resumes, and ends when the send’s window ends', async () => {
    const { id, sentAt } = await sentThenStopped(300_000);
    await runOnce(runner({ pollDeadlineMs: 300_000 }));
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'deadline' });
    // Ended at the send's deadline, not five minutes after the resume.
    const endedAt = op(id)?.status_updated_at ?? 0;
    expect(endedAt).toBeGreaterThanOrEqual(sentAt + 300_000);
    expect(endedAt).toBeLessThan(sentAt + 302_000);
  });

  it('past the window: the resume ends it at once, with no more polling', async () => {
    const { id, gets } = await sentThenStopped(30_000);
    const before = gets();
    await runOnce(runner({ pollDeadlineMs: 30_000 }));
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'deadline' });
    expect(gets()).toBe(before);
  });
});

// Cold audit C4-10: once sent, an agent the owner removed hears nothing more from Dina
describe('the owner removes the agent after the send', () => {
  const removeAgent = () => expect(revokeRemoteAgent({ store: runtime.store, nowMs: () => clock }, agentId)).toBe(true);

  it('while Dina polls: no further call goes out, and the request ends unknown', async () => {
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      gets += 1;
      if (gets === 1) removeAgent();
      return task('rt-1', 'TASK_STATE_WORKING');
    };
    const id = approvedOperation();
    await runOnce();
    expect(rpcs.map((r) => r.method)).toEqual(['SendMessage', 'GetTask']);
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'credential_unusable_after_send' });
  });

  it('while its dispatch waits to resume after a lost lease: the resume sends nothing', async () => {
    // A deadline the lease's lapse does not pass, so the resume is judged on the agent, not the clock.
    const first = runner({ pollDeadlineMs: 300_000 });
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      void first.stop();
      return task('rt-1', 'TASK_STATE_WORKING');
    };
    const id = approvedOperation();
    await runOnce(first);
    expect(op(id)).toMatchObject({ state: 'running', submission_phase: 'acknowledged' });
    removeAgent();
    clock += 60_001;
    expect(workflow.store().expireLeasedTasks(clock).length).toBe(1);
    const before = rpcs.length;
    await runOnce(runner({ pollDeadlineMs: 300_000 }));
    expect(rpcs.length).toBe(before);
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'credential_unusable_after_send' });
  });
});

it('a remote that forgets the task leaves the outcome unknown', async () => {
  script = (rpc) => (rpc.method === 'SendMessage' ? { task: task('rt-1', 'TASK_STATE_WORKING') } : { error: { code: -32001, message: 'Task not found' } });
  const id = approvedOperation();
  await runOnce();
  expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'remote_task_lost' });
});

it('carries the owner’s cancel to the remote, and records a confirmed cancel', async () => {
  let id = '';
  script = (rpc) => {
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    if (rpc.method === 'CancelTask') return task('rt-1', 'TASK_STATE_CANCELED');
    cancelOutboundOperation(runtime, id); // the owner cancels while the task runs
    return task('rt-1', 'TASK_STATE_WORKING');
  };
  id = approvedOperation();
  await runOnce();
  expect(rpcs.map((r) => r.method)).toEqual(['SendMessage', 'GetTask', 'CancelTask']);
  expect(op(id)).toMatchObject({ state: 'cancelled', reason_code: 'cancelled_by_owner' });
});

it('a remote that refuses the cancel runs on to its real end', async () => {
  let id = '';
  let gets = 0;
  script = (rpc) => {
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    if (rpc.method === 'CancelTask') return { error: { code: -32002, message: 'Task cannot be canceled' } };
    gets += 1;
    if (gets === 1) cancelOutboundOperation(runtime, id);
    return gets < 3 ? task('rt-1', 'TASK_STATE_WORKING') : task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
  };
  id = approvedOperation();
  await runOnce();
  const row = op(id);
  expect(row?.state).toBe('quarantined');
  expect(runtime.store.getCancelRequest(row?.id ?? 0)?.state).toBe('refused');
});

// Cold audit C3-5: only an error that says the cancel cannot happen answers it "no"
it.each([
  ['task not cancelable', -32002],
  ['task not found', -32001],
  ['unsupported operation', -32004],
  ['method not found', -32601],
])('a cancel refused as %s is asked once, and stays refused', async (_name, code) => {
  let id = '';
  let gets = 0;
  script = (rpc) => {
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    if (rpc.method === 'CancelTask') return { error: { code, message: 'no' } };
    gets += 1;
    if (gets === 1) cancelOutboundOperation(runtime, id);
    return gets < 4 ? task('rt-1', 'TASK_STATE_WORKING') : task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
  };
  id = approvedOperation();
  await runOnce();
  expect(rpcs.filter((r) => r.method === 'CancelTask')).toHaveLength(1);
  expect(runtime.store.getCancelRequest(op(id)?.id ?? 0)?.state).toBe('refused');
});

it('an error that says nothing of the cancel (an internal one) is asked again on the next poll, until an answer comes', async () => {
  let id = '';
  let gets = 0;
  let cancels = 0;
  script = (rpc) => {
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    if (rpc.method === 'CancelTask') {
      cancels += 1;
      return cancels < 3 ? { error: { code: -32603, message: 'Internal error' } } : task('rt-1', 'TASK_STATE_CANCELED');
    }
    gets += 1;
    if (gets === 1) cancelOutboundOperation(runtime, id);
    return task('rt-1', 'TASK_STATE_WORKING');
  };
  id = approvedOperation();
  await runOnce();
  expect(cancels).toBe(3);
  expect(op(id)).toMatchObject({ state: 'cancelled', reason_code: 'cancelled_by_owner' });
  expect(runtime.store.getCancelRequest(op(id)?.id ?? 0)?.state).toBe('confirmed');
});

it('a refused cancel: asking again answers cancel_refused, and the operation shows it', async () => {
  let id = '';
  let gets = 0;
  script = (rpc) => {
    if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
    if (rpc.method === 'CancelTask') return { error: { code: -32002, message: 'Task cannot be canceled' } };
    gets += 1;
    if (gets === 1) expect(cancelOutboundOperation(runtime, id)).toEqual({ ok: true, state: 'cancel_requested' });
    if (gets === 2) expect(outboundOperationView(runtime, id)?.cancel).toBe('refused');
    if (gets === 2) expect(cancelOutboundOperation(runtime, id)).toEqual({ ok: false, reason: 'cancel_refused' });
    return gets < 3 ? task('rt-1', 'TASK_STATE_WORKING') : task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
  };
  id = approvedOperation();
  await runOnce();
  expect(gets).toBe(3);
  expect(rpcs.filter((r) => r.method === 'CancelTask')).toHaveLength(1);
});

it('never rejects: a Core fault in a tick is logged, and the next tick works', async () => {
  const logs: Record<string, unknown>[] = [];
  const r = runner({ log: (e) => logs.push(e) });
  const id = approvedOperation();
  const list = jest.spyOn(runtime.store, 'listTasksInStates').mockImplementation(() => {
    throw new Error('database is locked');
  });
  await expect(r.tick()).resolves.toBeUndefined();
  list.mockRestore();
  expect(logs.map((e) => e.event)).toEqual(expect.arrayContaining(['a2a.sweep_failed', 'a2a.tick_failed']));
  await runOnce(r);
  expect(op(id)?.state).toBe('quarantined');
});

it('a failing claim is logged and leaves the work for the next tick', async () => {
  const logs: Record<string, unknown>[] = [];
  const r = runner({ log: (e) => logs.push(e) });
  const id = approvedOperation();
  const claim = jest.spyOn(runtime.workflow.store(), 'claimDelegationTask').mockImplementationOnce(() => {
    throw new Error('SQLITE_BUSY');
  });
  await runOnce(r);
  claim.mockRestore();
  expect(logs.map((e) => e.event)).toContain('a2a.claim_failed');
  expect(rpcs).toEqual([]);
  await runOnce(r);
  expect(op(id)?.state).toBe('quarantined');
});

it('does nothing while Lane 1 is not available', async () => {
  approvedOperation();
  await runOnce(runner({ runtime: () => null }));
  expect(rpcs).toEqual([]);
});

it('claims nothing it was not asked to send, and sweeps on every tick', async () => {
  const p = proposeDelegation(runtime, { agentId, skill: 'summarize', text: 'not approved yet', releaseSession: 'chat:main' });
  if (!p.ok) throw new Error(p.reason);
  await runOnce();
  expect(rpcs).toEqual([]);
  // Approved with no decision handler run: the sweeper mints, and the next tick sends.
  runtime.workflow.store().approveWithEvent(p.approvalTaskId, 'pending_approval', 'queued', '{}', clock);
  await runOnce();
  await runOnce();
  expect(rpcs.map((r) => r.method)).toEqual(['SendMessage']);
});

describe("Lane 2 upkeep: bound client DIDs and spent nonces (design §5.1)", () => {
  const PLC = 'did:plc:client00000000000000000000';
  const KEY_A = publicKeyToMultibase(getPublicKey(new Uint8Array(32).fill(21)));
  const KEY_B = publicKeyToMultibase(getPublicKey(new Uint8Array(32).fill(22)));
  const doc = (key: string) => ({
    id: PLC,
    verificationMethod: [{ id: `${PLC}#dina_signing`, type: 'Multikey', controller: PLC, publicKeyMultibase: key }],
  });

  function boundClient(): string {
    const made = createA2AClient(runtime.store, { display_name: 'Bound' }, clock);
    if (!made.ok) throw new Error(made.reason);
    db.execute(`UPDATE a2a_clients SET bound_did = ?, bound_key = ?, token_hash = NULL WHERE client_id = ?`, [
      PLC,
      KEY_A,
      made.client.client_id,
    ]);
    return made.client.client_id;
  }
  afterEach(() => installA2ADidResolver(null));

  it('re-checks bound DIDs once per interval, off the tick, and stops a removed key', async () => {
    const id = boundClient();
    let lookups = 0;
    let current = doc(KEY_A);
    installA2ADidResolver(async () => {
      lookups += 1;
      return { kind: 'document', document: current };
    });
    const logs: Record<string, unknown>[] = [];
    const r = runner({ log: (e) => logs.push(e) });
    await runOnce(r);
    await runOnce(r);
    expect(lookups).toBe(1);
    current = doc(KEY_B);
    clock += DID_REFRESH_INTERVAL_MS;
    await runOnce(r);
    expect(lookups).toBe(2);
    expect(getA2AClient(runtime.store, id)?.credential).toBe('did_key_removed');
    expect(logs).toContainEqual({ event: 'a2a.did_refresh', checked: 1, suspended: 1, unresolved: 0 });
  });

  it('never makes the tick wait on a slow DID lookup, and runs one re-check at a time', async () => {
    boundClient();
    let lookups = 0;
    let release = (): void => undefined;
    installA2ADidResolver(() => {
      lookups += 1;
      return new Promise((resolve) => (release = () => resolve({ kind: 'document', document: doc(KEY_A) })));
    });
    const r = runner();
    // The tick ends while the lookup still waits.
    await r.tick();
    clock += DID_REFRESH_INTERVAL_MS;
    await r.tick();
    expect(lookups).toBe(1);
    release();
    await r.flush();
  });

  it('purges spent request nonces once their signatures have aged out', async () => {
    db.execute('INSERT INTO a2a_request_nonces (did, nonce, expires_at) VALUES (?, ?, ?), (?, ?, ?)', [
      PLC,
      'old'.padEnd(32, '0'),
      Date.now() - 1,
      PLC,
      'new'.padEnd(32, '0'),
      Date.now() + 60_000,
    ]);
    await runOnce();
    expect(db.query('SELECT nonce FROM a2a_request_nonces')).toEqual([{ nonce: 'new'.padEnd(32, '0') }]);
  });
});

describe('a credentialed agent (design §5.3)', () => {
  let keyedAgent: string;
  let credentialRef: string;

  beforeEach(async () => {
    const d = { store: runtime.store, nowMs: () => clock };
    const reg = await registerRemoteAgent(d, KEYED_CARD_URL);
    if (!reg.ok) throw new Error(reg.reason);
    keyedAgent = reg.agent.agent_id;
    const cred = createRemoteCredential(d, keyedAgent, { kind: 'api_key', scheme: 'key', secret: { value: 'KEY-123' } });
    if (!cred.ok) throw new Error(cred.reason);
    credentialRef = cred.credential.credential_ref;
    bindRemoteSkill(d, keyedAgent, { skill: 'summarize', actionClass: 'read', credentialRef });
    activateRemoteAgent(d, keyedAgent);
  });

  function approvedKeyed(): string {
    const p = proposeDelegation(runtime, { agentId: keyedAgent, skill: 'summarize', text: 'go', releaseSession: 'chat:main' });
    if (!p.ok) throw new Error(p.reason);
    workflow.approve(p.approvalTaskId);
    return p.operationId;
  }

  // Cold audit C4-10
  it('the credential revoked with nothing to follow it while Dina polls: no further call goes out, and the request ends unknown', async () => {
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      gets += 1;
      if (gets === 1) expect(revokeRemoteCredential({ store: runtime.store, nowMs: () => clock }, credentialRef)).toBe(true);
      return task('rt-1', 'TASK_STATE_WORKING');
    };
    const id = approvedKeyed();
    await runOnce();
    expect(rpcs.map((r) => r.method)).toEqual(['SendMessage', 'GetTask']);
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'credential_unusable_after_send' });
  });

  it('sends the key on every call, built per request', async () => {
    script = (rpc) => (rpc.method === 'SendMessage' ? { task: task('rt-1', 'TASK_STATE_WORKING') } : task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]));
    const id = approvedKeyed();
    await runOnce();
    expect(rpcs.map((r) => [r.method, r.headers['X-Api-Key']])).toEqual([
      ['SendMessage', 'KEY-123'],
      ['GetTask', 'KEY-123'],
    ]);
    expect(op(id)?.state).toBe('quarantined');
    // The key is in no stored row of the operation.
    expect(JSON.stringify(op(id))).not.toContain('KEY-123');
  });

  it('a refused credential (401) ends the request as refused, not unknown', async () => {
    script = () => ({ ok: true, status: 401, body: '', connectedAddress: '203.0.113.10' });
    const id = approvedKeyed();
    await runOnce();
    expect(op(id)).toMatchObject({ state: 'failed', reason_code: 'remote_auth_refused' });
  });

  it('a credential Dina cannot use sends nothing', async () => {
    const id = approvedKeyed();
    // The material is gone by the time of the send: no headers can be built.
    runtime.store.deleteCredentialSecret(credentialRef);
    await runOnce();
    expect(rpcs).toEqual([]);
    // Settled before the permit was consumed: nothing could have left.
    expect(op(id)).toMatchObject({ state: 'failed', reason_code: 'credential_unusable', message_id: null });
    expect(runtime.store.permitsOf(op(id)?.id ?? 0).map((p) => p.state)).toEqual(['void']);
  });

  it.each([401, 403])('a %i to a static key while polling ends the request at once, with its cause', async (status) => {
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      gets += 1;
      return { ok: true, status, body: '', connectedAddress: '203.0.113.10' };
    };
    const id = approvedKeyed();
    await runOnce();
    expect(gets).toBe(1);
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'remote_auth_refused_after_send' });
  });

  it('a secret rotated mid-task: the poll follows the new reference and the result still comes in', async () => {
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      gets += 1;
      if (gets === 1) {
        const rotated = rotateRemoteCredential({ store: runtime.store, nowMs: () => clock }, credentialRef, { value: 'KEY-456' });
        if (!rotated.ok) throw new Error(rotated.reason);
        return task('rt-1', 'TASK_STATE_WORKING');
      }
      return task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
    };
    const id = approvedKeyed();
    await runOnce();
    expect(rpcs.map((r) => [r.method, r.headers['X-Api-Key']])).toEqual([
      ['SendMessage', 'KEY-123'],
      ['GetTask', 'KEY-123'],
      ['GetTask', 'KEY-456'],
    ]);
    expect(op(id)?.state).toBe('quarantined');
  });
});

describe('an OAuth client agent (design §5.3)', () => {
  const OAUTH_CARD_URL = 'https://oauth.example/.well-known/agent-card.json';
  let tokens: string[];
  let failTokens: boolean;
  /** The token endpoint's next answers, before it issues tokens again: an outage, or a refusal. */
  let tokenTrouble: ('timeout' | 'address_blocked' | 503 | 401)[];

  beforeEach(async () => {
    tokens = [];
    failTokens = false;
    tokenTrouble = [];
    const inner = getA2AHostTransport();
    setA2AHostTransport(async (request) => {
      if (request.url === OAUTH_CARD_URL) {
        const card = {
          ...CARD,
          supportedInterfaces: [{ url: 'https://oauth.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          securitySchemes: {
            oauth: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: 'https://oauth.example/token', scopes: { run: 'Run' } } } } },
          },
        };
        return { ok: true, status: 200, body: JSON.stringify(card), connectedAddress: '203.0.113.11' };
      }
      if (request.url === 'https://oauth.example/token') {
        if (failTokens) return { ok: false, error: 'timeout', sent: true };
        const trouble = tokenTrouble.shift();
        if (trouble === 'timeout' || trouble === 'address_blocked') return { ok: false, error: trouble, sent: trouble === 'timeout' };
        if (trouble !== undefined) return { ok: true, status: trouble, body: '{}', connectedAddress: '203.0.113.11' };
        const token = `tok-${tokens.length + 1}`;
        tokens.push(token);
        return { ok: true, status: 200, body: JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }), connectedAddress: '203.0.113.11' };
      }
      if (inner === null) throw new Error('no transport');
      return inner(request);
    });
  });

  it('sends a bearer token from the card’s token endpoint, and fetches a fresh one when the remote refuses it', async () => {
    const d = { store: runtime.store, nowMs: () => clock };
    const reg = await registerRemoteAgent(d, OAUTH_CARD_URL);
    if (!reg.ok) throw new Error(reg.reason);
    const cred = createRemoteCredential(d, reg.agent.agent_id, {
      kind: 'oauth2_client',
      scheme: 'oauth',
      secret: { client_id: 'c', client_secret: 's' },
      scopes: ['run'],
    });
    if (!cred.ok) throw new Error(cred.reason);
    bindRemoteSkill(d, reg.agent.agent_id, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref });
    activateRemoteAgent(d, reg.agent.agent_id);
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      gets += 1;
      if (gets === 1) return { ok: true, status: 401, body: '', connectedAddress: '203.0.113.11' };
      return task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
    };
    const p = proposeDelegation(runtime, { agentId: reg.agent.agent_id, skill: 'summarize', text: 'go', releaseSession: 'chat:main' });
    if (!p.ok) throw new Error(p.reason);
    workflow.approve(p.approvalTaskId);
    await runOnce();
    expect(rpcs.map((r) => [r.method, r.headers.Authorization])).toEqual([
      ['SendMessage', 'Bearer tok-1'],
      ['GetTask', 'Bearer tok-1'],
      ['GetTask', 'Bearer tok-2'],
    ]);
    expect(op(p.operationId)?.state).toBe('quarantined');
  });

  async function oauthAgent(): Promise<string> {
    const d = { store: runtime.store, nowMs: () => clock };
    const reg = await registerRemoteAgent(d, OAUTH_CARD_URL);
    if (!reg.ok) throw new Error(reg.reason);
    const cred = createRemoteCredential(d, reg.agent.agent_id, {
      kind: 'oauth2_client',
      scheme: 'oauth',
      secret: { client_id: 'c', client_secret: 's' },
      scopes: ['run'],
    });
    if (!cred.ok) throw new Error(cred.reason);
    bindRemoteSkill(d, reg.agent.agent_id, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref });
    activateRemoteAgent(d, reg.agent.agent_id);
    const p = proposeDelegation(runtime, { agentId: reg.agent.agent_id, skill: 'summarize', text: 'go', releaseSession: 'chat:main' });
    if (!p.ok) throw new Error(p.reason);
    workflow.approve(p.approvalTaskId);
    return p.operationId;
  }

  it('refreshes an OAuth token once while polling; refused again, the request ends with its cause', async () => {
    script = (rpc) =>
      rpc.method === 'SendMessage'
        ? { task: task('rt-1', 'TASK_STATE_WORKING') }
        : { ok: true, status: 401, body: '', connectedAddress: '203.0.113.11' };
    const id = await oauthAgent();
    await runOnce();
    expect(rpcs.map((r) => r.method)).toEqual(['SendMessage', 'GetTask', 'GetTask']);
    expect(tokens).toEqual(['tok-1', 'tok-2']);
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'remote_auth_refused_after_send' });
  });

  it('an OAuth token endpoint that does not answer before the send: nothing is sent, the permit is voided, and the owner reads why', async () => {
    failTokens = true;
    const id = await oauthAgent();
    await runOnce();
    expect(rpcs).toEqual([]);
    expect(op(id)).toMatchObject({ state: 'failed', reason_code: 'token_unavailable', message_id: null });
  });

  // Cold audit C4-2: an outage is not a refusal
  it.each([
    ['refuses the client', 401],
    ['is an address the policy refuses', 'address_blocked'],
  ] as const)('an OAuth token endpoint that %s before the send: the credential is unusable, never “try again”', async (_name, trouble) => {
    tokenTrouble = [trouble];
    const id = await oauthAgent();
    await runOnce();
    expect(rpcs).toEqual([]);
    expect(op(id)).toMatchObject({ state: 'failed', reason_code: 'credential_unusable', message_id: null });
  });

  it.each(['timeout', 503] as const)(
    'a token endpoint that does not answer (%s) while polling: the poll asks again, and the result still comes in',
    async (trouble) => {
      let gets = 0;
      script = (rpc) => {
        if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
        gets += 1;
        if (gets === 1) {
          // The cached token is refused: the next read needs a new one, and the endpoint is down for one try.
          tokenTrouble = [trouble];
          return { ok: true, status: 401, body: '', connectedAddress: '203.0.113.11' };
        }
        return task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
      };
      const id = await oauthAgent();
      await runOnce();
      expect(op(id)?.state).toBe('quarantined');
      expect(rpcs.map((r) => [r.method, r.headers.Authorization])).toEqual([
        ['SendMessage', 'Bearer tok-1'],
        ['GetTask', 'Bearer tok-1'],
        ['GetTask', 'Bearer tok-2'],
      ]);
    },
  );

  it('each read that goes through earns the next refused token its own refresh', async () => {
    const answers = ['401', 'working', '401', 'done'];
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      const next = answers.shift();
      if (next === '401') return { ok: true, status: 401, body: '', connectedAddress: '203.0.113.11' };
      return next === 'working' ? task('rt-1', 'TASK_STATE_WORKING') : task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'ok' }] }]);
    };
    const id = await oauthAgent();
    await runOnce();
    expect(op(id)?.state).toBe('quarantined');
    expect(tokens).toEqual(['tok-1', 'tok-2', 'tok-3']);
  });
});
