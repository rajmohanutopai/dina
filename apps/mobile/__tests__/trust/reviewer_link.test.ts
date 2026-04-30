/**
 * Reviewer profile drill-down deep-link tests (TN-MOB-026).
 *
 * Pins the contract every reviewer-row surface (subject card
 * spotlight line, subject-detail reviewer list, cosig inbox sender
 * line, network feed reviewer chip) shares:
 *
 *   - `isReviewerProfileTappable`: self-rows + DID-less rows + bad
 *     DIDs are NOT tappable; valid DIDs ARE.
 *   - `buildReviewerProfileDeepLink`: composes
 *     `/trust/reviewer/<did>[?namespace=<frag>]` per plan §8.5
 *     and §3.5.
 *   - DID + namespace validation: malformed inputs throw rather
 *     than silently stripping (per plan §3.5: a tap on a namespaced
 *     row that loses the namespace lands on the merged-root profile,
 *     which is misleading).
 *   - `parseReviewerProfileDeepLink`: graceful degradation on
 *     mangled `?namespace=` values (root profile, not crash);
 *     hard-null on non-/trust/reviewer/ paths or bad DIDs.
 *   - Round-trip: build → parse yields the original input shape.
 *
 * Pure-function tests — runs under plain Jest, no RN deps.
 */

import {
  buildReviewerProfileDeepLink,
  isReviewerProfileTappable,
  parseReviewerProfileDeepLink,
  type ParsedReviewerProfileDeepLink,
} from '../../src/trust/reviewer_link';

const VALID_DID = 'did:plc:reviewer42';
const VALID_DID_WEB = 'did:web:example.com';
const VALID_DID_KEY = 'did:key:zDnaerx9CtbPJ1q36T5Ln5wYt3MQYeGRG5ehnPAmxcf5mDZpv';
const VALID_NAMESPACE = 'namespace_3';

// ─── isReviewerProfileTappable ───────────────────────────────────────────

describe('isReviewerProfileTappable', () => {
  it('returns true for a valid DID', () => {
    expect(isReviewerProfileTappable({ did: VALID_DID })).toBe(true);
  });

  it('returns true for a valid did:web', () => {
    expect(isReviewerProfileTappable({ did: VALID_DID_WEB })).toBe(true);
  });

  it('returns true for any DID method admitted by the protocol validator (e.g. did:key)', () => {
    // Mirror of `record-validator.ts`'s `didString` regex — `^did:[a-z]+:`
    // — admits any DID method, not just plc/web. A tighter mobile
    // regex would silently render valid reviewers as non-tappable.
    expect(isReviewerProfileTappable({ did: VALID_DID_KEY })).toBe(true);
    expect(isReviewerProfileTappable({ did: 'did:ion:abc1234567' })).toBe(true);
  });

  it('returns false for self rows (user already on their own profile faster)', () => {
    expect(isReviewerProfileTappable({ did: VALID_DID, isSelf: true })).toBe(false);
  });

  it('returns false when did is null', () => {
    expect(isReviewerProfileTappable({ did: null })).toBe(false);
  });

  it('returns false when did is empty', () => {
    expect(isReviewerProfileTappable({ did: '' })).toBe(false);
  });

  it('returns false for non-DID strings (data anomaly defence)', () => {
    expect(isReviewerProfileTappable({ did: 'not-a-did' })).toBe(false);
    // Method-segment must be lowercase (per spec) — uppercase rejected.
    expect(isReviewerProfileTappable({ did: 'did:FOO:bar' })).toBe(false);
    // Must have non-empty body after the second colon (validator's
    // 8-char min length implicitly enforces).
    expect(isReviewerProfileTappable({ did: 'did:plc:' })).toBe(false);
    // Below 8-char min length cap.
    expect(isReviewerProfileTappable({ did: 'did:p:' })).toBe(false);
  });

  it('returns false for DIDs above the 2KiB length cap (DOS guard)', () => {
    const huge = 'did:plc:' + 'a'.repeat(2050);
    expect(isReviewerProfileTappable({ did: huge })).toBe(false);
  });

  it('does not throw on malformed inputs (predicate is total)', () => {
    // The point of the predicate is "branch without try/catch" — it
    // must never throw, even on weird input.
    // @ts-expect-error — runtime guard
    expect(() => isReviewerProfileTappable({ did: 42 })).not.toThrow();
  });
});

// ─── buildReviewerProfileDeepLink ────────────────────────────────────────

