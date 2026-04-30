/**
 * Inbox row → source-attestation deep-link tests (TN-MOB-041).
 *
 * Pins the contract that the inbox renderer + the receiver screen
 * + any future inbox surface (DID-direct messages, mentions, etc.)
 * all share:
 *
 *   - Builder (`/trust/<id>` plain, `?attestation=<uri>` when anchored).
 *   - Strict validation: empty subjectId throws; malformed AT-URI
 *     throws (loud failure beats a silent missing-anchor on tap).
 *   - Parser graceful degradation: malformed `?attestation=` value
 *     parses to `attestationUri: null` rather than crashing the
 *     screen (incoming OS-deep-links may have been mangled upstream).
 *   - AT-URI structural regex: covers `did:plc:` + `did:web:` shapes,
 *     rejects anything that doesn't look like `at://<did>/<nsid>/<rkey>`.
 *   - Builder ↔ parser round-trip: every link the builder emits
 *     parses back to its original input.
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  buildAttestationDeepLink,
  parseAtUri,
  parseAttestationDeepLink,
  type ParsedAttestationDeepLink,
  type ParsedAtUri,
} from '../../src/trust/inbox_deep_link';

const VALID_AT_URI = 'at://did:plc:author/com.dina.trust.attestation/abc123';

// ─── parseAtUri ───────────────────────────────────────────────────────────

describe('parseAtUri', () => {
  it('returns the three components for a well-formed AT-URI', () => {
    const out = parseAtUri('at://did:plc:abc/com.dina.trust.attestation/3kxxxxx');
    expect(out).toEqual<ParsedAtUri>({
      did: 'did:plc:abc',
      collection: 'com.dina.trust.attestation',
      rkey: '3kxxxxx',
    });
  });

  it('accepts did:web (the spec admits both DID methods)', () => {
    const out = parseAtUri('at://did:web:example.com/com.dina.trust.vouch/r-1');
    expect(out).toEqual<ParsedAtUri>({
      did: 'did:web:example.com',
      collection: 'com.dina.trust.vouch',
      rkey: 'r-1',
    });
  });

  it('rejects malformed shapes (returns null, not throw)', () => {
    // Total function — callers should be able to test-and-branch
    // without try/catch noise.
    expect(parseAtUri('https://example.com/x')).toBeNull();
    expect(parseAtUri('at://no-did-and-collection')).toBeNull();
    expect(parseAtUri('at://did:plc:abc/no-rkey')).toBeNull();
    expect(parseAtUri('at://did:plc:abc/foo/')).toBeNull(); // trailing-slash empty rkey
    expect(parseAtUri('at://did:plc:abc//rkey')).toBeNull(); // empty collection
    expect(parseAtUri('')).toBeNull();
  });

  it('rejects non-string inputs without throwing', () => {
    // @ts-expect-error — runtime guard
    expect(parseAtUri(null)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseAtUri(undefined)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseAtUri(42)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseAtUri({})).toBeNull();
  });

  it('collection NSID requires at least one dot (NSIDs are dotted)', () => {
    // `flatcollection` would be a single-token NSID — invalid.
    expect(parseAtUri('at://did:plc:abc/flatcollection/rkey')).toBeNull();
  });
});

// ─── buildAttestationDeepLink ─────────────────────────────────────────────

describe('buildAttestationDeepLink — plain (no anchor)', () => {
  it('returns /trust/<id> when attestationUri is omitted', () => {
    expect(buildAttestationDeepLink({ subjectId: 'subj-aeron' })).toBe('/trust/subj-aeron');
  });

  it('returns /trust/<id> when attestationUri is null', () => {
    expect(buildAttestationDeepLink({ subjectId: 'subj-aeron', attestationUri: null })).toBe(
      '/trust/subj-aeron',
    );
  });

  it('encodes special characters in subjectId', () => {
    expect(buildAttestationDeepLink({ subjectId: 'a/b c' })).toBe('/trust/a%2Fb%20c');
  });
});

describe('buildAttestationDeepLink — anchored', () => {
  it('appends ?attestation=<encoded> when attestationUri is supplied', () => {
    const out = buildAttestationDeepLink({
      subjectId: 'subj-aeron',
      attestationUri: VALID_AT_URI,
    });
    expect(out).toBe(
      '/trust/subj-aeron?attestation=at%3A%2F%2Fdid%3Aplc%3Aauthor%2Fcom.dina.trust.attestation%2Fabc123',
    );
  });

  it('encodes the attestation URI but preserves the query-key spelling', () => {
    const out = buildAttestationDeepLink({
      subjectId: 'a',
      attestationUri: VALID_AT_URI,
    });
    expect(out.startsWith('/trust/a?attestation=')).toBe(true);
  });
});

describe('buildAttestationDeepLink — validation', () => {
  it('throws on empty subjectId', () => {
    expect(() => buildAttestationDeepLink({ subjectId: '' })).toThrow(/non-empty/);
  });

  it('throws on non-string subjectId', () => {
    // @ts-expect-error — runtime guard
    expect(() => buildAttestationDeepLink({ subjectId: undefined })).toThrow(/non-empty/);
    // @ts-expect-error — runtime guard
    expect(() => buildAttestationDeepLink({ subjectId: 42 })).toThrow(/non-empty/);
  });

  it('throws on empty-string attestationUri (when explicitly provided)', () => {
    // Empty string is not the same as null — null = "intentionally
    // no anchor"; "" = "I tried to set an anchor and failed". Loud.
    expect(() =>
      buildAttestationDeepLink({ subjectId: 'a', attestationUri: '' }),
    ).toThrow(/non-empty/);
  });

  it('throws on a non-string attestationUri value', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      buildAttestationDeepLink({ subjectId: 'a', attestationUri: 42 }),
    ).toThrow();
  });

  it('throws on a malformed AT-URI', () => {
    expect(() =>
      buildAttestationDeepLink({ subjectId: 'a', attestationUri: 'banana' }),
    ).toThrow(/AT-URI/);
    expect(() =>
      buildAttestationDeepLink({
        subjectId: 'a',
        attestationUri: 'at://did:plc:abc/no-rkey',
      }),
    ).toThrow(/AT-URI/);
  });
});

// ─── parseAttestationDeepLink ─────────────────────────────────────────────

describe('parseAttestationDeepLink — happy paths', () => {
  it('parses a plain /trust/<id> deep link', () => {
    expect(parseAttestationDeepLink('/trust/subj-aeron')).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'subj-aeron',
      attestationUri: null,
    });
  });

  it('parses a /trust/<id>?attestation=<uri> deep link', () => {
    const url = buildAttestationDeepLink({
      subjectId: 'subj-aeron',
      attestationUri: VALID_AT_URI,
    });
    expect(parseAttestationDeepLink(url)).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'subj-aeron',
      attestationUri: VALID_AT_URI,
    });
  });

  it('decodes encoded subjectIds', () => {
    expect(parseAttestationDeepLink('/trust/a%2Fb%20c')).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'a/b c',
      attestationUri: null,
    });
  });

  it('first attestation param wins; later ones are ignored (deterministic)', () => {
    // RFC 3986 doesn't define duplicate-query-key precedence; we
    // pin "first wins" by code so the screen behaviour is
    // predictable across ill-formed deep links.
    const url =
      `/trust/x?attestation=${encodeURIComponent(VALID_AT_URI)}` +
      `&attestation=${encodeURIComponent('at://did:plc:other/com.dina.trust.attestation/zzz')}`;
    expect(parseAttestationDeepLink(url)?.attestationUri).toBe(VALID_AT_URI);
  });

  it('ignores other query params (forward-compat with future anchors)', () => {
    const url = `/trust/x?other=42&attestation=${encodeURIComponent(VALID_AT_URI)}&trace=abc`;
    expect(parseAttestationDeepLink(url)).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'x',
      attestationUri: VALID_AT_URI,
    });
  });
});

describe('parseAttestationDeepLink — graceful degradation', () => {
  // The parser sees URLs that may have been mangled by the OS / OS
  // intent stack / push payload. Crashing the screen on a malformed
  // anchor is worse than gracefully degrading to "open the subject
  // without scroll".

  it('malformed attestation value → attestationUri: null (subject still resolves)', () => {
    const out = parseAttestationDeepLink('/trust/x?attestation=not-an-at-uri');
    expect(out).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'x',
      attestationUri: null,
    });
  });

  it('badly-encoded attestation value → attestationUri: null (no throw)', () => {
    // `%E0%A4` is a half-formed UTF-8 sequence that decodeURIComponent
    // throws on. We catch + degrade.
    const out = parseAttestationDeepLink('/trust/x?attestation=%E0%A4');
    expect(out?.attestationUri).toBeNull();
    expect(out?.subjectId).toBe('x');
  });

  it('badly-encoded subjectId → null (no usable route)', () => {
    expect(parseAttestationDeepLink('/trust/%E0%A4')).toBeNull();
  });

  it('returns null for non-/trust/ paths (not our deep link to handle)', () => {
    expect(parseAttestationDeepLink('/other/x')).toBeNull();
    expect(parseAttestationDeepLink('https://example.com')).toBeNull();
    expect(parseAttestationDeepLink('/trust')).toBeNull(); // missing trailing slash + id
  });

  it('returns null for empty subjectId path', () => {
    expect(parseAttestationDeepLink('/trust/')).toBeNull();
  });

  it('returns null for non-string / empty input', () => {
    // @ts-expect-error — runtime guard
    expect(parseAttestationDeepLink(null)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseAttestationDeepLink(undefined)).toBeNull();
    expect(parseAttestationDeepLink('')).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseAttestationDeepLink(42)).toBeNull();
  });

  it('empty attestation value (?attestation=) → attestationUri: null', () => {
    // Edge case from the OS sometimes shipping `?attestation=` with
    // no value. Should not crash; should not match.
    expect(parseAttestationDeepLink('/trust/x?attestation=')).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'x',
      attestationUri: null,
    });
  });

  it('attestation key without "=" (`?attestation`) → attestationUri: null', () => {
    // RFC 3986 admits flag-style query keys; we ignore them
    // gracefully rather than tripping on `eqIdx === -1`.
    expect(parseAttestationDeepLink('/trust/x?attestation')).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'x',
      attestationUri: null,
    });
  });

  it('exact-match query key — `attestationFoo=...` does NOT match `attestation=`', () => {
    // Defends against a refactor that switches to `startsWith` /
    // `includes` and silently accepts a typo'd key as the anchor.
    const url = `/trust/x?attestationFoo=${encodeURIComponent(VALID_AT_URI)}`;
    expect(parseAttestationDeepLink(url)).toEqual<ParsedAttestationDeepLink>({
      subjectId: 'x',
      attestationUri: null,
    });
  });
});

// ─── Round trip ───────────────────────────────────────────────────────────

describe('buildAttestationDeepLink ↔ parseAttestationDeepLink — round trip', () => {
  // Property-style pairs covering the dimensions that matter for
  // mobile in practice: simple ids, slash-bearing ids, percent-
  // bearing ids, no-anchor and anchored forms.
  const cases: Array<{ subjectId: string; attestationUri?: string | null }> = [
    { subjectId: 'subj-aeron', attestationUri: null },
    { subjectId: 'subj-aeron', attestationUri: VALID_AT_URI },
    { subjectId: 'a/b c', attestationUri: null },
    { subjectId: 'a/b c', attestationUri: VALID_AT_URI },
    { subjectId: '日本語', attestationUri: null },
    {
      subjectId: 'unicode-✅',
      attestationUri: 'at://did:web:example.com/com.dina.trust.vouch/r-1',
    },
  ];

  for (const c of cases) {
    it(`round-trips: ${c.subjectId} ${c.attestationUri ? 'WITH anchor' : 'NO anchor'}`, () => {
      const url = buildAttestationDeepLink(c);
      const parsed = parseAttestationDeepLink(url);
      expect(parsed?.subjectId).toBe(c.subjectId);
      expect(parsed?.attestationUri).toBe(c.attestationUri ?? null);
    });
  }
});
