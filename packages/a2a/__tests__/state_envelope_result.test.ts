import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_LIMITS,
  A2A_TO_OUTBOUND,
  DEFAULT_RESULT_SCHEMA,
  DEFAULT_RESULT_SCHEMA_HASH,
  DINA_WORKFLOW_STATES,
  REFUSAL_VIEW,
  TASK_STATES,
  WORKFLOW_TO_A2A,
  bytesToHex,
  canonicalize,
  envelopeObject,
  parseInvocationEnvelope,
  parseQualifiedSkill,
  qualifySkill,
  resultValueForSchema,
  sanitizeRemoteParts,
  utf8Bytes,
} from '../src';

describe('state maps (design §6.4, §7.4)', () => {
  it('maps every workflow state, and nothing else', () => {
    expect(Object.keys(WORKFLOW_TO_A2A).sort()).toEqual([...DINA_WORKFLOW_STATES].sort());
  });

  it('maps every A2A task state outbound, and nothing else', () => {
    expect(Object.keys(A2A_TO_OUTBOUND).sort()).toEqual([...TASK_STATES].sort());
  });

  it.each([
    ['created', 'TASK_STATE_SUBMITTED'],
    ['queued', 'TASK_STATE_SUBMITTED'],
    ['scheduled', 'TASK_STATE_SUBMITTED'],
    ['claimed', 'TASK_STATE_WORKING'],
    ['running', 'TASK_STATE_WORKING'],
    ['awaiting', 'TASK_STATE_WORKING'],
    ['pending_approval', 'TASK_STATE_WORKING'],
    ['completed', 'TASK_STATE_COMPLETED'],
    ['failed', 'TASK_STATE_FAILED'],
    ['cancelled', 'TASK_STATE_CANCELED'],
  ] as const)('inbound %s reads as %s', (internal, external) => {
    expect(WORKFLOW_TO_A2A[internal].state).toBe(external);
  });

  it('reports outcome_unknown honestly and flags recorded as an anomaly', () => {
    expect(WORKFLOW_TO_A2A.outcome_unknown).toEqual({
      state: 'TASK_STATE_FAILED',
      outcome: 'unknown',
    });
    expect(WORKFLOW_TO_A2A.recorded).toEqual({ state: 'TASK_STATE_FAILED', anomaly: true });
    expect(REFUSAL_VIEW).toEqual({ state: 'TASK_STATE_REJECTED' });
  });

  it('never keeps a remote INPUT_REQUIRED task running (no outbound multi-turn)', () => {
    expect(A2A_TO_OUTBOUND.TASK_STATE_INPUT_REQUIRED).toEqual({
      kind: 'fail',
      reason: 'remote_needs_input',
    });
    expect(A2A_TO_OUTBOUND.TASK_STATE_AUTH_REQUIRED).toEqual({
      kind: 'fail',
      reason: 'remote_needs_auth',
    });
    expect(A2A_TO_OUTBOUND.TASK_STATE_UNSPECIFIED).toEqual({ kind: 'unknown' });
    expect(A2A_TO_OUTBOUND.TASK_STATE_CANCELED).toEqual({ kind: 'cancelled' });
  });
});

describe('qualified skill names', () => {
  it.each([
    ['eta_query', { capability: 'eta_query' }],
    ['eta_query@self', { capability: 'eta_query', rkey: 'self' }],
    ['com.acme.widget_price@shop-1', { capability: 'com.acme.widget_price', rkey: 'shop-1' }],
  ])('parses %s', (raw, parsed) => expect(parseQualifiedSkill(raw)).toEqual(parsed));

  it.each([
    '',
    'ETA_query',
    'eta query',
    'eta_query@',
    '@self',
    'a@b@c',
    'eta_query@.',
    'eta_query@..',
    'eta_query@a/b',
    'x'.repeat(129),
  ])('refuses %p', (raw) => expect(parseQualifiedSkill(raw)).toBeNull());

  it('qualifies a skill', () => expect(qualifySkill('eta_query', 'self')).toBe('eta_query@self'));
});

describe('invocation envelope (design §7.2a)', () => {
  const data = (d: Record<string, unknown>) => ({ data: d });
  const valid = { skill: 'eta_query@self', params: { route: '42' } };

  it('accepts exactly one data part and ignores text', () => {
    const parsed = parseInvocationEnvelope([{ text: 'please' }, data(valid), { text: 'thanks' }]);
    expect(parsed).toEqual({
      ok: true,
      envelope: {
        skill: { capability: 'eta_query', rkey: 'self' },
        skillText: 'eta_query@self',
        params: { route: '42' },
      },
    });
  });

  it('keeps grant_id and schema_hash when well-formed', () => {
    const hash = 'a'.repeat(64);
    const parsed = parseInvocationEnvelope([
      data({ ...valid, grant_id: 'g-1', schema_hash: hash }),
    ]);
    expect(parsed.ok && envelopeObject(parsed.envelope)).toEqual({
      ...valid,
      grant_id: 'g-1',
      schema_hash: hash,
    });
  });

  it.each([
    ['no parts', [], 'no_parts'],
    ['text only', [{ text: 'hi' }], 'no_data_part'],
    ['two data parts', [data(valid), data(valid)], 'several_data_parts'],
    ['a raw part', [data(valid), { raw: 'AQID' }], 'raw_part_refused'],
    ['a url part', [{ url: 'https://x' }, data(valid)], 'url_part_refused'],
    ['a part with two contents', [{ text: 'a', data: valid }], 'part_content_not_exactly_one'],
    ['data that is an array', [{ data: [valid] }], 'data_not_object'],
    ['an unknown member', [data({ ...valid, priority: 'high' })], 'unknown_envelope_member'],
    ['a missing skill', [data({ params: {} })], 'skill_required'],
    ['an unknown-shaped skill', [data({ ...valid, skill: 'Eta Query' })], 'skill_malformed'],
    ['missing params', [data({ skill: 'eta_query' })], 'params_not_object'],
    ['array params', [data({ skill: 'eta_query', params: [] })], 'params_not_object'],
    [
      'an uppercase schema hash',
      [data({ ...valid, schema_hash: 'A'.repeat(64) })],
      'schema_hash_malformed',
    ],
    ['a grant id with spaces', [data({ ...valid, grant_id: 'g 1' })], 'grant_id_malformed'],
  ])('refuses %s', (_name, parts, reason) => {
    expect(parseInvocationEnvelope(parts)).toEqual({ ok: false, reason });
  });
});

