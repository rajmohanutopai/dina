/**
 * Core's Lane 1 routes and the guard job routes print nothing they carry
 * (design §10 "metadata-only logs", §12 "no PII in gateway/runner logs"):
 * an operation driven end to end through the routes, with a credential
 * secret, personal details in the owner's words, a remote's answer and a
 * route fault, leaves no trace of any of them on the console.
 */

import { format } from 'node:util';

import { beginOutboundDispatch, recordRemoteOutcome } from '../../src/a2a';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';

import { LaneWorld, RUNNER_DID, SESSION, agentCard } from './outbound_fixture';

const CAP = 'owner-capability-for-tests';
const KEYED_URL = 'https://keyed.example/.well-known/agent-card.json';
const API_KEY = 'KEY-SECRET-6019';
const EMAIL = 'alonso@example.com';
const WORDS = `Write to ${EMAIL} about the booking.`;
const REMOTE = 'REMOTE-ANSWER-TEXT-7720';

let world: LaneWorld;
let router: CoreRouter;
let printed: string[];

beforeEach(() => {
  world = new LaneWorld();
  router = new CoreRouter();
  registerA2ARoutes(router, CAP);
  registerWorkflowRoutes(router, CAP);
  printed = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      // As a console prints it: an Error's message and stack show, as they would in a log.
      printed.push(format(...args));
    });
  }
  // The recorder sees what a console call prints, an Error's message included.
  console.error('probe', new Error('RECORDER-PROBE'));
  expect(printed.join('\n')).toContain('RECORDER-PROBE');
  printed = [];
});
afterEach(() => {
  jest.restoreAllMocks();
  world.close();
});

async function call(caller: 'brain' | 'owner', method: CoreRequest['method'], path: string, body: Record<string, unknown> = {}) {
  return router.handle({
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(caller === 'brain' ? { callerType: 'brain', callerDID: 'did:key:brain' } : { callerType: 'owner', ownerCapability: CAP }),
  });
}

describe('Lane 1 routes print nothing they carry (design §10, §12)', () => {
  // Plan X-4
  it('the owner, Brain and guard routes log no secret, no owner words, no original and no remote text', async () => {
    world.cards.set(
      KEYED_URL,
      agentCard({
        supportedInterfaces: [{ url: 'https://keyed.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X-Api-Key' } } },
        securityRequirements: [{ schemes: { key: { list: [] } } }],
      }),
    );
    const reg = await call('owner', 'POST', '/v1/owner/a2a/remote-agents', { card_url: KEYED_URL });
    const agentId = (reg.body as { agent_id: string }).agent_id;
    const cred = await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/credentials`, {
      kind: 'api_key',
      scheme: 'key',
      secret: { value: API_KEY },
    });
    expect(cred.status).toBe(201);
    const ref = (cred.body as { credential_ref: string }).credential_ref;
    // A refused secret is a route answer, never an echo.
    expect((await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/credentials/${ref}/rotate`, { secret: { value: `bad ${API_KEY}` } })).status).toBe(400);
    await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/bindings`, { skill: 'summarize', action_class: 'read', credential_ref: ref });
    expect((await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/activate`)).status).toBe(200);

    expect((await call('brain', 'POST', '/v1/a2a/turns', { release_session: SESSION, turn_id: 't-9', text: WORDS })).status).toBe(200);
    const proposed = await call('brain', 'POST', '/v1/a2a/delegate', {
      release_session: SESSION,
      agent_id: agentId,
      skill: 'summarize',
      text: WORDS,
      sources: [{ quote: WORDS, from: 'owner' }],
      reply_to: 'main',
    });
    expect(proposed.status).toBe(201);
    const { operation_id, approval_task_id } = proposed.body as { operation_id: string; approval_task_id: string };
    expect((await call('owner', 'POST', `/v1/workflow/tasks/${approval_task_id}/approve`)).status).toBe(200);

    const task = world.claim(agentId);
    if (task === null) throw new Error('claim');
    const claim = { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
    beginOutboundDispatch(world.runtime, claim);
    recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: `${REMOTE} for [EMAIL_1]` }] });

    const next = await call('brain', 'POST', '/v1/a2a/guard/next');
    const work = next.body as { job_id: string; claim_id: string; digest: string };
    expect((await call('brain', 'POST', '/v1/a2a/guard/verdict', { job_id: work.job_id, claim_id: work.claim_id, digest: work.digest, verdict: 'passed', code: 'model_pass' })).status).toBe(200);
    expect((await call('brain', 'GET', `/v1/a2a/operations/${operation_id}`)).status).toBe(200);
    const ownerView = await call('owner', 'GET', `/v1/owner/a2a/operations/${operation_id}`);
    expect(JSON.stringify(ownerView.body)).toContain(EMAIL); // the owner's legend: the original exists, and still is not logged

    // A route that meets a fault answers 500 and logs the error's name only.
    jest.spyOn(world.store, 'getTaskByExternal').mockImplementation(() => {
      throw new Error(`disk fault while reading ${WORDS} ${API_KEY} ${REMOTE}`);
    });
    expect((await call('brain', 'GET', `/v1/a2a/operations/${operation_id}`)).status).toBe(500);

    const all = printed.join('\n');
    // The fault was logged, so the search below reads real log lines.
    expect(all).toContain('handler threw');
    for (const text of [API_KEY, EMAIL, 'Write to', REMOTE]) {
      expect(all).not.toContain(text);
    }
  });
});
