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
    expect(doc).not.toBeNull();
    expect(doc!.did).toBe(GOOD_DID);
    expect(doc!.handles).toEqual(['at://alice.bsky.social']);
    expect(doc!.verificationMethods).toHaveLength(1);
    expect(doc!.services).toHaveLength(1);
  });

  it('preserves raw body', () => {
    const raw = validDoc();
    const doc = parsePlcDoc(raw);
    expect(doc!.raw).toBe(raw);
  });

  it('filters non-at:// handles', () => {
    const raw = validDoc();
    raw.alsoKnownAs = ['at://good.example', 'https://not-at-proto', null];
    const doc = parsePlcDoc(raw);
    expect(doc!.handles).toEqual(['at://good.example']);
  });

  it('empty alsoKnownAs → empty handles array', () => {
    const raw = validDoc();
    delete raw.alsoKnownAs;
    const doc = parsePlcDoc(raw);
    expect(doc!.handles).toEqual([]);
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
    expect(doc).not.toBeNull();
    expect(doc!.verificationMethods).toEqual([]);
  });

  it('missing service array → empty array', () => {
    const raw = validDoc();
    delete raw.service;
    const doc = parsePlcDoc(raw);
    expect(doc!.services).toEqual([]);
  });

  it('skips non-object entries in verification + service arrays', () => {
    const raw = validDoc();
    raw.verificationMethod = [null, 'string', 42, ...(raw.verificationMethod as unknown[])];
    raw.service = [null, ...(raw.service as unknown[])];
    const doc = parsePlcDoc(raw);
    expect(doc!.verificationMethods).toHaveLength(1);
    expect(doc!.services).toHaveLength(1);
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
    expect(doc.services[1]!.serviceEndpoint).toBe('https://label.example');
  });
});
