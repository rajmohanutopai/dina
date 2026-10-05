/**
 * DEV SELF-TEST for the UCP schema validator on Hermes (UCP test plan T-U1-1).
 *
 * Core validates every UCP request and answer with an interpreting JSON Schema
 * validator, which resolves `$ref`s with the global `URL`. React Native's own
 * `URL` joins a relative reference onto the whole base path and cannot set a
 * hash; Expo replaces it with a WHATWG one at start-up. These cases prove, on
 * the device, that references resolve as they do under Node: relative paths
 * with `..`, absolute versioned references, `#/$defs` pointers (with `~1` and
 * `%24` escapes), the release's own patterns kept, a merchant's catastrophic
 * pattern never run, and a composition of absolute references.
 *
 * The same function runs under Node in jest (`__tests__/services/ucp_schema_selftest.test.ts`),
 * which proves the expected answers; the device must print the same.
 */

import { SchemaSet } from '@dina/core';

export interface SelfTestCase {
  name: string;
  pass: boolean;
}

const R = 'https://ucp.dev/2026-08-25/schemas/';
const M = 'https://shop.example/ucp/schemas/';

const DOCS = [
  {
    url: `${R}shopping/checkout.json`,
    schema: {
      $id: 'https://ucp.dev/schemas/shopping/checkout.json',
      type: 'object',
      required: ['id', 'status', 'line_items', 'currency'],
      properties: {
        id: { type: 'string' },
        status: { enum: ['incomplete', 'completed'] },
        currency: { $ref: '../common/types/currency.json' },
        line_items: { type: 'array', items: { $ref: `${R}shopping/types/line_item.json` } },
        version: { $ref: `${R}ucp.json#/$defs/version` },
        odd: { $ref: '#/$defs/a~1b' },
        escaped: { $ref: '#/%24defs/plain' },
      },
      $defs: { 'a/b': { type: 'integer' }, plain: { type: 'boolean' } },
    },
  },
  { url: `${R}common/types/currency.json`, schema: { type: 'string', pattern: '^[A-Z]{3}$' } },
  {
    url: `${R}shopping/types/line_item.json`,
    schema: {
      type: 'object',
      required: ['quantity'],
      properties: { quantity: { type: 'integer', minimum: 1 }, item: { $ref: 'item.json' } },
    },
  },
  {
    url: `${R}shopping/types/item.json`,
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    url: `${R}ucp.json`,
    schema: { $defs: { version: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } },
  },
  {
    url: `${M}ext.json`,
    schema: { type: 'object', properties: { code: { type: 'string', pattern: '^(a+)+$' } } },
  },
];

const GOOD = {
  id: 'chk_1',
  status: 'incomplete',
  currency: 'EUR',
  line_items: [{ quantity: 2, item: { id: 'sku_1' } }],
  version: '2026-08-25',
  odd: 3,
  escaped: true,
  a_future_member: { x: 1 },
};

/** Every case with its result; all must pass on Node and on the device. */
export function runUcpSchemaSelfTest(): SelfTestCase[] {
  const out: SelfTestCase[] = [];
  const built = SchemaSet.build(DOCS);
  out.push({ name: 'the set builds (every reference lands inside it)', pass: built.ok });
  if (!built.ok) return out;
  const set = built.set;
  const v = (schema: string | Record<string, unknown>, value: unknown): boolean =>
    set.validate(schema, value).valid;
  const C = `${R}shopping/checkout.json`;
  out.push({ name: 'a checkout with every kind of reference validates', pass: v(C, GOOD) });
  out.push({
    name: 'a relative "../" reference is followed',
    pass: !v(C, { ...GOOD, currency: 'euro' }),
  });
  out.push({
    name: 'a relative reference from a nested document is followed',
    pass: !v(C, { ...GOOD, line_items: [{ quantity: 2, item: {} }] }),
  });
  out.push({
    name: 'an absolute versioned reference is followed',
    pass: !v(C, { ...GOOD, line_items: [{ quantity: 0 }] }),
  });
  out.push({
    name: 'a pointer into another document is followed',
    pass: !v(C, { ...GOOD, version: '2026-8-25' }),
  });
  out.push({
    name: 'a pointer with a ~1 escape is followed',
    pass: !v(C, { ...GOOD, odd: 'three' }),
  });
  out.push({
    name: 'a pointer with a %24 escape is followed',
    pass: !v(C, { ...GOOD, escaped: 'yes' }),
  });
  out.push({
    name: 'a closed enum refuses an unknown value',
    pass: !v(C, { ...GOOD, status: 'teleported' }),
  });
  const started = Date.now();
  const merchantOk = v(`${M}ext.json`, { code: `${'a'.repeat(40)}!` });
  out.push({
    name: "a merchant's catastrophic pattern never runs",
    pass: merchantOk && Date.now() - started < 500,
  });
  out.push({
    name: 'a composition of absolute references validates',
    pass:
      v({ allOf: [{ $ref: `${R}ucp.json#/$defs/version` }, { maxLength: 10 }] }, '2026-08-25') &&
      !v({ allOf: [{ $ref: `${R}ucp.json#/$defs/version` }, { maxLength: 10 }] }, '20260-08-25'),
  });
  // The URL behaviours the validator relies on, checked directly.
  const rel = new URL('../common/types/currency.json', `${R}shopping/checkout.json`).href;
  out.push({
    name: 'URL resolves "../" like WHATWG',
    pass: rel === `${R}common/types/currency.json`,
  });
  const withHash = new URL(`${R}ucp.json#/$defs/version`);
  withHash.hash = '';
  out.push({ name: 'URL hash can be cleared', pass: withHash.href === `${R}ucp.json` });
  out.push({
    name: 'URL reads a pointer hash whole',
    pass: new URL(`${R}ucp.json#/$defs/version`).hash === '#/$defs/version',
  });
  return out;
}

/** Log every case (dev builds only); the caller gates on the self-test flag. */
export function logUcpSchemaSelfTest(): void {
  for (const c of runUcpSchemaSelfTest()) {
    console.log(`[ucp-schema selftest] ${c.pass ? 'PASS' : 'FAIL'} ${c.name}`);
  }
  console.log('[ucp-schema selftest] done');
}
