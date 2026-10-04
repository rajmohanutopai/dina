/**
 * Inbound A2A, Lane 2 (design §7.2, §7.3, §7.4, §12 M2 done-when): Core's
 * half of SendMessage, GetTask, ListTasks and CancelTask, driven the way the
 * gateway drives it — a forwarded raw request and its bearer.
 */

import { DINA_A2A_EXTENSION_URI, canonicalize, exclusionReason, type JsonObject, type JsonValue } from '@dina/a2a';

import {
  A2A_ENDED_RETENTION_MS,
  parseInboundReviewCard,
  purgeEndedA2AOperations,
  revokeA2AGrant,
  a2aWorkflowHooks,
  createA2AClient,
  ingressCancelTask,
  ingressGetTask,
  ingressListTasks,
  ingressSendMessage,
  issueA2AGrant,
  revokeA2AClient,
  settleInbound,
  sweepA2AInbound,
  type InboundRuntime,
  admitInboundClaimWith,
  ACTION_REGISTRY_REVISION,
  actionRegistryRevisionOf,
  shippedRegistryFacts,
  inboundProjectionListings,
} from '../../src/a2a';
import { sha256HexOfText } from '../../src/a2a/digest';
import { registerDevice } from '../../src/devices/registry';
import { claimPluginTask } from '../../src/plugins/claim_guard';
import {
  SQLitePluginInstallRepository,
  getPluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { ServiceQueryIngress } from '../../src/service/query_ingress';
import { getServiceConfig, resetServiceConfigState } from '../../src/service/service_config';
import { LocalDelegationRunner } from '../../src/workflow/local_delegation_runner';

import {
  BOOK_PARAMS,
  BOOK_RESULT,
  ETA_RESULT,
  InboundWorld,
  bookingListing,
  errorOf,
  listing,
  resultOf,
  save,
  saveUnchecked,
  sentTask,
} from './inbound_fixture';

import type { PluginManifest } from '@dina/protocol';

let iw: InboundWorld;
let world: InboundWorld['world'];
let rt: InboundRuntime;
let clientId: string;
let runnerDid: string;
let sent: unknown[];
let grants: InboundWorld['grants'];

beforeEach(async () => {
  iw = await InboundWorld.create();
  ({ world, rt, clientId, runnerDid, sent, grants } = iw);
});

afterEach(() => iw.close());

const request = (...args: Parameters<InboundWorld['request']>) => iw.request(...args);
const message = (...args: Parameters<InboundWorld['message']>) => iw.message(...args);
const call = (...args: Parameters<InboundWorld['call']>) => iw.call(...args);
const opOf = (externalId: string) => iw.opOf(externalId);
/** The operation's current workflow child (execution or review card). */
const childOf = (externalId: string) => iw.childOf(externalId);
const sentStateOf = (answer: { body?: unknown }) =>
  (sentTask(answer).status as { state: string }).state;
const stateOf = (answer: { body?: unknown }) =>
  (resultOf(answer).status as { state: string }).state;

/** The pinned snapshot the operation was accepted under. */
const snapshotOf = (externalId: string): Record<string, unknown> =>
  JSON.parse(opOf(externalId).snapshot_json ?? 'null') as Record<string, unknown>;

describe('steps 1–4: protocol errors, no durable state', () => {
  it('answers 401 for no bearer, a wrong one, and a revoked client', () => {
    expect(
      ingressSendMessage(
        rt,
        request('SendMessage', message({ skill: 'eta_query', params: {} }), {}, null),
      ).status,
    ).toBe(401);
    expect(
      ingressSendMessage(
        rt,
        request(
          'SendMessage',
          message({ skill: 'eta_query', params: {} }),
          {},
          `Bearer dina_a2a_${'A'.repeat(43)}`,
        ),
      ).status,
    ).toBe(401);
    revokeA2AClient(world.store, grants, clientId, world.clock);
    expect(call({ skill: 'eta_query', params: { route_id: '42' } }).status).toBe(401);
    expect(
      world.store.db.query("SELECT 1 FROM a2a_tasks WHERE direction = 'inbound'"),
    ).toHaveLength(0);
  });

  it('answers 413 past 256 KB', () => {
    const big = request(
      'SendMessage',
      message({ skill: 'eta_query', params: { route_id: 'x'.repeat(300_000) } }),
    );
    expect(ingressSendMessage(rt, big).status).toBe(413);
  });

  it('refuses a body the gateway sent to the wrong door, and one that is not JSON-RPC', () => {
    expect(errorOf(ingressSendMessage(rt, request('GetTask', { id: 'x' }))).reason).toBe(
      'operation_mismatch',
    );
    const garbled = request('SendMessage', {});
    garbled.request.body =
      '{"jsonrpc":"2.0","id":1,"method":"SendMessage","method":"GetTask","params":{}}';
    expect(errorOf(ingressSendMessage(rt, garbled)).code).toBe(-32600);
  });

  it('speaks A2A 1.0 only', () => {
    expect(
      errorOf(
        ingressSendMessage(
          rt,
          request('SendMessage', message({ skill: 'eta_query', params: {} }), {
            version: undefined,
          }),
        ),
      ).code,
    ).toBe(-32009);
    expect(
      errorOf(
        ingressSendMessage(
          rt,
          request('SendMessage', message({ skill: 'eta_query', params: {} }), { version: '0.3' }),
        ),
      ).code,
    ).toBe(-32009);
  });

  it.each([
    ['an agent-role message', { role: 'ROLE_AGENT' }, -32602],
    // A message naming a task is an answer (§7.7); here the task is not the caller's.
    ['an answer to a task it does not own', { taskId: 'some-task' }, -32001],
  ])('refuses %s', (_name, over, code) => {
    expect(errorOf(call({ skill: 'eta_query', params: { route_id: '42' } }, over)).code).toBe(code);
  });

  // TCK CORE-SEND-003 (spec §3.1.1): content in a media type Dina does not read
  it.each([
    ['a text part only', [{ text: 'when is the next bus?' }], 'no_data_part'],
    ['a file by URL', [{ url: 'https://example.org/q.json', mediaType: 'application/json' }], 'url_part_refused'],
    ['raw bytes', [{ raw: 'eyJ9', mediaType: 'application/octet-stream' }], 'raw_part_refused'],
  ])('%s is ContentTypeNotSupportedError, A2A’s reason first and Dina’s after', (_what, parts, reason) => {
    const answer = ingressSendMessage(rt, request('SendMessage', { message: { messageId: `m-${reason}`, role: 'ROLE_USER', parts } }));
    const error = (answer.body as { error: { code: number; data: JsonObject[] } }).error;
    expect(error.code).toBe(-32005);
    expect(error.data.map((d) => [d.domain, d.reason])).toEqual([
      ['a2a-protocol.org', 'CONTENT_TYPE_NOT_SUPPORTED'],
      ['dinakernel.com', reason],
    ]);
    // Control: a data part of the wrong shape is still InvalidParams.
    const wrongShape = request('SendMessage', { message: { messageId: 'm-bad', role: 'ROLE_USER', parts: [{ data: { nope: 1 } }] } });
    expect(errorOf(ingressSendMessage(rt, wrongShape)).code).toBe(-32602);
  });

  it('refuses a malformed envelope as a protocol error', () => {
    const twoParts = ingressSendMessage(
      rt,
      request('SendMessage', {
        message: {
          messageId: 'm-x',
          role: 'ROLE_USER',
          parts: [
            { data: { skill: 'eta_query', params: {} } },
            { data: { skill: 'eta_query', params: {} } },
          ],
        },
      }),
    );
    expect(errorOf(twoParts)).toEqual({ code: -32602, reason: 'several_data_parts' });
    expect(world.store.db.query('SELECT 1 FROM a2a_idempotency_receipts')).toHaveLength(0);
  });
});

describe('acceptance (step 9): one commit, the executor frozen', () => {
  it('a public read on a bound lane: SUBMITTED, the child pinned to the runner, no permit', () => {
    const answer = call({ skill: 'eta_query', params: { route_id: '42', extra: 'dropped' } });
    expect(sentStateOf(answer)).toBe('TASK_STATE_SUBMITTED');
    const id = sentTask(answer).id as string;
    expect(opOf(id).state).toBe('open');
    const child = childOf(id);
    expect(child.requested_runner).toBe('transit');
    expect(world.store.getChild(child.id)?.pep_did).toBe(runnerDid);
    expect(JSON.parse(child.payload)).toEqual(
      expect.objectContaining({
        params: { route_id: '42' },
        mcp_tool: 'get_eta',
        from_did: `a2a:${clientId}`,
      }),
    );
    expect(world.store.permitsOf(opOf(id).id)).toHaveLength(0);
    expect(snapshotOf(id)).toEqual(
      expect.objectContaining({
        executor: { kind: 'mcp_server', lane: 'transit', mcpTool: 'get_eta', pepDid: runnerDid },
        config_revision: 1,
        mode: 'public',
      }),
    );
  });

  it('an effectful call waits for the owner; approval mints a permit bound to the post-normalization hash and the runner', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    expect(world.store.permitsOf(opOf(id).id)).toHaveLength(0);
    const card = childOf(id);
    world.workflow.approve(card.id);
    const [permit] = world.store.permitsOf(opOf(id).id);
    expect(permit).toEqual(
      expect.objectContaining({
        direction: 'inbound',
        state: 'minted',
        action_class: 'booking',
        pep_did: runnerDid,
        approval_task_id: card.id,
      }),
    );
    expect(permit?.payload_hash).toBe(snapshotOf(id).post_hash);
    expect(opOf(id).effect_phase).toBe('pre_effect');
  });

  it('a booking row saying auto still goes to the owner: the validator’s rule holds at call time', async () => {
    await saveUnchecked(bookingListing('auto'), 'bus');
    const id = sentTask(call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    expect(childOf(id).status).toBe('pending_approval');
    expect(snapshotOf(id).response_policy).toBe('review');
  });

  it('a skill whose contract is too large for a card is refused at the call too: no call reaches what no card shows', async () => {
    await saveUnchecked(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
        capabilitySchemas: {
          eta_query: {
            params: { type: 'object', required: ['n'], properties: { n: { type: 'array', const: Array(20_000).fill(0) } } },
            result: ETA_RESULT,
            schemaHash: 'h-big',
          },
        },
      }),
      'bulk',
    );
    const answer = call({ skill: 'eta_query@bulk', params: { n: Array(20_000).fill(0) } });
    expect(sentStateOf(answer)).toBe('TASK_STATE_REJECTED');
    expect(opOf(sentTask(answer).id as string).reason_code).toBe('skill_too_large');
  });

  // Cold audit C6-2: the id rule the card applies, applied to the call
  it('a skill whose id is longer than a card allows is off the card and refused, by bare name and by reference', async () => {
    // Only the long listing is public, so a bare name can reach nothing else.
    await saveUnchecked(listing({ discoverability: 'known_only', isDiscoverable: false }), 'bus');
    const long = 'r'.repeat(247); // `eta_query@` + 247 = 257 characters, one past MAX_ID_LENGTH
    await saveUnchecked(listing({}), long);
    const projected = inboundProjectionListings(world.store).find((l) => l.rkey === long);
    const cap = projected?.capabilities.find((c) => c.capability === 'eta_query');
    if (projected === undefined || cap === undefined) throw new Error('not projected');
    expect(exclusionReason(projected, cap)).toBe('skill_id_too_long');
    for (const skill of ['eta_query', `eta_query@${long}`]) {
      const answer = call({ skill, params: { route_id: '42' } });
      expect(sentStateOf(answer)).toBe('TASK_STATE_REJECTED');
      expect(opOf(sentTask(answer).id as string).reason_code).toBe('skill_id_too_long');
    }
    // Control: an id of exactly MAX_ID_LENGTH fits, on the card and at the call.
    const fits = 'r'.repeat(246);
    await saveUnchecked(listing({}), fits);
    expect(sentStateOf(call({ skill: `eta_query@${fits}`, params: { route_id: '42' } }))).not.toBe('TASK_STATE_REJECTED');
  });

  it('a capability the catalog never allows in public is refused on a public listing, named or bare', async () => {
    await saveUnchecked(
      listing({
        capabilities: {
          appointment_status: {
            responsePolicy: 'review',
            instruction: 'Look it up.',
            category: 'appointments',
          },
        },
        capabilitySchemas: {
          appointment_status: { params: BOOK_PARAMS, result: BOOK_RESULT, schemaHash: 'h' },
        },
      }),
      'bus',
    );
    expect(
      opOf(sentTask(call({ skill: 'appointment_status@bus', params: { slot: 'x' } })).id as string)
        .reason_code,
    ).toBe('not_public_exposable');
    expect(
      opOf(sentTask(call({ skill: 'appointment_status', params: { slot: 'x' } })).id as string)
        .reason_code,
    ).toBe('not_public_exposable');
  });

  it('an instruction-only capability runs in process; it is never handed to a reasoning backend', async () => {
    await save(
      listing({
        capabilities: {
          eta_query: {
            responsePolicy: 'auto',
            instruction: 'Answer from the timetable.',
            category: 'transit',
          },
        },
      }),
      'bus',
    );
    const child = childOf(
      sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string,
    );
    expect(child.requested_runner).toBe('dina.local');
    expect(world.store.getChild(child.id)?.pep_did).toBeNull();
  });
});

