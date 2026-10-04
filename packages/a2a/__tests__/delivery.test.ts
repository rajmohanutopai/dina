/**
 * The delivery wire between Core and the gateway (design §7.5): each side
 * checks what the other sends, and a stream ends on a terminal state.
 */

import { endsStream, parseDeliveryAcks, parseDeliveryClaim } from '../src';

const status = (state: string) => ({
  statusUpdate: { taskId: 't', contextId: 'c', status: { state } },
});
/** A stream event: it carries the client's credential generation. */
const item = (over: Record<string, unknown> = {}) => ({
  id: 1,
  claim_id: 'abc_123',
  target: 'sse',
  task_id: 't',
  seq: 1,
  event: status('TASK_STATE_WORKING'),
  credential_gen: 0,
  ...over,
});
/** A webhook event: it carries its webhook and no generation. */
const hookItem = (over: Record<string, unknown> = {}) => {
  const { credential_gen: _gen, ...base } = item({ id: 2, target: 'webhook', webhook: { url: 'https://h.test/x', headers: { authorization: 'Bearer z' } } });
  return { ...base, ...over };
};
const claimOf = (over: Record<string, unknown> = {}) => ({ items: [item()], closed: [], fenced: [], ...over });

describe('parseDeliveryClaim (the gateway reads Core)', () => {
  it('reads streams, webhooks, closes and fences', () => {
    const value = { items: [item({ credential_gen: 3 }), hookItem()], closed: ['t9'], fenced: [{ client: 'f'.repeat(32), before_gen: 2 }] };
    expect(parseDeliveryClaim(value)).toEqual(value);
    // The base the cases below start from reads.
    expect(parseDeliveryClaim(claimOf())).not.toBeNull();
  });

  it.each([
    ['a webhook with no address', claimOf({ items: [hookItem({ webhook: undefined })] })],
    ['a stream item carrying a webhook', claimOf({ items: [item({ webhook: { url: 'u', headers: {} } })] })],
    ['a stream item with no credential generation', claimOf({ items: [item({ credential_gen: undefined })] })],
    ['a negative credential generation', claimOf({ items: [item({ credential_gen: -1 })] })],
    ['a fractional credential generation', claimOf({ items: [item({ credential_gen: 1.5 })] })],
    ['a webhook item carrying a credential generation', claimOf({ items: [hookItem({ credential_gen: 0 })] })],
    ['an event with two payloads', claimOf({ items: [item({ event: { ...status('TASK_STATE_WORKING'), artifactUpdate: {} } })] })],
    ['an event with neither payload', claimOf({ items: [item({ event: { task: {} } })] })],
    ['a non-numeric id', claimOf({ items: [item({ id: '1' })] })],
    ['a header that is not text', claimOf({ items: [hookItem({ webhook: { url: 'u', headers: { a: 1 } } })] })],
    ['an empty closed task id', claimOf({ closed: [''] })],
    ['no fence list', { items: [item()], closed: [] }],
    ['a fence with no client', claimOf({ fenced: [{ before_gen: 1 }] })],
    ['a fence whose client is not a stream client key', claimOf({ fenced: [{ client: 'ac_0123', before_gen: 1 }] })],
    ['a fence before generation 0, which ends nothing', claimOf({ fenced: [{ client: 'f'.repeat(32), before_gen: 0 }] })],
    ['a fence with no generation', claimOf({ fenced: [{ client: 'f'.repeat(32) }] })],
  ])('drops a claim with %s', (_name, value) => {
    expect(parseDeliveryClaim(value)).toBeNull();
  });
});

describe('parseDeliveryAcks (Core reads the gateway)', () => {
  it('reads reports', () => {
    expect(parseDeliveryAcks({ acks: [{ id: 3, claim_id: 'k', outcome: 'retry' }] })).toEqual([
      { id: 3, claim_id: 'k', outcome: 'retry' },
    ]);
  });

  it.each([
    ['an unknown outcome', { acks: [{ id: 3, claim_id: 'k', outcome: 'maybe' }] }],
    [
      'a claim id with odd characters',
      { acks: [{ id: 3, claim_id: "k'; drop", outcome: 'delivered' }] },
    ],
    ['a zero id', { acks: [{ id: 0, claim_id: 'k', outcome: 'delivered' }] }],
    [
      'too many reports',
      {
        acks: Array.from({ length: 201 }, (_, i) => ({
          id: i + 1,
          claim_id: 'k',
          outcome: 'delivered',
        })),
      },
    ],
    ['no list', {}],
  ])('refuses %s, whole', (_name, value) => {
    expect(parseDeliveryAcks(value)).toBeNull();
  });
});

it('a stream ends on a terminal or an interrupted state, never on work in progress', () => {
  for (const s of [
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_REJECTED',
    // Interrupted: the task waits on the client, whose answer opens the next stream.
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
  ]) {
    expect(endsStream(status(s))).toBe(true);
  }
  for (const s of ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']) {
    expect(endsStream(status(s))).toBe(false);
  }
  expect(endsStream({ artifactUpdate: { taskId: 't' } })).toBe(false);
});
