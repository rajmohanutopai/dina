/**
 * What an inbound call takes and gives is held to its pinned schema pair
 * (design §7.2 step 9, §7.3), and a result Core cannot hand back after the
 * effect began never reads as a plain failure (A2A-I8):
 * - a result that breaks its schema, or cannot be read, ends the call FAILED
 *   when nothing could have happened, and OUTCOME_UNKNOWN once the effect
 *   began (a booking made, its answer malformed);
 * - a result schema with a keyword Core's validator would skip keeps the
 *   skill off the card and refuses the call, and a call pinned to one
 *   anyway never releases its result;
 * - the params that execute satisfy the params schema after undeclared
 *   members are dropped: a `required` member the schema never declares
 *   refuses the call instead of vanishing from it.
 */

import { buildInboundCard, ingressGetTask, type A2ACardConfig } from '../../src/a2a';
import { deriveP256SigningKey } from '../../src/crypto/slip0010';

import { InboundWorld, bookingListing, listing, resultOf, save, sentTask } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const CARD: A2ACardConfig = {
  key: { privateKey: deriveP256SigningKey(new Uint8Array(32).fill(9), 0).privateKey, generation: 0 },
  publicOrigin: 'https://dina.example.org',
};
/** The skills the card shows: none when no listing projects one (the card is then not built). */
async function cardSkills(): Promise<string[]> {
  const built = await buildInboundCard(iw.world.store, { nodeDid: 'did:plc:inboundprovidernode', config: CARD });
  if (!built.ok && built.reason === 'no_projectable_skills') return [];
  if (!built.ok) throw new Error(built.reason);
  return built.card.skills.map((s) => s.id);
}

const stateByGet = (id: string) =>
  resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id }), id)) as { status: { state: string }; artifacts?: unknown };

/** An approved booking whose round the runner claimed: the effect has begun. */
async function bookingUnderway(): Promise<{ id: string; taskId: string }> {
  await save(bookingListing(), 'bus');
  const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
  iw.world.workflow.approve(iw.childOf(id).id);
  const { verdict, taskId } = iw.claimChild(id);
  expect(verdict).toBe('admitted');
  expect(iw.opOf(id).effect_phase).toBe('effect_started');
  return { id, taskId };
}

describe('a result Core cannot hand back (A2A-I8)', () => {
  it('a booking made, its result breaking the schema: OUTCOME_UNKNOWN, never a plain failure, and no artifact', async () => {
    const { id, taskId } = await bookingUnderway();
    iw.world.workflow.complete(taskId, JSON.stringify({ booked: 'not a boolean' }), 'done', iw.runnerDid);
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'outcome_unknown', reason_code: 'result_schema_mismatch' }));
    expect(stateByGet(id).artifacts).toBeUndefined();
  });

  it('a booking made, its result not JSON at all: OUTCOME_UNKNOWN', async () => {
    const { id, taskId } = await bookingUnderway();
    iw.world.workflow.complete(taskId, '{not json', 'done', iw.runnerDid);
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'outcome_unknown', reason_code: 'result_unreadable' }));
  });

  it('a read whose result breaks the schema changed nothing: FAILED', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    iw.runChild(id, { eta_minutes: 'soon' });
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'result_schema_mismatch', effect_phase: null }));
  });
});

describe('a result schema Core cannot enforce (§7.3)', () => {
  const NOT_SECRET = { type: 'object', not: { required: ['secret'] } };
  const unenforceable = () =>
    listing({
      capabilitySchemas: {
        eta_query: {
          params: { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } },
          result: NOT_SECRET,
          schemaHash: 'h-eta-not',
        },
      },
    });

  it('keeps the skill off the card, and the call is refused', async () => {
    // Control: the same listing with a result schema Core enforces is on the card.
    expect(await cardSkills()).toEqual(['eta_query@bus']);
    await save(unenforceable(), 'bus');
    expect(await cardSkills()).toEqual([]);
    const task = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } }));
    expect((task.status as { state: string }).state).toBe('TASK_STATE_REJECTED');
    expect(iw.opOf(task.id as string).reason_code).toBe('schema_unenforceable');
  });

  it('a call pinned to one anyway never releases its result', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    // As a call pinned before admission refused these schemas would carry it.
    const op = iw.opOf(id);
    const snapshot = JSON.parse(op.snapshot_json ?? '{}') as { schemas: { result: unknown } };
    snapshot.schemas.result = NOT_SECRET;
    iw.world.store.db.run('UPDATE a2a_tasks SET snapshot_json = ? WHERE id = ?', [JSON.stringify(snapshot), op.id]);
    iw.runChild(id, { eta_minutes: 3, secret: 'SECRET-VALUE' });
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'result_schema_unenforceable', result_json: null }));
    expect(JSON.stringify(stateByGet(id))).not.toContain('SECRET-VALUE');
  });
});

describe('the params that execute satisfy their schema (§7.2 step 9)', () => {
  const requiresUndeclared = (declared: boolean) =>
    listing({
      capabilitySchemas: {
        eta_query: {
          params: {
            type: 'object',
            required: ['route_id', 'destination'],
            properties: {
              route_id: { type: 'string', minLength: 1 },
              ...(declared ? { destination: { type: 'string' } } : {}),
            },
          },
          result: { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } },
          schemaHash: `h-eta-${declared ? 'declared' : 'undeclared'}`,
        },
      },
    });

  it('a required member the schema never declares would be dropped, so the call is refused, not run without it', async () => {
    await save(requiresUndeclared(false), 'bus');
    const task = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42', destination: 'Elm' } }));
    expect((task.status as { state: string }).state).toBe('TASK_STATE_REJECTED');
    expect(iw.opOf(task.id as string).reason_code).toBe('params_invalid');
  });

  it('control: declared, the same params are accepted and run whole', async () => {
    await save(requiresUndeclared(true), 'bus');
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42', destination: 'Elm' } })).id as string;
    expect(iw.opOf(id).state).toBe('open');
    expect(JSON.parse(iw.childOf(id).payload) as { params: unknown }).toEqual(
      expect.objectContaining({ params: { route_id: '42', destination: 'Elm' } }),
    );
  });
});