describe('receipts and budgets (steps 5–6)', () => {
  it('the same call returns the same task; a reused message id with another request is refused', () => {
    const env = request(
      'SendMessage',
      message({ skill: 'eta_query', params: { route_id: '42' } }, { messageId: 'fixed' }),
    );
    const a = sentTask(ingressSendMessage(rt, env)).id;
    const b = sentTask(ingressSendMessage(rt, { ...env, request: { ...env.request } })).id;
    expect(b).toBe(a);
    const other = request(
      'SendMessage',
      message({ skill: 'eta_query', params: { route_id: '43' } }, { messageId: 'fixed' }),
    );
    expect(errorOf(ingressSendMessage(rt, other)).reason).toBe('message_id_reused');
    expect(
      world.store.db.query("SELECT 1 FROM a2a_tasks WHERE direction = 'inbound'"),
    ).toHaveLength(1);
  });

  it('new calls spend the principal’s budget; replays are answered under the ceiling', () => {
    const replay = request(
      'SendMessage',
      message({ skill: 'eta_query', params: { route_id: '1' } }, { messageId: 'r' }),
    );
    ingressSendMessage(rt, replay);
    for (let i = 1; i < 60; i += 1) call({ skill: 'eta_query', params: { route_id: String(i) } });
    expect(call({ skill: 'eta_query', params: { route_id: 'x' } }).status).toBe(429);
    expect(ingressSendMessage(rt, replay).status).toBe(200);
  });
});

