/**
 * Lane 2 ingress edges (design §4.3, §5.1, §7.2, A2A-I4, A2A-I5): what Core
 * refuses before any state, how receipts and budgets hold at their edges,
 * and how ListTasks pages. Driven the way the gateway drives Core: a
 * forwarded raw request and the client's bearer.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import { A2A_DID_BINDING_PATH, base64urlEncodeUtf8, didBindingSigningInput } from '@dina/a2a';

import {
  A2A_RPC_PATH,
  MAX_TRACKED_PRINCIPALS,
  PrincipalBudgets,
  createA2AClient,
  ingressCancelTask,
  ingressCompleteDidBinding,
  ingressCreatePushConfig,
  ingressDeletePushConfig,
  ingressGetPushConfig,
  ingressGetTask,
  ingressListPushConfigs,
  ingressListTasks,
  ingressSendMessage,
  issueA2AGrant,
  issueDidChallenge,
  type GatewayEnvelope,
} from '../../src/a2a';
import { getPublicKey, sign } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { SQLiteServiceGrantRepository } from '../../src/service/service_grant_repository';

import { InboundWorld, didRequestSignature, errorOf, listing, resultOf, save, sentTask } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const count = (sql: string): number =>
  (iw.world.store.db.query(sql) as { n: number }[])[0]?.n ?? 0;
const inboundRows = () => count("SELECT COUNT(*) AS n FROM a2a_tasks WHERE direction = 'inbound'");
const receiptRows = () => count('SELECT COUNT(*) AS n FROM a2a_idempotency_receipts');
const pushRows = () => count('SELECT COUNT(*) AS n FROM a2a_push_configs');
const eta = (route = '42') => sentTask(iw.call({ skill: 'eta_query', params: { route_id: route } })).id as string;

/** A raw body sent as the gateway would forward it. */
function raw(body: string, over: Partial<GatewayEnvelope['request']> = {}): GatewayEnvelope {
  const env = iw.request('SendMessage', {});
  return { ...env, request: { ...env.request, body, ...over } };
}

describe('push-config routes bind the task id and the config id to the signed body (§5.1)', () => {
  // Plan C43
  it('a body naming one task or config, sent to another’s route, is refused and changes nothing', () => {
    const a = eta('1');
    const b = eta('2');
    const made = resultOf(
      ingressCreatePushConfig(
        iw.rt,
        iw.request('CreateTaskPushNotificationConfig', { taskId: a, url: 'https://hooks.example.test/a' }),
        a,
      ),
    );
    const cfg = made.id as string;
    // Create for task a, sent to task b's door.
    expect(
      errorOf(
        ingressCreatePushConfig(
          iw.rt,
          iw.request('CreateTaskPushNotificationConfig', { taskId: a, url: 'https://hooks.example.test/x' }),
          b,
        ),
      ),
    ).toEqual({ code: -32600, reason: 'id_mismatch' });
    // Get: the right task with another config id, and the right config under another task.
    expect(
      errorOf(ingressGetPushConfig(iw.rt, iw.request('GetTaskPushNotificationConfig', { taskId: a, id: cfg }), a, 'other')),
    ).toEqual({ code: -32600, reason: 'id_mismatch' });
    expect(
      errorOf(ingressGetPushConfig(iw.rt, iw.request('GetTaskPushNotificationConfig', { taskId: a, id: cfg }), b, cfg)),
    ).toEqual({ code: -32600, reason: 'id_mismatch' });
    // Delete: the right task with another config id, the right config under another task, and the ids swapped.
    for (const [taskRoute, configRoute] of [
      [a, 'other'],
      [b, cfg],
      [cfg, a],
    ] as const) {
      expect(
        errorOf(
          ingressDeletePushConfig(iw.rt, iw.request('DeleteTaskPushNotificationConfig', { taskId: a, id: cfg }), taskRoute, configRoute),
        ),
      ).toEqual({ code: -32600, reason: 'id_mismatch' });
    }
    // Nothing changed: task a still holds its one config, task b none.
    expect(resultOf(ingressListPushConfigs(iw.rt, iw.request('ListTaskPushNotificationConfigs', { taskId: a }), a)).configs).toHaveLength(1);
    expect(resultOf(ingressListPushConfigs(iw.rt, iw.request('ListTaskPushNotificationConfigs', { taskId: b }), b)).configs).toHaveLength(0);
    // Control: the same body on its own route deletes it.
    expect(
      ingressDeletePushConfig(iw.rt, iw.request('DeleteTaskPushNotificationConfig', { taskId: a, id: cfg }), a, cfg).status,
    ).toBe(200);
    expect(resultOf(ingressListPushConfigs(iw.rt, iw.request('ListTaskPushNotificationConfigs', { taskId: a }), a)).configs).toHaveLength(0);
  });
});

