/**
 * A `SendMessage` waits for its task (A2A `returnImmediately`, false by
 * default: "the operation MUST wait until the task reaches a terminal ... or
 * interrupted ... state"; `true` returns once the task is made). The wait
 * holds no transaction and ends when the task completes, fails, is refused
 * or canceled, or asks the caller (INPUT_REQUIRED). The answer is the view
 * GetTask would give at that moment, egress checks included. Past its bound
 * the caller gets an error naming the task, never the unfinished task, and
 * the task goes on. A credential that ends while the call waits (§10) ends
 * the wait with 401 and leaves the task alone. A stream never waits. Both
 * bindings reach the same wait through Core's route.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import { A2A_DID_BINDING_PATH, A2A_SEND_WAIT_MS, didBindingSigningInput, dinaErrorInfo, type JsonObject } from '@dina/a2a';

import {
  A2A_BEARER_LIFETIME_MS,
  INBOUND_WAIT_RECHECK_MS,
  awaitSendMessage,
  ingressCompleteDidBinding,
  ingressGetTask,
  ingressSendMessage,
  installA2ADidResolver,
  issueDidChallenge,
  requestInboundInputWith,
  revokeA2AClient,
  rotateA2AClientToken,
  type A2ADidResolution,
} from '../../src/a2a';
import { InboundChangeSignal, inboundChangeSignal } from '../../src/a2a/change_signal';
import { getPublicKey, sign } from '../../src/crypto/ed25519';
import { publicKeyToMultibase } from '../../src/identity/did';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { registerA2AIngressRoutes, resetA2AIngressState } from '../../src/server/routes/a2a_ingress';
import { clearServiceConfigDurable } from '../../src/service/service_config';
import { SQLiteServiceGrantRepository } from '../../src/service/service_grant_repository';

import { INBOUND_NODE_DID, InboundWorld, errorOf, resultOf } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  resetA2AIngressState();
  iw = await InboundWorld.create();
});
afterEach(() => {
  // A test that ended early must not leave its runner to act on a closed world.
  for (const timer of pending.splice(0)) clearTimeout(timer);
  jest.restoreAllMocks();
  iw.close();
});

const ETA = { skill: 'eta_query', params: { route_id: '42' } };
const ASK = { prompt: 'Which stop?', input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } } };

let msg = 0;
/** A SendMessage, awaited as the route serves it; `configuration` as the client sent it. */
function send(data: Record<string, unknown>, opts: { configuration?: unknown; waitMs?: number; over?: Record<string, unknown> } = {}) {
  msg += 1;
  const params = {
    ...iw.message(data, { messageId: `wait-${msg}`, ...opts.over }),
    ...(opts.configuration === undefined ? {} : { configuration: opts.configuration }),
  };
  return awaitSendMessage(iw.rt, iw.request('SendMessage', params), opts.waitMs ?? 3_000);
}

/** The Task of an answer, with how long the answer took. */
async function timed(answer: Promise<{ body?: unknown }>): Promise<{ task: Record<string, unknown>; state: string; ms: number }> {
  const started = performance.now();
  const task = resultOf(await answer).task as Record<string, unknown>;
  return { task, state: (task.status as { state: string }).state, ms: performance.now() - started };
}

const pending: ReturnType<typeof setTimeout>[] = [];
/** Run `fn` once the call is committed and waiting. */
const soon = (fn: () => void | Promise<void>, ms = 40): void => {
  pending.push(setTimeout(() => void fn(), ms));
};

/** The error a wait that ran out answers: its code, reason and the task it names. */
function deadlineError(answer: { body?: unknown }): { code: number; reason?: string; task_id?: string } {
  const error = (answer.body as { error?: { code: number; data?: JsonObject[] } }).error;
  if (error === undefined) throw new Error(`no error: ${JSON.stringify(answer.body)}`);
  const info = dinaErrorInfo(error) as { reason: string; metadata?: { task_id: string } } | undefined;
  return { code: error.code, ...(info === undefined ? {} : { reason: info.reason, task_id: info.metadata?.task_id ?? '' }) };
}

/** The task's state as the client reads it now, under its current bearer. */
const stateByGet = (taskId: string) =>
  ((resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id: taskId }), taskId)) as { status: { state: string } }).status.state);