describe('refusals (steps 7–9): one collapsed REJECTED, durable, replayed the same', () => {
  it.each([
    ['an unknown skill', { skill: 'appointment_status', params: {} }],
    ['a commerce capability', { skill: 'com.dinakernel.commerce.order_status', params: {} }],
    ['invalid params', { skill: 'eta_query', params: { route_id: '' } }],
    [
      'a wrong schema hash',
      { skill: 'eta_query', params: { route_id: '42' }, schema_hash: '0'.repeat(64) },
    ],
  ])('%s', (_name, data) => {
    const answer = call(data);
    expect(sentStateOf(answer)).toBe('TASK_STATE_REJECTED');
    const op = opOf(sentTask(answer).id as string);
    expect(op.state).toBe('rejected');
    expect(op.internal_id).toBeNull();
    expect(world.workflow.store().getById(`a2a-in-exec-${op.external_id}-g0`)).toBeNull();
  });

  it('a lane with no runner binding, and a schema-less capability, have no A2A executor', async () => {
    await save(
      listing({
        capabilities: {
          eta_query: {
            mcpServer: 'unbound',
            mcpTool: 'x',
            responsePolicy: 'auto',
            category: 'transit',
          },
        },
      }),
      'bus',
    );
    expect(
      opOf(sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string)
        .reason_code,
    ).toBe('no_executor');
    await save(listing({ capabilitySchemas: {} }), 'bus');
    expect(
      opOf(sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string)
        .reason_code,
    ).toBe('schema_unenforceable');
  });

  it('a known_only skill needs this client’s grant', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    expect(sentStateOf(call({ skill: 'eta_query@private', params: { route_id: '42' } }))).toBe(
      'TASK_STATE_REJECTED',
    );
    const issued = issueA2AGrant(
      world.store,
      grants,
      { client_id: clientId, service_rkey: 'private', capability: 'eta_query' },
      world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    expect(
      sentStateOf(
        call({
          skill: 'eta_query@private',
          params: { route_id: '42' },
          grant_id: issued.grant.grantId,
        }),
      ),
    ).toBe('TASK_STATE_SUBMITTED');
  });
});

const claimChild = (externalId: string) => iw.claimChild(externalId);
const runChild = (externalId: string, result: unknown) => iw.runChild(externalId, result);

describe('results (§7.3): settled once, validated, never sent over D2D', () => {
  it('a valid result completes the task with one data part', async () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    runChild(id, { eta_minutes: 7 });
    await Promise.resolve();
    expect(opOf(id).state).toBe('completed');
    const got = resultOf(ingressGetTask(rt, request('GetTask', { id }), id));
    expect((got.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    expect(got.artifacts).toEqual([
      {
        artifactId: 'result',
        parts: [{ data: { eta_minutes: 7 }, mediaType: 'application/json' }],
      },
    ]);
    expect(sent).toHaveLength(0);
  });

  it('a result that breaks the pinned schema fails the task', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    runChild(id, { eta_minutes: 'soon' });
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'result_schema_mismatch' }),
    );
  });

  it('a listing changed between acceptance and claim refuses the claim as stale authority', async () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    await save(listing({ name: 'Bus 42 (new name)' }), 'bus');
    expect(claimChild(id).verdict).toBe('refused');
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'stale_authority' }),
    );
  });

  it('a settled result: its grant revoked ends it for good (kept for the owner); its listing paused does not hold it back', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const issued = issueA2AGrant(
      world.store,
      grants,
      { client_id: clientId, service_rkey: 'private', capability: 'eta_query' },
      world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const id = sentTask(
      call({
        skill: 'eta_query@private',
        params: { route_id: '42' },
        grant_id: issued.grant.grantId,
      }),
    ).id as string;
    runChild(id, { eta_minutes: 7 });
    const read = () => resultOf(ingressGetTask(rt, request('GetTask', { id }), id));
    expect((read().status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    revokeA2AGrant(grants, issued.grant.grantId, world.clock);
    expect(read()).toEqual(
      expect.objectContaining({ status: expect.objectContaining({ state: 'TASK_STATE_FAILED' }) }),
    );
    expect(read().artifacts).toBeUndefined();
    // Ended for good: no later read can show the result again.
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }),
    );
    expect(opOf(id).result_json).not.toBeNull();

    const pub = sentTask(call({ skill: 'eta_query@bus', params: { route_id: '43' } })).id as string;
    runChild(pub, { eta_minutes: 3 });
    await save(listing({ status: 'paused' }), 'bus');
    // A pause stops new work; it does not take back work already done.
    const paused = resultOf(ingressGetTask(rt, request('GetTask', { id: pub }), pub));
    expect((paused.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    expect(paused.artifacts).toEqual([
      {
        artifactId: 'result',
        parts: [{ data: { eta_minutes: 3 }, mediaType: 'application/json' }],
      },
    ]);
  });

  it('a client revoked while its read runs: the result is kept for the owner and the end is neutral', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const { verdict, taskId } = claimChild(id);
    expect(verdict).toBe('admitted');
    revokeA2AClient(world.store, grants, clientId, world.clock);
    world.workflow.complete(taskId, JSON.stringify({ eta_minutes: 7 }), 'done', runnerDid);
    const op = opOf(id);
    expect(op).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }),
    );
    expect(op.result_json).not.toBeNull();
  });

  it('a client revoked before the claim: nothing runs', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '43' } })).id as string;
    revokeA2AClient(world.store, grants, clientId, world.clock);
    expect(claimChild(id).verdict).toBe('refused');
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }),
    );
  });
});

describe('review policy: the owner decides, Core mints', () => {
  beforeEach(async () => {
    await save(
      listing({
        capabilities: {
          eta_query: {
            mcpServer: 'transit',
            mcpTool: 'get_eta',
            responsePolicy: 'review',
            category: 'transit',
          },
        },
      }),
      'bus',
    );
  });

  it('the call waits on an owner-only card; approval mints the execution child', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const card = childOf(id);
    expect(card.status).toBe('pending_approval');
    const parsed = parseInboundReviewCard(card.payload);
    expect(parsed).toEqual(
      expect.objectContaining({
        client_name: 'Acme agent',
        skill: 'eta_query@bus',
        params: { route_id: '42' },
      }),
    );
    expect(parsed?.post_hash).toBe(snapshotOf(id).post_hash);
    expect(parsed?.display.title).toBe('Acme agent asks to use eta_query@bus');
    expect(stateOf(ingressGetTask(rt, request('GetTask', { id }), id))).toBe('TASK_STATE_WORKING');
    world.workflow.approve(card.id);
    expect(opOf(id).internal_id).toBe(`a2a-in-exec-${id}-g0`);
    expect(JSON.parse(childOf(id).payload).operator_approved).toBe(true);
  });

  it('a refusal ends the task as a neutral FAILED', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    world.workflow.cancel(childOf(id).id, 'denied_by_owner');
    expect(stateOf(ingressGetTask(rt, request('GetTask', { id }), id))).toBe('TASK_STATE_FAILED');
    expect(opOf(id).reason_code).toBe('declined');
  });

  it('a missed decision handler is repaired by the sweep', () => {
    world.useService(false, {
      responseEgressGate: a2aWorkflowHooks(() => world.runtime).responseEgressGate,
    });
    rt = { ...rt, a2a: world.runtime };
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    world.workflow.approve(childOf(id).id);
    expect(opOf(id).internal_id).not.toBe(`a2a-in-exec-${id}-g0`);
    expect(sweepA2AInbound(rt).minted).toBe(1);
    expect(opOf(id).internal_id).toBe(`a2a-in-exec-${id}-g0`);
  });
});