describe('the signed query (§5.1, spec §3.6)', () => {
  // Plan C45
  it('carries only A2A-Version, which then stands for the header; any other query is refused', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: iw.message({ skill: 'eta_query', params: { route_id: '7' } }),
    });
    const byParam = ingressSendMessage(iw.rt, raw(body, { query: 'A2A-Version=1.0', version: undefined }));
    expect((sentTask(byParam).status as { state: string }).state).toBe('TASK_STATE_SUBMITTED');
    const before = inboundRows();
    for (const query of ['foo=bar', 'A2A-Version=1.0&x=1', 'a2a-version=1.0']) {
      expect(errorOf(ingressSendMessage(iw.rt, raw(body, { query })))).toEqual({
        code: -32600,
        reason: 'query_not_allowed',
      });
    }
    expect(inboundRows()).toBe(before);
  });
});

describe('strict I-JSON at Core (§5.1): refused before any state', () => {
  // Plan C46
  it.each([
    ['a __proto__ member', '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"__proto__":{"x":1},"message":{}}}'],
    ['a lone surrogate', '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"\\ud800"}}}'],
    ['array params', '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":[1,2]}'],
  ])('%s', (_name, body) => {
    const answer = ingressSendMessage(iw.rt, raw(body));
    expect(errorOf(answer).code).toBe(-32600);
    expect([inboundRows(), receiptRows()]).toEqual([0, 0]);
  });
});

describe('one credential, never both (§5.1)', () => {
  const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
  const alice = (() => {
    const privateKey = new Uint8Array(32).fill(21);
    return { privateKey, did: deriveDIDKey(getPublicKey(privateKey)) };
  })();
  let n = 0;

  /** A SendMessage signed by Alice's DID, as the gateway forwards it. */
  function signedByAlice(): GatewayEnvelope {
    n += 1;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 9000 + n,
      method: 'SendMessage',
      params: iw.message({ skill: 'eta_query', params: { route_id: '1' } }, { messageId: `both-${n}` }),
    });
    return {
      request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
      client_auth: { did_signature: didRequestSignature({ body, signer: alice }) },
    };
  }

  // Plan C47
  it('a valid bearer and a valid DID signature, each enough alone, are refused together with 401', async () => {
    // The world's client binds Alice's DID; a second client keeps its bearer.
    const issued = issueDidChallenge(iw.world.store, iw.clientId, alice.did, iw.world.clock);
    if (!issued.ok) throw new Error(issued.reason);
    const proof = didBindingSigningInput({ nodeDid: NODE_DID, clientId: iw.clientId, did: alice.did, challenge: issued.challenge });
    const bound = await ingressCompleteDidBinding(
      iw.rt,
      {
        request: {
          method: 'POST',
          path: A2A_DID_BINDING_PATH,
          query: '',
          body: JSON.stringify({ did: alice.did, challenge: issued.challenge, signature: bytesToHex(sign(alice.privateKey, new TextEncoder().encode(proof))) }),
        },
        client_auth: {},
      },
      NODE_DID,
    );
    expect(bound.status).toBe(200);
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    // Each credential alone runs a call.
    expect((sentTask(ingressSendMessage(iw.rt, signedByAlice())).status as { state: string }).state).toBe('TASK_STATE_SUBMITTED');
    const byBearer = iw.request(
      'SendMessage',
      iw.message({ skill: 'eta_query', params: { route_id: '1' } }, { messageId: 'bearer-alone' }),
      {},
      `Bearer ${other.token}`,
    );
    expect((sentTask(ingressSendMessage(iw.rt, byBearer)).status as { state: string }).state).toBe('TASK_STATE_SUBMITTED');
    expect(inboundRows()).toBe(2);
    // Both at once: refused, whichever Core would have read first.
    const signed = signedByAlice();
    const both: GatewayEnvelope = { ...signed, client_auth: { ...signed.client_auth, authorization: `Bearer ${other.token}` } };
    const answer = ingressSendMessage(iw.rt, both);
    expect(answer.status).toBe(401);
    expect(answer.headers?.['www-authenticate']).toBe('Bearer realm="dina-a2a"');
    expect([inboundRows(), receiptRows()]).toEqual([2, 2]);
  });
});