describe('buildReviewerProfileDeepLink — plain (no namespace)', () => {
  it('returns /trust/reviewer/<did> for a valid did:plc', () => {
    expect(buildReviewerProfileDeepLink({ did: VALID_DID })).toBe(
      `/trust/reviewer/${encodeURIComponent(VALID_DID)}`,
    );
  });

  it('handles did:web (encoded for path-segment safety)', () => {
    const out = buildReviewerProfileDeepLink({ did: VALID_DID_WEB });
    // did:web colons need encoding for path-segment safety
    expect(out).toBe('/trust/reviewer/did%3Aweb%3Aexample.com');
  });

  it('treats namespace=null as omitted', () => {
    expect(buildReviewerProfileDeepLink({ did: VALID_DID, namespace: null })).toBe(
      `/trust/reviewer/${encodeURIComponent(VALID_DID)}`,
    );
  });

  it('treats namespace=undefined as omitted', () => {
    expect(buildReviewerProfileDeepLink({ did: VALID_DID, namespace: undefined })).toBe(
      `/trust/reviewer/${encodeURIComponent(VALID_DID)}`,
    );
  });
});

describe('buildReviewerProfileDeepLink — namespaced', () => {
  it('appends ?namespace=<frag> for a valid namespace', () => {
    const out = buildReviewerProfileDeepLink({ did: VALID_DID, namespace: VALID_NAMESPACE });
    expect(out).toBe(
      `/trust/reviewer/${encodeURIComponent(VALID_DID)}?namespace=namespace_3`,
    );
  });

  it('encoded namespace stays alphanumeric (no encoding needed for the regex-allowed charset)', () => {
    // Per the namespaceFragment regex (alphanumeric + underscore),
    // encodeURIComponent passes the value through unchanged.
    const ns = 'a_b_c_1_2_3';
    const out = buildReviewerProfileDeepLink({ did: VALID_DID, namespace: ns });
    expect(out.endsWith(`?namespace=${ns}`)).toBe(true);
  });
});

describe('buildReviewerProfileDeepLink — validation', () => {
  it('throws on self rows (use isReviewerProfileTappable to guard)', () => {
    expect(() =>
      buildReviewerProfileDeepLink({ did: VALID_DID, isSelf: true }),
    ).toThrow(/self-reviews/);
  });

  it('throws on null did', () => {
    expect(() => buildReviewerProfileDeepLink({ did: null })).toThrow(/non-empty/);
  });

  it('throws on empty did', () => {
    expect(() => buildReviewerProfileDeepLink({ did: '' })).toThrow(/non-empty/);
  });

  it('throws on non-string did', () => {
    // @ts-expect-error — runtime guard
    expect(() => buildReviewerProfileDeepLink({ did: 42 })).toThrow(/non-empty/);
  });

  it('throws on did exceeding 2KiB (DOS guard symmetric with isReviewerProfileTappable)', () => {
    const huge = 'did:plc:' + 'a'.repeat(2050);
    expect(() => buildReviewerProfileDeepLink({ did: huge })).toThrow(/length must be in/);
  });

  it('throws on malformed DID (silent root-fallback would be misleading)', () => {
    expect(() => buildReviewerProfileDeepLink({ did: 'banana12' })).toThrow(/valid DID/);
    // Empty body after method — fails the regex (\S+ requires ≥1 char).
    expect(() => buildReviewerProfileDeepLink({ did: 'did:plc:' })).toThrow(/valid DID/);
    // Below 8-char min length cap — fails length check first.
    expect(() => buildReviewerProfileDeepLink({ did: 'did:p:' })).toThrow(/length must be in/);
  });

  it('throws on empty-string namespace (vs null = "intentionally root")', () => {
    expect(() =>
      buildReviewerProfileDeepLink({ did: VALID_DID, namespace: '' }),
    ).toThrow(/at least 1 char/);
  });

  it('throws on non-string namespace', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      buildReviewerProfileDeepLink({ did: VALID_DID, namespace: 42 }),
    ).toThrow();
  });

  it('throws on namespace exceeding 255-char cap', () => {
    expect(() =>
      buildReviewerProfileDeepLink({ did: VALID_DID, namespace: 'a'.repeat(256) }),
    ).toThrow(/exceeds max length/);
  });

  it('accepts unrestricted-charset namespaces (matches protocol validator — no regex constraint)', () => {
    // `record-validator.ts`'s `namespaceFragment = z.string().min(1).max(255)`
    // — NO regex. Tightening the mobile contract beyond that would
    // silently break compose for any namespace the protocol admits
    // but the mobile rejected. encodeURIComponent handles URL safety.
    const url = buildReviewerProfileDeepLink({ did: VALID_DID, namespace: 'has space' });
    expect(url).toContain(`?namespace=${encodeURIComponent('has space')}`);
  });
});

// ─── parseReviewerProfileDeepLink ────────────────────────────────────────

