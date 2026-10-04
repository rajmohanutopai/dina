/**
 * The server's A2A delivery hop (design A2A-I7; notes M1a "idempotent by
 * event id"; plan X-5): on a server node Core owns the workflow event
 * consumer and forwards each A2A event to Brain's /api/v1/chat/a2a-result,
 * which appends once per event id. This drives the REAL lite
 * `wireWorkflowPlane`, with its own consumer and forwarding closure, and a
 * Brain that fails the first POST: the event comes again, and both POSTs name
 * the same event, operation and thread, so Brain's append-once rule holds.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import {
  A2AReleaseLog,
  A2AStore,
  activateRemoteAgent,
  beginOutboundDispatch,
  bindRemoteSkill,
  claimNextGuardJob,
  createCoreRouter,
  createNoneCredential,
  getA2ARuntime,
  getWorkflowService,
  installA2A,
  installA2AReleaseLog,
  proposeDelegation,
  recordRemoteOutcome,
  registerRemoteAgent,
  setA2AHostTransport,
  submitGuardVerdict,
  type A2ARuntime,
} from '@dina/core';

import { deriveIdentity } from '../src/identity/derivations';
import { initializeStorage } from '../src/storage/init';
import { wireWorkflowPlane, type WiredWorkflowPlane } from '../src/workflow/wire_workflow_plane';

import type { PdsIdentity } from '../src/identity/provision_pds';
import type { DatabaseAdapter } from '@dina/core/storage';

const logger = pino({ level: 'silent' });
const CARD_URL = 'https://agent.example/.well-known/agent-card.json';
const CARD = {
  name: 'Summarizer',
  description: 'Summarizes.',
  supportedInterfaces: [{ url: 'https://agent.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarize a text.', tags: ['text'] }],
};
const SESSION = 'chat:forward';
const THREAD = 'forward-thread';
const RUNNER = 'did:key:z6MkForwardRunner';
const A2A_RESULT_PATH = '/api/v1/chat/a2a-result';

interface Posted {
  path: string;
  body: Record<string, unknown>;
}

let dir: string;
let identityDB: DatabaseAdapter;
let wired: WiredWorkflowPlane | undefined;
let posts: Posted[];
let failNext: number;

/** Brain as the plane sees it: every POST recorded, the first `failNext` A2A ones answered 500. */
const brainFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  posts.push({ path: url.pathname, body });
  if (url.pathname === A2A_RESULT_PATH && failNext > 0) {
    failNext -= 1;
    return new Response('{"error":"brain restarting"}', { status: 500 });
  }
  return new Response('{"ok":true}', { status: 200 });
}) as typeof fetch;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'lane1-forward-'));
  posts = [];
  failNext = 1;
  const seed = new Uint8Array(32).fill(11);
  ({ identityDB } = await initializeStorage(seed, dir, logger));
  installA2A({ store: new A2AStore(identityDB) });
  setA2AHostTransport(async (request) =>
    request.url === CARD_URL
      ? { ok: true, status: 200, body: JSON.stringify(CARD), connectedAddress: '203.0.113.9' }
      : { ok: false, error: 'dns_failed', sent: false },
  );
  const derivations = deriveIdentity({ masterSeed: seed });
  const pdsIdentity: PdsIdentity = {
    did: 'did:plc:localforwardtest00000000000',
    handle: 'forward.local',
    password: 'x',
    email: 'forward@local',
    pdsUrl: 'https://pds.invalid',
  };
  wired = wireWorkflowPlane({
    identityDB,
    pdsIdentity,
    signingKeypair: { publicKey: derivations.root.publicKey, privateKey: derivations.root.privateKey },
    msgboxURL: 'wss://msgbox.invalid',
    appViewURL: 'https://appview.invalid',
    coreRouter: createCoreRouter({}),
    brainUrl: 'http://127.0.0.1:8299',
    brainFetch,
    logger,
  });
});

afterEach(async () => {
  if (wired !== undefined) await wired.dispose();
  wired = undefined;
  setA2AHostTransport(null);
  installA2AReleaseLog(null);
  installA2A(null);
  rmSync(dir, { recursive: true, force: true });
});

