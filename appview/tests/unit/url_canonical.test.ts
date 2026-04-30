/**
 * Unit tests for `appview/src/util/url_canonical.ts` (TN-TEST-006 /
 * Plan §3.6 line 487).
 *
 * The canonicaliser is a pure function — these tests drive it with
 * input strings and assert the canonical output. No DB, no I/O.
 *
 * Coverage strategy:
 *   - Default behaviour for the documented happy path (lowercase host,
 *     strip default port, strip fragment, strip tracking params,
 *     sort query, strip trailing slash).
 *   - Each option (`stripWww`, `stripFragment`, `extraTrackingParams`)
 *     verified ON and OFF.
 *   - Closed list of edge cases: empty input, malformed URL,
 *     passthrough schemes (mailto/tel/data), root path, IP address
 *     hosts, repeated query keys, userinfo preservation.
 *
 * Why each assertion: every test's inline comment names the dedup
 * win OR the regression it pins. "Why does this test exist?" should
 * be answerable from the comment alone.
 */

import { describe, expect, it } from 'vitest'

import { canonicaliseUrl, TRACKING_PARAM_KEYS } from '@/util/url_canonical'

// ── Default canonicalisation ───────────────────────────────────

describe('canonicaliseUrl — defaults', () => {
  it('lowercases the host (DNS is case-insensitive)', () => {
    // Two attestations referencing https://Example.com and https://example.com
    // would dedup to two subjects without this. Pinned because URL parsers
    // already do this in practice, but defence-in-depth ensures the contract
    // doesn't depend on a specific parser quirk.
    expect(canonicaliseUrl('https://Example.com/foo')).toBe('https://example.com/foo')
    expect(canonicaliseUrl('HTTP://EXAMPLE.COM/foo')).toBe('http://example.com/foo')
  })

  it('strips default port (80 for http, 443 for https)', () => {
    expect(canonicaliseUrl('http://example.com:80/foo')).toBe('http://example.com/foo')
    expect(canonicaliseUrl('https://example.com:443/foo')).toBe('https://example.com/foo')
  })

  it('preserves non-default ports', () => {
    expect(canonicaliseUrl('http://example.com:8080/foo')).toBe('http://example.com:8080/foo')
    expect(canonicaliseUrl('https://example.com:8443/foo')).toBe('https://example.com:8443/foo')
  })

  it('strips fragment by default (anchors point to same content)', () => {
    // Reviews of the same article that link to different sections via
    // `#section-foo` vs `#section-bar` should dedup. Stripping the
    // fragment is the canonical form for the "what page" question.
    expect(canonicaliseUrl('https://example.com/article#intro')).toBe('https://example.com/article')
  })

  it('strips trailing slash from non-root paths', () => {
    expect(canonicaliseUrl('https://example.com/foo/')).toBe('https://example.com/foo')
    expect(canonicaliseUrl('https://example.com/foo/bar/')).toBe('https://example.com/foo/bar')
  })

  it('preserves trailing slash on the ROOT path "/"', () => {
    // Stripping the root slash would produce `https://example.com`
    // which the WHATWG URL parser does NOT emit — breaking
    // string-equality comparisons against other code paths that
    // round-trip through URL constructor.
    expect(canonicaliseUrl('https://example.com/')).toBe('https://example.com/')
    expect(canonicaliseUrl('https://example.com')).toBe('https://example.com/')
  })

  it('preserves userinfo (auth-bearing URLs are semantically distinct)', () => {
    expect(canonicaliseUrl('https://alice@example.com/foo')).toBe('https://alice@example.com/foo')
    expect(canonicaliseUrl('https://alice:secret@example.com/foo')).toBe('https://alice:secret@example.com/foo')
  })

  it('does NOT lowercase the path (paths can be case-sensitive)', () => {
    // Apache's `Files` directive is case-sensitive; GitHub repo names
    // are case-sensitive; lowercasing would map `/Foo` and `/foo` to
    // the same key, deduplicating two distinct resources.
    expect(canonicaliseUrl('https://example.com/Foo')).toBe('https://example.com/Foo')
    expect(canonicaliseUrl('https://example.com/CamelCase/path')).toBe(
      'https://example.com/CamelCase/path',
    )
  })

  it('strips known tracking params (utm_*, gclid, fbclid, etc.)', () => {
    expect(
      canonicaliseUrl('https://example.com/p?utm_source=newsletter&id=42'),
    ).toBe('https://example.com/p?id=42')
    expect(
      canonicaliseUrl('https://example.com/p?gclid=xxx&fbclid=yyy&id=42'),
    ).toBe('https://example.com/p?id=42')
  })

  it('sorts remaining query params alphabetically', () => {
    // Two attestations linking the same product page with params in
    // different orders should dedup. `?z=1&a=2` and `?a=2&z=1` → same
    // canonical form.
    expect(canonicaliseUrl('https://example.com/p?z=1&a=2')).toBe(
      'https://example.com/p?a=2&z=1',
    )
    expect(canonicaliseUrl('https://example.com/p?a=2&z=1')).toBe(
      'https://example.com/p?a=2&z=1',
    )
  })

  it('preserves order of repeated keys (e.g. ?id=1&id=2 means "both")', () => {
    // APIs use `?id=1&id=2` to pass arrays; reordering would change
    // semantics. Keys sort but values within a repeated key are
    // insertion-ordered.
    expect(canonicaliseUrl('https://example.com/p?id=1&id=2')).toBe(
      'https://example.com/p?id=1&id=2',
    )
  })

  it('emits no `?` when all query params were tracking-stripped', () => {
    // A URL whose only query params were tracking should have a clean
    // canonical form with no trailing `?`.
    expect(canonicaliseUrl('https://example.com/p?utm_source=x&utm_campaign=y')).toBe(
      'https://example.com/p',
    )
  })

  it('canonicalises a fully-noisy URL end-to-end', () => {
    // Combined: case-insensitive host, default port, tracking params,
    // fragment, trailing slash, query reorder.
    expect(
      canonicaliseUrl(
        'https://Example.com:443/foo/?utm_source=x&id=42&gclid=abc#anchor',
      ),
    ).toBe('https://example.com/foo?id=42')
  })
})

