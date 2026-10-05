/**
 * Request and response forms of the UCP schemas (plan §3.6 step 4a), checked
 * against the published v2026-08-25 documents, and the operation table's
 * schema locations checked to exist.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DINA_CAPABILITIES } from '../src/capabilities';
import { OPERATIONS } from '../src/operations';
import { schemaVariant, subschemas } from '../src/schema_variant';

const DIR = join(__dirname, 'fixtures/schemas/2026-08-25');
const load = (path: string) =>
  JSON.parse(readFileSync(join(DIR, path), 'utf8')) as Record<string, unknown>;
type Obj = Record<string, unknown>;
const props = (s: Obj) => s.properties as Record<string, unknown>;

describe('the annotations', () => {
  it('checkout: response-only members are forbidden in requests and required lists follow each operation', () => {
    const checkout = load('shopping/checkout.json');
    const create = schemaVariant(checkout, 'request', 'create');
    const update = schemaVariant(checkout, 'request', 'update');
    const response = schemaVariant(checkout, 'response');
    // `id` and `status` are response-only: forbidden in every request, required in a response.
    for (const req of [create, update]) {
      expect(props(req).id).toBe(false);
      expect(props(req).status).toBe(false);
      expect(req.required).not.toContain('id');
    }
    expect(response.required).toEqual(expect.arrayContaining(['id', 'status', 'line_items']));
    expect(props(response).id).not.toBe(false);
    // The original is untouched.
    expect(props(checkout).id).not.toBe(false);
  });

  it('a per-operation annotation applies to its operation only', () => {
    const doc = {
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string', ucp_request: { create: 'omit', update: 'required' } },
        c: { type: 'string', ucp_request: 'optional' },
        d: {
          type: 'string',
          ucp_request: { create: { transition: { from: 'omit', to: 'required' } } },
        },
      },
    };
    const doc2 = { ...doc, required: ['a', 'c'] };
    expect(schemaVariant(doc2, 'request', 'create')).toMatchObject({
      required: ['a'],
      properties: { b: false },
    });
    expect(schemaVariant(doc2, 'request', 'update')).toMatchObject({ required: ['a', 'b'] });
    expect(props(schemaVariant(doc2, 'request', 'update')).b).toEqual({
      type: 'string',
      ucp_request: { create: 'omit', update: 'required' },
    });
    // A transition reads as optional; a response ignores ucp_request entirely.
    expect(schemaVariant(doc2, 'request', 'create').required).not.toContain('d');
    expect(schemaVariant(doc2, 'response')).toEqual(doc2);
  });

  it('ucp_response: a member responses must omit is forbidden in a response; one they must carry is required', () => {
    const consent = load('shopping/buyer_consent.json');
    const response = schemaVariant(consent, 'response');
    const request = schemaVariant(consent, 'request', 'create');
    const withDescription = [...subschemas(response)].find((s) => {
      const p = s.properties as Obj | undefined;
      return p !== undefined && 'description' in p;
    });
    expect(withDescription?.required).toEqual(expect.arrayContaining(['description']));
    const inRequest = [...subschemas(request)].find((s) => {
      const p = s.properties as Obj | undefined;
      return p !== undefined && p.description === false;
    });
    expect(inRequest).toBeDefined();
  });

  it('a required list beside an allOf branch that annotates the member follows the annotation (daily_hour)', () => {
    const daily = load('common/types/daily_hour.json');
    const request = schemaVariant(daily, 'request', 'create');
    // The parent requires day, opens, closes; the branch says requests omit day.
    expect(request.required).toEqual(['opens', 'closes']);
    const branch = (request.allOf as Obj[])[1] as Obj;
    expect(props(branch).day).toBe(false);
    // Responses keep day required.
    expect(schemaVariant(daily, 'response').required).toEqual(['day', 'opens', 'closes']);
  });

  it('walks schema keywords only: a property named like a keyword, and data under examples, are not schemas', () => {
    const schema = {
      properties: { allOf: { type: 'string' } },
      examples: [{ properties: { x: { ucp_request: 'omit' } } }],
      allOf: [{ properties: { y: { type: 'integer', ucp_request: 'omit' } } }],
    };
    const seen = [...subschemas(schema)];
    expect(seen).toHaveLength(4); // root, properties.allOf, allOf[0], allOf[0].properties.y
    const out = schemaVariant(schema, 'request', 'create');
    expect((out.examples as Obj[])[0]).toEqual({ properties: { x: { ucp_request: 'omit' } } });
    expect(((out.allOf as Obj[])[0] as Obj).properties).toEqual({ y: false });
  });
});

describe('the operation table', () => {
  const schemaFor = (capability: string) => {
    const decl = DINA_CAPABILITIES.find((d) => d.name === capability);
    if (decl === undefined) throw new Error(capability);
    return load(decl.schema.replace('https://ucp.dev/2026-08-25/schemas/', ''));
  };
  const at = (doc: Obj, pointer: string): unknown =>
    pointer === ''
      ? doc
      : pointer
          .slice(1)
          .split('/')
          .reduce<unknown>(
            (node, t) => (node as Obj | undefined)?.[t.replace(/~1/g, '/').replace(/~0/g, '~')],
            doc,
          );

  it.each(Object.entries(OPERATIONS))(
    '%s points at schemas that exist in its capability’s document',
    (_name, op) => {
      const doc = schemaFor(op.capability);
      expect(at(doc, op.schemas.response.pointer)).toBeDefined();
      if (op.schemas.request !== undefined)
        expect(at(doc, op.schemas.request.pointer)).toBeDefined();
      // A request typed by the resource itself names its operation; one typed by its own $def does not.
      if (op.schemas.request !== undefined)
        expect(op.schemas.request.variant !== undefined).toBe(op.schemas.request.pointer === '');
      // A payload exactly when the binding carries one.
      expect(op.schemas.request !== undefined).toBe(op.payloadArg !== undefined);
    },
  );
});