describe('budgets (notes M3; receipts.ts)', () => {
  // Plan C57
  it('push-config Create spends the new-call budget; Get, List and Delete spend the read budget', () => {
    const id = eta('1'); // one new call spent
    const create = (n: number) =>
      ingressCreatePushConfig(
        iw.rt,
        iw.request('CreateTaskPushNotificationConfig', { taskId: id, url: `https://hooks.example.test/${n}` }),
        id,
      );
    // 59 more new calls use up the minute's budget of 60.
    for (let i = 0; i < 59; i += 1) eta(String(i + 100));
    const over = create(1);
    expect([over.status, over.headers?.['retry-after']]).toEqual([429, '60']);
    expect(pushRows()).toBe(0);
    // The reads still pass: they spend another budget.
    expect(ingressListPushConfigs(iw.rt, iw.request('ListTaskPushNotificationConfigs', { taskId: id }), id).status).toBe(200);
    expect(errorOf(ingressGetPushConfig(iw.rt, iw.request('GetTaskPushNotificationConfig', { taskId: id, id: 'x' }), id, 'x')).code).toBe(-32001);
    expect(ingressDeletePushConfig(iw.rt, iw.request('DeleteTaskPushNotificationConfig', { taskId: id, id: 'x' }), id, 'x').status).toBe(200);
    // A minute later Create passes again.
    iw.world.clock += 60_001;
    expect(create(2).status).toBe(200);
    // And past the read budget, the reads stop while Create still passes.
    for (let i = 0; i < 600; i += 1) ingressListPushConfigs(iw.rt, iw.request('ListTaskPushNotificationConfigs', { taskId: id }), id);
    expect(ingressListPushConfigs(iw.rt, iw.request('ListTaskPushNotificationConfigs', { taskId: id }), id).status).toBe(429);
    expect(create(3).status).toBe(200);
  });

  // Plan C58
  it(`tracks at most ${MAX_TRACKED_PRINCIPALS} principals, dropping the quietest first`, () => {
    const budgets = new PrincipalBudgets();
    for (let i = 0; i < 60; i += 1) expect(budgets.chargeMiss('a2a:first', 1_000)).toBe(true);
    expect(budgets.chargeMiss('a2a:first', 1_000)).toBe(false);
    for (let i = 0; i < MAX_TRACKED_PRINCIPALS + 50; i += 1) budgets.chargeMiss(`a2a:p${i}`, 1_000);
    const book = (budgets as unknown as { misses: Map<string, number[]> }).misses;
    expect(book.size).toBeLessThanOrEqual(MAX_TRACKED_PRINCIPALS);
    // The quietest (the first) was dropped, so it starts afresh.
    expect(book.has('a2a:first')).toBe(false);
    expect(budgets.chargeMiss('a2a:first', 1_000)).toBe(true);
  });
});

describe('message structure: protocol errors with no durable state (§7.2 steps 3–4, §2 item 6)', () => {
  // Plan C66
  it('more than 16 parts is too_many_parts, and nothing is stored', () => {
    const parts = Array.from({ length: 17 }, () => ({ text: 'x' }));
    const answer = ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', { message: { messageId: 'm-parts', role: 'ROLE_USER', parts } }),
    );
    expect(errorOf(answer)).toEqual({ code: -32602, reason: 'too_many_parts' });
    expect([inboundRows(), receiptRows()]).toEqual([0, 0]);
  });

  // Plan C67
  it('an empty contextId is invalid params, and nothing is stored', () => {
    const answer = iw.call({ skill: 'eta_query', params: { route_id: '1' } }, { contextId: '' });
    expect(errorOf(answer).code).toBe(-32602);
    expect([inboundRows(), receiptRows()]).toEqual([0, 0]);
  });
});