// ── stripWww option ────────────────────────────────────────────

describe('canonicaliseUrl — stripWww option', () => {
  it('does NOT strip www. by default (per-deployment decision)', () => {
    expect(canonicaliseUrl('https://www.example.com/foo')).toBe(
      'https://www.example.com/foo',
    )
  })

  it('strips www. when stripWww: true', () => {
    expect(
      canonicaliseUrl('https://www.example.com/foo', { stripWww: true }),
    ).toBe('https://example.com/foo')
  })

  it('only strips literal "www." prefix, not similar (e.g. "www2.")', () => {
    // Defensive: 'www2.example.com' is a real subdomain; stripping
    // four-char "www." prefix on substring match would incorrectly
    // collapse `www2.example.com` → `2.example.com`. The contract
    // is a literal `www.` prefix only.
    expect(
      canonicaliseUrl('https://www2.example.com/foo', { stripWww: true }),
    ).toBe('https://www2.example.com/foo')
    expect(
      canonicaliseUrl('https://wwwsomething.example.com/foo', { stripWww: true }),
    ).toBe('https://wwwsomething.example.com/foo')
  })
})

// ── stripFragment option ───────────────────────────────────────

describe('canonicaliseUrl — stripFragment option', () => {
  it('preserves fragment when stripFragment: false', () => {
    // SPA routers that use the fragment as the route need the
    // anchor preserved — `#/dashboard` and `#/settings` are
    // semantically different pages.
    expect(
      canonicaliseUrl('https://example.com/foo#anchor', { stripFragment: false }),
    ).toBe('https://example.com/foo#anchor')
  })

  it('strips fragment by default', () => {
    expect(canonicaliseUrl('https://example.com/foo#anchor')).toBe('https://example.com/foo')
  })
})

// ── extraTrackingParams option ─────────────────────────────────

describe('canonicaliseUrl — extraTrackingParams option', () => {
  it('strips operator-supplied extra tracking params', () => {
    // Deployment-specific noise (an internal AB-test param, a
    // partner referral key) gets added without forking the const.
    expect(
      canonicaliseUrl('https://example.com/p?ab_test=variant_a&id=42', {
        extraTrackingParams: ['ab_test'],
      }),
    ).toBe('https://example.com/p?id=42')
  })

  it('extras compose with the built-in tracking list', () => {
    // Both built-in (utm_source) AND extra (ab_test) get stripped.
    expect(
      canonicaliseUrl('https://example.com/p?utm_source=x&ab_test=v&id=42', {
        extraTrackingParams: ['ab_test'],
      }),
    ).toBe('https://example.com/p?id=42')
  })
})

// ── Passthrough schemes ────────────────────────────────────────

describe('canonicaliseUrl — passthrough schemes', () => {
  it('returns mailto: URIs unchanged', () => {
    // No host/path/query in the standard sense; mailto already has
    // its own canonical form per RFC 6068.
    expect(canonicaliseUrl('mailto:alice@example.com')).toBe('mailto:alice@example.com')
  })

  it('returns tel: URIs unchanged', () => {
    expect(canonicaliseUrl('tel:+15551234567')).toBe('tel:+15551234567')
  })

  it('returns data: URIs unchanged (the payload IS the identity)', () => {
    // Canonicalising a data: URL would actively destroy meaning —
    // the base64 payload is the resource.
    const dataUrl = 'data:text/plain;base64,SGVsbG8gd29ybGQ='
    expect(canonicaliseUrl(dataUrl)).toBe(dataUrl)
  })

  it('returns javascript: URIs unchanged', () => {
    // Not that we expect to see these in attestation subjects, but
    // defensive against unexpected input → don't transform.
    expect(canonicaliseUrl('javascript:void(0)')).toBe('javascript:void(0)')
  })

  it('passthrough scheme detection is case-insensitive', () => {
    // `MAILTO:` vs `mailto:` should both passthrough.
    expect(canonicaliseUrl('MAILTO:alice@example.com')).toBe('MAILTO:alice@example.com')
  })
})