describe('GetTask, CancelTask, ListTasks', () => {
  it('never shows one client another’s task', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const other = createA2AClient(world.store, { display_name: 'Other' }, world.clock);
    if (!other.ok) throw new Error('client');
    const env = request('GetTask', { id }, {}, `Bearer ${other.token}`);
    expect(errorOf(ingressGetTask(rt, env, id)).code).toBe(-32001);
  });

  it('cancels before any effect; refuses once a runner took the child', async () => {
    const a = sentTask(call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    expect(stateOf(ingressCancelTask(rt, request('CancelTask', { id: a }), a))).toBe(
      'TASK_STATE_CANCELED',
    );
    expect(childOf(a).status).toBe('cancelled');
    const b = sentTask(call({ skill: 'eta_query', params: { route_id: '2' } })).id as string;
    world.repo.claimDelegationTask(runnerDid, world.clock, 60_000, 'transit');
    expect(errorOf(ingressCancelTask(rt, request('CancelTask', { id: b }), b)).code).toBe(-32002);
  });

  it('lists the client’s tasks, most recently updated first, a page at a time', () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      world.clock += 1000;
      ids.push(
        sentTask(call({ skill: 'eta_query', params: { route_id: String(i) } })).id as string,
      );
    }
    const [oldest] = ids as [string, string, string];
    // The oldest task changes last: it moves to the front.
    world.clock += 1000;
    ingressCancelTask(rt, request('CancelTask', { id: oldest }), oldest);
    const first = resultOf(ingressListTasks(rt, request('ListTasks', { pageSize: 2 })));
    expect((first.tasks as { id: string }[]).map((t) => t.id)).toEqual([oldest, ids[2]]);
    const second = resultOf(
      ingressListTasks(rt, request('ListTasks', { pageSize: 2, pageToken: first.nextPageToken })),
    );
    expect((second.tasks as { id: string }[]).map((t) => t.id)).toEqual([ids[1]]);
    expect(second.nextPageToken).toBe('');
    // The cursor holds a time and the id the client already has, never a row id (§10, A2A-I5).
    const cursor = JSON.parse(Buffer.from(first.nextPageToken as string, 'base64url').toString('utf8')) as unknown[];
    expect(cursor).toEqual([expect.any(Number), ids[2]]);
    const rowId = opOf(ids[2] as string).id;
    expect(cursor.filter((f) => f === rowId)).toEqual([]);
    // Tasks that change in the same millisecond still page without loss or repeat.
    const sameTime = world.clock;
    const ties: string[] = [];
    for (let i = 0; i < 3; i += 1) ties.push(sentTask(call({ skill: 'eta_query', params: { route_id: `t${i}` } })).id as string);
    expect(world.clock).toBe(sameTime);
    const seen: string[] = [];
    let token = '';
    do {
      const page = resultOf(ingressListTasks(rt, request('ListTasks', { pageSize: 1, ...(token === '' ? {} : { pageToken: token }) })));
      seen.push(...(page.tasks as { id: string }[]).map((t) => t.id));
      token = page.nextPageToken as string;
    } while (token !== '');
    expect(seen.length).toBe(new Set(seen).size);
    expect(new Set(seen)).toEqual(new Set([...ids, ...ties]));
  });

  it('every method refuses a tenant alike (Dina serves none, plan D5); an empty one is no tenant', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    const named = [
      ingressSendMessage(rt, request('SendMessage', { ...message({ skill: 'eta_query', params: { route_id: '2' } }), tenant: 'acme' })),
      ingressGetTask(rt, request('GetTask', { id, tenant: 'acme' }), id),
      ingressListTasks(rt, request('ListTasks', { tenant: 'acme' })),
      ingressCancelTask(rt, request('CancelTask', { id, tenant: 'acme' }), id),
    ];
    for (const answer of named) {
      expect(errorOf(answer)).toMatchObject({ code: -32602 });
      expect(JSON.stringify(errorOf(answer))).toContain('tenant_unsupported');
    }
    expect(resultOf(ingressGetTask(rt, request('GetTask', { id, tenant: '' }), id))).toMatchObject({ id });
  });

  it('refuses a cursor it did not make, the old time:row form included', () => {
    for (const pageToken of [Buffer.from('1000:3').toString('base64url'), Buffer.from('[1000]').toString('base64url'), 'not base64 at all']) {
      expect(errorOf(ingressListTasks(rt, request('ListTasks', { pageToken })))).toMatchObject({ code: -32602 });
    }
  });
});

describe('settling is idempotent', () => {
  it('a second settle changes nothing', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    runChild(id, { eta_minutes: 7 });
    expect(settleInbound(rt, opOf(id))).toBeNull();
  });
});

