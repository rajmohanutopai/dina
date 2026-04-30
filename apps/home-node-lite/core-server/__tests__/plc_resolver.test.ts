/**
 * Task 6.6 — resolveDid / parsePlcDoc tests.
 */

import {
  parsePlcDoc,
  resolveDid,
  validatePlcDid,
  type PlcDoc,
  type PlcFetchFn,
  type PlcResolveOutcome,
} from '../src/appview/plc_resolver';

const GOOD_DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function validDoc(did: string = GOOD_DID): Record<string, unknown> {
  return {
    id: did,
    alsoKnownAs: ['at://alice.bsky.social'],
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: 'zQ3shW…',
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://bsky.social',
      },
    ],
  };
}

describe('validatePlcDid (task 6.6)', () => {
  it('accepts a well-formed did:plc', () => {
    expect(validatePlcDid(GOOD_DID)).toBe(GOOD_DID);
  });

  it('trims whitespace', () => {
    expect(validatePlcDid(`  ${GOOD_DID}  `)).toBe(GOOD_DID);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['number', 42],
    ['did:web', 'did:web:example.com'],
    ['wrong prefix', 'plc:abc123def456ghi789jkl012'],
    ['too short', 'did:plc:abc'],
    ['too long', `did:plc:${'a'.repeat(30)}`],
    ['uppercase', 'did:plc:ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['invalid base32 char', 'did:plc:abcdefghijklmnopqrstuvw1'],
  ])('rejects %s', (_label, input) => {
    expect(() => validatePlcDid(input)).toThrow();
  });
});

describe('parsePlcDoc (task 6.6)', () => {
  it('parses a valid doc', () => {
    const doc = parsePlcDoc(validDoc());
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.did).toBe(GOOD_DID);
    expect(doc.handles).toEqual(['at://alice.bsky.social']);
    expect(doc.verificationMethods).toHaveLength(1);
    expect(doc.services).toHaveLength(1);
  });

  it('preserves raw body', () => {
    const raw = validDoc();
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.raw).toBe(raw);
  });

  it('filters non-at:// handles', () => {
    const raw = validDoc();
    raw.alsoKnownAs = ['at://good.example', 'https://not-at-proto', null];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.handles).toEqual(['at://good.example']);
  });

  it('empty alsoKnownAs → empty handles array', () => {
    const raw = validDoc();
    delete raw.alsoKnownAs;
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.handles).toEqual([]);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 42],
    ['string', 'nope'],
  ])('rejects %s', (_label, raw) => {
    expect(parsePlcDoc(raw)).toBeNull();
  });

  it('rejects doc with missing id', () => {
    const raw = validDoc();
    delete raw.id;
    expect(parsePlcDoc(raw)).toBeNull();
  });

  it('rejects doc with malformed id', () => {
    expect(parsePlcDoc({ ...validDoc(), id: 'nope' })).toBeNull();
  });

  it('rejects verification method missing publicKeyMultibase', () => {
    const raw = validDoc();
    raw.verificationMethod = [
      {
        id: `${GOOD_DID}#atproto`,
        type: 'Multikey',
        controller: GOOD_DID,
      },
    ];
    expect(parsePlcDoc(raw)).toBeNull();
  });

  it('rejects service missing serviceEndpoint', () => {
    const raw = validDoc();
    raw.service = [
      { id: '#atproto_pds', type: 'AtprotoPersonalDataServer' },
    ];
    expect(parsePlcDoc(raw)).toBeNull();
  });

  it('missing verificationMethod array → empty array (not rejected)', () => {
    const raw = validDoc();
    delete raw.verificationMethod;
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.verificationMethods).toEqual([]);
  });

  it('missing service array → empty array', () => {
    const raw = validDoc();
    delete raw.service;
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.services).toEqual([]);
  });

  it('skips non-object entries in verification + service arrays', () => {
    const raw = validDoc();
    raw.verificationMethod = [null, 'string', 42, ...(raw.verificationMethod as unknown[])];
    raw.service = [null, ...(raw.service as unknown[])];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.verificationMethods).toHaveLength(1);
    expect(doc.services).toHaveLength(1);
  });
});