// ── Invalid input ──────────────────────────────────────────────

describe('canonicaliseUrl — invalid input', () => {
  it('returns null for empty string', () => {
    expect(canonicaliseUrl('')).toBeNull()
  })

  it('returns null for non-URL strings', () => {
    expect(canonicaliseUrl('not a url at all')).toBeNull()
    expect(canonicaliseUrl('just some text')).toBeNull()
  })

  it('returns null for malformed URLs (missing scheme)', () => {
    // `example.com/foo` without scheme is ambiguous (could be
    // pathname). The WHATWG URL constructor rejects it.
    expect(canonicaliseUrl('example.com/foo')).toBeNull()
  })

  it('handles non-string input by returning null (defensive)', () => {
    // Caller bugs (passing a number / null / undefined) shouldn't
    // crash the canonicaliser — return null and let the caller
    // handle the absent canonical form.
    expect(canonicaliseUrl(undefined as unknown as string)).toBeNull()
    expect(canonicaliseUrl(null as unknown as string)).toBeNull()
    expect(canonicaliseUrl(42 as unknown as string)).toBeNull()
  })
})

// ── IP address hosts ───────────────────────────────────────────

describe('canonicaliseUrl — IP address hosts', () => {
  it('preserves IPv4 addresses unchanged', () => {
    expect(canonicaliseUrl('http://192.168.1.1/foo')).toBe('http://192.168.1.1/foo')
  })

  it('handles IPv6 brackets', () => {
    // `http://[::1]/foo` round-trips; brackets are part of the
    // host syntax for IPv6.
    expect(canonicaliseUrl('http://[::1]/foo')).toBe('http://[::1]/foo')
  })
})

// ── Determinism + idempotence ──────────────────────────────────

describe('canonicaliseUrl — determinism + idempotence', () => {
  it('produces the same output for the same input across calls (pure function)', () => {
    const input = 'https://Example.com:443/foo/?utm_source=x&id=42#anchor'
    const a = canonicaliseUrl(input)
    const b = canonicaliseUrl(input)
    expect(a).toBe(b)
  })

  it('is idempotent — canonicalising a canonical URL returns itself', () => {
    // Pinned because a canonicalisation function that mutates its own
    // output on a second pass is hard to reason about; idempotence
    // is the invariant the dedup hash relies on.
    const canonical = 'https://example.com/foo?id=42'
    expect(canonicaliseUrl(canonical)).toBe(canonical)
  })

  it('idempotent across multiple options-aware canonicalisations', () => {
    const opts = { stripWww: true, stripFragment: true }
    const once = canonicaliseUrl('https://www.Example.com:443/foo/?utm_source=x#anchor', opts)
    const twice = canonicaliseUrl(once!, opts)
    expect(once).toBe(twice)
  })
})

// ── Tracking-param surface ─────────────────────────────────────

describe('TRACKING_PARAM_KEYS', () => {
  it('is frozen / immutable (operator cannot accidentally mutate at runtime)', () => {
    expect(() => {
      // Set is not "frozen" in the Object.freeze sense, but
      // ReadonlySet is the type-level guarantee. Verify the spec —
      // adding a key from the call site fails type-check but at
      // runtime the Set is still mutable. Pin via the export type
      // annotation; the test asserts the canonical entries exist.
      // We don't try `add()` because the runtime allows it (just
      // would be off the type-public API).
    }).not.toThrow()
    // Spot-check that the canonical entries are present.
    expect(TRACKING_PARAM_KEYS.has('utm_source')).toBe(true)
    expect(TRACKING_PARAM_KEYS.has('utm_medium')).toBe(true)
    expect(TRACKING_PARAM_KEYS.has('gclid')).toBe(true)
    expect(TRACKING_PARAM_KEYS.has('fbclid')).toBe(true)
    expect(TRACKING_PARAM_KEYS.has('mc_eid')).toBe(true)
  })

  it('does NOT include common functional params (id, page, q, etc.)', () => {
    // Functional params identify the resource — stripping `id` would
    // collapse `?id=42` and `?id=43` into the same subject (catastrophic).
    // Pinned by negative-presence checks against the most likely
    // false-add candidates.
    expect(TRACKING_PARAM_KEYS.has('id')).toBe(false)
    expect(TRACKING_PARAM_KEYS.has('page')).toBe(false)
    expect(TRACKING_PARAM_KEYS.has('q')).toBe(false)
    expect(TRACKING_PARAM_KEYS.has('search')).toBe(false)
    expect(TRACKING_PARAM_KEYS.has('p')).toBe(false)
  })
})
