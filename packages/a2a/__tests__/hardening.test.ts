/**
 * Remote input never makes a pure function throw or change silently: the
 * strict parser, the invisible-character table, sanitation depth, the
 * `__proto__` member, and the total state maps.
 */

import {
  A2A_LIMITS,
  canonicalize,
  exclusionReason,
  inboundView,
  isInvisibleCodePoint,
  outboundDisposition,
  parseInvocationEnvelope,
  parseStrictJson,
  projectSkills,
  sampleFromSchema,
  sanitizeRemoteParts,
  stripInvisible,
  untrustedJsonProblem,
  uuidV4FromBytes,
  isUuidV4,
  type ProjectionCapability,
  type ProjectionListing,
} from '../src';

describe('parseStrictJson (RFC 7493)', () => {
  it.each([
    ['an object', '{"a":[1,2.5,-0,true,null,"x"]}'],
    ['whitespace around values', ' \t\n{ "a" : 1 } \r\n'],
    ['escapes, including a surrogate pair', '"\\u00e9\\ud83d\\ude00\\n"'],
    ['a large finite number', '1.7976931348623157e308'],
  ])('accepts %s exactly as JSON.parse reads it', (_name, text) => {
    const parsed = parseStrictJson(text);
    expect(parsed).toEqual({ ok: true, value: JSON.parse(text) });
  });

  it.each([
    ['empty text', '', 'syntax'],
    ['a trailing comma', '[1,]', 'syntax'],
    ['a leading zero', '01', 'syntax'],
    ['a leading plus', '+1', 'syntax'],
    ['a bare control character', '"a\u0001b"', 'syntax'],
    ['a bad escape', '"\\x41"', 'syntax'],
    ['trailing content', '{} {}', 'syntax'],
    ['a single quote', "{'a':1}", 'syntax'],
    ['a duplicate member', '{"a":1,"a":2}', 'duplicate_member'],
    ['a duplicate written two ways', '{"a":1,"\\u0061":2}', 'duplicate_member'],
    ['a __proto__ member', '{"__proto__":{"x":1}}', 'forbidden_member'],
    ['an escaped __proto__ member', '{"\\u005f_proto__":1}', 'forbidden_member'],
    ['a lone high surrogate', '"\\ud800"', 'lone_surrogate'],
    ['a lone low surrogate in a key', '{"\\udc00":1}', 'lone_surrogate'],
    ['a number past double range', '1e400', 'number_out_of_range'],
  ])('refuses %s', (_name, text, reason) => {
    expect(parseStrictJson(text)).toEqual({ ok: false, reason });
  });

  it('caps depth at the same place canonicalize does', () => {
    const nested = (n: number): string => '['.repeat(n) + ']'.repeat(n);
    // Depth counts from 0 at the root: n arrays put the innermost at depth n - 1.
    const atCap = nested(A2A_LIMITS.maxJsonDepth + 1);
    const pastCap = nested(A2A_LIMITS.maxJsonDepth + 2);
    const ok = parseStrictJson(atCap);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(() => canonicalize(ok.value)).not.toThrow();
    expect(parseStrictJson(pastCap)).toEqual({ ok: false, reason: 'too_deep' });
    expect(() => canonicalize(JSON.parse(pastCap))).toThrow(/too deep/);
  });

  it('untrustedJsonProblem agrees with the parser on depth and __proto__', () => {
    const poisoned = JSON.parse('{"a":{"__proto__":1}}') as unknown;
    expect(untrustedJsonProblem(poisoned)).toBe('forbidden_member');
    let deep: unknown = 1;
    for (let i = 0; i <= A2A_LIMITS.maxJsonDepth; i++) deep = [deep];
    expect(untrustedJsonProblem(deep)).toBe('too_deep');
    expect(untrustedJsonProblem({ a: [1, { b: 'c' }] })).toBeNull();
  });
});