describe('the effect boundary (§7.3): admitted at claim, by the pinned runner only', () => {
  const router = new CoreRouter();
  registerWorkflowRoutes(router);

  const http = (
    method: CoreRequest['method'],
    p: string,
    did: string,
    body: Record<string, unknown> = {},
    id = '',
  ): Promise<CoreResponse> =>
    router.handle({
      method,
      path: p,
      query: {},
      headers: { 'x-did': did },
      body,
      rawBody: new Uint8Array(),
      params: id === '' ? {} : { id },
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: did,
    });
  const claimOver = (did: string) =>
    http('POST', '/v1/workflow/tasks/claim', did, { runner_filter: 'transit', lease_ms: 30_000 });

  /** A booking the owner approved: its execution child queued with a minted permit. */
  async function approvedBooking(): Promise<string> {
    await save(bookingListing(), 'bus');
    const id = sentTask(call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    world.workflow.approve(childOf(id).id);
    return id;
  }

  it('another device on the lane never sees the child, and does not stall behind it', async () => {
    const other = registerDevice('Other runner', 'z6MkOtherRunner', 'agent', 'runner').did;
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    world.repo.create({
      id: 'plain',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'plain',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      requested_runner: 'transit',
      created_at: world.clock + 1,
      updated_at: world.clock + 1,
    });
    expect(world.repo.claimDelegationTask(other, world.clock, 30_000, 'transit')?.id).toBe('plain');
    expect(world.repo.claimDelegationTask(other, world.clock, 30_000, 'transit')).toBeNull();
    expect(world.repo.claimDelegationTask(runnerDid, world.clock, 30_000, 'transit')?.id).toBe(
      opOf(id).internal_id,
    );
  });

  it('a claim consumes an effectful call’s permit and starts its effect', async () => {
    const id = await approvedBooking();
    const claimed = await claimOver(runnerDid);
    expect(claimed.status).toBe(200);
    expect((claimed.body as { id: string }).id).toBe(opOf(id).internal_id);
    expect(world.store.permitsOf(opOf(id).id)[0]?.state).toBe('consumed');
    expect(opOf(id).effect_phase).toBe('effect_started');
  });

  it('a claim after the listing changed fails the call; the runner gets nothing', async () => {
    const id = await approvedBooking();
    await save(bookingListing('review', 'book_v2'), 'bus');
    expect((await claimOver(runnerDid)).status).toBe(204);
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'stale_authority' }),
    );
    expect(childOf(id).status).toBe('failed');
    expect(world.store.permitsOf(opOf(id).id)[0]?.state).toBe('void');
  });

  it('a lapsed lease after the effect started is outcome_unknown, never a second run', async () => {
    const id = await approvedBooking();
    await claimOver(runnerDid);
    world.clock += 31_000;
    world.repo.expireLeasedTasks(world.clock);
    expect(childOf(id).status).toBe('outcome_unknown');
    settleInbound(rt, opOf(id));
    expect(opOf(id).state).toBe('outcome_unknown');
    expect(stateOf(ingressGetTask(rt, request('GetTask', { id }), id))).toBe('TASK_STATE_FAILED');
  });

  it('a booking cancelled outside CancelTask after its effect began is outcome_unknown, never canceled', async () => {
    const id = await approvedBooking();
    await claimOver(runnerDid);
    expect(opOf(id).effect_phase).toBe('effect_started');
    // The owner stops the running execution from the task list.
    world.workflow.cancel(childOf(id).id, 'owner');
    settleInbound(rt, opOf(id));
    expect(opOf(id)).toEqual(expect.objectContaining({ state: 'outcome_unknown', reason_code: 'canceled_after_effect' }));
    expect(stateOf(ingressGetTask(rt, request('GetTask', { id }), id))).toBe('TASK_STATE_FAILED');
  });

  it('Brain may not cancel an inbound call’s execution; its read stays the caller’s to cancel', async () => {
    const id = await approvedBooking();
    await claimOver(runnerDid);
    const asBrain = await router.handle({
      method: 'POST',
      path: `/v1/workflow/tasks/${childOf(id).id}/cancel`,
      query: {},
      headers: {},
      body: {},
      rawBody: new Uint8Array(),
      params: { id: childOf(id).id },
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
    expect(asBrain.status).toBe(403);
    expect(childOf(id).status).toBe('running');
  });

  it('a lapsed lease on a read requeues it for the same runner', async () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    await claimOver(runnerDid);
    world.clock += 31_000;
    world.repo.expireLeasedTasks(world.clock);
    expect(childOf(id).status).toBe('queued');
  });

  it('only the pinned runner, holding the claim token, reports on the child', async () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const claimed = (await claimOver(runnerDid)).body as { id: string; claim_id: string };
    const other = registerDevice('Other runner', 'z6MkOtherRunner', 'agent', 'runner').did;
    const complete = (did: string, body: Record<string, unknown>) =>
      http('POST', `/v1/workflow/tasks/${claimed.id}/complete`, did, body, claimed.id);
    expect(
      (await complete(other, { result: '{"eta_minutes":7}', claim_id: claimed.claim_id })).status,
    ).toBe(403);
    expect(
      (await http('GET', `/v1/workflow/tasks/${claimed.id}`, other, {}, claimed.id)).status,
    ).toBe(403);
    expect((await complete(runnerDid, { result: '{"eta_minutes":7}' })).status).toBe(400);
    expect(
      (await complete(runnerDid, { result: '{"eta_minutes":7}', claim_id: claimed.claim_id }))
        .status,
    ).toBe(200);
    expect(opOf(id).state).toBe('completed');
  });

  it('the in-process runner checks authority before it runs an instruction-only call', async () => {
    await save(
      listing({
        capabilities: {
          eta_query: {
            responsePolicy: 'auto',
            instruction: 'Answer from the timetable.',
            category: 'transit',
          },
        },
      }),
      'bus',
    );
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    await save(
      listing({
        capabilities: {
          eta_query: {
            responsePolicy: 'auto',
            instruction: 'Answer from the new timetable.',
            category: 'transit',
          },
        },
      }),
      'bus',
    );
    const ran = jest.fn(async () => ({ eta_minutes: 1 }));
    const runner = new LocalDelegationRunner({
      repository: world.repo,
      workflowService: world.workflow,
      agentDID: 'did:key:z6MkLocal',
      runner: ran,
      nowMsFn: () => world.clock,
    });
    await runner.runTick();
    expect(ran).not.toHaveBeenCalled();
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'stale_authority' }),
    );
  });
});

describe('retention', () => {
  it('an ended call purges 30 days on, with its child and its receipt; an open one stays', () => {
    const env = request(
      'SendMessage',
      message({ skill: 'eta_query', params: { route_id: '42' } }, { messageId: 'kept' }),
    );
    const ended = sentTask(ingressSendMessage(rt, env)).id as string;
    const childId = childOf(ended).id;
    ingressCancelTask(rt, request('CancelTask', { id: ended }), ended);
    const open = sentTask(call({ skill: 'eta_query', params: { route_id: '43' } })).id as string;
    world.clock += A2A_ENDED_RETENTION_MS + 1;
    expect(purgeEndedA2AOperations(world.runtime)).toBe(1);
    expect(world.store.getTaskByExternal('inbound', `a2a:${clientId}`, ended)).toBeNull();
    expect(world.workflow.store().getById(childId)).toBeNull();
    expect(
      world.store.db.query('SELECT 1 FROM a2a_idempotency_receipts WHERE message_id = ?', ['kept']),
    ).toHaveLength(0);
    expect(opOf(open).state).toBe('open');
  });
});

