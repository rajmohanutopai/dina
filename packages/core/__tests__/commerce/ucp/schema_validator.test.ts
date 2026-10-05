/**
 * The interpreting validator (plan §3.6 "Validation", step 4a "References"):
 * the published v2026-08-25 schemas, exactly as ucp.dev serves them
 * (packages/ucp/scripts/fetch_release_schemas.mjs), validating the spec's own
 * examples; bases taken from retrieval URLs; refusals at build time; merchant
 * regular expressions never run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { classify, SPEC_EXAMPLES } from '../../../../ucp/__tests__/spec_fixture';
import { SchemaSet, type SchemaDocument } from '../../../src/commerce/ucp/schema_validator';

const RELEASE = 'https://ucp.dev/2026-08-25/schemas/';
const DIR = join(__dirname, '../../../../ucp/__tests__/fixtures/schemas/2026-08-25');

function releaseDocuments(): SchemaDocument[] {
  const docs: SchemaDocument[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        docs.push({
          url: RELEASE + relative(DIR, path),
          schema: JSON.parse(readFileSync(path, 'utf8')),
        });
    }
  };
  walk(DIR);
  return docs;
}

const built = SchemaSet.build(releaseDocuments());
if (!built.ok) throw new Error(`release did not build: ${built.reason} ${built.url}`);
const release = built.set;

const SCHEMA_FOR = {
  checkout: `${RELEASE}shopping/checkout.json`,
  cart: `${RELEASE}shopping/cart.json`,
  order: `${RELEASE}shopping/order.json`,
} as const;

describe('the published release', () => {
  it('builds as one set: every $ref of all 116 documents lands inside it', () => {
    expect(release.urls).toHaveLength(116);
  });

  it.each(
    SPEC_EXAMPLES.map((e) => ({ e, kind: classify(e) }))
      .filter(({ kind }) => kind === 'checkout' || kind === 'cart' || kind === 'order')
      .map(({ e, kind }) => [`${kind} ${e.source}`, kind, e.value] as const),
  )('the spec example %s validates', (_name, kind, value) => {
    expect(release.validate(SCHEMA_FOR[kind as keyof typeof SCHEMA_FOR], value)).toEqual({
      valid: true,
    });
  });

  it('a checkout missing a required member fails, and the error names the place, never the value', () => {
    const example = SPEC_EXAMPLES.find((e) => classify(e) === 'checkout');
    if (example === undefined) throw new Error('no checkout example');
    const { id: _id, ...rest } = example.value as Record<string, unknown>;
    const outcome = release.validate(SCHEMA_FOR.checkout, {
      ...rest,
      buyer_secret: 'person@example.com',
    });
    expect(outcome.valid).toBe(false);
    if (outcome.valid) return;
    expect(outcome.errors.some((e) => e.keyword === 'required')).toBe(true);
    expect(JSON.stringify(outcome.errors)).not.toContain('person@example.com');
    for (const e of outcome.errors)
      expect(Object.keys(e).sort()).toEqual(['instanceLocation', 'keyword', 'keywordLocation']);
  });

  it('unknown members pass (the schemas are open); a value outside a closed enum fails (A16 as the spec writes it)', () => {
    const example = SPEC_EXAMPLES.find((e) => classify(e) === 'checkout');
    const value = example?.value as Record<string, unknown>;
    expect(
      release.validate(SCHEMA_FOR.checkout, { ...value, a_future_member: { nested: [1, 2] } }),
    ).toEqual({ valid: true });
    // `status` is a closed enum: a new status needs integrators' code (schema-authoring.md, "Closed Enumerations").
    expect(release.validate(SCHEMA_FOR.checkout, { ...value, status: 'teleported' }).valid).toBe(
      false,
    );
  });

  it('validates against a pointer into a document, and against a composition of absolute references', () => {
    expect(release.validate(`${RELEASE}ucp.json#/$defs/version`, '2026-08-25').valid).toBe(true);
    expect(release.validate(`${RELEASE}ucp.json#/$defs/version`, 'yesterday').valid).toBe(false);
    const composed = {
      allOf: [{ $ref: `${RELEASE}ucp.json#/$defs/version` }, { type: 'string', maxLength: 10 }],
    };
    expect(release.validate(composed, '2026-08-25')).toEqual({ valid: true });
  });
});

describe('bases and references', () => {
  const MERCHANT = 'https://shop.example/schemas/';

  it('a relative $ref resolves against the retrieval URL, never the document’s own $id', () => {
    const built2 = SchemaSet.build([
      // Claims to live elsewhere; its relative reference must still resolve beside where it was fetched.
      {
        url: `${MERCHANT}a/root.json`,
        schema: { $id: 'https://evil.example/root.json', $ref: '../types/n.json' },
      },
      { url: `${MERCHANT}types/n.json`, schema: { type: 'integer' } },
    ]);
    expect(built2.ok).toBe(true);
    if (!built2.ok) return;
    expect(built2.set.validate(`${MERCHANT}a/root.json`, 3)).toEqual({ valid: true });
    expect(built2.set.validate(`${MERCHANT}a/root.json`, 'three').valid).toBe(false);
  });

  it('refuses a reference to a document outside the set, a nested $id, a duplicate URL, a non-object and a non-string $ref', () => {
    expect(
      SchemaSet.build([
        { url: `${MERCHANT}x.json`, schema: { $ref: 'https://elsewhere.example/y.json' } },
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'unresolved_ref',
    });
    expect(
      SchemaSet.build([
        {
          url: `${MERCHANT}x.json`,
          schema: { properties: { a: { $id: 'https://other.example/', type: 'string' } } },
        },
      ]),
    ).toMatchObject({ ok: false, reason: 'nested_id' });
    expect(
      SchemaSet.build([
        { url: `${MERCHANT}x.json`, schema: {} },
        { url: `${MERCHANT}x.json`, schema: {} },
      ]),
    ).toMatchObject({ ok: false, reason: 'duplicate_url' });
    expect(SchemaSet.build([{ url: `${MERCHANT}x.json`, schema: [] }])).toMatchObject({
      ok: false,
      reason: 'not_object',
    });
    expect(SchemaSet.build([{ url: `${MERCHANT}x.json`, schema: { $ref: 7 } }])).toMatchObject({
      ok: false,
      reason: 'bad_ref',
    });
  });

  it('a property NAMED $id (a schema in a properties map) is not a nested $id; data under const or examples is not walked', () => {
    const ok = SchemaSet.build([
      {
        url: `${MERCHANT}x.json`,
        schema: {
          properties: { $id: { type: 'string' }, id: { type: 'string' } },
          examples: [{ $id: 'x', id: 'y' }],
          const: { $id: 'z' },
          enum: [{ id: 'w' }],
          default: { $id: 'v' },
        },
      },
    ]);
    expect(ok.ok).toBe(true);
  });

  it('a pointer fragment resolves however it is escaped: ~1, %24, percent-encoded Unicode, or raw', () => {
    const b = SchemaSet.build([
      {
        url: `${MERCHANT}x.json`,
        schema: {
          properties: {
            slash: { $ref: '#/$defs/a~1b' },
            dollar: { $ref: '#/%24defs/plain' },
            encoded: { $ref: '#/$defs/%C3%A9t%C3%A9' },
            raw: { $ref: '#/$defs/été' },
          },
          $defs: {
            'a/b': { type: 'integer' },
            plain: { type: 'boolean' },
            été: { type: 'string' },
          },
        },
      },
    ]);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const v = (value: unknown) => b.set.validate(`${MERCHANT}x.json`, value).valid;
    expect(v({ slash: 1, dollar: true, encoded: 's', raw: 's' })).toBe(true);
    expect(v({ slash: 'x' })).toBe(false);
    expect(v({ dollar: 'x' })).toBe(false);
    expect(v({ encoded: 1 })).toBe(false);
    expect(v({ raw: 1 })).toBe(false);
    expect(
      SchemaSet.build([{ url: `${MERCHANT}y.json`, schema: { $ref: '#/%E0%A4%A' } }]),
    ).toMatchObject({ ok: false, reason: 'bad_ref' });
  });

  it('a reference to a pointer that is not there is refused when the set is built', () => {
    expect(
      SchemaSet.build([{ url: `${MERCHANT}x.json`, schema: { $ref: '#/$defs/missing' } }]),
    ).toMatchObject({
      ok: false,
      reason: 'unresolved_ref',
    });
    expect(
      SchemaSet.build([
        {
          url: `${MERCHANT}x.json`,
          schema: { $ref: '#/$defs/here', $defs: { here: { type: 'string' } } },
        },
      ]).ok,
    ).toBe(true);
    // A plain-name fragment must name an $anchor in its document.
    expect(
      SchemaSet.build([{ url: `${MERCHANT}x.json`, schema: { $ref: '#nowhere' } }]),
    ).toMatchObject({ reason: 'unresolved_ref' });
    expect(
      SchemaSet.build([
        {
          url: `${MERCHANT}x.json`,
          schema: { $ref: '#here', $defs: { a: { $anchor: 'here', type: 'string' } } },
        },
      ]).ok,
    ).toBe(true);
  });
});

describe('merchant regular expressions never run', () => {
  // A catastrophic pattern: (a+)+$ against "aaaa…!" backtracks exponentially.
  const EVIL = '^(a+)+$';
  const LONG = `${'a'.repeat(40)}!`;

  it('a merchant schema’s pattern and patternProperties are removed, with the property rules beside them', () => {
    const b = SchemaSet.build([
      {
        url: 'https://shop.example/ext.json',
        schema: {
          type: 'object',
          properties: { code: { type: 'string', pattern: EVIL } },
          patternProperties: { [EVIL]: { type: 'string' } },
          additionalProperties: false,
          propertyNames: { pattern: EVIL },
        },
      },
    ]);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const started = Date.now();
    expect(
      b.set.validate('https://shop.example/ext.json', { code: LONG, [LONG]: 'x', other: 1 }),
    ).toEqual({ valid: true });
    expect(Date.now() - started).toBeLessThan(500);
    // Types still hold.
    expect(b.set.validate('https://shop.example/ext.json', { code: 5 }).valid).toBe(false);
  });

  it('the release’s own patterns are kept', () => {
    // ucp.json's version pattern: YYYY-MM-DD.
    expect(release.validate(`${RELEASE}ucp.json#/$defs/version`, '2026-8-25').valid).toBe(false);
  });

  it('a document fetched from a look-alike of the release host is a merchant document', () => {
    const b = SchemaSet.build([
      { url: 'https://ucp.dev.shop.example/x.json', schema: { type: 'string', pattern: '^z$' } },
    ]);
    expect(b.ok && b.set.validate('https://ucp.dev.shop.example/x.json', 'not z')).toEqual({
      valid: true,
    });
  });
});

describe('what a merchant schema cannot do', () => {
  const M = 'https://shop.example/schemas/';

  it('re-base part of a document: a nested $id or id anywhere the validator looks, unknown keywords included', () => {
    for (const schema of [
      { properties: { a: { id: 'https://elsewhere.example/a.json' } } },
      { 'x-vendor': { inner: { $id: 'https://elsewhere.example/b.json' } } },
      { dependencies: { a: { $id: 'https://elsewhere.example/c.json' } } },
    ]) {
      expect(SchemaSet.build([{ url: `${M}x.json`, schema }])).toMatchObject({
        ok: false,
        reason: 'nested_id',
      });
    }
  });

  it('use recursive or dynamic references', () => {
    for (const k of ['$recursiveRef', '$dynamicRef', '$recursiveAnchor', '$dynamicAnchor']) {
      expect(
        SchemaSet.build([{ url: `${M}x.json`, schema: { properties: { a: { [k]: '#' } } } }]),
      ).toMatchObject({
        ok: false,
        reason: 'unsupported_keyword',
      });
    }
  });

  it('run a pattern from under dependencies or an unknown keyword', () => {
    const evil = '^(a+)+$';
    const b = SchemaSet.build([
      {
        url: `${M}x.json`,
        schema: {
          type: 'object',
          dependencies: { trigger: { properties: { code: { type: 'string', pattern: evil } } } },
          'x-vendor': { properties: { code: { pattern: evil } } },
        },
      },
    ]);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const started = Date.now();
    expect(b.set.validate(`${M}x.json`, { trigger: 1, code: `${'a'.repeat(40)}!` })).toEqual({
      valid: true,
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('expand without bound: nested allOf references that double at every level are refused', () => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++)
      defs[`a${i}`] = { allOf: [{ $ref: `#/$defs/a${i + 1}` }, { $ref: `#/$defs/a${i + 1}` }] };
    defs.a30 = { type: 'string' };
    const b = SchemaSet.build([{ url: `${M}x.json`, schema: { $ref: '#/$defs/a0', $defs: defs } }]);
    expect(b).toMatchObject({ ok: false, reason: 'too_costly' });
    // A recursive schema (a tree) is not refused: its expansion is bounded by the answer's depth.
    const tree = {
      $defs: {
        node: {
          type: 'object',
          properties: { children: { type: 'array', items: { $ref: '#/$defs/node' } } },
        },
      },
      $ref: '#/$defs/node',
    };
    expect(SchemaSet.build([{ url: `${M}y.json`, schema: tree }]).ok).toBe(true);
  });

  it('make an answer check every pair of a long array: answer sets drop uniqueItems', () => {
    const schema = { type: 'array', uniqueItems: true, items: { type: 'object' } };
    const long = Array.from({ length: 5000 }, () => ({
      same: 'item',
      with: ['a', 'few', 'members'],
    }));
    const answers = SchemaSet.build([{ url: `${M}u.json`, schema }], { forAnswers: true });
    expect(answers.ok).toBe(true);
    if (!answers.ok) return;
    const started = Date.now();
    expect(answers.set.validate(`${M}u.json`, long)).toEqual({ valid: true });
    expect(Date.now() - started).toBeLessThan(500);
    // Requests (Dina's own, short) keep it.
    const requests = SchemaSet.build([{ url: `${M}u.json`, schema }]);
    expect(requests.ok && requests.set.validate(`${M}u.json`, [{ a: 1 }, { a: 1 }]).valid).toBe(
      false,
    );
  });

  it('the published release is within the evaluation bound', () => {
    expect(release.urls).toHaveLength(116);
  });
});
