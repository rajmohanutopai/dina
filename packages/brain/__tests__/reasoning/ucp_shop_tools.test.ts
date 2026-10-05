/**
 * The UCP buying tools (UCP plan §3.7, U2.7; T-U2-14): every call names this
 * conversation and handles only; Core's answers reach the model with prices
 * read in the currency's decimals and a note on what each state means;
 * refusals come back as values with a note; the logs carry no merchant data.
 */

import {
  createUcpCartTool,
  createUcpShopTools,
  type UcpShopCoreClient,
} from '../../src/reasoning/ucp_shop_tools';

import type { UcpShopResult } from '@dina/core';

function fakeCore(answers: { cart?: UcpShopResult; checkout?: UcpShopResult } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const core: UcpShopCoreClient = {
    ucpCart: async (input) => {
      calls.push({ method: 'ucpCart', input });
      return answers.cart ?? { ok: false, status: 503, reason: 'ucp_unavailable' };
    },
    ucpCheckout: async (input) => {
      calls.push({ method: 'ucpCheckout', input });
      return answers.checkout ?? { ok: false, status: 503, reason: 'ucp_unavailable' };
    },
  };
  return { core, calls };
}

const tool = (core: UcpShopCoreClient, name: string, log: Record<string, unknown>[] = []) => {
  const t = createUcpShopTools({
    core,
    releaseSession: 'chat:t-1',
    logger: (e) => log.push(e),
  }).find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

describe('the buying tools', () => {
  it('a checkout proposal names this conversation, handles and codes only, and says the owner decides on a card', async () => {
    const { core, calls } = fakeCore({
      checkout: {
        ok: true,
        status: 201,
        body: {
          checkout: { session_id: 'ucp-checkout-1', state: 'awaiting_approval', merchant: 'm1' },
          card_expires_at: 1,
        },
      },
    });
    const out = (await tool(core, 'start_ucp_checkout').execute({
      lines: [{ variant: 'v1.2', quantity: 2 }, { variant: 7 }, 'junk'],
      discount_codes: ['SPRING', 3],
    })) as Record<string, unknown>;
    expect(calls).toEqual([
      {
        method: 'ucpCheckout',
        input: {
          releaseSession: 'chat:t-1',
          op: 'propose',
          lines: [{ variant: 'v1.2', quantity: 2 }],
          discountCodes: ['SPRING'],
        },
      },
    ]);
    expect(out).toMatchObject({ status: 'ok', checkout: { state: 'awaiting_approval' } });
    expect(String(out.meaning)).toContain('Nothing has been sent to the shop');
    expect(String(out.note)).toContain('Dina never pays');
  });

  it('amounts read in the currency’s own decimals beside the minor units', async () => {
    const { core } = fakeCore({
      checkout: {
        ok: true,
        status: 200,
        body: {
          checkout: {
            session_id: 'ucp-checkout-1',
            state: 'open',
            totals: [{ type: 'total', amount: '6500', currency: 'EUR' }],
            choices: [
              {
                choice: 'c1',
                method: 'pickup',
                chosen: false,
                cost: { amount: '0', currency: 'JPY' },
              },
            ],
          },
        },
      },
    });
    const out = (await tool(core, 'get_ucp_checkout').execute({
      session_id: 'ucp-checkout-1',
    })) as {
      checkout: { totals: { shown?: string }[]; choices: { cost: { shown?: string } }[] };
    };
    expect(out.checkout.totals[0]?.shown).toMatch(/65\.00/);
    expect(out.checkout.choices[0]?.cost.shown).toMatch(/0/);
  });

  it('every operation reaches Core as it should; a refusal comes back as a value with a note, and the log holds no data', async () => {
    const log: Record<string, unknown>[] = [];
    const { core, calls } = fakeCore({
      checkout: { ok: false, status: 409, reason: 'checkout_changed' },
      cart: { ok: false, status: 404, reason: 'unknown_variant' },
    });
    expect(
      await tool(core, 'choose_ucp_delivery', log).execute({
        session_id: 's',
        choice: 'c2',
        rev: 'r',
      }),
    ).toMatchObject({
      status: 'refused',
      reason: 'checkout_changed',
      note: expect.stringContaining('Read it again'),
    });
    await tool(core, 'hand_off_ucp_checkout', log).execute({ session_id: 's' });
    await tool(core, 'cancel_ucp_checkout', log).execute({ session_id: 's' });
    await createUcpCartTool({ core, releaseSession: 'chat:t-1' }).execute({
      action: 'update',
      cart_id: 'ucp-cart-1',
      lines: [{ variant: 'v1.1', quantity: 3 }],
    });
    expect(calls.map((c) => c.input)).toEqual([
      { releaseSession: 'chat:t-1', op: 'choose', sessionId: 's', choice: 'c2', rev: 'r' },
      { releaseSession: 'chat:t-1', op: 'handoff', sessionId: 's' },
      { releaseSession: 'chat:t-1', op: 'cancel', sessionId: 's' },
      {
        releaseSession: 'chat:t-1',
        op: 'update',
        cartId: 'ucp-cart-1',
        lines: [{ variant: 'v1.1', quantity: 3 }],
      },
    ]);
    expect(JSON.stringify(log)).not.toMatch(/c2|ucp-cart|v1\./);
  });

  it('a checkout whose outcome Dina cannot see never reads as "not bought": it sends the owner to the shop’s email', async () => {
    for (const [state, words] of [
      ['unknown', /can’t see whether the owner bought this.*email from the shop/],
      ['not_completed', /If the owner paid anyway, the shop’s email has the order/],
      ['completed', /My Orders/],
    ] as const) {
      const { core } = fakeCore({
        checkout: { ok: true, status: 200, body: { checkout: { session_id: 's', state } } },
      });
      const out = (await tool(core, 'get_ucp_checkout').execute({ session_id: 's' })) as {
        meaning: string;
      };
      expect([state, out.meaning]).toEqual([state, expect.stringMatching(words)]);
      expect(out.meaning).not.toMatch(/without being completed|did not buy|was not bought/);
    }
  });

  it('a shop that asks for a linked account: the note sends the owner to Linked accounts', async () => {
    for (const detail of ['identity_required', 'insufficient_scope']) {
      const { core } = fakeCore({
        checkout: { ok: false, status: 409, reason: 'refused', detail },
      });
      expect(await tool(core, 'hand_off_ucp_checkout').execute({ session_id: 's' })).toMatchObject({
        status: 'refused',
        reason: 'refused',
        detail,
        note: expect.stringContaining('Settings, Linked accounts'),
      });
    }
    const { core } = fakeCore({
      checkout: { ok: false, status: 409, reason: 'refused', detail: 'out_of_stock' },
    });
    expect(await tool(core, 'hand_off_ucp_checkout').execute({ session_id: 's' })).toMatchObject({
      note: 'The shop refused that change.',
    });
  });

  it('an unknown cart action is refused without asking Core', async () => {
    const { core, calls } = fakeCore();
    expect(
      await createUcpCartTool({ core, releaseSession: 'chat:t-1' }).execute({ action: 'buy' }),
    ).toMatchObject({
      status: 'refused',
      reason: 'bad_action',
    });
    expect(calls).toEqual([]);
  });
});