/** The only open call's id: the one the client is waiting on. */
const waitingId = () => {
  const rows = iw.world.store.db.query(`SELECT external_id FROM a2a_tasks WHERE direction = 'inbound' AND state = 'open'`) as unknown as {
    external_id: string;
  }[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`open calls: ${rows.length}`);
  return rows[0].external_id;
};

describe('a call that did not ask to return at once waits for its task to end or ask', () => {
  it.each([
    ['omitted', undefined],
    ['false', { returnImmediately: false }],
  ])('returnImmediately %s: answered COMPLETED, with the result, once the runner finishes', async (_name, configuration) => {
    soon(() => iw.runChild(waitingId(), { eta_minutes: 4 }));
    const out = await timed(send(ETA, configuration === undefined ? {} : { configuration }));
    expect(out.state).toBe('TASK_STATE_COMPLETED');
    expect(JSON.stringify(out.task.artifacts)).toContain('"eta_minutes":4');
    // Woken by the change, not by the recheck.
    expect(out.ms).toBeLessThan(INBOUND_WAIT_RECHECK_MS);
    expect(inboundChangeSignal(iw.world.store).size).toBe(0);
  });

  it('a run that fails ends the wait: FAILED', async () => {
    soon(() => {
      const { taskId } = iw.claimChild(waitingId());
      iw.world.workflow.fail(taskId, 'boom', iw.runnerDid);
    });
    expect((await timed(send(ETA))).state).toBe('TASK_STATE_FAILED');
  });

  it('a task that asks the caller ends the wait: INPUT_REQUIRED, with its question', async () => {
    soon(() => {
      const { taskId } = iw.claimChild(waitingId());
      const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
      requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ASK });
    });
    const out = await timed(send(ETA));
    expect(out.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(JSON.stringify(out.task.status)).toContain('Which stop?');
  });

  it('an answer to that question waits for the next round the same way', async () => {
    const id = (resultOf(ingressSendMessage(iw.rt, iw.request('SendMessage', iw.message(ETA, { messageId: 'first-round' })))).task as { id: string }).id;
    const { taskId } = iw.claimChild(id);
    const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
    requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ASK });
    soon(() => iw.runChild(id, { eta_minutes: 6 }));
    const out = await timed(send({ stop: 'Elm' }, { over: { taskId: id } }));
    expect(out.task.id).toBe(id);
    expect(out.state).toBe('TASK_STATE_COMPLETED');
  });

  it('a retry of the same message waits for the same task', async () => {
    const env = iw.request('SendMessage', iw.message(ETA, { messageId: 'retried' }));
    const first = resultOf(ingressSendMessage(iw.rt, env)).task as { id: string };
    soon(() => iw.runChild(first.id, { eta_minutes: 2 }));
    const out = await timed(awaitSendMessage(iw.rt, { ...env, request: { ...env.request } }, 3_000));
    expect([out.task.id, out.state]).toEqual([first.id, 'TASK_STATE_COMPLETED']);
  });

  it('a task unfinished at the bound: an error naming the task, never the unfinished task; the task goes on', async () => {
    const started = performance.now();
    const answer = await send(ETA, { waitMs: 150 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    const taskId = waitingId();
    expect(deadlineError(answer)).toEqual({ code: -32603, reason: 'wait_deadline_exceeded', task_id: taskId });
    expect(inboundChangeSignal(iw.world.store).size).toBe(0);
    // Nothing about the task changed: it is still queued for its runner.
    expect(iw.opOf(taskId)).toEqual(expect.objectContaining({ state: 'open' }));
    expect(stateByGet(taskId)).toBe('TASK_STATE_SUBMITTED');
  });

  it('a task that finishes after the bound: the same message again waits again, and gets the result', async () => {
    const params = iw.message(ETA, { messageId: 'slow-runner' });
    const first = await awaitSendMessage(iw.rt, iw.request('SendMessage', params), 100);
    const taskId = deadlineError(first).task_id ?? '';
    soon(() => iw.runChild(taskId, { eta_minutes: 11 }));
    const again = await timed(awaitSendMessage(iw.rt, iw.request('SendMessage', params), 3_000));
    expect([again.task.id, again.state]).toEqual([taskId, 'TASK_STATE_COMPLETED']);
  });

  it('a change that is never signalled is still read, at the next recheck', async () => {
    jest.spyOn(InboundChangeSignal.prototype, 'notify').mockImplementation(() => undefined);
    soon(() => iw.runChild(waitingId(), { eta_minutes: 3 }));
    const out = await timed(send(ETA, { waitMs: 5_000 }));
    expect(out.state).toBe('TASK_STATE_COMPLETED');
    expect(out.ms).toBeLessThan(INBOUND_WAIT_RECHECK_MS + 1_000);
  });

  it('the answer goes through GetTask’s egress check: a listing deleted while the call waited withholds the result', async () => {
    soon(() => {
      iw.runChild(waitingId(), { eta_minutes: 9 });
      void clearServiceConfigDurable('bus');
    });
    const out = await timed(send(ETA));
    expect(out.state).toBe('TASK_STATE_FAILED');
    expect(out.task.artifacts).toBeUndefined();
    expect(JSON.stringify(out.task)).not.toContain('eta_minutes');
  });
});