describe('resolveDid (task 6.6)', () => {
  it('returns ok:true on successful fetch + parse', async () => {
    const fetchFn: PlcFetchFn = async () => validDoc();
    const out = (await resolveDid(GOOD_DID, fetchFn)) as Extract<
      PlcResolveOutcome,
      { ok: true }
    >;
    expect(out.ok).toBe(true);
    expect(out.doc.did).toBe(GOOD_DID);
  });

  it('invalid DID → ok:false, kind=invalid_did (no fetch)', async () => {
    let fetchCalls = 0;
    const fetchFn: PlcFetchFn = async () => {
      fetchCalls++;
      return validDoc();
    };
    const out = await resolveDid('did:web:example.com', fetchFn);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('invalid_did');
    expect(fetchCalls).toBe(0);
  });

  it('null body → not_found', async () => {
    const out = await resolveDid(GOOD_DID, async () => null);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('not_found');
  });

  it('malformed body → malformed_doc', async () => {
    const out = await resolveDid(GOOD_DID, async () => ({
      id: 'not-a-did',
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe('malformed_doc');
  });

  it('body with mismatched id → malformed_doc', async () => {
    // Use a structurally-valid but different DID so parse succeeds
    // + the mismatch check is what rejects (not the format check).
    const otherDid = 'did:plc:zyxwvutsrqponmlkjihgfedc';
    const out = await resolveDid(
      GOOD_DID,
      async () => validDoc(otherDid),
    );
    expect(out.ok).toBe(false);
    if (out.ok === false && out.kind === 'malformed_doc') {
      expect(out.detail).toMatch(/does not match requested/);
    }
  });

  it('fetchFn throws → network_error', async () => {
    const out = await resolveDid(GOOD_DID, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(out.ok).toBe(false);
    if (out.ok === false && out.kind === 'network_error') {
      expect(out.error).toMatch(/ECONNREFUSED/);
    }
  });

  it('rejects when fetchFn is missing', async () => {
    await expect(
      resolveDid(GOOD_DID, undefined as unknown as PlcFetchFn),
    ).rejects.toThrow(/fetchFn/);
  });
});

describe('validatePlcDid — boundary length', () => {
  // DID_PLC_RE requires exactly 24 base32-sortable chars after `did:plc:`.
  // Pin both edges (23, 25) so neither off-by-one regression slips through.
  it('rejects exactly 23 chars (one short)', () => {
    expect(() => validatePlcDid(`did:plc:${'a'.repeat(23)}`)).toThrow();
  });

  it('rejects exactly 25 chars (one long)', () => {
    expect(() => validatePlcDid(`did:plc:${'a'.repeat(25)}`)).toThrow();
  });

  it('accepts exactly 24 chars (counter-pin)', () => {
    // Counter-pin: the boundary itself is valid, otherwise the
    // length test above could pass for the wrong reason.
    const did = `did:plc:${'a'.repeat(24)}`;
    expect(validatePlcDid(did)).toBe(did);
  });
});

describe('validatePlcDid — exhaust forbidden base32 chars', () => {
  // Base32-sortable alphabet = a-z + 2-7. Forbidden numerics: 0, 1, 8, 9.
  // Forbidden punctuation/symbols: anything outside [a-z2-7]. Pin each
  // forbidden numeric so a regex regression that lets one through is
  // caught.
  it.each(['0', '1', '8', '9'])('rejects forbidden numeric %s', (ch) => {
    // Insert at position 23 (last char) — most likely to escape a
    // sloppy "starts with" or "first char" regex.
    expect(() => validatePlcDid(`did:plc:${'a'.repeat(23)}${ch}`)).toThrow();
  });

  it.each(['-', '_', '.', '/', '+', '='])(
    'rejects forbidden symbol %s',
    (ch) => {
      expect(() => validatePlcDid(`did:plc:${'a'.repeat(23)}${ch}`)).toThrow();
    },
  );

  it('rejects mixed-case (single uppercase mid-string)', () => {
    // Counter-pin to the all-uppercase test in the main describe —
    // confirms the regex doesn't allow even one uppercase char.
    expect(() => validatePlcDid('did:plc:abcdefghijkLmnopqrstuvwx')).toThrow();
  });
});

describe('validatePlcDid — non-string types', () => {
  it.each([
    ['boolean true', true],
    ['boolean false', false],
    ['plain object', {}],
    ['array', []],
    ['symbol', Symbol('did')],
    ['function', () => GOOD_DID],
  ])('rejects %s with TypeError', (_label, input) => {
    expect(() => validatePlcDid(input)).toThrow(TypeError);
  });
});

describe('validatePlcDid — whitespace handling', () => {
  it('trims leading-only whitespace', () => {
    expect(validatePlcDid(`   ${GOOD_DID}`)).toBe(GOOD_DID);
  });

  it('trims trailing-only whitespace', () => {
    expect(validatePlcDid(`${GOOD_DID}\t\n`)).toBe(GOOD_DID);
  });

  it('rejects whitespace-only string as empty', () => {
    expect(() => validatePlcDid('   \t\n  ')).toThrow(/empty/);
  });

  it('rejects internal whitespace (not stripped, just trimmed)', () => {
    // Counter-pin: trim is edge-only, not a strip-all-whitespace.
    expect(() =>
      validatePlcDid('did:plc:abcdef ghijklmnopqrstuvwx'),
    ).toThrow();
  });
});

describe('parsePlcDoc — id field strictness', () => {
  it('rejects non-string id', () => {
    expect(parsePlcDoc({ ...validDoc(), id: 42 })).toBeNull();
  });

  it('rejects empty-string id', () => {
    expect(parsePlcDoc({ ...validDoc(), id: '' })).toBeNull();
  });

  it('rejects id with whitespace (parsePlcDoc does NOT trim)', () => {
    // parsePlcDoc takes the doc as-is; only validatePlcDid trims.
    // Pin that semantic so a future "let's trim everywhere" change
    // is caught.
    expect(parsePlcDoc({ ...validDoc(), id: ` ${GOOD_DID} ` })).toBeNull();
  });

  it('rejects array id', () => {
    expect(parsePlcDoc({ ...validDoc(), id: [GOOD_DID] })).toBeNull();
  });
});

describe('parseVerificationMethods — per-field reject taxonomy', () => {
  // For each required field × {non-string, empty-string}, prove the
  // whole doc is rejected (returns null), not silently skipped.
  // This is the critical reject-vs-skip distinction.
  function vmWith(overrides: Record<string, unknown>): Record<string, unknown> {
    const raw = validDoc();
    raw.verificationMethod = [
      {
        id: `${GOOD_DID}#atproto`,
        type: 'Multikey',
        controller: GOOD_DID,
        publicKeyMultibase: 'zQ3shW…',
        ...overrides,
      },
    ];
    return raw;
  }

  it.each([
    ['id non-string', { id: 42 }],
    ['id empty', { id: '' }],
    ['type non-string', { type: null }],
    ['type empty', { type: '' }],
    ['controller non-string', { controller: { x: 1 } }],
    ['controller empty', { controller: '' }],
    ['publicKeyMultibase non-string', { publicKeyMultibase: 42 }],
    ['publicKeyMultibase empty', { publicKeyMultibase: '' }],
  ])('rejects entry with %s', (_label, overrides) => {
    expect(parsePlcDoc(vmWith(overrides))).toBeNull();
  });

  it('rejects when id field is missing entirely', () => {
    const raw = validDoc();
    raw.verificationMethod = [
      { type: 'Multikey', controller: GOOD_DID, publicKeyMultibase: 'zQ…' },
    ];
    expect(parsePlcDoc(raw)).toBeNull();
  });

  it('rejects when controller field is missing entirely', () => {
    const raw = validDoc();
    raw.verificationMethod = [
      {
        id: `${GOOD_DID}#atproto`,
        type: 'Multikey',
        publicKeyMultibase: 'zQ…',
      },
    ];
    expect(parsePlcDoc(raw)).toBeNull();
  });
});

describe('parseVerificationMethods — skip vs reject distinction', () => {
  // Critical: malformed *object* entries reject the whole doc;
  // non-object entries (null, primitives) are silently skipped.
  // This is the documented semantic — pin it so a refactor that
  // unifies the two paths is caught.
  it('skips null entry (does not reject doc)', () => {
    const raw = validDoc();
    raw.verificationMethod = [null, ...(raw.verificationMethod as unknown[])];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.verificationMethods).toHaveLength(1);
  });

  it.each([
    ['string', 'nope'],
    ['number', 42],
    ['boolean', true],
    ['undefined', undefined],
  ])('skips %s entry (does not reject doc)', (_label, garbage) => {
    const raw = validDoc();
    raw.verificationMethod = [garbage, ...(raw.verificationMethod as unknown[])];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.verificationMethods).toHaveLength(1);
  });

  it('rejects when valid + malformed object entries are mixed', () => {
    // The malformed entry rejects the whole doc — even if a valid
    // entry comes first.
    const raw = validDoc();
    raw.verificationMethod = [
      ...(raw.verificationMethod as unknown[]),
      // valid first, malformed second
      {
        id: `${GOOD_DID}#bad`,
        type: 'Multikey',
        controller: GOOD_DID,
        // publicKeyMultibase missing
      },
    ];
    expect(parsePlcDoc(raw)).toBeNull();
  });

  it('non-array verificationMethod → empty array (treated as missing)', () => {
    const raw = validDoc();
    raw.verificationMethod = 'not-an-array';
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.verificationMethods).toEqual([]);
  });
});

describe('parseServices — per-field reject taxonomy', () => {
  function svcWith(overrides: Record<string, unknown>): Record<string, unknown> {
    const raw = validDoc();
    raw.service = [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://bsky.social',
        ...overrides,
      },
    ];
    return raw;
  }

  it.each([
    ['id non-string', { id: 42 }],
    ['id empty', { id: '' }],
    ['type non-string', { type: null }],
    ['type empty', { type: '' }],
    ['serviceEndpoint non-string', { serviceEndpoint: { url: 'x' } }],
    ['serviceEndpoint empty', { serviceEndpoint: '' }],
  ])('rejects entry with %s', (_label, overrides) => {
    expect(parsePlcDoc(svcWith(overrides))).toBeNull();
  });

  it('rejects when type field is missing entirely', () => {
    const raw = validDoc();
    raw.service = [
      { id: '#atproto_pds', serviceEndpoint: 'https://bsky.social' },
    ];
    expect(parsePlcDoc(raw)).toBeNull();
  });
});