describe('receipts (§7.2 steps 5 and 8, §10 "Message mutation")', () => {
  // Plan C71
  it('a refused call replayed returns the same REJECTED task, and adds nothing', () => {
    const env = iw.request(
      'SendMessage',
      iw.message({ skill: 'appointment_status', params: {} }, { messageId: 'refused-once' }),
    );
    const first = sentTask(ingressSendMessage(iw.rt, env));
    expect((first.status as { state: string }).state).toBe('TASK_STATE_REJECTED');
    const again = sentTask(ingressSendMessage(iw.rt, { ...env, request: { ...env.request } }));
    expect(again.id).toBe(first.id);
    expect((again.status as { state: string }).state).toBe('TASK_STATE_REJECTED');
    expect([inboundRows(), receiptRows()]).toEqual([1, 1]);
  });

  // Plan C73
  it('a replay whose inline webhook differs is a conflict, and adds no config', () => {
    const send = (url: string) =>
      ingressSendMessage(
        iw.rt,
        iw.request('SendMessage', {
          ...iw.message({ skill: 'eta_query', params: { route_id: '1' } }, { messageId: 'hooked' }),
          configuration: { taskPushNotificationConfig: { url } },
        }),
      );
    expect(send('https://hooks.example.test/one').status).toBe(200);
    expect(pushRows()).toBe(1);
    expect(errorOf(send('https://hooks.example.test/two'))).toEqual({ code: -32602, reason: 'message_id_reused' });
    expect([inboundRows(), pushRows()]).toEqual([1, 1]);
  });

  // Plan C75
  it('two calls that both miss the receipt make one task: the key refuses the second commit, which leaves nothing, and a retry replays the first', () => {
    const env = iw.request(
      'SendMessage',
      iw.message({ skill: 'eta_query', params: { route_id: '1' } }, { messageId: 'twice-at-once' }),
    );
    const first = sentTask(ingressSendMessage(iw.rt, env));
    // Core's handler is synchronous over one connection, so a race needs a hand: the
    // second call's receipt lookup is made to miss, as if both had read before either wrote.
    const db = iw.world.store.db;
    const realQuery = db.query.bind(db);
    const hidden: unknown[][] = [];
    const spy = jest.spyOn(db, 'query').mockImplementation(((sql: string, params?: unknown[]) => {
      // Only the receipt lookup for this caller and this message id misses, once.
      if (hidden.length === 0 && sql.includes('FROM a2a_idempotency_receipts') && Array.isArray(params) && params.includes('twice-at-once')) {
        hidden.push(params);
        return [];
      }
      return realQuery(sql, params);
    }) as typeof db.query);
    let second: { status: number; body?: unknown } | Error;
    try {
      second = ingressSendMessage(iw.rt, { ...env, request: { ...env.request } });
    } catch (err) {
      second = err as Error;
    }
    spy.mockRestore();
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toEqual(expect.arrayContaining([`a2a:${iw.clientId}`, 'twice-at-once']));
    // The receipt's key refuses the second commit, and nothing of it stays. (The driver's error
    // comes from a native module a reused worker may have loaded in another realm, so its class
    // is not this file's Error: the test reads what it says, not what it is an instance of.)
    expect(second).toEqual(expect.objectContaining({ message: expect.stringMatching(/UNIQUE constraint failed: a2a_idempotency_receipts/) }));
    expect([inboundRows(), receiptRows()]).toEqual([1, 1]);
    expect(count('SELECT COUNT(*) AS n FROM workflow_tasks')).toBe(1);
    // The caller's retry is a plain replay.
    expect(sentTask(ingressSendMessage(iw.rt, { ...env, request: { ...env.request } })).id).toBe(first.id);
  });
});

describe('contextId carries no authority (§5.2)', () => {
  // Plan C95
  it('a contextId naming a grant, or another client’s context, opens nothing and shows nothing', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    const issued = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: other.client.client_id, service_rkey: 'private', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const mine = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!mine.ok) throw new Error(mine.reason);
    // The other client's call, in its own context.
    const theirs = sentTask(
      ingressSendMessage(
        iw.rt,
        iw.request(
          'SendMessage',
          iw.message(
            { skill: 'eta_query@private', params: { route_id: '1' }, grant_id: issued.grant.grantId },
            { contextId: 'their-context' },
          ),
          {},
          `Bearer ${other.token}`,
        ),
      ),
    );
    expect((theirs.status as { state: string }).state).toBe('TASK_STATE_SUBMITTED');
    // This client names a grant, and the other client's context, as its contextId: no door.
    for (const contextId of [mine.grant.grantId, issued.grant.grantId, 'their-context']) {
      const refused = sentTask(iw.call({ skill: 'eta_query@private', params: { route_id: '2' } }, { contextId }));
      expect((refused.status as { state: string }).state).toBe('TASK_STATE_REJECTED');
    }
    // Sharing a context shows nothing of the other client's tasks.
    const listed = resultOf(ingressListTasks(iw.rt, iw.request('ListTasks', { contextId: 'their-context' })));
    expect((listed.tasks as { id: string }[]).map((t) => t.id)).not.toContain(theirs.id);
  });
});