describe('a credential that ends while the call waits takes the answer with it (§10), never the task', () => {
  /**
   * While the call waits: end the credential and finish the task, in the
   * order given. `finished_first` finishes it and ends the credential in the
   * same turn, so the result is there when the call looks again; a revoked
   * client's runner could not claim the task afterwards.
   */
  async function endedDuringWait(end: () => void | Promise<void>, order: 'ended_first' | 'finished_first') {
    let taskId = '';
    soon(async () => {
      taskId = waitingId();
      if (order === 'finished_first') {
        iw.runChild(taskId, { eta_minutes: 9 });
        await end();
      } else {
        await end();
        iw.runChild(taskId, { eta_minutes: 9 });
      }
    });
    const answer = await send(ETA);
    return { answer, taskId };
  }

  const rotate = () => {
    const rotated = rotateA2AClientToken(iw.world.store, iw.clientId, iw.world.clock);
    if (!rotated.ok) throw new Error(rotated.reason);
    iw.token = rotated.token;
  };

  it.each(['ended_first', 'finished_first'] as const)('a rotated bearer (%s): 401, and the result is the new bearer’s to read', async (order) => {
    const { answer, taskId } = await endedDuringWait(rotate, order);
    expect(answer).toEqual(expect.objectContaining({ status: 401, headers: { 'www-authenticate': 'Bearer realm="dina-a2a"' } }));
    expect(JSON.stringify(answer)).not.toContain('eta_minutes');
    // The task went on, and the client reads it under its new bearer.
    expect(stateByGet(taskId)).toBe('TASK_STATE_COMPLETED');
  });

  it('a DID bound in place of the bearer: 401', async () => {
    const PLC = 'did:plc:waitbinding0000000000000';
    const key = new Uint8Array(32).fill(71);
    installA2ADidResolver(async (): Promise<A2ADidResolution> => ({
      kind: 'document',
      document: { id: PLC, verificationMethod: [{ id: `${PLC}#dina_signing`, type: 'Multikey', controller: PLC, publicKeyMultibase: publicKeyToMultibase(getPublicKey(key)) }] },
    }));
    try {
      const { answer } = await endedDuringWait(async () => {
        const issued = issueDidChallenge(iw.world.store, iw.clientId, PLC, iw.world.clock);
        if (!issued.ok) throw new Error(issued.reason);
        const input = didBindingSigningInput({ nodeDid: INBOUND_NODE_DID, clientId: iw.clientId, did: PLC, challenge: issued.challenge });
        const body = JSON.stringify({ did: PLC, challenge: issued.challenge, signature: bytesToHex(sign(key, new TextEncoder().encode(input))) });
        const bound = await ingressCompleteDidBinding(
          iw.rt,
          { request: { method: 'POST', path: A2A_DID_BINDING_PATH, query: '', body }, client_auth: {} },
          INBOUND_NODE_DID,
        );
        if (bound.status !== 200) throw new Error(JSON.stringify(bound.body));
      }, 'ended_first');
      expect(answer.status).toBe(401);
      expect(JSON.stringify(answer)).not.toContain('eta_minutes');
    } finally {
      installA2ADidResolver(null);
    }
  });

  it('a bearer that ran out: 401, and nothing of the result', async () => {
    const { answer } = await endedDuringWait(() => {
      iw.world.clock += A2A_BEARER_LIFETIME_MS;
    }, 'finished_first');
    expect(answer.status).toBe(401);
    expect(JSON.stringify(answer)).not.toContain('eta_minutes');
  });

  it('a revoked client: 401, and nothing of the result', async () => {
    const { answer } = await endedDuringWait(() => {
      expect(revokeA2AClient(iw.world.store, new SQLiteServiceGrantRepository(iw.world.store.db), iw.clientId, iw.world.clock).ok).toBe(true);
    }, 'finished_first');
    expect(answer.status).toBe(401);
    expect(JSON.stringify(answer)).not.toContain('eta_minutes');
  });
});

