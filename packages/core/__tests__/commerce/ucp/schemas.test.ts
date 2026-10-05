/**
 * The schema resolver (UCP plan §3.6 step 4a), against the published
 * v2026-08-25 schemas served by a fake fetch, plus merchant-hosted documents:
 * identity, release path, authority, references, limits, versions,
 * composition, and validation per operation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CAP, type CapabilityEntry, type NegotiatedCapability } from '@dina/ucp';

import { classify, SPEC_EXAMPLES } from '../../../../ucp/__tests__/spec_fixture';
import { RELEASE_SCHEMAS, SCHEMA_LIMITS, SchemaResolver } from '../../../src/commerce/ucp/schemas';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const DIR = join(__dirname, '../../../../ucp/__tests__/fixtures/schemas/2026-08-25');
const RELEASE: Record<string, string> = {};
(function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else RELEASE[RELEASE_SCHEMAS + relative(DIR, path)] = readFileSync(path, 'utf8');
  }
})(DIR);

/** The release plus any extra documents; anything else is a 404. */
function serve(extra: Record<string, unknown> = {}) {
  const fetched: string[] = [];
  const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
    fetched.push(r.url);
    const doc = extra[r.url] ?? RELEASE[r.url];
    if (doc === undefined)
      return {
        ok: true,
        status: 404,
        bodyBytes: new Uint8Array(),
        headers: {},
        connectedAddress: '203.0.114.7',
      };
    const body = typeof doc === 'string' ? doc : JSON.stringify(doc);
    if (body.length > r.maxResponseBytes) return { ok: false, error: 'too_large', sent: true };
    return {
      ok: true,
      status: 200,
      bodyBytes: new TextEncoder().encode(body),
      headers: {},
      connectedAddress: '203.0.114.7',
    };
  };
  return { fetch, fetched };
}

const entry = (schema: string, extendsOf?: string[]): CapabilityEntry => ({
  version: '2026-08-25',
  schema,
  ...(extendsOf !== undefined ? { extends: extendsOf } : {}),
});
const cap = (
  name: string,
  schema: string,
  extendsOf?: string[],
): [string, NegotiatedCapability] => [
  name,
  { name, version: '2026-08-25', entry: entry(schema, extendsOf) },
];
const release = (path: string) => RELEASE_SCHEMAS + path;

const DINA_SET = new Map([
  cap(CAP.catalogSearch, release('shopping/catalog_search.json')),
  cap(CAP.catalogLookup, release('shopping/catalog_lookup.json')),
  cap(CAP.cart, release('shopping/cart.json')),
  cap(CAP.checkout, release('shopping/checkout.json')),
  cap(CAP.fulfillment, release('shopping/fulfillment.json'), [CAP.checkout]),
  cap(CAP.discount, release('shopping/discount.json'), [CAP.checkout]),
  cap(CAP.order, release('shopping/order.json')),
]);

const example = (kind: string) => {
  const e = SPEC_EXAMPLES.find((x) => classify(x) === kind && x.binding === undefined);
  if (e === undefined) throw new Error(kind);
  return e.value as Record<string, unknown>;
};

describe('the release, composed', () => {
  it('resolves every capability Dina negotiates, within the limits, nothing dropped', async () => {
    const s = serve();
    const schemas = await new SchemaResolver({ fetch: s.fetch }).resolve(DINA_SET);
    expect(schemas.dropped).toEqual([]);
    expect([...schemas.active.keys()].sort()).toEqual([...DINA_SET.keys()].sort());
    // 81 release documents: over the merchant budget of 64, which they do not count against.
    expect(s.fetched.length).toBe(81);
    expect(s.fetched.length).toBeLessThanOrEqual(SCHEMA_LIMITS.maxReleaseDocuments);
    expect(new Set(s.fetched).size).toBe(s.fetched.length); // each document once
  });

  it('validates answers and requests per operation, with the extensions composed in', async () => {
    const schemas = await new SchemaResolver({ fetch: serve().fetch }).resolve(DINA_SET);
    const checkout = example('checkout');
    expect(schemas.validate('get_checkout', 'response', checkout)).toEqual({ valid: true });
    expect(schemas.validate('get_order', 'response', example('order'))).toEqual({ valid: true });
    // A create request may not carry the response-only `id` or `status`.
    const create = { line_items: [{ item: { id: 'sku_1' }, quantity: 1 }] };
    expect(schemas.validate('create_checkout', 'request', create)).toEqual({ valid: true });
    expect(schemas.validate('create_checkout', 'request', { ...create, id: 'chk_1' }).valid).toBe(
      false,
    );
    // An extension field (fulfillment) is typed: a wrong shape fails the composed answer.
    expect(
      schemas.validate('get_checkout', 'response', { ...checkout, fulfillment: 'shipping please' })
        .valid,
    ).toBe(false);
    // Catalog operations validate against their own $defs entries.
    expect(schemas.validate('search_catalog', 'request', { query: 'tea' })).toEqual({
      valid: true,
    });
    expect(schemas.validate('search_catalog', 'request', { query: 7 }).valid).toBe(false);
  });

  it('without the fulfillment extension, a checkout carrying a malformed fulfillment member still passes (open schema)', async () => {
    const withoutFulfillment = new Map(DINA_SET);
    withoutFulfillment.delete(CAP.fulfillment);
    const schemas = await new SchemaResolver({ fetch: serve().fetch }).resolve(withoutFulfillment);
    expect(
      schemas.validate('get_checkout', 'response', { ...example('checkout'), fulfillment: 'x' }),
    ).toEqual({
      valid: true,
    });
  });
});

