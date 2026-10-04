/**
 * Lane 1 runner gaps (design §6.3–§6.5, A2A-I5, A2A-I8, plan §2 row 12)
 * against a scripted remote agent behind the outbound port: the owner's
 * cancel before a send, during it, and when the remote cannot be reached to
 * cancel; remote states met while polling; answers that are not strict
 * JSON-RPC; the shape of every call Dina makes; what the remote learns; and
 * what the runner writes to its log.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { format, inspect } from 'node:util';

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
  clearVaults,
  createA2ARuntime,
  createNoneCredential,
  createPersona,
  createRemoteCredential,
  getItem,
  installA2AReleaseLog,
  proposeDelegation,
  registerRemoteAgent,
  resetPersonaState,
  setA2AHostTransport,
  storeItem,
  type A2AHttpRequest,
  type A2AHttpResult,
  type A2ARuntime,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';
import { makeVaultItem } from '@dina/test-harness';

import { A2ADispatchRunner } from '../src/a2a_runner';

const START = 1_800_000_000_000;
const SESSION = 'chat:main';
const iface = (host: string, tenant?: string) => ({
  url: `https://${host}/rpc`,
  protocolBinding: 'JSONRPC',
  protocolVersion: '1.0',
  ...(tenant !== undefined ? { tenant } : {}),
});
const card = (host: string, over: Record<string, unknown> = {}) => ({
  name: 'Remote',
  description: 'A remote agent.',
  supportedInterfaces: [iface(host)],
  version: '1',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarize.', tags: ['text'] }],
  ...over,
});
const CARDS: Record<string, Record<string, unknown>> = {
  'https://agent.example/.well-known/agent-card.json': card('agent.example'),
  'https://tenant.example/.well-known/agent-card.json': card('tenant.example', { supportedInterfaces: [iface('tenant.example', 't-9')] }),
  'https://keyed.example/.well-known/agent-card.json': card('keyed.example', {
    securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X-Api-Key' } } },
    securityRequirements: [{ schemes: { key: { list: [] } } }],
  }),
};

interface Rpc { method: string; params: Record<string, unknown>; id: string; headers: Readonly<Record<string, string>>; raw: string }
type Script = (rpc: Rpc) => A2AHttpResult | Record<string, unknown>;

let dir: string;
let db: NodeSQLiteAdapter;
let runtime: A2ARuntime;
let workflow: WorkflowService;
let log: A2AReleaseLog;
let clock: number;
let script: Script;
let rpcs: Rpc[];

function task(id: string, state: string, artifacts?: unknown[]): Record<string, unknown> {
  return { id, contextId: 'ctx-1', status: { state }, ...(artifacts !== undefined ? { artifacts } : {}) };
}
const done = (text = 'ok') => task('rt-1', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text }] }]);
const answer = (body: string): A2AHttpResult => ({ ok: true, status: 200, body, connectedAddress: '203.0.113.9' });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-lane1-runner-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: '34'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  clock = START;
  const store = new A2AStore(db);
  const hooks = a2aWorkflowHooks(() => runtime);
  workflow = new WorkflowService({ repository: new SQLiteWorkflowRepository(db), nowMsFn: () => clock, approvalDecisionHandler: hooks.approvalDecisionHandler });
  runtime = createA2ARuntime({ store, workflow, nowMs: () => clock });
  rpcs = [];
  script = () => ({ message: { messageId: 'm-r', role: 'ROLE_AGENT', parts: [{ text: 'done' }] } });
  setA2AHostTransport(async (request: A2AHttpRequest): Promise<A2AHttpResult> => {
    const served = CARDS[request.url];
    if (request.method === 'GET' && served !== undefined) return answer(JSON.stringify(served));
    const raw = request.body ?? '{}';
    const body = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
    const rpc = { method: body.method, params: body.params, id: body.id, headers: request.headers, raw };
    rpcs.push(rpc);
    const out = script(rpc);
    if ('ok' in out && typeof out.ok === 'boolean') return out as A2AHttpResult;
    const reply = 'error' in out ? { jsonrpc: '2.0', id: body.id, error: out.error } : { jsonrpc: '2.0', id: body.id, result: out };
    return answer(JSON.stringify(reply));
  });
  log = new A2AReleaseLog(db, () => clock);
  installA2AReleaseLog(log);
  log.recordUtterance(SESSION, 'turn-1', 'Summarize this for me.');
});

afterEach(() => {
  setA2AHostTransport(null);
  installA2AReleaseLog(null);
  jest.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function agent(host = 'agent.example', secret?: string): Promise<{ agentId: string; credentialRef: string }> {
  const d = { store: runtime.store, nowMs: () => clock };
  const reg = await registerRemoteAgent(d, `https://${host}/.well-known/agent-card.json`);
  if (!reg.ok) throw new Error(reg.reason);
  const agentId = reg.agent.agent_id;
  const cred =
    secret === undefined
      ? createNoneCredential(d, agentId)
      : createRemoteCredential(d, agentId, { kind: 'api_key', scheme: 'key', secret: { value: secret } });
  if (!cred.ok) throw new Error(cred.reason);
  bindRemoteSkill(d, agentId, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref });
  activateRemoteAgent(d, agentId);
  return { agentId, credentialRef: cred.credential.credential_ref };
}

function runner(over: Partial<ConstructorParameters<typeof A2ADispatchRunner>[0]> = {}): A2ADispatchRunner {
  return new A2ADispatchRunner({
    runtime: () => runtime,
    runnerDid: 'did:key:z6MkLaneOneRunner',
    sleep: async (ms) => {
      clock += ms;
    },
    pollBackoffMs: [1_000],
    pollDeadlineMs: 60_000,
    ...over,
  });
}

function approved(agentId: string, text = 'Summarize this.', sources?: unknown): string {
  const p = proposeDelegation(runtime, { agentId, skill: 'summarize', text, replyTo: 'main', releaseSession: SESSION, ...(sources !== undefined ? { sources } : {}) });
  if (!p.ok) throw new Error(p.reason);
  workflow.approve(p.approvalTaskId);
  return p.operationId;
}

const op = (id: string) => runtime.store.getTaskByExternal('outbound', 'owner', id);

async function runOnce(r = runner()): Promise<void> {
  await r.tick();
  await r.flush();
}

describe('the owner’s cancel (design §6.4)', () => {
  // Plan B179
  it('a cancel before the runner claims the work sends nothing', async () => {
    const { agentId } = await agent();
    const id = approved(agentId);
    expect(cancelOutboundOperation(runtime, id)).toEqual({ ok: true, state: 'cancelled' });
    await runOnce();
    expect(rpcs).toEqual([]);
    expect(op(id)?.state).toBe('cancelled');
  });

  // Plan B179
  it('a cancel that lands between the claim and the dispatch transaction sends nothing', async () => {
    const { agentId } = await agent();
    const id = approved(agentId);
    const store = runtime.workflow.store();
    const real = store.claimDelegationTask.bind(store);
    jest.spyOn(store, 'claimDelegationTask').mockImplementation((...args) => {
      const claimed = real(...args);
      if (claimed !== null) cancelOutboundOperation(runtime, id);
      return claimed;
    });
    await runOnce();
    expect(rpcs).toEqual([]);
    expect(op(id)).toMatchObject({ state: 'cancelled', message_id: null });
  });

  // Plan B181
  it('a cancel during the send: the message goes once, and CancelTask is the next call', async () => {
    const { agentId } = await agent();
    let id = '';
    script = (rpc) => {
      if (rpc.method === 'SendMessage') {
        cancelOutboundOperation(runtime, id); // the owner presses cancel while the request is on the wire
        return { task: task('rt-1', 'TASK_STATE_WORKING') };
      }
      if (rpc.method === 'CancelTask') return task('rt-1', 'TASK_STATE_CANCELED');
      return task('rt-1', 'TASK_STATE_WORKING');
    };
    id = approved(agentId);
    await runOnce();
    expect(rpcs.map((r) => r.method)).toEqual(['SendMessage', 'CancelTask']);
    expect(op(id)).toMatchObject({ state: 'cancelled', reason_code: 'cancelled_by_owner' });
  });

  // Plan X-3
  it('a CancelTask that times out never reads as cancelled: polling goes on to the remote’s real end', async () => {
    const { agentId } = await agent();
    let id = '';
    let gets = 0;
    const states: string[] = [];
    script = (rpc) => {
      states.push(op(id)?.state ?? '');
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      if (rpc.method === 'CancelTask') return { ok: false, error: 'timeout', sent: true };
      gets += 1;
      if (gets === 1) cancelOutboundOperation(runtime, id);
      return gets < 4 ? task('rt-1', 'TASK_STATE_WORKING') : done('finished anyway');
    };
    id = approved(agentId);
    await runOnce();
    expect(rpcs.filter((r) => r.method === 'CancelTask').length).toBeGreaterThan(0);
    expect(states).not.toContain('cancelled');
    expect(op(id)?.state).toBe('quarantined');
  });

  // Plan X-3
  it('a CancelTask that cannot reach the remote never reads as cancelled: the outcome is unknown at the deadline', async () => {
    const { agentId } = await agent();
    let id = '';
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      if (rpc.method === 'CancelTask') return { ok: false, error: 'connect_failed', sent: false };
      gets += 1;
      if (gets === 1) cancelOutboundOperation(runtime, id);
      return task('rt-1', 'TASK_STATE_WORKING');
    };
    id = approved(agentId);
    await runOnce(runner({ pollDeadlineMs: 6_000 }));
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'deadline' });
  });
});

describe('remote states while polling (design §6.4)', () => {
  // Plan B187
  it('INPUT_REQUIRED met while polling ends the call remote_needs_input, with no second message', async () => {
    const { agentId } = await agent();
    script = (rpc) => (rpc.method === 'SendMessage' ? { task: task('rt-1', 'TASK_STATE_WORKING') } : task('rt-1', 'TASK_STATE_INPUT_REQUIRED'));
    const id = approved(agentId);
    await runOnce();
    expect(rpcs.map((r) => r.method)).toEqual(['SendMessage', 'GetTask']);
    expect(op(id)).toMatchObject({ state: 'failed', reason_code: 'remote_needs_input' });
  });

  // Plan B188
  it('UNSPECIFIED: the runner polls again, and the outcome is unknown at the deadline', async () => {
    const { agentId } = await agent();
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_UNSPECIFIED') };
      gets += 1;
      return task('rt-1', 'TASK_STATE_UNSPECIFIED');
    };
    const id = approved(agentId);
    await runOnce(runner({ pollDeadlineMs: 5_000 }));
    expect(gets).toBeGreaterThan(1);
    expect(op(id)).toMatchObject({ state: 'outcome_unknown', reason_code: 'deadline' });
  });

  // Plan B197 (§6.5: whatever the answer names, it goes through the guard)
  it('Core holds a GetTask answer that names another task for the guard, like any answer, and releases nothing unscanned', async () => {
    const { agentId } = await agent();
    script = (rpc) =>
      rpc.method === 'SendMessage'
        ? { task: task('rt-1', 'TASK_STATE_WORKING') }
        : task('someone-else', 'TASK_STATE_COMPLETED', [{ artifactId: 'a', parts: [{ text: 'not yours' }] }]);
    const id = approved(agentId);
    await runOnce();
    const row = op(id);
    expect(row).toMatchObject({ state: 'quarantined', result_json: null, remote_task_id: 'rt-1' });
    expect(runtime.store.getGuardJobForOperation(row?.id ?? 0)?.state).toBe('pending');
  });
});

describe('answers that are not strict JSON-RPC are never a result (design §6.4, strict I-JSON)', () => {
  const message = '{"messageId":"m","role":"ROLE_AGENT","parts":[{"text":"x"}]}';
  // Each body answers the id the runner really sent (`@ID`), so each row meets its own rule.
  const reply = (body: string): Script => (rpc) => answer(body.replaceAll('@ID', rpc.id));

  // Plan B192 (control: a strict answer to the same call is a result held for the guard)
  it('a strict answer with the runner’s own id is held for the guard', async () => {
    const { agentId } = await agent();
    script = reply(`{"jsonrpc":"2.0","id":"@ID","result":{"message":${message}}}`);
    const id = approved(agentId);
    await runOnce();
    const row = op(id);
    expect(row?.state).toBe('quarantined');
    expect(runtime.store.getGuardJobForOperation(row?.id ?? 0)?.state).toBe('pending');
  });

  // Plan B192
  it.each([
    ['duplicate members', `{"jsonrpc":"2.0","id":"@ID","result":{"message":${message}},"result":{"message":${message}}}`, 'response_malformed'],
    ['a __proto__ member', `{"jsonrpc":"2.0","id":"@ID","result":{"message":${message},"__proto__":{"task":{}}}}`, 'response_malformed'],
    ['another JSON-RPC id', `{"jsonrpc":"2.0","id":"@ID-x","result":{"message":${message}}}`, 'response_malformed'],
    ['a task and a message in one answer', `{"jsonrpc":"2.0","id":"@ID","result":{"task":{"id":"rt","status":{"state":"TASK_STATE_COMPLETED"}},"message":${message}}}`, 'response_invalid'],
  ])('%s: the outcome is unknown, and Core holds no result', async (_name, body, reason) => {
    const { agentId } = await agent();
    script = reply(body);
    const id = approved(agentId);
    await runOnce();
    const row = op(id);
    expect(rpcs.map((r) => r.method)).toEqual(['SendMessage']);
    expect(row?.state).toBe('outcome_unknown');
    expect(row?.reason_code).toBe(reason);
    expect(row?.result_quarantine).toBeNull();
    expect(runtime.store.getGuardJobForOperation(row?.id ?? 0)).toBeNull();
  });
});

describe('the shape of every call (plan §2 row 12; notes M1a "recording its tenant")', () => {
  async function everyCall(host: string): Promise<Rpc[]> {
    const { agentId } = await agent(host);
    let id = '';
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      if (rpc.method === 'CancelTask') return task('rt-1', 'TASK_STATE_CANCELED');
      cancelOutboundOperation(runtime, id);
      return task('rt-1', 'TASK_STATE_WORKING');
    };
    id = approved(agentId);
    await runOnce();
    return rpcs;
  }

  // Plan X-2
  it('SendMessage, GetTask and CancelTask each carry A2A-Version 1.0 and the pinned tenant', async () => {
    const calls = await everyCall('tenant.example');
    expect(calls.map((r) => r.method)).toEqual(['SendMessage', 'GetTask', 'CancelTask']);
    for (const rpc of calls) {
      expect(rpc.headers['A2A-Version']).toBe('1.0');
      expect(rpc.params.tenant).toBe('t-9');
    }
  });

  // Plan X-2
  it('sends no tenant when the pinned interface names none', async () => {
    const calls = await everyCall('agent.example');
    expect(calls.map((r) => r.method)).toEqual(['SendMessage', 'GetTask', 'CancelTask']);
    for (const rpc of calls) {
      expect(rpc.headers['A2A-Version']).toBe('1.0');
      expect(Object.prototype.hasOwnProperty.call(rpc.params, 'tenant')).toBe(false);
    }
  });
});

describe('what the remote learns (A2A-I5)', () => {
  // Plan X-9
  it('gets a fresh UUID messageId and no workflow, operation, permit, claim, credential or vault id', async () => {
    clearVaults();
    resetPersonaState();
    createPersona('general', 'default');
    try {
      const { agentId, credentialRef } = await agent();
      const NOTE = 'The clinic opens at nine on weekdays.';
      const item = makeVaultItem({ summary: 'Note', body: NOTE });
      jest.spyOn(Date, 'now').mockReturnValueOnce(START - 60_000);
      storeItem('general', item);
      getItem('general', item.id, { sessionId: SESSION, audience: 'brain' });
      let claimId = '';
      let childId = '';
      script = (rpc) => (rpc.method === 'SendMessage' ? { task: task('rt-1', 'TASK_STATE_WORKING') } : done());
      const id = approved(agentId, NOTE, [{ quote: NOTE, from: 'vault', persona: 'general', item_id: item.id }]);
      const row = op(id);
      if (row === null) throw new Error('no operation');
      const children = runtime.store.childrenOf(row.id).map((c) => c.child_task_id);
      const store = runtime.workflow.store();
      const real = store.claimDelegationTask.bind(store);
      jest.spyOn(store, 'claimDelegationTask').mockImplementation((...args) => {
        const claimed = real(...args);
        if (claimed !== null) {
          claimId = claimed.claim_id ?? '';
          childId = claimed.id;
        }
        return claimed;
      });
      await runOnce();
      const permits = runtime.store.permitsOf(row.id).map((p) => p.permit_id);
      const sent = rpcs.find((r) => r.method === 'SendMessage');
      const message = (sent?.params.message ?? {}) as Record<string, unknown>;
      expect(message.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(message.messageId).not.toBe(id);
      expect(Object.keys(message).sort()).toEqual(['messageId', 'parts', 'role']);
      const internal = [id, row.request_hash ?? '', agentId, credentialRef, item.id, claimId, childId, ...children, ...permits].filter((x) => x !== '');
      expect(internal.length).toBeGreaterThan(6);
      for (const rpc of rpcs) {
        const wire = `${rpc.raw}\n${JSON.stringify(rpc.headers)}`;
        expect(internal.filter((x) => wire.includes(x))).toEqual([]);
      }
    } finally {
      resetPersonaState();
    }
  });
});

describe('what the runner logs (design §10, §12: metadata only)', () => {
  // Plan X-4
  it('logs ids, states and codes only: no message text, original, result, secret or remote text', async () => {
    const KEY = 'KEY-SECRET-4410';
    const EMAIL = 'alonso@example.com';
    const TEXT = `Write to ${EMAIL} about the booking.`;
    const { agentId } = await agent('keyed.example', KEY);
    let gets = 0;
    script = (rpc) => {
      if (rpc.method === 'SendMessage') return { task: task('rt-1', 'TASK_STATE_WORKING') };
      gets += 1;
      if (gets === 1) return { error: { code: -32603, message: 'REMOTE-ERROR-TEXT-88' } };
      return done('REMOTE-RESULT-TEXT-91');
    };
    const entries: Record<string, unknown>[] = [];
    const printed: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        // format() prints objects whole, as the console would, so a leak inside one shows.
        printed.push(format(...args));
      });
    }
    log.recordUtterance(SESSION, 'turn-2', TEXT);
    const id = approved(agentId, TEXT, [{ quote: TEXT, from: 'owner' }]);
    await runOnce(runner({ log: (e) => entries.push(e) }));
    expect(op(id)?.state).toBe('quarantined');
    expect(entries.length).toBeGreaterThan(0);
    // Printed as a logger would print them: an Error inside an entry shows its message and stack.
    const logged = `${inspect(entries, { depth: null })}\n${printed.join('\n')}`;
    for (const secret of [KEY, EMAIL, 'Write to', 'REMOTE-ERROR-TEXT-88', 'REMOTE-RESULT-TEXT-91']) {
      expect(logged).not.toContain(secret);
    }
  });
});
