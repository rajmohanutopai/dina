/**
 * Every example and response scaffold in the UCP spec (v2026-08-25), read by
 * the reader for its shape. The spec's own examples must read cleanly; a
 * reader that refuses one is wrong, or the example is, and the test names it.
 */
import { readCart } from '../src/cart';
import { readProductDetail, readProductList } from '../src/catalog';
import { readCheckout } from '../src/checkout';
import { readBusinessAnswer } from '../src/errors';
import { readOrder } from '../src/order';
import { parseMerchantProfile } from '../src/profile';

import { classify, SPEC, SPEC_EXAMPLES as examples } from './spec_fixture';

function read(kind: string, v: unknown): { ok: boolean; reason?: string } {
  switch (kind) {
    case 'error_response': {
      const r = readBusinessAnswer(v);
      return r.kind === 'error_response' && r.messages.unreadable === 0
        ? { ok: true }
        : { ok: false, reason: JSON.stringify(r) };
    }
    case 'product_list': {
      const r = readProductList(v);
      return r.ok && r.value.unreadable === 0
        ? { ok: true }
        : { ok: false, reason: r.ok ? 'unreadable products' : r.reason };
    }
    case 'product_detail':
      return readProductDetail(v);
    case 'order':
      return readOrder(v);
    case 'checkout':
      return readCheckout(v);
    case 'cart':
      return readCart(v);
    case 'profile':
      return parseMerchantProfile(v);
    default:
      // fragments, illustrations and shapes Dina does not read (payment instruments, locations)
      return { ok: true };
  }
}

describe(`spec examples (${SPEC.tag})`, () => {
  it('harvested a useful set', () => {
    expect(examples.length).toBeGreaterThanOrEqual(110);
    const kinds = new Set(examples.map(classify));
    for (const k of [
      'error_response',
      'product_list',
      'product_detail',
      'order',
      'checkout',
      'cart',
      'profile',
    ])
      expect(kinds).toContain(k);
  });

  it('includes the MCP binding answers (unwrapped from structuredContent) for each resource Dina reads', () => {
    const mcpKinds = new Set(examples.filter((e) => e.binding === 'mcp').map(classify));
    for (const k of ['checkout', 'cart', 'order', 'product_list', 'error_response'])
      expect(mcpKinds).toContain(k);
  });

  it.each(examples.map((e) => [e.source, classify(e), e.value] as const))(
    '%s reads as %s',
    (_source, kind, value) => {
      expect(read(kind, value)).toMatchObject({ ok: true });
    },
  );
});