describe('default result schema', () => {
  it('is pinned by hash', () => {
    expect(bytesToHex(sha256(utf8Bytes(canonicalize(DEFAULT_RESULT_SCHEMA))))).toBe(
      DEFAULT_RESULT_SCHEMA_HASH,
    );
  });

  it('cannot be mutated at runtime', () => {
    expect(Object.isFrozen(DEFAULT_RESULT_SCHEMA)).toBe(true);
    const props = DEFAULT_RESULT_SCHEMA.properties as Record<string, unknown>;
    expect(Object.isFrozen(props.parts)).toBe(true);
  });
});

describe('result sanitation (design §6.5)', () => {
  it('keeps text and data parts and drops part metadata', () => {
    const out = sanitizeRemoteParts([
      { text: 'hello', metadata: { a: 1 }, mediaType: 'text/plain' },
      { data: { n: 1, nested: [true, null] }, filename: 'x.json' },
    ]);
    expect(out).toEqual({
      ok: true,
      result: {
        envelope: {
          version: 1,
          parts: [{ text: 'hello' }, { data: { n: 1, nested: [true, null] } }],
        },
        truncated: false,
        stripped: false,
      },
    });
  });

  it('strips control, bidi and zero-width characters and lone surrogates, keeping tab/newline', () => {
    const out = sanitizeRemoteParts([
      { text: 'a\u0000b\u202Ec\u200Bd\uFEFFe\tf\ng\r\u0085h\ud800i' },
      { data: { 'k\u2066ey': 'v\u0007' } },
    ]);
    expect(out.ok && out.result.envelope.parts).toEqual([
      { text: 'abcde\tf\ng\rhi' },
      { data: { key: 'v' } },
    ]);
    expect(out.ok && out.result.stripped).toBe(true);
  });

  it('keeps well-formed astral characters', () => {
    const out = sanitizeRemoteParts([{ text: 'ok 😀' }]);
    expect(out.ok && out.result.envelope.parts).toEqual([{ text: 'ok 😀' }]);
  });

  it('cuts text at the code-point cap and flags the result', () => {
    // The cut lands inside a run of astral characters: it must not split a pair.
    const long = 'a'.repeat(A2A_LIMITS.maxTextCodePoints - 3) + '😀'.repeat(10);
    const out = sanitizeRemoteParts([{ text: long }]);
    expect(out.ok && out.result.truncated).toBe(true);
    const text = out.ok ? (out.result.envelope.parts[0] as { text: string }).text : '';
    expect([...text].length).toBe(A2A_LIMITS.maxTextCodePoints);
    expect(text.endsWith('😀😀😀')).toBe(true);
  });

  it.each([
    ['no parts', [], 'no_parts'],
    ['a raw part', [{ raw: 'AQID' }], 'raw_part_refused'],
    ['a url part', [{ url: 'https://x' }], 'url_part_refused'],
    ['too many parts', Array.from({ length: 17 }, () => ({ text: 'x' })), 'too_many_parts'],
    ['an oversized result', [{ text: 'x'.repeat(A2A_LIMITS.maxPayloadBytes) }], 'result_too_large'],
    ['a key collision after stripping', [{ data: { a: 1, 'a\u200B': 2 } }], 'data_key_collision'],
    ['a non-object part', ['text'], 'part_not_object'],
  ])('refuses %s', (_name, parts, reason) => {
    expect(sanitizeRemoteParts(parts)).toEqual({ ok: false, reason });
  });

  it('refuses data nested deeper than the cap', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(sanitizeRemoteParts([{ data: deep }])).toEqual({ ok: false, reason: 'data_too_deep' });
  });

  it('feeds the whole envelope to the default schema, and one data part to a pinned schema', () => {
    const out = sanitizeRemoteParts([{ data: { eta: 5 } }]);
    if (!out.ok) throw new Error('unexpected');
    expect(resultValueForSchema(out.result, 'default')).toEqual({
      ok: true,
      value: { version: 1, parts: [{ data: { eta: 5 } }] },
    });
    expect(resultValueForSchema(out.result, 'pinned')).toEqual({ ok: true, value: { eta: 5 } });
    const two = sanitizeRemoteParts([{ data: {} }, { text: 'x' }]);
    if (!two.ok) throw new Error('unexpected');
    expect(resultValueForSchema(two.result, 'pinned')).toEqual({
      ok: false,
      reason: 'pinned_schema_needs_one_data_part',
    });
  });
});