describe('what does not wait', () => {
  it('returnImmediately true: answered once the task is made, SUBMITTED, nothing left waiting', async () => {
    const out = await timed(send(ETA, { configuration: { returnImmediately: true }, waitMs: 5_000 }));
    expect(out.state).toBe('TASK_STATE_SUBMITTED');
    expect(out.ms).toBeLessThan(500);
    expect(inboundChangeSignal(iw.world.store).size).toBe(0);
  });

  it('a refused call is already at its end: REJECTED at once', async () => {
    const out = await timed(send({ skill: 'eta_query', params: {} }, { waitMs: 5_000 }));
    expect(out.state).toBe('TASK_STATE_REJECTED');
    expect(out.ms).toBeLessThan(500);
  });

  it.each([['a string', 'yes'], ['a number', 1], ['null', null]])(
    'returnImmediately as %s is refused before anything is stored',
    async (_name, value) => {
      const answer = await send(ETA, { configuration: { returnImmediately: value } });
      expect(errorOf(answer)).toEqual({ code: -32602, reason: 'return_immediately_malformed' });
      expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE direction = 'inbound'`)).toEqual([{ n: 0 }]);
    },
  );
});

describe('through Core’s route, both bindings', () => {
  const router = new CoreRouter();
  registerA2AIngressRoutes(router);

  function forward(path: string, request: { method: string; path: string; body: string }): Promise<CoreResponse> {
    const envelope = { request: { ...request, query: '', version: '1.0' }, client_auth: { authorization: `Bearer ${iw.token}` } };
    return router.handle({
      method: 'POST',
      path,
      query: {},
      headers: {},
      body: envelope,
      rawBody: new TextEncoder().encode(JSON.stringify(envelope)),
      params: {},
      trustedInProcess: true,
      callerType: 'gateway',
      callerDID: 'did:key:z6MkGateway',
    } as unknown as CoreRequest);
  }

  const params = (messageId: string, configuration?: unknown) => ({
    ...iw.message(ETA, { messageId }),
    ...(configuration === undefined ? {} : { configuration }),
  });

  it('the route answers a task that does not move at the shared bound, with the error naming it, and not before', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      let answered: CoreResponse | null = null;
      void forward('/v1/a2a/ingress/message', {
        method: 'POST',
        path: '/a2a/v1',
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'SendMessage', params: params('route-bound') }),
      }).then((res) => {
        answered = res;
      });
      await jest.advanceTimersByTimeAsync(A2A_SEND_WAIT_MS - 1);
      expect(answered).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(deadlineError(answered as unknown as CoreResponse)).toEqual({ code: -32603, reason: 'wait_deadline_exceeded', task_id: waitingId() });
    } finally {
      jest.useRealTimers();
    }
  });

  it('JSON-RPC SendMessage: answered COMPLETED once the runner finishes', async () => {
    soon(() => iw.runChild(waitingId(), { eta_minutes: 7 }));
    const res = await forward('/v1/a2a/ingress/message', {
      method: 'POST',
      path: '/a2a/v1',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: params('route-rpc') }),
    });
    const task = (res.body as { result: { task: { status: { state: string } } } }).result.task;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('REST message:send: the bare answer, COMPLETED once the runner finishes', async () => {
    soon(() => iw.runChild(waitingId(), { eta_minutes: 8 }));
    const res = await forward('/v1/a2a/ingress/message', { method: 'POST', path: '/a2a/rest/message:send', body: JSON.stringify(params('route-rest')) });
    expect(res.status).toBe(200);
    expect((res.body as { task: { status: { state: string } } }).task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('a streaming call never waits: it opens with the task as made', async () => {
    const started = performance.now();
    const res = await forward('/v1/a2a/ingress/message/stream', {
      method: 'POST',
      path: '/a2a/v1',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SendStreamingMessage', params: params('route-stream', { returnImmediately: false }) }),
    });
    expect((res.body as { result: { task: { status: { state: string } } } }).result.task.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