describe('parseServices — skip vs reject distinction', () => {
  it.each([
    ['null', null],
    ['string', 'nope'],
    ['number', 42],
    ['boolean', false],
  ])('skips %s entry', (_label, garbage) => {
    const raw = validDoc();
    raw.service = [garbage, ...(raw.service as unknown[])];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.services).toHaveLength(1);
  });

  it('non-array service → empty array', () => {
    const raw = validDoc();
    raw.service = 99;
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.services).toEqual([]);
  });
});

describe('parseHandles — non-array + non-string filter', () => {
  // parseHandles is forgiving (returns []) for non-arrays, and
  // filters non-string + non-at:// elements. Pin the full taxonomy.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['number', 42],
    ['string', 'at://nope-not-array'],
    ['boolean', true],
  ])('non-array %s → empty handles', (_label, value) => {
    const raw = validDoc();
    raw.alsoKnownAs = value;
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.handles).toEqual([]);
  });

  it.each([
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['array', []],
    ['boolean', true],
    ['empty string', ''],
    ['plain string without at:// prefix', 'alice.bsky.social'],
    ['https URL', 'https://example.com'],
    ['did string', 'did:plc:abc'],
  ])('filters %s element from handles', (_label, element) => {
    const raw = validDoc();
    raw.alsoKnownAs = ['at://valid.example', element];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.handles).toEqual(['at://valid.example']);
  });

  it('preserves duplicate at:// entries (no de-dup)', () => {
    // Pin: parseHandles does not de-dup. If a future "smart" version
    // adds de-dup it should be a deliberate change with a test diff,
    // not a silent regression.
    const raw = validDoc();
    raw.alsoKnownAs = ['at://alice.example', 'at://alice.example'];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.handles).toEqual(['at://alice.example', 'at://alice.example']);
  });

  it('preserves order from input (no sort)', () => {
    const raw = validDoc();
    raw.alsoKnownAs = [
      'at://zulu.example',
      'at://alpha.example',
      'at://mike.example',
    ];
    const doc = parsePlcDoc(raw);
    if (!doc) throw new Error('expected doc to parse');
    expect(doc.handles).toEqual([
      'at://zulu.example',
      'at://alpha.example',
      'at://mike.example',
    ]);
  });
});