describe('invisible code points', () => {
  it('covers every format character (Cf) this runtime knows, by code point', () => {
    const cf = /^\p{Cf}$/u;
    const missed: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (cf.test(String.fromCodePoint(cp)) && !isInvisibleCodePoint(cp)) {
        missed.push(cp.toString(16));
      }
    }
    expect(missed).toEqual([]);
  });

  // Cold audit C6-3
  it('covers every default-ignorable code point this runtime knows, which a renderer must draw as nothing', () => {
    const ignorable = /^\p{Default_Ignorable_Code_Point}$/u;
    const missed: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (ignorable.test(String.fromCodePoint(cp)) && !isInvisibleCodePoint(cp)) {
        missed.push(cp.toString(16));
      }
    }
    expect(missed).toEqual([]);
  });

  it('covers the controls, separators, variation selectors and blank fillers', () => {
    for (const cp of [
      0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0xfe0f, 0xe0100, 0x180b, 0x3164, 0x115f,
      0x034f,
    ]) {
      expect(isInvisibleCodePoint(cp)).toBe(true);
    }
    for (const cp of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0xe9, 0x1f600, 0x4e00]) {
      expect(isInvisibleCodePoint(cp)).toBe(false);
    }
  });

  it('strips astral invisibles (the tag block spelling hidden ASCII) and lone surrogates', () => {
    const hidden = [...'ignore']
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join('');
    const report = { stripped: false };
    expect(stripInvisible(`ok${hidden}\u2062\u00ad\u180e\ufe0f\u2028done\ud800`, report)).toBe(
      'okdone',
    );
    expect(report.stripped).toBe(true);
    const clean = { stripped: false };
    expect(stripInvisible('café 😀\tline\n', clean)).toBe('café 😀\tline\n');
    expect(clean.stripped).toBe(false);
  });
});

describe('result sanitation never throws and never changes data silently', () => {
  it('refuses a __proto__ key in data rather than setting a prototype', () => {
    const parts = JSON.parse('[{"data":{"__proto__":{"isAdmin":true}}}]') as unknown;
    expect(sanitizeRemoteParts(parts)).toEqual({ ok: false, reason: 'data_forbidden_key' });
  });

  it('refuses a key that only becomes __proto__ after stripping', () => {
    const parts = [{ data: JSON.parse('{"__pro\\u200bto__":1}') as unknown }];
    expect(sanitizeRemoteParts(parts)).toEqual({ ok: false, reason: 'data_forbidden_key' });
  });

  it('accepts data exactly as deep as the released envelope can be canonicalized, and no deeper', () => {
    for (let n = 25; n <= 34; n++) {
      let data: unknown = 'leaf';
      for (let i = 0; i < n; i++) data = { d: data };
      const out = sanitizeRemoteParts([{ data }]);
      let canonicalizes = true;
      try {
        canonicalize({ version: 1, parts: [{ data }] });
      } catch {
        canonicalizes = false;
      }
      expect(out.ok).toBe(canonicalizes);
      if (out.ok) expect(() => canonicalize(out.result.envelope)).not.toThrow();
    }
  });
});

describe('envelope params cannot carry __proto__ or excess depth', () => {
  it('refuses a __proto__ member anywhere in params', () => {
    const data = JSON.parse('{"skill":"eta_query","params":{"a":{"__proto__":{}}}}') as unknown;
    expect(parseInvocationEnvelope([{ data }])).toEqual({
      ok: false,
      reason: 'params_forbidden_member',
    });
  });

  it('refuses params too deep to hash inside the envelope', () => {
    let params: Record<string, unknown> = {};
    for (let i = 0; i < A2A_LIMITS.maxJsonDepth; i++) params = { p: params };
    expect(parseInvocationEnvelope([{ data: { skill: 'eta_query', params } }])).toEqual({
      ok: false,
      reason: 'params_too_deep',
    });
  });
});

