/**
 * The buying calls' wire (UCP plan §3.7, U2.7), which the HTTP and in-process
 * clients share: the bodies Brain sends, and how both read Core's answers.
 * A refusal is a value with Core's reason and detail, never a throw; an
 * answer Brain cannot read is a refusal too.
 */

import { parseUcpShopResponse, ucpCartBody, ucpCheckoutBody } from '../../src/client/ucp_wire';

describe('the buying calls on the wire', () => {
  it('bodies carry the conversation, the operation and handles only', () => {
    expect(
      ucpCartBody({
        releaseSession: 'chat:t',
        op: 'update',
        cartId: 'ucp-cart-1',
        lines: [{ variant: 'v1.2', quantity: 2 }],
      }),
    ).toEqual({
      release_session: 'chat:t',
      op: 'update',
      cart_id: 'ucp-cart-1',
      lines: [{ variant: 'v1.2', quantity: 2 }],
    });
    expect(ucpCartBody({ releaseSession: 'chat:t', op: 'read', cartId: 'c' })).toEqual({
      release_session: 'chat:t',
      op: 'read',
      cart_id: 'c',
    });
    expect(
      ucpCheckoutBody({
        releaseSession: 'chat:t',
        op: 'propose',
        lines: [{ variant: 'v1', quantity: 1 }],
        discountCodes: ['X'],
      }),
    ).toEqual({
      release_session: 'chat:t',
      op: 'propose',
      lines: [{ variant: 'v1', quantity: 1 }],
      discount_codes: ['X'],
    });
    expect(
      ucpCheckoutBody({
        releaseSession: 'chat:t',
        op: 'choose',
        sessionId: 's',
        choice: 'c2',
        rev: 'r',
      }),
    ).toEqual({ release_session: 'chat:t', op: 'choose', session_id: 's', choice: 'c2', rev: 'r' });
  });

  it('reads 200 and 201 as answers, and every other status as a refusal with Core’s reason and detail', () => {
    expect(parseUcpShopResponse(201, { checkout: { state: 'awaiting_approval' } })).toEqual({
      ok: true,
      status: 201,
      body: { checkout: { state: 'awaiting_approval' } },
    });
    for (const [status, body, reason] of [
      [409, { error: 'not_settled' }, 'not_settled'],
      [409, { error: 'refused', detail: 'out_of_stock' }, 'refused'],
      [502, { error: 'merchant_unreachable' }, 'merchant_unreachable'],
      [503, { error: 'ucp_unavailable' }, 'ucp_unavailable'],
      [500, 'not json', 'response_malformed'],
    ] as const) {
      const out = parseUcpShopResponse(status, body);
      expect(out).toMatchObject({ ok: false, status, reason });
    }
    expect(parseUcpShopResponse(409, { error: 'refused', detail: 'out_of_stock' })).toEqual({
      ok: false,
      status: 409,
      reason: 'refused',
      detail: 'out_of_stock',
    });
  });
});