describe('resolveDid — outcome shape pinning', () => {
  // Each outcome kind has its own shape; pin them explicitly so a
  // refactor that reorders union members or renames fields is caught.
  it('invalid_did outcome has detail field (string, non-empty)', async () => {
    const out = await resolveDid('garbage', async () => null);
    if (out.ok) throw new Error('expected ok:false');
    if (out.kind !== 'invalid_did') throw new Error(`wrong kind: ${out.kind}`);
    expect(typeof out.detail).toBe('string');
    expect(out.detail.length).toBeGreaterThan(0);
  });

  it('not_found outcome has NO detail or error field', async () => {
    const out = await resolveDid(GOOD_DID, async () => null);
    if (out.ok) throw new Error('expected ok:false');
    if (out.kind !== 'not_found') throw new Error(`wrong kind: ${out.kind}`);
    // Counter-pin: ensure not_found stays minimal — exactly {ok, kind}.
    expect(Object.keys(out).sort()).toEqual(['kind', 'ok']);
  });

  it('malformed_doc outcome has detail field describing reason', async () => {
    const out = await resolveDid(GOOD_DID, async () => ({ id: 'not-a-did' }));
    if (out.ok) throw new Error('expected ok:false');
    if (out.kind !== 'malformed_doc')
      throw new Error(`wrong kind: ${out.kind}`);
    expect(typeof out.detail).toBe('string');
    expect(out.detail.length).toBeGreaterThan(0);
  });

  it('network_error outcome has error field carrying the original message', async () => {
    const original = 'EHOSTUNREACH: directory unreachable';
    const out = await resolveDid(GOOD_DID, async () => {
      throw new Error(original);
    });
    if (out.ok) throw new Error('expected ok:false');
    if (out.kind !== 'network_error')
      throw new Error(`wrong kind: ${out.kind}`);
    expect(out.error).toBe(original);
  });

  it('network_error stringifies non-Error throws', async () => {
    // Pin: throwing a non-Error (e.g. a string) still yields a
    // network_error kind with the value coerced to string.
    const out = await resolveDid(GOOD_DID, async () => {
      throw 'raw-string-throw';
    });
    if (out.ok) throw new Error('expected ok:false');
    if (out.kind !== 'network_error')
      throw new Error(`wrong kind: ${out.kind}`);
    expect(out.error).toBe('raw-string-throw');
  });

  it('successful outcome carries doc with mutually consistent did + raw.id', async () => {
    const fixture = validDoc();
    const out = await resolveDid(GOOD_DID, async () => fixture);
    if (!out.ok) throw new Error('expected ok:true');
    expect(out.doc.did).toBe(fixture.id);
    expect(out.doc.raw).toBe(fixture);
  });
});

