/**
 * Merchant input written to trip the readers: keys named after
 * Object.prototype members, URLs Dina must never offer, JSON that `JSON.parse`
 * would accept, and lists that are not lists. Each case reproduces a defect
 * the U0 review found.
 */
import { readDiscounts } from '../src/discount';
import { readBusinessAnswer, readMcpError, readRestError } from '../src/errors';
import { readFulfillment } from '../src/fulfillment';
import { messageFromSse, readToolCallResponse } from '../src/mcp';
import { parseTotalEntries } from '../src/money';
import { fromDinaQuantity, parseQuantityUnit, toDinaQuantity } from '../src/units';

import { must } from './helpers';

describe('prototype-named merchant strings find nothing', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'a unit named %p stays opaque',
    (unit) => {
      const u = must(parseQuantityUnit({ unit, display_text: 'x' }));
      expect(toDinaQuantity(5n, u)).toBeNull();
      expect(fromDinaQuantity({ value: '5', unit_code: unit }, u)).toBeNull();
    },
  );

  it.each(['constructor', '__proto__', 'valueOf'])(
    'a total type %p is unknown, so it needs display_text',
    (type) => {
      expect(parseTotalEntries([{ type, amount: 5 }])).toEqual({
        ok: false,
        reason: 'unknown_total_without_display_text',
      });
      expect(parseTotalEntries([{ type, amount: 5, display_text: 'Other' }])).toMatchObject({
        ok: true,
      });
    },
  );
});

describe('continue_url in error answers is offered only when https', () => {
  const bad = [
    'javascript:alert(1)',
    'data:text/html,hi',
    'http://shop.example/cart',
    'https://user:pw@shop.example/cart',
  ];
  it.each(bad)('drops %p', (url) => {
    expect(
      readBusinessAnswer({
        ucp: { status: 'error' },
        continue_url: url,
        messages: [{ type: 'error', code: 'x', content: 'c', severity: 'unrecoverable' }],
      }),
    ).not.toHaveProperty('continueUrl');
    expect(readRestError(400, { code: 'x', continue_url: url })).not.toHaveProperty('continueUrl');
    expect(readMcpError(-32000, { code: 'x', continue_url: url })).not.toHaveProperty(
      'continueUrl',
    );
  });
  it('keeps an https one', () => {
    expect(
      readRestError(400, { code: 'x', continue_url: 'https://shop.example/cart' }),
    ).toMatchObject({ continueUrl: 'https://shop.example/cart' });
  });
});

describe('MCP text and SSE are parsed strictly', () => {
  it.each([
    ['a duplicate member', '{"id":"a","id":"b"}', 'text_duplicate_member'],
    ['a __proto__ member', '{"__proto__":{"x":1}}', 'text_forbidden_member'],
    ['a number out of range', '{"total":1e400}', 'text_number_out_of_range'],
  ])('refuses a text fallback with %s', (_n, text, reason) => {
    expect(
      readToolCallResponse(
        { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } },
        1,
      ),
    ).toEqual({ kind: 'malformed', reason });
  });
  it('skips an SSE event that is not strict JSON', () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"id":2,"result":{}}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(messageFromSse(body, 1)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });
});

describe('a list that is not a list is malformed, never empty', () => {
  it('applied discounts', () => {
    expect(readDiscounts({ applied: { title: 'x', amount: 1 } })).toEqual({
      ok: false,
      reason: 'applied_discounts',
    });
  });
  it.each([
    [
      'groups',
      { methods: [{ id: 'm', type: 'shipping', line_item_ids: [], groups: {} }] },
      'method_groups',
    ],
    [
      'destinations',
      { methods: [{ id: 'm', type: 'pickup', line_item_ids: [], destinations: 'loc' }] },
      'method_destinations',
    ],
    [
      'options',
      {
        methods: [
          {
            id: 'm',
            type: 'shipping',
            line_item_ids: [],
            groups: [{ id: 'g', line_item_ids: [], options: {} }],
          },
        ],
      },
      'group_options',
    ],
  ])('fulfillment %s', (_n, value, reason) => {
    expect(readFulfillment(value)).toEqual({ ok: false, reason });
  });
});