describe('state maps are total over strings read from storage or a peer', () => {
  it('reads an unknown workflow state as a FAILED anomaly', () => {
    expect(inboundView('teleported')).toEqual({ state: 'TASK_STATE_FAILED', anomaly: true });
    expect(inboundView('toString')).toEqual({ state: 'TASK_STATE_FAILED', anomaly: true });
    expect(inboundView('running')).toEqual({ state: 'TASK_STATE_WORKING' });
  });

  it('reads an unknown remote state as unknown (re-poll), never as success or failure', () => {
    expect(outboundDisposition('TASK_STATE_FROZEN')).toEqual({ kind: 'unknown' });
    expect(outboundDisposition('constructor')).toEqual({ kind: 'unknown' });
    expect(outboundDisposition('TASK_STATE_COMPLETED')).toEqual({ kind: 'completed' });
  });
});

describe('card projection', () => {
  const cap = (over: Partial<ProjectionCapability> = {}): ProjectionCapability => ({
    capability: 'eta_query',
    canonical: 'eta_query',
    actionClass: 'read',
    publicExposureAllowed: true,
    paramsSchema: { type: 'object', properties: { route: { type: 'string' } } },
    schemaHash: 'a'.repeat(64),
    schemasEnforceable: true,
    executor: 'tier1',
    displayName: 'ETA',
    description: 'Arrival time.',
    tags: [],
    ...over,
  });
  const listing = (caps: ProjectionCapability[]): ProjectionListing => ({
    rkey: 'self',
    status: 'active',
    discoverability: 'public',
    surface: 'services',
    capabilities: caps,
  });

  it('leaves out a skill id that a capability and its alias would both claim', () => {
    const both = listing([cap(), cap({ capability: 'bus_eta' })]);
    expect(projectSkills([both])).toEqual([]);
    expect(both.capabilities.map((c) => exclusionReason(both, c))).toEqual(['ambiguous_skill', 'ambiguous_skill']);
    // The extended card's granted skills follow the same rule.
    const granted = { ...both, discoverability: 'known_only' as const };
    const audience = { scope: [], grants: [{ grantId: 'g1', rkey: 'self', capability: 'eta_query' }] };
    expect(projectSkills([granted], audience)).toEqual([]);
  });

  it('is ambiguous whatever else is true of either entry: one with no executor still takes the other off', () => {
    // Invocation could not tell which entry a call means; the card shows neither.
    const both = listing([cap(), cap({ capability: 'bus_eta', executor: null })]);
    expect(both.capabilities.map((c) => exclusionReason(both, c))).toEqual(['ambiguous_skill', 'ambiguous_skill']);
    expect(projectSkills([listing([cap()])]).map((s) => s.skill.id)).toEqual(['eta_query@self']);
  });

  it('leaves out a capability whose params schema Core cannot enforce exactly', () => {
    expect(projectSkills([listing([cap({ schemasEnforceable: false })])])).toEqual([]);
  });

  it.each([
    ['pattern', { type: 'string', pattern: '^[0-9]+$' }],
    ['exclusiveMinimum', { type: 'integer', exclusiveMinimum: 0 }],
    ['multipleOf', { type: 'number', multipleOf: 3 }],
    ['uniqueItems', { type: 'array', minItems: 2, items: { type: 'integer' }, uniqueItems: true }],
    ['minProperties', { type: 'object', minProperties: 1 }],
    ['oneOf', { oneOf: [{ type: 'string' }] }],
    ['min above max', { type: 'string', minLength: 3, maxLength: 1 }],
    ['a required name with no property', { type: 'object', required: ['a'], properties: {} }],
  ])('gives no example rather than a wrong one (%s)', (_name, schema) => {
    expect(sampleFromSchema(schema)).toBeUndefined();
  });
});

describe('uuidV4FromBytes', () => {
  it('sets the version and variant bits', () => {
    const id = uuidV4FromBytes(new Uint8Array(16).fill(0xff));
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(isUuidV4(id)).toBe(true);
    expect(isUuidV4(uuidV4FromBytes(new Uint8Array(16)))).toBe(true);
    expect(() => uuidV4FromBytes(new Uint8Array(15))).toThrow();
  });
});