describe('what drops a capability', () => {
  it('a merchant pointing checkout at the order schema (identity)', async () => {
    const set = new Map([cap(CAP.checkout, release('shopping/order.json'))]);
    const schemas = await new SchemaResolver({ fetch: serve().fetch }).resolve(set);
    expect(schemas.dropped).toEqual([{ name: CAP.checkout, reason: 'identity' }]);
    expect(schemas.validate('create_checkout', 'request', {})).toEqual({
      valid: false,
      unavailable: true,
      errors: [],
    });
    expect(schemas.available('create_checkout')).toBe(false);
  });

  it('a dev.ucp schema outside the release path, or reached through a relative ref that leaves it', async () => {
    const other = new Map([
      cap(CAP.checkout, 'https://ucp.dev/2026-04-08/schemas/shopping/checkout.json'),
    ]);
    expect((await new SchemaResolver({ fetch: serve().fetch }).resolve(other)).dropped).toEqual([
      { name: CAP.checkout, reason: 'release_path' },
    ]);
    // A release document whose relative $ref climbs out of /schemas/ (its own $id claims to be elsewhere).
    const climbing = release('shopping/checkout.json');
    const doc = {
      ...JSON.parse(RELEASE[climbing] as string),
      $id: 'https://ucp.dev/schemas/x/y/checkout.json',
    };
    doc.properties = { ...doc.properties, extra: { $ref: '../../evil.json' } };
    const schemas = await new SchemaResolver({ fetch: serve({ [climbing]: doc }).fetch }).resolve(
      new Map([cap(CAP.checkout, climbing)]),
    );
    expect(schemas.dropped).toEqual([{ name: CAP.checkout, reason: 'release_path' }]);
  });

  it('references resolve from where a document was fetched, never from the $id it claims', async () => {
    // Fetched from the merchant; claims to be a release document. Its relative reference reaches
    // the merchant's own types document from where it was fetched, and nothing at all from its $id.
    const root = 'https://shop.example/ucp/ext/root.json';
    const fetchedBase = 'https://shop.example/ucp/types/n.json';
    const doc = {
      name: 'example.shop.based',
      $id: 'https://ucp.dev/2026-08-25/schemas/shopping/checkout.json',
      $defs: { [CAP.checkout]: { properties: { n: { $ref: '../types/n.json' } } } },
    };
    const s = serve({ [root]: doc, [fetchedBase]: { type: 'integer' } });
    const schemas = await new SchemaResolver({ fetch: s.fetch }).resolve(
      new Map([...DINA_SET, cap('example.shop.based', root, [CAP.checkout])]),
    );
    expect(schemas.dropped).toEqual([]);
    expect(s.fetched).toContain(fetchedBase);
    expect(s.fetched).not.toContain('https://ucp.dev/2026-08-25/schemas/types/n.json');
    expect(
      schemas.validate('get_checkout', 'response', { ...example('checkout'), n: 'not a number' })
        .valid,
    ).toBe(false);
  });

  it('a merchant extension: may reach the release, must pass authority binding for anything else', async () => {
    const ext = 'https://shop.example/ucp/loyalty.json';
    const loyalty = (extraRef?: string) => ({
      name: 'example.shop.loyalty',
      $defs: {
        [CAP.checkout]: {
          allOf: [
            { $ref: release('shopping/checkout.json') },
            { type: 'object', properties: { loyalty: { $ref: extraRef ?? 'points.json' } } },
          ],
        },
      },
    });
    const points = { type: 'object', properties: { balance: { type: 'integer' } } };
    const set = new Map([...DINA_SET, cap('example.shop.loyalty', ext, [CAP.checkout])]);
    const ok = await new SchemaResolver({
      fetch: serve({ [ext]: loyalty(), 'https://shop.example/ucp/points.json': points }).fetch,
    }).resolve(set);
    expect(ok.dropped).toEqual([]);
    expect(
      ok.validate('get_checkout', 'response', {
        ...example('checkout'),
        loyalty: { balance: 'lots' },
      }).valid,
    ).toBe(false);
    const bad = await new SchemaResolver({
      fetch: serve({ [ext]: loyalty('https://tracker.example/points.json') }).fetch,
    }).resolve(set);
    expect(bad.dropped).toEqual([{ name: 'example.shop.loyalty', reason: 'authority' }]);
    // Checkout itself is untouched by the extension's failure.
    expect(bad.available('get_checkout')).toBe(true);
  });

  it('a $ref loop resolves, each document fetched once', async () => {
    const a = 'https://shop.example/ucp/a.json';
    const b = 'https://shop.example/ucp/b.json';
    const docs = {
      [a]: {
        name: 'example.shop.loop',
        $defs: { [CAP.checkout]: { $ref: 'b.json' } },
        properties: { next: { $ref: 'b.json' } },
      },
      [b]: { properties: { back: { $ref: 'a.json' } } },
    };
    const s = serve(docs);
    const schemas = await new SchemaResolver({ fetch: s.fetch }).resolve(
      new Map([...DINA_SET, cap('example.shop.loop', a, [CAP.checkout])]),
    );
    expect(schemas.dropped).toEqual([]);
    expect(s.fetched.filter((u) => u === a || u === b)).toEqual([a, b]);
  });

  it('a graph over each limit: documents, depth, bytes', async () => {
    const base = 'https://shop.example/ucp/';
    const chain = (n: number, pad = 0) => {
      const docs: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        docs[`${base}${i}.json`] = {
          ...(i === 0 ? { name: 'example.shop.big', $defs: { [CAP.checkout]: {} } } : {}),
          ...(i + 1 < n ? { properties: { next: { $ref: `${i + 1}.json` } } } : {}),
          description: 'x'.repeat(pad),
        };
      }
      return docs;
    };
    const run = async (docs: Record<string, unknown>) =>
      (
        await new SchemaResolver({ fetch: serve(docs).fetch }).resolve(
          new Map([cap('example.shop.big', `${base}0.json`)]),
        )
      ).dropped;
    // Depth: 17 levels below the root.
    expect(await run(chain(SCHEMA_LIMITS.maxDepth + 2))).toEqual([
      { name: 'example.shop.big', reason: 'limits' },
    ]);
    expect(await run(chain(SCHEMA_LIMITS.maxDepth + 1))).toEqual([]);
    // Bytes: 9 documents of 250 KiB pass 2 MiB.
    expect(await run(chain(9, 250 * 1024))).toEqual([
      { name: 'example.shop.big', reason: 'limits' },
    ]);
    // One document over its own cap.
    expect(await run(chain(1, 300 * 1024))).toEqual([
      { name: 'example.shop.big', reason: 'limits' },
    ]);
    // Documents: 65 reachable from one root at depth 1.
    const wide: Record<string, unknown> = {
      [`${base}0.json`]: {
        name: 'example.shop.big',
        properties: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`p${i}`, { $ref: `w${i}.json` }]),
        ),
      },
    };
    for (let i = 0; i < 65; i++) wide[`${base}w${i}.json`] = { type: 'string' };
    expect(await run(wide)).toEqual([{ name: 'example.shop.big', reason: 'limits' }]);
  });

  it('an extension whose requires fail, or that lacks $defs for its parent, is dropped; a dropped parent prunes its extensions', async () => {
    const ext = 'https://shop.example/ucp/x.json';
    const withRequires = (requires: unknown, defs = true) => ({
      name: 'example.shop.x',
      ...(requires !== undefined ? { requires } : {}),
      $defs: defs ? { [CAP.checkout]: { $ref: release('shopping/checkout.json') } } : {},
    });
    const set = new Map([...DINA_SET, cap('example.shop.x', ext, [CAP.checkout])]);
    const run = async (doc: unknown) =>
      (await new SchemaResolver({ fetch: serve({ [ext]: doc }).fetch }).resolve(set)).dropped;
    expect(await run(withRequires({ protocol: { min: '2027-01-01' } }))).toEqual([
      { name: 'example.shop.x', reason: 'requires' },
    ]);
    expect(
      await run(
        withRequires({
          capabilities: { [CAP.checkout]: { min: '2026-01-01', max: '2026-06-01' } },
        }),
      ),
    ).toEqual([{ name: 'example.shop.x', reason: 'requires' }]);
    expect(
      await run(withRequires({ capabilities: { [CAP.cart]: { min: '2026-01-01' } } })),
    ).toEqual([{ name: 'example.shop.x', reason: 'requires' }]);
    expect(await run(withRequires({ protocol: { min: '2026-01-23' } }))).toEqual([]);
    expect(await run(withRequires(undefined, false))).toEqual([
      { name: 'example.shop.x', reason: 'missing_defs' },
    ]);
    // Checkout's own entry is unusable (outside the release path): checkout is dropped and
    // its extensions pruned, while cart (whose graph also reaches checkout.json) stays.
    const badCheckout = new Map(DINA_SET);
    badCheckout.set(
      CAP.checkout,
      cap(CAP.checkout, 'https://ucp.dev/2026-04-08/schemas/shopping/checkout.json')[1],
    );
    const noCheckout = await new SchemaResolver({ fetch: serve().fetch }).resolve(badCheckout);
    expect(noCheckout.dropped).toEqual([
      { name: CAP.checkout, reason: 'release_path' },
      { name: CAP.fulfillment, reason: 'parent_dropped' },
      { name: CAP.discount, reason: 'parent_dropped' },
    ]);
    // A broken document drops every capability whose graph reaches it.
    const broken = await new SchemaResolver({
      fetch: serve({ [release('shopping/checkout.json')]: 'not json' }).fetch,
    }).resolve(DINA_SET);
    expect(broken.dropped.map((d) => d.name).sort()).toEqual(
      [CAP.cart, CAP.checkout, CAP.discount, CAP.fulfillment].sort(),
    );
    expect(noCheckout.available('get_cart')).toBe(true);
  });

  it('a merchant extension that cannot be built drops itself, never the checkout it extends', async () => {
    const ext = 'https://shop.example/ucp/broken.json';
    const broken = {
      name: 'example.shop.broken',
      $defs: { [CAP.checkout]: { $ref: '#/$defs/missing' } },
    };
    const schemas = await new SchemaResolver({ fetch: serve({ [ext]: broken }).fetch }).resolve(
      new Map([...DINA_SET, cap('example.shop.broken', ext, [CAP.checkout])]),
    );
    expect(schemas.dropped).toEqual([{ name: 'example.shop.broken', reason: 'build' }]);
    expect(schemas.available('create_checkout')).toBe(true);
    expect(schemas.validate('get_checkout', 'response', example('checkout'))).toEqual({
      valid: true,
    });
  });

  it('a catalogue call composes an extension that defines its part (fulfillment extends catalog search)', async () => {
    // fulfillment.json types `fulfillment` on each variant of a search result.
    const list = example('product_list') as { products: { variants: Record<string, unknown>[] }[] };
    const product = list.products[0] as { variants: Record<string, unknown>[] };
    const variant = product.variants[0] as Record<string, unknown>;
    const answer = {
      ...list,
      products: [{ ...product, variants: [{ ...variant, fulfillment: 'by pigeon' }] }],
    };
    const withExt = new Map(DINA_SET);
    withExt.set(
      CAP.fulfillment,
      cap(CAP.fulfillment, release('shopping/fulfillment.json'), [
        CAP.checkout,
        CAP.catalogSearch,
      ])[1],
    );
    const composed = await new SchemaResolver({ fetch: serve().fetch }).resolve(withExt);
    expect(composed.validate('search_catalog', 'response', example('product_list'))).toEqual({
      valid: true,
    });
    expect(composed.validate('search_catalog', 'response', answer).valid).toBe(false);
    // Without the declaration, the same answer passes: the extension does not apply.
    const plain = await new SchemaResolver({ fetch: serve().fetch }).resolve(DINA_SET);
    expect(plain.validate('search_catalog', 'response', answer)).toEqual({ valid: true });
  });

  it('a schema that cannot be fetched drops its capability (fetch)', async () => {
    const set = new Map([cap(CAP.order, release('shopping/order-missing.json'))]);
    expect((await new SchemaResolver({ fetch: serve().fetch }).resolve(set)).dropped).toEqual([
      { name: CAP.order, reason: 'fetch' },
    ]);
  });
});