/** Wait (real time: the plane's consumer runs on its own 1s timer) until `done` holds. */
async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the plane');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Register, bind and activate an agent; propose, approve, dispatch, hold and release one result. */
async function releasedOperation(runtime: A2ARuntime): Promise<string> {
  const d = { store: runtime.store };
  const reg = await registerRemoteAgent(d, CARD_URL);
  if (!reg.ok) throw new Error(reg.reason);
  const agentId = reg.agent.agent_id;
  const cred = createNoneCredential(d, agentId);
  if (!cred.ok) throw new Error(cred.reason);
  expect(bindRemoteSkill(d, agentId, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref }).ok).toBe(true);
  expect(activateRemoteAgent(d, agentId)).toEqual({ ok: true });

  const log = new A2AReleaseLog(identityDB);
  installA2AReleaseLog(log);
  log.recordUtterance(SESSION, 'turn-1', 'Summarize my note for the agent.');
  const p = proposeDelegation(runtime, { agentId, skill: 'summarize', text: 'Summarize my note.', replyTo: THREAD, releaseSession: SESSION });
  if (!p.ok) throw new Error(p.reason);
  runtime.workflow.approve(p.approvalTaskId);

  const op = runtime.store.getTaskByExternal('outbound', 'owner', p.operationId);
  const childId = op === null ? undefined : runtime.store.childrenOf(op.id, 'dispatch')[0]?.child_task_id;
  const child = childId === undefined ? null : runtime.workflow.store().getById(childId);
  if (child === null) throw new Error('no dispatch child');
  const claimed = runtime.workflow.store().claimDelegationTask(RUNNER, Date.now(), 30_000, child.requested_runner ?? '');
  if (claimed === null) throw new Error('no claim');
  const claim = { childTaskId: claimed.id, claimId: claimed.claim_id ?? '', runnerDid: RUNNER };
  expect(beginOutboundDispatch(runtime, claim).kind).toBe('send');
  recordRemoteOutcome(runtime, claim, { kind: 'result', parts: [{ text: 'The summary.' }] });
  const job = claimNextGuardJob(runtime);
  if (job === null) throw new Error('no guard job');
  expect(submitGuardVerdict(runtime, { jobId: job.job_id, claimId: job.claim_id, digest: job.digest, verdict: 'passed', code: 'model_pass' }).ok).toBe(true);
  return p.operationId;
}

describe('Core forwards an A2A event to Brain by its event id (design A2A-I7; plan X-5)', () => {
  // Plan X-5 (the server hop: core-server's forwarding closure in wire_workflow_plane.ts)
  it('a POST Brain fails is sent again with the same event id, operation and thread, and the event is retired once Brain takes it', async () => {
    const runtime = getA2ARuntime();
    if (runtime === null || getWorkflowService() === null) throw new Error('the plane wired no A2A runtime');
    const operationId = await releasedOperation(runtime);
    const released = identityDB.query(`SELECT event_id FROM workflow_events WHERE event_kind = 'a2a_result_released'`) as { event_id: number }[];
    expect(released).toHaveLength(1);
    const eventId = released[0]?.event_id;

    // The consumer backs off 2s after the 500, then sends again.
    await until(() => posts.filter((p) => p.path === A2A_RESULT_PATH).length >= 2, 15_000);
    const forwarded = posts.filter((p) => p.path === A2A_RESULT_PATH);
    expect(forwarded).toHaveLength(2);
    for (const post of forwarded) {
      expect(post.body).toMatchObject({ event_id: eventId, operation_id: operationId, reply_to: THREAD });
      expect(post.body.text).toContain('The summary.');
    }
    expect(forwarded[1]?.body).toEqual(forwarded[0]?.body);

    // Brain took the second: Core retires the event, and nothing is sent a third time.
    await until(() => {
      const rows = identityDB.query(`SELECT needs_delivery FROM workflow_events WHERE event_id = ?`, [eventId]) as { needs_delivery: number }[];
      return rows[0]?.needs_delivery === 0;
    }, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(posts.filter((p) => p.path === A2A_RESULT_PATH)).toHaveLength(2);
  }, 30_000);
});