describe('resolveDid — DID format check happens BEFORE fetch', () => {
  // Pin the orchestration order: validate first, then fetch. This
  // matters because invalid DIDs should never hit the network.
  it.each([
    ['empty string', ''],
    ['plain string', 'garbage'],
    ['wrong scheme', 'did:web:example.com'],
    ['too short', 'did:plc:abc'],
    ['uppercase', 'did:plc:ABCDEFGHIJKLMNOPQRSTUVWX'],
  ])('%s → invalid_did, fetchFn never called', async (_label, badDid) => {
    let calls = 0;
    const out = await resolveDid(badDid, async () => {
      calls++;
      return validDoc();
    });
    if (out.ok) throw new Error('expected ok:false');
    expect(out.kind).toBe('invalid_did');
    expect(calls).toBe(0);
  });
});

describe('realistic PLC responses', () => {
  it('resolves a doc with multiple verification methods + services', async () => {
    const raw = validDoc();
    raw.verificationMethod = [
      {
        id: `${GOOD_DID}#atproto`,
        type: 'Multikey',
        controller: GOOD_DID,
        publicKeyMultibase: 'zQ3shW…',
      },
      {
        id: `${GOOD_DID}#atproto_rotation`,
        type: 'Multikey',
        controller: GOOD_DID,
        publicKeyMultibase: 'zM…',
      },
    ];
    raw.service = [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://bsky.social',
      },
      {
        id: '#atproto_labeler',
        type: 'AtprotoLabeler',
        serviceEndpoint: 'https://label.example',
      },
    ];
    const out = (await resolveDid(GOOD_DID, async () => raw)) as Extract<
      PlcResolveOutcome,
      { ok: true }
    >;
    expect(out.doc.verificationMethods).toHaveLength(2);
    expect(out.doc.services).toHaveLength(2);
    const doc: PlcDoc = out.doc;
    const labeler = doc.services[1];
    if (!labeler) throw new Error('expected second service entry');
    expect(labeler.serviceEndpoint).toBe('https://label.example');
  });
});