describe('CancelTask (§7.4, §10 "Cross-principal")', () => {
  // Plan C150
  it('another client’s cancel is TaskNotFound, and the call stays open', () => {
    const id = eta();
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    const answer = ingressCancelTask(iw.rt, iw.request('CancelTask', { id }, {}, `Bearer ${other.token}`), id);
    expect(errorOf(answer).code).toBe(-32001);
    expect(iw.opOf(id).state).toBe('open');
    expect(iw.childOf(id).status).toBe('queued');
  });

  // Plan C151
  it('a completed task and a refused one are not cancelable', () => {
    const done = eta();
    iw.runChild(done, { eta_minutes: 3 });
    const refused = sentTask(iw.call({ skill: 'appointment_status', params: {} })).id as string;
    for (const id of [done, refused]) {
      expect(errorOf(ingressCancelTask(iw.rt, iw.request('CancelTask', { id }), id)).code).toBe(-32002);
    }
    expect(iw.opOf(done).state).toBe('completed');
    expect(iw.opOf(refused).state).toBe('rejected');
  });
});

describe('ListTasks (§4.3, A2A §3.1.4)', () => {
  const page = (params: Record<string, unknown>, auth?: string) =>
    resultOf(ingressListTasks(iw.rt, iw.request('ListTasks', params, {}, auth)));
  const walk = (pageSize: number): string[] => {
    const seen: string[] = [];
    let token: unknown = undefined;
    for (let i = 0; i < 100; i += 1) {
      const got = page({ pageSize, ...(token === undefined ? {} : { pageToken: token }) });
      seen.push(...(got.tasks as { id: string }[]).map((t) => t.id));
      if (got.nextPageToken === '') return seen;
      token = got.nextPageToken;
    }
    throw new Error('paging never ended');
  };

  // Plan C153
  it('tasks that share a status time page through once each', () => {
    // Seven calls in the same millisecond: every status time ties.
    const ids = Array.from({ length: 7 }, (_, i) => eta(String(i)));
    const seen = walk(2);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  // Plan C154
  it('a cursor from before a restart pages on in the same order', () => {
    for (let i = 0; i < 5; i += 1) {
      iw.world.clock += i % 2 === 0 ? 0 : 1000;
      eta(String(i));
    }
    const whole = walk(50);
    const first = page({ pageSize: 2 });
    iw.world.restart();
    const grants = new SQLiteServiceGrantRepository(iw.world.store.db);
    const rt = { a2a: iw.world.runtime, grants, budgets: new PrincipalBudgets() };
    const rest: string[] = [];
    let token = first.nextPageToken as string;
    expect(token).not.toBe('');
    for (let i = 0; token !== ''; i += 1) {
      if (i >= 100) throw new Error('paging never ended');
      const got = resultOf(ingressListTasks(rt, iw.request('ListTasks', { pageSize: 2, pageToken: token })));
      rest.push(...(got.tasks as { id: string }[]).map((t) => t.id));
      expect(typeof got.nextPageToken).toBe('string');
      token = got.nextPageToken as string;
    }
    expect(whole).toHaveLength(5);
    expect([...(first.tasks as { id: string }[]).map((t) => t.id), ...rest]).toEqual(whole);
  });

  // Plan C156
  it('lists only the caller’s own tasks', () => {
    const mine = [eta('1'), eta('2')];
    // Control: the owner of the tasks sees both.
    const own = page({});
    expect(new Set((own.tasks as { id: string }[]).map((t) => t.id))).toEqual(new Set(mine));
    expect(own.totalSize).toBe(2);
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    expect(page({}, `Bearer ${other.token}`)).toEqual(expect.objectContaining({ tasks: [], totalSize: 0 }));
    // And the other client's own call shows to it alone.
    const theirs = sentTask(
      ingressSendMessage(
        iw.rt,
        iw.request('SendMessage', iw.message({ skill: 'eta_query', params: { route_id: '3' } }), {}, `Bearer ${other.token}`),
      ),
    ).id as string;
    expect((page({}, `Bearer ${other.token}`).tasks as { id: string }[]).map((t) => t.id)).toEqual([theirs]);
    expect((page({}).tasks as { id: string }[]).map((t) => t.id)).not.toContain(theirs);
  });

  // Plan C157
  it('refuses a malformed cursor; caps a page at 50; reads zero as the default', () => {
    for (let i = 0; i < 52; i += 1) eta(String(i));
    const malformed = [
      '%%%',
      base64urlEncodeUtf8('nonsense'),
      base64urlEncodeUtf8('1:2:3'),
      // The cursor is JSON [time, task id]: every other JSON shape is refused too.
      ...['[1]', '[1,"a","b"]', '["1","a"]', '[1.5,"a"]', '[1,""]', '[1,2]', '{"at":1,"id":"a"}'].map(base64urlEncodeUtf8),
    ];
    for (const pageToken of malformed) {
      expect(errorOf(ingressListTasks(iw.rt, iw.request('ListTasks', { pageToken })))).toEqual({
        code: -32602,
        reason: 'page_token_malformed',
      });
    }
    // A well-formed cursor, for no task this client has, reads a page and no error.
    expect(Array.isArray(page({ pageToken: base64urlEncodeUtf8('[0,"zzz"]') }).tasks)).toBe(true);
    const capped = page({ pageSize: 500 });
    expect([(capped.tasks as unknown[]).length, capped.pageSize]).toEqual([50, 50]);
    const zero = page({ pageSize: 0 });
    expect([(zero.tasks as unknown[]).length, zero.pageSize]).toEqual([50, 50]);
  });
});

describe('no internal id in a Lane 2 answer (A2A-I5, §4.3 "opaque cursor", §10 "Internal id leakage")', () => {
  // Extra X-4 (the ids)
  it('task and context ids are fresh UUIDs, never row numbers', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const tasks = [
      sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })),
      sentTask(iw.call({ skill: 'appointment_status', params: {} })),
    ];
    for (const task of tasks) {
      expect(task.id).toMatch(uuid);
      expect(task.contextId).toMatch(uuid);
      expect(task.id).not.toBe(String(iw.opOf(task.id as string).id));
    }
    const read = resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id: tasks[0]?.id }), tasks[0]?.id as string));
    expect(JSON.stringify(read)).not.toContain(iw.opOf(tasks[0]?.id as string).internal_id ?? '\u0000');
  });
});

