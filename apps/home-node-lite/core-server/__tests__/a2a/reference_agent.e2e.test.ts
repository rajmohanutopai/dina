/**
 * A2A Lane 1 end to end (design §12 M1a done-when) against a real a2a-sdk
 * agent (`reference/agent.py`, Python, pinned in `reference/requirements.txt`):
 * the owner registers the live card over TLS, binds a skill and activates,
 * all through Core's owner routes; Brain proposes through its client; the
 * owner approves; the runner sends `SendMessage` through the real host
 * transport (resolve, vet, pin, TLS) and polls `GetTask`; Brain's guard
 * worker scans the held result; the conversation's sentence is Dina's own.
 * Includes the agent that answers with a bare `Message`.
 *
 * Runs when the reference venv exists (`scripts/test/a2a_reference_e2e.sh`
 * creates it) or `DINA_A2A_REFERENCE_PYTHON` names a Python with a2a-sdk;
 * skipped otherwise — unless `DINA_A2A_REFERENCE_REQUIRED=1`, which turns a
 * missing interpreter into a failure, so a run that must cover it cannot
 * pass by skipping.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { A2AGuardWorker, a2aDeliveryText } from '@dina/brain';
import {
  A2AReleaseLog,
  A2AStore,
  IDENTITY_MIGRATIONS,
  InProcessTransport,
  SQLiteWorkflowRepository,
  WorkflowService,
  applyMigrations,
  createCoreRouter,
  installA2AReleaseLog,
  setA2AHostTransport,
  setWorkflowService,
  type CoreRequest,
  type CoreRouter,
} from '@dina/core';
import { a2aWorkflowHooks, getA2ARuntime, installA2A } from '@dina/core/runtime';
import { A2ADispatchRunner } from '@dina/home-node';
import { createA2AHostTransport } from '@dina/net-node';
import { NodeSQLiteAdapter } from '@dina/storage-node';


const REFERENCE_DIR = path.join(__dirname, 'reference');
const PYTHON = process.env.DINA_A2A_REFERENCE_PYTHON ?? path.join(REFERENCE_DIR, '.venv', 'bin', 'python');
const AVAILABLE = existsSync(PYTHON);
const REQUIRED = process.env.DINA_A2A_REFERENCE_REQUIRED === '1';
const CERT = readFileSync(path.join(__dirname, '..', 'fixtures', 'a2a_tls', 'localhost.cert.pem'), 'utf8');
const CAP = 'owner-capability-e2e';

/** Start the agent on a port it binds itself; resolves with the port it reports. */
async function startAgent(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(PYTHON, [path.join(REFERENCE_DIR, 'agent.py'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reference agent did not start')), 20_000);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const ready = /READY (\d+)/.exec(out);
      if (ready !== null) {
        clearTimeout(timer);
        resolve(Number(ready[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`reference agent exited ${String(code)}`));
    });
  });
  return { child, port };
}

if (!AVAILABLE && REQUIRED) {
  it('has the reference agent’s Python (DINA_A2A_REFERENCE_REQUIRED=1)', () => {
    throw new Error(`no a2a-sdk Python at ${PYTHON}: run scripts/test/a2a_reference_e2e.sh`);
  });
}

(AVAILABLE ? describe : describe.skip)('A2A Lane 1 against the a2a-sdk reference agent', () => {
  let agent: ChildProcess;
  let port: number;
  let dir: string;
  let db: NodeSQLiteAdapter;
  let workflow: WorkflowService;
  let router: CoreRouter;
  let brain: InProcessTransport;
  let runner: A2ADispatchRunner;
  let guard: A2AGuardWorker;
  let agentId: string;
  let credentialRef: string;
  let releaseLog: A2AReleaseLog;
  let turns = 0;

  const owner = async (method: CoreRequest['method'], p: string, body: Record<string, unknown> = {}) =>
    router.handle({
      method,
      path: p,
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: CAP,
    });

  beforeAll(async () => {
    ({ child: agent, port } = await startAgent());
    dir = mkdtempSync(path.join(tmpdir(), 'a2a-e2e-'));
    db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: '9a'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    const hooks = a2aWorkflowHooks(getA2ARuntime);
    workflow = new WorkflowService({ repository: new SQLiteWorkflowRepository(db), approvalDecisionHandler: hooks.approvalDecisionHandler });
    setWorkflowService(workflow);
    installA2A({ store: new A2AStore(db) });
    releaseLog = new A2AReleaseLog(db);
    installA2AReleaseLog(releaseLog);
    setA2AHostTransport(
      createA2AHostTransport({
        resolve: async (host) => (host === 'agent.test' ? ['127.0.0.1'] : []),
        isAllowedAddress: (a) => a === '127.0.0.1',
        ca: CERT,
      }),
    );
    router = createCoreRouter({ ownerCapability: CAP });
    brain = new InProcessTransport(router);
    runner = new A2ADispatchRunner({ runtime: getA2ARuntime, runnerDid: 'did:key:e2e#a2a-runner', pollBackoffMs: [250], pollDeadlineMs: 20_000 });
    guard = new A2AGuardWorker({ core: brain, llm: async () => '{"verdict":"pass","reason":"plain answer"}' });

    const registered = await owner('POST', '/v1/owner/a2a/remote-agents', { card_url: `https://agent.test:${port}/.well-known/agent-card.json` });
    expect(registered.status).toBe(201);
    agentId = (registered.body as { agent_id: string }).agent_id;
    const cred = await owner('POST', `/v1/owner/a2a/remote-agents/${agentId}/credentials`, { kind: 'none' });
    credentialRef = (cred.body as { credential_ref: string }).credential_ref;
    expect((await owner('POST', `/v1/owner/a2a/remote-agents/${agentId}/bindings`, { skill: 'echo', action_class: 'read', credential_ref: credentialRef })).status).toBe(200);
    expect((await owner('POST', `/v1/owner/a2a/remote-agents/${agentId}/activate`)).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await runner?.stop();
    await guard?.stop();
    agent?.kill();
    setA2AHostTransport(null);
    installA2A(null);
    installA2AReleaseLog(null);
    setWorkflowService(null);
    db?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** Brain proposes, the owner approves, the runner runs, the guard scans. */
  async function delegate(text: string): Promise<{ operationId: string; state: string; sentence: string | null }> {
    // The owner said it, through the chat entry: the turn the proposal belongs to.
    turns += 1;
    await brain.recordOwnerTurn({ releaseSession: 'chat:main', turnId: `turn-${turns}`, text });
    const proposed = await brain.delegateToA2AAgent({
      agentId,
      skill: 'echo',
      text,
      replyTo: 'main',
      releaseSession: 'chat:main',
      sources: [{ quote: text, from: 'owner' }],
    });
    if (!proposed.ok) throw new Error(`proposal refused: ${proposed.reason}`);
    workflow.approve(proposed.approvalTaskId);
    await runner.tick();
    await runner.flush();
    await guard.tick();
    const op = await brain.getA2AOperation(proposed.operationId);
    if (op === null) throw new Error('operation vanished');
    // Exactly one ending event, on one of the operation's tasks: its sentence is what the owner hears.
    const store = new A2AStore(db);
    const repo = new SQLiteWorkflowRepository(db);
    const row = store.getTaskByExternal('outbound', 'owner', proposed.operationId);
    const endings = (row === null ? [] : store.childrenOf(row.id))
      .flatMap((child) => repo.listEventsForTask(child.child_task_id))
      .filter((e) => ['a2a_operation_ended', 'a2a_result_released', 'a2a_result_blocked'].includes(e.event_kind));
    expect(endings).toHaveLength(1);
    const kind = endings[0]?.event_kind ?? '';
    return { operationId: proposed.operationId, state: op.state, sentence: a2aDeliveryText(kind, op) };
  }

  it('pinned the live card and its JSON-RPC 1.0 endpoint', async () => {
    const view = await owner('GET', `/v1/owner/a2a/remote-agents/${agentId}`);
    expect(view.body).toMatchObject({
      status: 'active',
      endpoint: `https://agent.test:${port}/rpc`,
      signature_state: 'unsigned',
      skills: [{ id: 'echo', name: 'Echo' }],
    });
    const listed = await brain.listA2AAgents();
    expect(listed.map((a) => a.agent_id)).toEqual([agentId]);
  });

  it('takes a bare Message answer as the result', async () => {
    const out = await delegate('MODE:message hello there');
    expect(out.state).toBe('completed');
    expect(out.sentence).toBe('Reference Agent answered:\n\necho: MODE:message hello there');
  });

  it('takes a completed task’s artifact as the result', async () => {
    const out = await delegate('MODE:task build it');
    expect(out.sentence).toBe('Reference Agent answered:\n\ndone: MODE:task build it');
  });

  it('polls a working task with GetTask until it completes', async () => {
    const out = await delegate('MODE:slow take your time');
    expect(out.sentence).toBe('Reference Agent answered:\n\nslow work finished');
  }, 30_000);

  it('ends INPUT_REQUIRED and FAILED tasks in Dina’s words', async () => {
    expect((await delegate('MODE:input ask me')).sentence).toMatch(/needs more information/);
    expect((await delegate('MODE:fail please')).sentence).toBe('Reference Agent could not do it.');
  });

  it('holds back a result that tries to instruct Dina', async () => {
    const out = await delegate('MODE:inject now');
    expect(out.state).toBe('blocked');
    expect(out.sentence).toMatch(/held back the answer/);
    const op = await brain.getA2AOperation(out.operationId);
    expect(JSON.stringify(op)).not.toContain('passwords');
  });

  it('validates against a pinned result schema in force at consent', async () => {
    expect(
      (await owner('POST', `/v1/owner/a2a/remote-agents/${agentId}/bindings`, {
        skill: 'echo',
        action_class: 'read',
        credential_ref: credentialRef,
        result_schema: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } },
      })).status,
    ).toBe(200);
    expect((await delegate('MODE:data count')).sentence).toBe('Reference Agent answered:\n\n{\n  "total": 3\n}');
    expect((await delegate('MODE:message not data')).sentence).toMatch(/could not accept/);
  });

  it('keeps the pin when the unchanged card is fetched again', async () => {
    const verified = await owner('POST', `/v1/owner/a2a/remote-agents/${agentId}/verify`);
    expect(verified.body).toMatchObject({ changed: false });
  });
});