describe('parseReviewerProfileDeepLink — happy paths', () => {
  it('parses a plain /trust/reviewer/<did>', () => {
    const url = `/trust/reviewer/${encodeURIComponent(VALID_DID)}`;
    expect(parseReviewerProfileDeepLink(url)).toEqual<ParsedReviewerProfileDeepLink>({
      did: VALID_DID,
      namespace: null,
    });
  });

  it('parses /trust/reviewer/<did>?namespace=<frag>', () => {
    const url = buildReviewerProfileDeepLink({ did: VALID_DID, namespace: VALID_NAMESPACE });
    expect(parseReviewerProfileDeepLink(url)).toEqual<ParsedReviewerProfileDeepLink>({
      did: VALID_DID,
      namespace: VALID_NAMESPACE,
    });
  });

  it('parses did:web after path-encoded colon', () => {
    const url = buildReviewerProfileDeepLink({ did: VALID_DID_WEB });
    expect(parseReviewerProfileDeepLink(url)?.did).toBe(VALID_DID_WEB);
  });

  it('first namespace wins (RFC-3986-undefined; explicit pin)', () => {
    const url = `/trust/reviewer/${encodeURIComponent(VALID_DID)}?namespace=ns_a&namespace=ns_b`;
    expect(parseReviewerProfileDeepLink(url)?.namespace).toBe('ns_a');
  });
});

describe('parseReviewerProfileDeepLink — graceful degradation', () => {
  it('namespace round-trips through encodeURIComponent (unrestricted charset)', () => {
    // The parser admits any namespace that fits the length cap —
    // matches the protocol validator's behaviour. URL safety is
    // handled by encode/decode, not by content rejection.
    const url = `/trust/reviewer/${encodeURIComponent(VALID_DID)}?namespace=has%20space`;
    const out = parseReviewerProfileDeepLink(url);
    expect(out?.did).toBe(VALID_DID);
    expect(out?.namespace).toBe('has space');
  });

  it('namespace exceeding 255 chars → namespace: null', () => {
    const huge = 'a'.repeat(300);
    const url = `/trust/reviewer/${encodeURIComponent(VALID_DID)}?namespace=${huge}`;
    expect(parseReviewerProfileDeepLink(url)?.namespace).toBeNull();
  });

  it('returns null for non-/trust/reviewer paths', () => {
    expect(parseReviewerProfileDeepLink('/trust/subject-aeron')).toBeNull();
    expect(parseReviewerProfileDeepLink('https://example.com')).toBeNull();
    expect(parseReviewerProfileDeepLink('/trust/reviewer')).toBeNull(); // missing trailing slash + did
  });

  it('returns null for empty did segment', () => {
    expect(parseReviewerProfileDeepLink('/trust/reviewer/')).toBeNull();
  });

  it('returns null for invalid DIDs in the path (defensive)', () => {
    expect(parseReviewerProfileDeepLink('/trust/reviewer/banana12')).toBeNull();
    // Length below 8-char min length cap.
    expect(parseReviewerProfileDeepLink('/trust/reviewer/did:p:x')).toBeNull();
  });

  it('returns null for non-string / empty input', () => {
    expect(parseReviewerProfileDeepLink('')).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseReviewerProfileDeepLink(null)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseReviewerProfileDeepLink(undefined)).toBeNull();
  });

  it('exact-match query key — `namespaceFoo=...` does NOT match `namespace=`', () => {
    const url = `/trust/reviewer/${encodeURIComponent(VALID_DID)}?namespaceFoo=ns_1`;
    expect(parseReviewerProfileDeepLink(url)?.namespace).toBeNull();
  });
});

// ─── Round trip ──────────────────────────────────────────────────────────

describe('build ↔ parse round-trip', () => {
  const cases: Array<{ did: string; namespace?: string | null }> = [
    { did: VALID_DID, namespace: null },
    { did: VALID_DID, namespace: VALID_NAMESPACE },
    { did: VALID_DID_WEB, namespace: null },
    { did: VALID_DID_WEB, namespace: 'namespace_99' },
    // did:key — admitted by the protocol validator's any-method regex.
    { did: VALID_DID_KEY, namespace: null },
    // Unrestricted-charset namespace — handled by encode/decode.
    { did: VALID_DID, namespace: 'has space' },
  ];

  for (const c of cases) {
    it(`round-trips ${c.did} ${c.namespace ?? '(no namespace)'}`, () => {
      const url = buildReviewerProfileDeepLink(c);
      const parsed = parseReviewerProfileDeepLink(url);
      expect(parsed?.did).toBe(c.did);
      expect(parsed?.namespace).toBe(c.namespace ?? null);
    });
  }
});