describe('M2 adversarial set (design §10, §12 M2)', () => {
  it('an unlisted listing answers a call by exact reference only, under either policy', async () => {
    await save(listing({ discoverability: 'unlisted', isDiscoverable: false }), 'hidden');
    expect(
      opOf(sentTask(call({ skill: 'eta_query@hidden', params: { route_id: '1' } })).id as string)
        .state,
    ).toBe('open');
    // A bare name resolves among public listings only: here, the public `bus`.
    expect(
      snapshotOf(sentTask(call({ skill: 'eta_query', params: { route_id: '2' } })).id as string)
        .rkey,
    ).toBe('bus');
    await save(
      listing({
        discoverability: 'unlisted',
        isDiscoverable: false,
        capabilities: {
          eta_query: {
            mcpServer: 'transit',
            mcpTool: 'get_eta',
            responsePolicy: 'review',
            category: 'transit',
          },
        },
      }),
      'hidden',
    );
    expect(
      childOf(sentTask(call({ skill: 'eta_query@hidden', params: { route_id: '3' } })).id as string)
        .status,
    ).toBe('pending_approval');
  });

  it('a known_only skill under review: the grant opens it, the owner still decides', async () => {
    await save(
      listing({
        discoverability: 'known_only',
        isDiscoverable: false,
        capabilities: {
          eta_query: {
            mcpServer: 'transit',
            mcpTool: 'get_eta',
            responsePolicy: 'review',
            category: 'transit',
          },
        },
      }),
      'private',
    );
    const issued = issueA2AGrant(
      world.store,
      grants,
      { client_id: clientId, service_rkey: 'private', capability: 'eta_query' },
      world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const id = sentTask(
      call({
        skill: 'eta_query@private',
        params: { route_id: '4' },
        grant_id: issued.grant.grantId,
      }),
    ).id as string;
    expect(childOf(id).status).toBe('pending_approval');
  });

  it('scope narrows public skills only; a grant is its own door', async () => {
    const scoped = createA2AClient(
      world.store,
      { display_name: 'Scoped', scope: ['price_check'] },
      world.clock,
    );
    if (!scoped.ok) throw new Error(scoped.reason);
    const asScoped = (data: Record<string, unknown>) =>
      ingressSendMessage(rt, request('SendMessage', message(data), {}, `Bearer ${scoped.token}`));
    expect(sentStateOf(asScoped({ skill: 'eta_query', params: { route_id: '5' } }))).toBe(
      'TASK_STATE_REJECTED',
    );
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const issued = issueA2AGrant(
      world.store,
      grants,
      { client_id: scoped.client.client_id, service_rkey: 'private', capability: 'eta_query' },
      world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    expect(
      sentStateOf(
        asScoped({
          skill: 'eta_query@private',
          params: { route_id: '6' },
          grant_id: issued.grant.grantId,
        }),
      ),
    ).toBe('TASK_STATE_SUBMITTED');
    // Another client's grant is no door for this one.
    expect(
      sentStateOf(
        call({
          skill: 'eta_query@private',
          params: { route_id: '7' },
          grant_id: issued.grant.grantId,
        }),
      ),
    ).toBe('TASK_STATE_REJECTED');
  });

  it('a Talk listing is unreachable, even with a grant', async () => {
    await save(
      listing({ surface: 'talk', discoverability: 'known_only', isDiscoverable: false }),
      'talk',
    );
    const issued = issueA2AGrant(
      world.store,
      grants,
      { client_id: clientId, service_rkey: 'talk', capability: 'eta_query' },
      world.clock,
    );
    const grantId = issued.ok ? issued.grant.grantId : 'ag_none';
    expect(
      opOf(sentTask(call({ skill: 'eta_query@talk', params: { route_id: '8' } })).id as string)
        .reason_code,
    ).toBe('skill_unknown');
    expect(
      sentStateOf(call({ skill: 'eta_query@talk', params: { route_id: '8' }, grant_id: grantId })),
    ).toBe('TASK_STATE_REJECTED');
  });

  it('seventy clients calling once each all get through at production defaults', () => {
    const answers = Array.from({ length: 70 }, (_, i) => {
      const c = createA2AClient(world.store, { display_name: `Client ${i}` }, world.clock);
      if (!c.ok) throw new Error(c.reason);
      return ingressSendMessage(
        rt,
        request(
          'SendMessage',
          message({ skill: 'eta_query', params: { route_id: String(i) } }),
          {},
          `Bearer ${c.token}`,
        ),
      );
    });
    expect(
      answers.every((a) => a.status === 200 && sentStateOf(a) === 'TASK_STATE_SUBMITTED'),
    ).toBe(true);
  });

  it('replays stop at the production ceiling, ten times the new-call budget', () => {
    const env = request(
      'SendMessage',
      message({ skill: 'eta_query', params: { route_id: '9' } }, { messageId: 'flood' }),
    );
    expect(ingressSendMessage(rt, env).status).toBe(200); // the new call
    for (let i = 0; i < 600; i += 1) expect(ingressSendMessage(rt, env).status).toBe(200);
    const over = ingressSendMessage(rt, env);
    expect([over.status, over.headers?.['retry-after']]).toEqual([429, '60']);
    expect(
      world.store.db.query("SELECT 1 FROM a2a_tasks WHERE direction = 'inbound'"),
    ).toHaveLength(1);
  });

  it('a settled task carries the receipt id: the sha256 of the client’s own canonical params, never a row id (§7.6)', async () => {
    const params = iw.message({ skill: 'eta_query', params: { route_id: '7' } }, { messageId: 'receipt-call' });
    const id = sentTask(ingressSendMessage(rt, request('SendMessage', params))).id as string;
    const read = () => resultOf(ingressGetTask(rt, request('GetTask', { id }), id)) as { metadata?: Record<string, { receiptId?: string }> };
    expect(read().metadata).toBeUndefined();
    iw.runChild(id, { eta_minutes: 3 });
    const done = read();
    expect(done.metadata?.[DINA_A2A_EXTENSION_URI]).toEqual({ receiptId: sha256HexOfText(canonicalize(params as JsonValue)) });
  });

  it('every refusal looks the same from outside', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const views = [
      call({ skill: 'appointment_status', params: {} }),
      call({ skill: 'eta_query@private', params: { route_id: '1' } }),
      call({ skill: 'eta_query', params: { route_id: '' } }),
      call({ skill: 'com.dinakernel.commerce.order_status', params: {} }),
    ].map((answer) => {
      // Ids and times are fresh per task, and the receipt id is the hash of the
      // client's own request (it tells the client nothing it did not send);
      // everything else must match.
      const r = sentTask(answer) as {
        id: string;
        contextId: string;
        status: { timestamp: string };
        metadata?: Record<string, { receiptId?: string }>;
      };
      const ext = r.metadata?.[DINA_A2A_EXTENSION_URI];
      expect(ext?.receiptId).toMatch(/^[0-9a-f]{64}$/);
      return JSON.stringify({
        ...r,
        id: 'x',
        contextId: 'c',
        status: { ...r.status, timestamp: 't' },
        metadata: { [DINA_A2A_EXTENSION_URI]: { ...ext, receiptId: 'r' } },
      });
    });
    expect(new Set(views).size).toBe(1);
  });

  it('a catalog change between acceptance and claim voids the call as stale authority', async () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '10' } })).id as string;
    const snapshot = { ...snapshotOf(id), registry_revision: 'an-older-catalog' };
    world.store.db.run('UPDATE a2a_tasks SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(snapshot),
      opOf(id).id,
    ]);
    expect(
      world.repo.claimDelegationTask(runnerDid, world.clock, 30_000, 'transit'),
    ).not.toBeNull();
    expect(admitInboundClaimWith(rt, childOf(id), runnerDid)).toBe('refused');
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'stale_authority' }),
    );
  });

  it('a report under a claim token the lease already moved past is refused', async () => {
    const router = new CoreRouter();
    registerWorkflowRoutes(router);
    const post = (p: string, body: Record<string, unknown>, id = '') =>
      router.handle({
        method: 'POST',
        path: p,
        query: {},
        headers: { 'x-did': runnerDid },
        body,
        rawBody: new Uint8Array(),
        params: id === '' ? {} : { id },
        trustedInProcess: true,
        callerType: 'agent',
        callerDID: runnerDid,
      });
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '11' } })).id as string;
    const first = (
      await post('/v1/workflow/tasks/claim', { runner_filter: 'transit', lease_ms: 30_000 })
    ).body as { id: string; claim_id: string };
    world.clock += 31_000;
    world.repo.expireLeasedTasks(world.clock);
    const second = (
      await post('/v1/workflow/tasks/claim', { runner_filter: 'transit', lease_ms: 30_000 })
    ).body as { id: string; claim_id: string };
    expect(second.id).toBe(first.id);
    expect(second.claim_id).not.toBe(first.claim_id);
    const stale = await post(
      `/v1/workflow/tasks/${first.id}/complete`,
      { result: '{"eta_minutes":1}', claim_id: first.claim_id },
      first.id,
    );
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(opOf(id).state).toBe('open');
    const fresh = await post(
      `/v1/workflow/tasks/${second.id}/complete`,
      { result: '{"eta_minutes":2}', claim_id: second.claim_id },
      second.id,
    );
    expect(fresh.status).toBe(200);
    expect(opOf(id).state).toBe('completed');
  });
});