describe('one timing class across refusal causes (A2A-I4)', () => {
  // Plan C98
  it('refusals for different causes take the same order of time', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const rt = { ...iw.rt, budgets: new PrincipalBudgets({ perMinute: 1e9, replayPerMinute: 1e9, readPerMinute: 1e9 }) };
    const causes: Record<string, Record<string, unknown>> = {
      unknown: { skill: 'appointment_status', params: {} },
      commerce: { skill: 'com.dinakernel.commerce.order_status', params: {} },
      invalid: { skill: 'eta_query', params: { route_id: '' } },
      hash: { skill: 'eta_query', params: { route_id: '1' }, schema_hash: '0'.repeat(64) },
      grant: { skill: 'eta_query@private', params: { route_id: '1' } },
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    /** One sample set: the causes interleaved round by round; the ratio of the slowest median to the fastest. */
    const sample = (set: number): number => {
      const times: Record<string, number[]> = Object.fromEntries(Object.keys(causes).map((k) => [k, []]));
      for (let round = 0; round < 120; round += 1) {
        for (const [name, data] of Object.entries(causes)) {
          const env = iw.request('SendMessage', iw.message(data, { messageId: `t-${set}-${name}-${round}` }));
          const start = process.hrtime.bigint();
          const answer = ingressSendMessage(rt, env);
          const took = Number(process.hrtime.bigint() - start);
          expect((sentTask(answer).status as { state: string }).state).toBe('TASK_STATE_REJECTED');
          // The first rounds warm the code paths; they are not counted.
          if (round >= 20) times[name]?.push(took);
        }
      }
      const medians = Object.values(times).map(median);
      return Math.max(...medians) / Math.min(...medians);
    };
    // Wall-clock times under a loaded test run can stray: a second set is taken
    // only when the first misses, and either set under the bound passes.
    const first = sample(1);
    const ratio = first < 3 ? first : Math.min(first, sample(2));
    expect(ratio).toBeLessThan(3);
  });
});