describe('the plugin plane (§7.3): the plugin guard pins the device; the permit is still minted and consumed', () => {
  const PLUGIN_DEVICE = 'did:plc:a2aplugindevice';
  const PLUGIN_CAP = 'com.acme.clinic.book';
  const PLUGIN_ETA = 'com.acme.clinic.eta';
  const PLUGIN_PAY = 'com.acme.clinic.pay';
  let installId: string;

  beforeEach(() => {
    const installs = new SQLitePluginInstallRepository(world.store.db);
    setPluginInstallRepository(installs);
    installId = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.clinic',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreiclinic1',
      currentVersion: '0.1.0',
      manifest: {
        $type: 'com.dinakernel.plugin.release',
        plugin_id: 'com.acme.clinic',
        version: '0.1.0',
        display_name: 'Clinic',
        execution: { mode: 'runner' },
        capabilities: [
          {
            id: PLUGIN_CAP,
            display_name: 'Book',
            interaction: 'query',
            action_class: 'booking',
            privacy_class: 'personal',
            kinds: ['provider'],
            result_schema: BOOK_RESULT,
          },
          {
            id: PLUGIN_ETA,
            display_name: 'ETA',
            interaction: 'query',
            action_class: 'read',
            privacy_class: 'personal',
            kinds: ['provider'],
            result_schema: ETA_RESULT,
          },
          {
            id: PLUGIN_PAY,
            display_name: 'Pay',
            interaction: 'query',
            action_class: 'payment',
            privacy_class: 'personal',
            kinds: ['provider'],
            result_schema: ETA_RESULT,
          },
        ],
      } as unknown as PluginManifest,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: {
        [PLUGIN_CAP]: 'h'.repeat(64),
        [PLUGIN_ETA]: 'e'.repeat(64),
        [PLUGIN_PAY]: 'f'.repeat(64),
      },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(world.clock / 1000) + 900,
      nowMs: world.clock,
    });
    installs.activate(installId, PLUGIN_DEVICE, world.clock);
  });

  afterEach(() => setPluginInstallRepository(null));

  async function pluginListing(): Promise<void> {
    await save(
      listing({
        capabilities: {
          appointment_book: {
            responsePolicy: 'review',
            category: 'appointments',
            pluginInstallId: installId,
            pluginManifestCid: 'bafyreiclinic1',
            pluginCapabilityId: PLUGIN_CAP,
          },
        },
        capabilitySchemas: {
          appointment_book: { params: BOOK_PARAMS, result: BOOK_RESULT, schemaHash: 'h-book' },
        },
      }),
      'bus',
    );
  }

  /** `eta_query` (a read name) bound to one of the plugin's capabilities. */
  async function etaOnPlugin(pluginCapabilityId: string): Promise<void> {
    await save(
      listing({
        capabilities: {
          eta_query: {
            responsePolicy: 'auto',
            category: 'transit',
            pluginInstallId: installId,
            pluginManifestCid: 'bafyreiclinic1',
            pluginCapabilityId,
          },
        },
      }),
      'bus',
    );
  }

  const claimAsPlugin = () => {
    const install = getPluginInstallRepository()?.getById(installId);
    if (install == null) throw new Error('install');
    return claimPluginTask({
      repo: world.repo,
      install,
      deviceDid: PLUGIN_DEVICE,
      nowMs: world.clock,
      leaseMs: 30_000,
    });
  };

  it('an approved booking runs on the plugin, its permit consumed at claim, its result delivered', async () => {
    await pluginListing();
    const id = sentTask(call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    world.workflow.approve(childOf(id).id);
    const child = childOf(id);
    expect(child.requested_runner).toBe(`plugin:${installId}`);
    expect(world.store.getChild(child.id)?.pep_did).toBe(PLUGIN_DEVICE);
    expect(world.store.permitsOf(opOf(id).id)[0]).toEqual(
      expect.objectContaining({
        state: 'minted',
        pep_did: PLUGIN_DEVICE,
        execution_child_id: child.id,
      }),
    );
    const claim = claimAsPlugin();
    expect(claim.task?.id).toBe(child.id);
    expect(world.store.permitsOf(opOf(id).id)[0]?.state).toBe('consumed');
    expect(opOf(id).effect_phase).toBe('effect_started');
    world.workflow.complete(
      child.id,
      JSON.stringify({ booked: true }),
      'done',
      PLUGIN_DEVICE,
      claim.task?.claim_id,
    );
    expect(opOf(id).state).toBe('completed');
  });

  it('a lapsed lease after the plugin took the permit ends outcome_unknown', async () => {
    await pluginListing();
    const id = sentTask(call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    world.workflow.approve(childOf(id).id);
    claimAsPlugin();
    world.clock += 31_000;
    world.repo.expireLeasedTasks(world.clock);
    expect(childOf(id).status).toBe('outcome_unknown');
    sweepA2AInbound(rt);
    expect(stateOf(ingressGetTask(rt, request('GetTask', { id }), id))).toBe('TASK_STATE_FAILED');
    expect(opOf(id).state).toBe('outcome_unknown');
    expect(sent).toHaveLength(0);
  });

  it('a read the plugin serves runs at once, with no permit, and its result never goes out over D2D', async () => {
    await etaOnPlugin(PLUGIN_ETA);
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    expect(world.store.permitsOf(opOf(id).id)).toHaveLength(0);
    const claim = claimAsPlugin();
    expect(claim.task?.id).toBe(childOf(id).id);
    world.workflow.complete(
      childOf(id).id,
      JSON.stringify({ eta_minutes: 6 }),
      'done',
      PLUGIN_DEVICE,
      claim.task?.claim_id,
    );
    expect(resultOf(ingressGetTask(rt, request('GetTask', { id }), id)).artifacts).toEqual([
      {
        artifactId: 'result',
        parts: [{ data: { eta_minutes: 6 }, mediaType: 'application/json' }],
      },
    ]);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['a booking plugin', 'com.acme.clinic.book'],
    ['a payment plugin', 'com.acme.clinic.pay'],
  ])(
    'under a read name, %s is no executor: off the card, refused on call',
    async (_name, pluginCapabilityId) => {
      await etaOnPlugin(pluginCapabilityId);
      expect(
        opOf(sentTask(call({ skill: 'eta_query', params: { route_id: '42' } })).id as string)
          .reason_code,
      ).toBe('no_executor');
      const projected = inboundProjectionListings(world.store).flatMap((l) => l.capabilities);
      expect(projected.find((c) => c.capability === 'eta_query')?.executor).toBeNull();
    },
  );
});

describe('the reasoning plane is never A2A’s executor (§7.3)', () => {
  it('with D2D’s reasoning submitter wired, instruction-only calls by bare name and by reference stay in process', async () => {
    const submitted: unknown[] = [];
    const d2d = new ServiceQueryIngress({
      workflow: world.workflow,
      readConfig: (rkey) => getServiceConfig(rkey),
      reasoningSubmitter: async (input) => {
        submitted.push(input);
        return null;
      },
    });
    // The one listing, at `self`, where a D2D query with no service_uri lands.
    resetServiceConfigState();
    await save(
      listing({
        capabilities: {
          eta_query: {
            responsePolicy: 'auto',
            instruction: 'Answer from the timetable.',
            category: 'transit',
          },
        },
      }),
      'self',
    );
    // Control: D2D does offer this capability to the submitter.
    await d2d.admitQuery('did:plc:d2dpeer', {
      query_id: 'q-ctl',
      capability: 'eta_query',
      params: { route_id: '1' },
      ttl_seconds: 60,
      schema_hash: 'h-eta',
    });
    expect(submitted).toHaveLength(1);
    for (const skill of ['eta_query', 'eta_query@self']) {
      const child = childOf(sentTask(call({ skill, params: { route_id: '2' } })).id as string);
      expect(child.requested_runner).toBe('dina.local');
    }
    expect(submitted).toHaveLength(1);
  });
});

describe('review findings: cancel, order, egress, versions, list filters, read budgets', () => {
  it('cancelling a call that waits on review cancels it, and withdraws the card', async () => {
    await save(
      listing({
        capabilities: {
          eta_query: {
            mcpServer: 'transit',
            mcpTool: 'get_eta',
            responsePolicy: 'review',
            category: 'transit',
          },
        },
      }),
      'bus',
    );
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    const card = childOf(id).id;
    expect(stateOf(ingressCancelTask(rt, request('CancelTask', { id }), id))).toBe(
      'TASK_STATE_CANCELED',
    );
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'canceled', reason_code: 'canceled' }),
    );
    expect(world.workflow.store().getById(card)?.status).toBe('cancelled');
  });

  it('a claim moves an older call to the front of the list', () => {
    const older = sentTask(call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    world.clock += 1000;
    const newer = sentTask(call({ skill: 'eta_query', params: { route_id: '2' } })).id as string;
    world.clock += 1000;
    const claimed = world.repo.claimDelegationTask(runnerDid, world.clock, 30_000, 'transit');
    expect(claimed?.id).toBe(childOf(older).id);
    expect(admitInboundClaimWith(rt, childOf(older), runnerDid)).toBe('admitted');
    const listed = resultOf(ingressListTasks(rt, request('ListTasks', {}))).tasks as {
      id: string;
      status: { state: string };
    }[];
    expect(listed.map((t) => t.id)).toEqual([older, newer]);
    expect(listed[0]?.status.state).toBe('TASK_STATE_WORKING');
  });

  it('a listing edited after the claim does not undo a result: it was judged at claim', async () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '3' } })).id as string;
    const claimed = world.repo.claimDelegationTask(runnerDid, world.clock, 30_000, 'transit');
    if (claimed === null) throw new Error('claim');
    expect(admitInboundClaimWith(rt, claimed, runnerDid)).toBe('admitted');
    await save(listing({ name: 'Bus 42 (renamed)' }), 'bus');
    world.workflow.complete(claimed.id, JSON.stringify({ eta_minutes: 5 }), 'done', runnerDid);
    expect(stateOf(ingressGetTask(rt, request('GetTask', { id }), id))).toBe(
      'TASK_STATE_COMPLETED',
    );
  });

  it('a client revoked after its booking ran gets an unknown outcome, never a plain failure', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    world.workflow.approve(childOf(id).id);
    const claimed = world.repo.claimDelegationTask(runnerDid, world.clock, 30_000, 'transit');
    if (claimed === null) throw new Error('claim');
    expect(admitInboundClaimWith(rt, claimed, runnerDid)).toBe('admitted');
    revokeA2AClient(world.store, grants, clientId, world.clock);
    world.workflow.complete(claimed.id, JSON.stringify({ booked: true }), 'done', runnerDid);
    expect(opOf(id)).toEqual(
      expect.objectContaining({ state: 'outcome_unknown', reason_code: 'authority_revoked' }),
    );
    expect(opOf(id).result_json).not.toBeNull();
  });

  it.each([
    ['1.0', 'TASK_STATE_SUBMITTED'],
    ['1.0.1', 'TASK_STATE_SUBMITTED'],
  ])('speaks version %s', (version, state) => {
    expect(
      sentStateOf(
        ingressSendMessage(
          rt,
          request('SendMessage', message({ skill: 'eta_query', params: { route_id: '4' } }), {
            version,
          }),
        ),
      ),
    ).toBe(state);
  });

  it.each(['1.1', '2.0', '1', ''])('refuses version %j', (version) => {
    expect(
      errorOf(
        ingressSendMessage(
          rt,
          request('SendMessage', message({ skill: 'eta_query', params: { route_id: '4' } }), {
            version,
          }),
        ),
      ).code,
    ).toBe(-32009);
  });

  it('a task body for one id sent to another id’s route is refused', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '5' } })).id as string;
    expect(errorOf(ingressGetTask(rt, request('GetTask', { id }), 'some-other-id'))).toEqual({
      code: -32600,
      reason: 'id_mismatch',
    });
  });

  it('lists by context and time, counts every match, and leaves artifacts out unless asked', () => {
    const first = sentTask(call({ skill: 'eta_query', params: { route_id: '6' } })) as {
      id: string;
      contextId: string;
    };
    runChild(first.id, { eta_minutes: 2 });
    world.clock += 1000;
    const cutoff = new Date(world.clock).toISOString();
    world.clock += 1000;
    const second = sentTask(call({ skill: 'eta_query', params: { route_id: '7' } })).id as string;
    const all = resultOf(ingressListTasks(rt, request('ListTasks', { pageSize: 1 })));
    expect([all.totalSize, (all.tasks as unknown[]).length, all.nextPageToken !== '']).toEqual([
      2,
      1,
      true,
    ]);
    expect((all.tasks as { artifacts?: unknown }[])[0]?.artifacts).toBeUndefined();
    const withArtifacts = resultOf(
      ingressListTasks(rt, request('ListTasks', { includeArtifacts: true })),
    );
    expect(
      (withArtifacts.tasks as { id: string; artifacts?: unknown }[]).find((t) => t.id === first.id)
        ?.artifacts,
    ).toBeDefined();
    const byContext = resultOf(
      ingressListTasks(rt, request('ListTasks', { contextId: first.contextId })),
    );
    expect([(byContext.tasks as { id: string }[]).map((t) => t.id), byContext.totalSize]).toEqual([
      [first.id],
      1,
    ]);
    const byTime = resultOf(
      ingressListTasks(rt, request('ListTasks', { statusTimestampAfter: cutoff })),
    );
    expect((byTime.tasks as { id: string }[]).map((t) => t.id)).toEqual([second]);
    expect(
      errorOf(ingressListTasks(rt, request('ListTasks', { status: 'TASK_STATE_WORKING' }))),
    ).toEqual({ code: -32602, reason: 'status_filter_unsupported' });
  });

  it('one client polling past its read budget does not slow another', () => {
    const id = sentTask(call({ skill: 'eta_query', params: { route_id: '8' } })).id as string;
    for (let i = 0; i < 600; i += 1)
      expect(ingressGetTask(rt, request('GetTask', { id }), id).status).toBe(200);
    expect(ingressGetTask(rt, request('GetTask', { id }), id).status).toBe(429);
    const other = createA2AClient(world.store, { display_name: 'Quiet' }, world.clock);
    if (!other.ok) throw new Error(other.reason);
    expect(ingressListTasks(rt, request('ListTasks', {}, {}, `Bearer ${other.token}`)).status).toBe(
      200,
    );
  });

  it('a rogue device never sees an effectful child, and is refused on its verbs', async () => {
    const router = new CoreRouter();
    registerWorkflowRoutes(router);
    const rogue = registerDevice('Rogue runner', 'z6MkRogueRunner', 'agent', 'runner').did;
    await save(bookingListing(), 'bus');
    const id = sentTask(call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    world.workflow.approve(childOf(id).id);
    expect(world.repo.claimDelegationTask(rogue, world.clock, 30_000, 'transit')).toBeNull();
    const child = childOf(id).id;
    const res = await router.handle({
      method: 'POST',
      path: `/v1/workflow/tasks/${child}/heartbeat`,
      query: {},
      headers: { 'x-did': rogue },
      body: { claim_id: 'guess' },
      rawBody: new Uint8Array(),
      params: { id: child },
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: rogue,
    });
    expect(res.status).toBe(403);
    expect(world.store.permitsOf(opOf(id).id)[0]?.state).toBe('minted');
  });
});

describe('the registry revision a call pins', () => {
  it('moves when a capability is reclassified (read → booking), and with nothing else', () => {
    const facts = shippedRegistryFacts();
    expect(actionRegistryRevisionOf(facts)).toBe(ACTION_REGISTRY_REVISION);
    expect(actionRegistryRevisionOf([...facts].reverse())).toBe(ACTION_REGISTRY_REVISION);
    const reclassified = facts.map((f) =>
      f.canonical === 'eta_query' ? { ...f, action_class: 'booking' as const } : f,
    );
    expect(actionRegistryRevisionOf(reclassified)).not.toBe(ACTION_REGISTRY_REVISION);
  });
});
