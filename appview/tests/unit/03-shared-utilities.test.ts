/**
 * §3 — Shared Utilities (src/shared/)
 *
 * 38 tests total:
 *   §3.1 AT URI Parser:    UT-URI-001 through UT-URI-008 ( 8 tests)
 *   §3.2 Deterministic ID: UT-DI-001  through UT-DI-017  (17 tests)
 *   §3.3 Retry Utility:    UT-RT-001  through UT-RT-005  ( 5 tests)
 *   §3.4 Batch Insert:     UT-BA-001  through UT-BA-004  ( 4 tests)
 *   §3.5 Error Types:      UT-ER-001  through UT-ER-004  ( 4 tests)
 *
 * Plan traceability: UNIT_TEST_PLAN.md §3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { parseAtUri, constructAtUri } from '@/shared/utils/at-uri'
import { generateDeterministicId, MAX_NAME_LENGTH, RESOLVER_VERSION } from '@/db/queries/subjects'
import { AppError, ValidationError, NotFoundError } from '@/shared/errors/app-error'
import type { SubjectRef } from '@/shared/types/lexicon-types'

// Mock the logger to avoid noisy output during retry tests
vi.mock('@/shared/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// §3.1 AT URI Parser
// Traces to: Architecture §"Directory Structure — shared/atproto/uri.ts"
// ---------------------------------------------------------------------------
describe('§3.1 AT URI Parser', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0161", "section": "01", "sectionName": "General", "title": "UT-URI-001: parse valid AT URI"}
  it('UT-URI-001: parse valid AT URI', () => {
    const result = parseAtUri('at://did:plc:abc/com.dina.peerlens.attestation/tid123')
    expect(result.did).toBe('did:plc:abc')
    expect(result.collection).toBe('com.dina.peerlens.attestation')
    expect(result.rkey).toBe('tid123')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0162", "section": "01", "sectionName": "General", "title": "UT-URI-002: parse AT URI \u2014 did:web"}
  it('UT-URI-002: parse AT URI — did:web', () => {
    const result = parseAtUri('at://did:web:example.com/collection/rkey')
    expect(result.did).toBe('did:web:example.com')
    expect(result.collection).toBe('collection')
    expect(result.rkey).toBe('rkey')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0163", "section": "01", "sectionName": "General", "title": "UT-URI-003: construct AT URI"}
  it('UT-URI-003: construct AT URI', () => {
    const uri = constructAtUri('did:plc:abc', 'com.dina.peerlens.attestation', 'tid123')
    expect(uri).toBe('at://did:plc:abc/com.dina.peerlens.attestation/tid123')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0164", "section": "01", "sectionName": "General", "title": "UT-URI-004: invalid URI \u2014 missing protocol"}
  it('UT-URI-004: invalid URI — missing protocol', () => {
    expect(() => parseAtUri('did:plc:abc/collection/rkey')).toThrow('Invalid AT URI')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0165", "section": "01", "sectionName": "General", "title": "UT-URI-005: invalid URI \u2014 missing collection"}
  it('UT-URI-005: invalid URI — missing collection', () => {
    expect(() => parseAtUri('at://did:plc:abc')).toThrow('Invalid AT URI')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0166", "section": "01", "sectionName": "General", "title": "UT-URI-006: invalid URI \u2014 empty string"}
  it('UT-URI-006: invalid URI — empty string', () => {
    expect(() => parseAtUri('')).toThrow('Invalid AT URI')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0167", "section": "01", "sectionName": "General", "title": "UT-URI-007: round-trip: parse -> construct -> parse"}
  it('UT-URI-007: round-trip: parse -> construct -> parse', () => {
    const original = 'at://did:plc:abc/com.dina.peerlens.vouch/tid456'
    const parsed = parseAtUri(original)
    const reconstructed = constructAtUri(parsed.did, parsed.collection, parsed.rkey)
    expect(reconstructed).toBe(original)
    const reparsed = parseAtUri(reconstructed)
    expect(reparsed).toEqual(parsed)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0168", "section": "01", "sectionName": "General", "title": "UT-URI-008: special characters in rkey"}
  it('UT-URI-008: special characters in rkey', () => {
    const result = parseAtUri('at://did:plc:abc/collection/rkey-with_special-chars_123')
    expect(result.rkey).toBe('rkey-with_special-chars_123')
    expect(result.did).toBe('did:plc:abc')
    expect(result.collection).toBe('collection')
  })
})

// ---------------------------------------------------------------------------
// Helper: compute expected sha256 hex prefix the same way the source does
// ---------------------------------------------------------------------------
function expectedId(input: string): string {
  return 'sub_' + createHash('sha256').update(input).digest('hex').slice(0, 32)
}

// ---------------------------------------------------------------------------
// §3.2 Deterministic ID Generation
// Traces to: Architecture §"3-Tier Subject Identity", Fix 10
// ---------------------------------------------------------------------------
describe('§3.2 Deterministic ID', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0169", "section": "01", "sectionName": "General", "title": "UT-DI-001: Fix 10: Tier 1 \u2014 DID produces global ID"}
  it('UT-DI-001: Fix 10: Tier 1 — DID produces global ID', () => {
    const ref: SubjectRef = { type: 'did', did: 'did:plc:abc' }
    const result = generateDeterministicId(ref)
    expect(result.id).toBe(expectedId('v2:did:did:plc:abc'))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0170", "section": "01", "sectionName": "General", "title": "UT-DI-002: Fix 10: Tier 1 \u2014 same DID, different authors -> same ID"}
  it('UT-DI-002: Fix 10: Tier 1 — same DID, different authors -> same ID', () => {
    const ref: SubjectRef = { type: 'did', did: 'did:plc:abc' }
    const result1 = generateDeterministicId(ref)
    const result2 = generateDeterministicId(ref)
    expect(result1.id).toBe(result2.id)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0171", "section": "01", "sectionName": "General", "title": "UT-DI-003: Fix 10: Tier 1 \u2014 URI produces global ID"}
  it('UT-DI-003: Fix 10: Tier 1 — URI produces global ID', () => {
    const ref: SubjectRef = { type: 'content', uri: 'https://example.com' }
    const result = generateDeterministicId(ref)
    expect(result.id).toBe(expectedId('v2:uri:https://example.com'))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0172", "section": "01", "sectionName": "General", "title": "UT-DI-004: Fix 10: Tier 1 \u2014 same URI, different authors -> same ID"}
  it('UT-DI-004: Fix 10: Tier 1 — same URI, different authors -> same ID', () => {
    const ref: SubjectRef = { type: 'content', uri: 'https://example.com' }
    const result1 = generateDeterministicId(ref)
    const result2 = generateDeterministicId(ref)
    expect(result1.id).toBe(result2.id)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0173", "section": "01", "sectionName": "General", "title": "UT-DI-005: Fix 10: Tier 1 \u2014 identifier produces global ID"}
  it('UT-DI-005: Fix 10: Tier 1 — identifier produces global ID', () => {
    const ref: SubjectRef = { type: 'product', identifier: 'asin:B01234' }
    const result = generateDeterministicId(ref)
    expect(result.id).toBe(expectedId('v2:id:asin:B01234'))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0174", "section": "01", "sectionName": "General", "title": "UT-DI-006: Fix 10: Tier 1 \u2014 priority: DID > URI > identifier"}
  it('UT-DI-006: Fix 10: Tier 1 — priority: DID > URI > identifier', () => {
    const ref: SubjectRef = {
      type: 'product',
      did: 'did:plc:abc',
      uri: 'https://example.com',
      identifier: 'asin:B01234',
    }
    const result = generateDeterministicId(ref)
    // DID takes priority — id is derived from DID, not URI or identifier
    expect(result.id).toBe(expectedId('v2:did:did:plc:abc'))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0175", "section": "01", "sectionName": "General", "title": "UT-DI-007: Fix 10: Tier 1 \u2014 priority: URI > identifier"}
  it('UT-DI-007: Fix 10: Tier 1 — priority: URI > identifier', () => {
    const ref: SubjectRef = {
      type: 'product',
      uri: 'https://example.com',
      identifier: 'asin:B01234',
    }
    const result = generateDeterministicId(ref)
    // URI takes priority over identifier (no DID present)
    expect(result.id).toBe(expectedId('v2:uri:https://example.com'))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0176", "section": "01", "sectionName": "General", "title": "UT-DI-008: Fix 10: Tier 2 \u2014 name-only -> author-scoped"}
  it('UT-DI-008: Tier 2 — name+type produces global ID', () => {
    const ref = { type: 'organization', name: 'Darshini Tiffin Center' } as SubjectRef
    const result = generateDeterministicId(ref)
    expect(result.id).toBe(expectedId('v2:name:organization:darshini tiffin center'))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0177", "section": "01", "sectionName": "General", "title": "UT-DI-009: Fix 10: Tier 2 \u2014 same name, different authors -> different IDs"}
  it('UT-DI-009: Tier 2 — same name → same ID regardless of caller', () => {
    const ref = { type: 'organization', name: 'Darshini Tiffin Center' } as SubjectRef
    const resultA = generateDeterministicId(ref)
    const resultB = generateDeterministicId(ref)
    expect(resultA.id).toBe(resultB.id)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0178", "section": "01", "sectionName": "General", "title": "UT-DI-010: Fix 10: Tier 2 \u2014 same name, same author -> same ID"}
  it('UT-DI-010: Tier 2 — repeated resolves are idempotent', () => {
    const ref = { type: 'organization', name: 'Darshini Tiffin Center' } as SubjectRef
    const result1 = generateDeterministicId(ref)
    const result2 = generateDeterministicId(ref)
    expect(result1.id).toBe(result2.id)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0179", "section": "01", "sectionName": "General", "title": "UT-DI-011: case normalization"}
  it('UT-DI-011: case normalization', () => {
    const ref1 = { type: 'organization', name: 'Darshini Tiffin' } as SubjectRef
    const ref2 = { type: 'organization', name: 'darshini tiffin' } as SubjectRef
    const result1 = generateDeterministicId(ref1)
    const result2 = generateDeterministicId(ref2)
    expect(result1.id).toBe(result2.id)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0180", "section": "01", "sectionName": "General", "title": "UT-DI-012: whitespace normalization"}
  it('UT-DI-012: whitespace normalization', () => {
    const ref1 = { type: 'organization', name: '  Darshini Tiffin  ' } as SubjectRef
    const ref2 = { type: 'organization', name: 'Darshini Tiffin' } as SubjectRef
    const result1 = generateDeterministicId(ref1)
    const result2 = generateDeterministicId(ref2)
    expect(result1.id).toBe(result2.id)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0181", "section": "01", "sectionName": "General", "title": "UT-DI-013: ID format \u2014 prefix"}
  it('UT-DI-013: ID format — prefix', () => {
    const ref: SubjectRef = { type: 'did', did: 'did:plc:abc' }
    const result = generateDeterministicId(ref)
    expect(result.id).toMatch(/^sub_/)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0182", "section": "01", "sectionName": "General", "title": "UT-DI-014: ID format \u2014 length"}
  it('UT-DI-014: ID format — length', () => {
    const ref: SubjectRef = { type: 'did', did: 'did:plc:abc' }
    const result = generateDeterministicId(ref)
    // "sub_" (4 chars) + 32 hex chars = 36 total
    expect(result.id.length).toBe(36)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0183", "section": "01", "sectionName": "General", "title": "UT-DI-015: name fallback order"}
  it('UT-DI-015: name fallback order', () => {
    // ref with DID but no name, no URI, no identifier — Tier 1 uses DID
    const ref: SubjectRef = { type: 'did', did: 'did:plc:abc' }
    const result = generateDeterministicId(ref)
    // DID present -> Tier 1 (global), id derived from DID
    expect(result.id).toBe(expectedId('v2:did:did:plc:abc'))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0184", "section": "01", "sectionName": "General", "title": "UT-DI-016: name fallback \u2014 "}
  it('UT-DI-016: empty Tier 2 ref → throws (no garbage subject_ids)', () => {
    // A ref with no DID / URI / identifier / name is unresolvable.
    // Previously the hash would still produce a deterministic id from
    // `name:type:undefined`, which seeded a ghost subject. The hardened
    // resolver fails loud so the ingester catches the malformed record
    // at write time.
    const ref = { type: 'organization' } as SubjectRef
    expect(() => generateDeterministicId(ref)).toThrow()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0185", "section": "01", "sectionName": "General", "title": "UT-DI-017: different subject types -> different IDs (Tier 2)"}
  it('UT-DI-017: different subject types -> different IDs (Tier 2)', () => {
    const ref1 = { type: 'organization', name: 'Test Corp' } as SubjectRef
    const ref2 = { type: 'claim', name: 'Test Corp' } as SubjectRef
    const result1 = generateDeterministicId(ref1)
    const result2 = generateDeterministicId(ref2)
    expect(result1.id).not.toBe(result2.id)
  })

  // ─────────────────────────────────────────────────────────────────
  // Tier 2 normalization (forward-compat safety net). The wire format
  // is a public contract — these tests pin the canonicalization rules
  // so two clients sending typographically-different but semantically-
  // identical refs converge on the same subject.
  // ─────────────────────────────────────────────────────────────────

  it('UT-DI-018: Tier 2 — Unicode NFC composes equivalent code-point sequences', () => {
    // "café" with precomposed é (U+00E9) vs the decomposed form
    // (e + combining acute U+0301). NFC normalizes both to the
    // composed form before hashing.
    const ref1 = { type: 'place', name: 'café' } as SubjectRef
    const ref2 = { type: 'place', name: 'café' } as SubjectRef
    expect(generateDeterministicId(ref1).id).toBe(generateDeterministicId(ref2).id)
  })

  it('UT-DI-019: Tier 2 — internal whitespace runs collapse to a single space', () => {
    const refs = [
      { type: 'product', name: 'Aeron Chair' },
      { type: 'product', name: 'Aeron  Chair' }, // double space
      { type: 'product', name: 'Aeron\tChair' }, // tab
      { type: 'product', name: 'Aeron\nChair' }, // newline
      { type: 'product', name: '  Aeron Chair  ' }, // edge padding
    ] as SubjectRef[]
    const ids = refs.map((r) => generateDeterministicId(r).id)
    expect(new Set(ids).size).toBe(1)
  })

  it('UT-DI-020: Tier 2 — type case + edge whitespace normalize', () => {
    const ref1 = { type: 'product', name: 'X' } as SubjectRef
    const ref2 = { type: 'Product ', name: 'X' } as unknown as SubjectRef
    expect(generateDeterministicId(ref1).id).toBe(generateDeterministicId(ref2).id)
  })

  it('UT-DI-021: Tier 2 — names beyond the length cap are rejected', () => {
    const ref = {
      type: 'product',
      name: 'A'.repeat(MAX_NAME_LENGTH + 1),
    } as SubjectRef
    expect(() => generateDeterministicId(ref)).toThrow()
  })

  it('UT-DI-022: Tier 2 — whitespace-only name is rejected', () => {
    const ref = { type: 'product', name: '   \n\t  ' } as SubjectRef
    expect(() => generateDeterministicId(ref)).toThrow()
  })

  // ─────────────────────────────────────────────────────────────────
  // Tier 1 URI canonicalization (forward-compat safety net). A URI
  // subject's identity should be stable across typographic variants
  // that RFC 3986 treats as equivalent: scheme/host case, default
  // port, trailing slash on path-empty roots.
  // ─────────────────────────────────────────────────────────────────

  it('UT-DI-024: URI scheme case folds (RFC 3986 sec 3.1)', () => {
    const refLower = { type: 'content', uri: 'https://example.com' } as SubjectRef
    const refUpper = { type: 'content', uri: 'HTTPS://example.com' } as SubjectRef
    expect(generateDeterministicId(refLower).id).toBe(generateDeterministicId(refUpper).id)
  })

  it('UT-DI-025: URI host case folds (RFC 3986 sec 3.2.2)', () => {
    const refLower = { type: 'content', uri: 'https://example.com' } as SubjectRef
    const refMixed = { type: 'content', uri: 'https://Example.COM' } as SubjectRef
    expect(generateDeterministicId(refLower).id).toBe(generateDeterministicId(refMixed).id)
  })

  it('UT-DI-026: default ports strip out', () => {
    const cases = [
      ['https://x.test', 'https://x.test:443'],
      ['http://x.test', 'http://x.test:80'],
      ['ftp://x.test', 'ftp://x.test:21'],
    ]
    for (const [a, b] of cases) {
      const idA = generateDeterministicId({ type: 'content', uri: a } as SubjectRef).id
      const idB = generateDeterministicId({ type: 'content', uri: b } as SubjectRef).id
      expect(idA).toBe(idB)
    }
  })

  it('UT-DI-027: non-default ports are PRESERVED', () => {
    const ref443 = { type: 'content', uri: 'https://x.test' } as SubjectRef
    const ref8443 = { type: 'content', uri: 'https://x.test:8443' } as SubjectRef
    expect(generateDeterministicId(ref443).id).not.toBe(generateDeterministicId(ref8443).id)
  })

  it('UT-DI-028: trailing slash on path-empty URL folds', () => {
    const refSlash = { type: 'content', uri: 'https://x.test/' } as SubjectRef
    const refNoSlash = { type: 'content', uri: 'https://x.test' } as SubjectRef
    expect(generateDeterministicId(refSlash).id).toBe(generateDeterministicId(refNoSlash).id)
  })

  it('UT-DI-029: trailing slash on non-root path is PRESERVED', () => {
    // Servers may treat /page and /page/ differently — we don't fold.
    const refSlash = { type: 'content', uri: 'https://x.test/page/' } as SubjectRef
    const refNoSlash = { type: 'content', uri: 'https://x.test/page' } as SubjectRef
    expect(generateDeterministicId(refSlash).id).not.toBe(generateDeterministicId(refNoSlash).id)
  })

  it('UT-DI-030: query strings are PRESERVED (semantic, not normalized)', () => {
    const ref1 = { type: 'content', uri: 'https://x.test/?b=2&a=1' } as SubjectRef
    const ref2 = { type: 'content', uri: 'https://x.test/?a=1&b=2' } as SubjectRef
    // Query parameter order MAY be semantic; do not reorder.
    expect(generateDeterministicId(ref1).id).not.toBe(generateDeterministicId(ref2).id)
  })

  it('UT-DI-031: path case is PRESERVED (servers may be case-sensitive)', () => {
    const ref1 = { type: 'content', uri: 'https://x.test/Page' } as SubjectRef
    const ref2 = { type: 'content', uri: 'https://x.test/page' } as SubjectRef
    expect(generateDeterministicId(ref1).id).not.toBe(generateDeterministicId(ref2).id)
  })

  it('UT-DI-032: malformed URI falls back to verbatim hashing', () => {
    // Garbage in: don't throw, just hash the literal string. The
    // lexicon validator already bounded length; we shouldn't crash
    // on a string the URL parser hates.
    const ref = { type: 'content', uri: 'not a real uri' } as SubjectRef
    expect(() => generateDeterministicId(ref)).not.toThrow()
    const result = generateDeterministicId(ref)
    expect(result.id).toMatch(/^sub_/)
  })

  it('UT-DI-033: IPv6 hosts are bracketed + lowercased', () => {
    // RFC 3986 §3.2.2: IPv6 literals in URIs are enclosed in brackets.
    // The URL parser preserves the brackets and lowercases the hex.
    const refUpper = { type: 'content', uri: 'https://[2001:DB8::1]/' } as SubjectRef
    const refLower = { type: 'content', uri: 'https://[2001:db8::1]/' } as SubjectRef
    expect(generateDeterministicId(refUpper).id).toBe(generateDeterministicId(refLower).id)
  })

  // ─────────────────────────────────────────────────────────────────
  // Tier 1 defense-in-depth: trim leading/trailing whitespace BEFORE
  // the truthy check so a whitespace-only string falls through to the
  // next tier instead of hashing `v2:did:   `. The lexicon validator
  // catches truly empty strings; the resolver doesn't assume the
  // validator was the only entry point.
  // ─────────────────────────────────────────────────────────────────

  it('UT-DI-035: whitespace-only did is present (verbatim), does NOT fold to name', () => {
    // `did:'   '` is not a real DID, but the resolver is spec-pure:
    // a non-empty string is present and hashed verbatim. The DID
    // regex in record-validator rejects `'   '` upstream (it can't
    // match `^did:[a-z]+:`), so production never reaches here with it.
    const refWithDid = { type: 'product', did: '   ', name: 'Aeron Chair' } as SubjectRef
    const refNameOnly = { type: 'product', name: 'Aeron Chair' } as SubjectRef
    expect(generateDeterministicId(refWithDid).id).not.toBe(
      generateDeterministicId(refNameOnly).id,
    )
  })

  // Tier 1 hashing is VERBATIM per the federation spec
  // (subject-id.md §"Tier 1 normalization"): no trimming, no
  // lowercasing, no Unicode normalization. Surrounding whitespace is
  // therefore identity-significant. The record-validator rejects
  // whitespace-padded / whitespace-only Tier 1 values up front (see
  // record_validator.test.ts), so production never reaches the hash
  // with such input — but the resolver itself is spec-pure: it hashes
  // exactly what it's given and a non-empty string is "present".
  it('UT-DI-036: whitespace-only uri is present (verbatim), does NOT fold to name', () => {
    const refWithUri = { type: 'product', uri: '   ', name: 'Aeron Chair' } as SubjectRef
    const refNameOnly = { type: 'product', name: 'Aeron Chair' } as SubjectRef
    expect(generateDeterministicId(refWithUri).id).not.toBe(
      generateDeterministicId(refNameOnly).id,
    )
  })

  it('UT-DI-037: whitespace-only identifier is present (verbatim), does NOT fold to name', () => {
    const refWithId = { type: 'product', identifier: '   ', name: 'Aeron Chair' } as SubjectRef
    const refNameOnly = { type: 'product', name: 'Aeron Chair' } as SubjectRef
    expect(generateDeterministicId(refWithId).id).not.toBe(
      generateDeterministicId(refNameOnly).id,
    )
  })

  it('UT-DI-038: Tier 1 fields are hashed VERBATIM — padded != clean (caller owns canonical form)', () => {
    // The old resolver trimmed; the spec says verbatim. Padded and
    // clean now mint DIFFERENT subjects. The validator rejects the
    // padded form, so this divergence is unreachable in production —
    // but the resolver's verbatim contract is what every language
    // port must replicate byte-for-byte.
    const refPadded = { type: 'did', did: '  did:plc:abc  ' } as SubjectRef
    const refClean = { type: 'did', did: 'did:plc:abc' } as SubjectRef
    expect(generateDeterministicId(refPadded).id).not.toBe(
      generateDeterministicId(refClean).id,
    )
  })

  it('UT-DI-041: Tier 2 name length is bounded by CODE POINTS, not UTF-16 units', () => {
    // 150 astral chars (emoji) = 150 code points but 300 UTF-16 code
    // units. The spec bound is 200 CODE POINTS, so this name is valid
    // and must hash without throwing. The old `.length` check counted
    // 300 UTF-16 units > 200 and wrongly rejected it (threw). Pinning
    // code-point counting keeps TS in step with non-TS ports.
    const astralName = '😀'.repeat(150)
    const ref = { type: 'product', name: astralName } as SubjectRef
    expect(() => generateDeterministicId(ref)).not.toThrow()
    // And it's stable: same astral name → same id.
    expect(generateDeterministicId(ref).id).toBe(generateDeterministicId(ref).id)
  })

  it('UT-DI-039: URI fragments are stripped (anchor != identity)', () => {
    // Wikipedia article reviewed at different sections is still the
    // same article. Stripping `#anchor` folds them into one subject.
    const refBare = { type: 'content', uri: 'https://wiki.test/Python' } as SubjectRef
    const refHistory = {
      type: 'content',
      uri: 'https://wiki.test/Python#History',
    } as SubjectRef
    const refSyntax = {
      type: 'content',
      uri: 'https://wiki.test/Python#Syntax',
    } as SubjectRef
    const ids = [refBare, refHistory, refSyntax].map((r) => generateDeterministicId(r).id)
    expect(new Set(ids).size).toBe(1)
  })

  it('UT-DI-040: fragment stripping plays nice with trailing slash folding', () => {
    // `https://x.test/#section` → `https://x.test` (strip hash THEN
    // strip root trailing slash).
    const refBare = { type: 'content', uri: 'https://x.test' } as SubjectRef
    const refHashRoot = { type: 'content', uri: 'https://x.test/#section' } as SubjectRef
    expect(generateDeterministicId(refBare).id).toBe(
      generateDeterministicId(refHashRoot).id,
    )
  })

  it('UT-DI-034: userinfo passes through verbatim', () => {
    // user:pass@ is part of the URI but rarely seen in practice. We
    // don't strip or normalize it — the URL parser preserves it.
    const refA = { type: 'content', uri: 'https://user:pass@x.test/' } as SubjectRef
    const refB = { type: 'content', uri: 'https://x.test/' } as SubjectRef
    // Different userinfo → different subject (treat as distinct
    // resource identities even though most servers ignore the path
    // for userinfo at the same host).
    expect(generateDeterministicId(refA).id).not.toBe(generateDeterministicId(refB).id)
  })

  it('UT-DI-023: resolver version prefix is stamped on every tier', () => {
    // The output ids must change if the version prefix changes —
    // pin the prefix so a refactor can't silently drop it (which
    // would silently collide with v1 hashes in the database).
    const refDid = { type: 'did', did: 'did:plc:abc' } as SubjectRef
    const refUri = { type: 'content', uri: 'https://x.test' } as SubjectRef
    const refId = { type: 'product', identifier: 'k' } as SubjectRef
    const refName = { type: 'product', name: 'k' } as SubjectRef
    expect(generateDeterministicId(refDid).id).toBe(
      expectedId(`${RESOLVER_VERSION}:did:did:plc:abc`),
    )
    expect(generateDeterministicId(refUri).id).toBe(
      expectedId(`${RESOLVER_VERSION}:uri:https://x.test`),
    )
    expect(generateDeterministicId(refId).id).toBe(
      expectedId(`${RESOLVER_VERSION}:id:k`),
    )
    expect(generateDeterministicId(refName).id).toBe(
      expectedId(`${RESOLVER_VERSION}:name:product:k`),
    )
  })
})

// ---------------------------------------------------------------------------
// §3.3 Retry Utility
// ---------------------------------------------------------------------------
describe('§3.3 Retry Utility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0186", "section": "01", "sectionName": "General", "title": "UT-RT-001: succeeds on first try -> no retry"}
  it('UT-RT-001: succeeds on first try -> no retry', async () => {
    const { withRetry } = await import('@/shared/utils/retry')
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0187", "section": "01", "sectionName": "General", "title": "UT-RT-002: fails once then succeeds -> one retry"}
  it('UT-RT-002: fails once then succeeds -> one retry', async () => {
    const { withRetry } = await import('@/shared/utils/retry')
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok')

    const promise = withRetry(fn, { baseDelayMs: 100, maxRetries: 3 })
    // Advance past the first retry delay
    await vi.advanceTimersByTimeAsync(200)
    const result = await promise
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0188", "section": "01", "sectionName": "General", "title": "UT-RT-003: exhausts all retries -> throws"}
  it('UT-RT-003: exhausts all retries -> throws', async () => {
    const { withRetry } = await import('@/shared/utils/retry')
    const error = new Error('persistent failure')
    const fn = vi.fn().mockRejectedValue(error)

    // Attach .catch immediately to prevent unhandled rejection
    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 100 }).catch((e: unknown) => e)
    // Advance timers to exhaust all retries: delay 100 + delay 200 = 300ms
    await vi.advanceTimersByTimeAsync(500)
    const result = await promise
    expect(result).toBe(error)
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  // TRACE: {"suite": "APPVIEW", "case": "0189", "section": "01", "sectionName": "General", "title": "UT-RT-004: exponential backoff timing"}
  it('UT-RT-004: exponential backoff timing', async () => {
    const { withRetry } = await import('@/shared/utils/retry')
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockResolvedValueOnce('ok')

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30_000 })

    // Delays: attempt 0 -> 1000ms, attempt 1 -> 2000ms, attempt 2 -> 4000ms
    // After first failure, advance 1000ms
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(2)

    // After second failure, advance 2000ms
    await vi.advanceTimersByTimeAsync(2000)
    expect(fn).toHaveBeenCalledTimes(3)

    // After third failure, advance 4000ms
    await vi.advanceTimersByTimeAsync(4000)
    expect(fn).toHaveBeenCalledTimes(4)

    const result = await promise
    expect(result).toBe('ok')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0190", "section": "01", "sectionName": "General", "title": "UT-RT-005: max delay cap"}
  it('UT-RT-005: max delay cap', async () => {
    const { withRetry } = await import('@/shared/utils/retry')
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    const maxDelayMs = 500
    // Attach .catch immediately to prevent unhandled rejection
    const promise = withRetry(fn, { maxRetries: 5, baseDelayMs: 1000, maxDelayMs })
      .catch((e: unknown) => e)

    // With baseDelayMs=1000, delays would be 1000, 2000, 4000, 8000, 16000
    // But maxDelayMs=500 caps them all at 500
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(500)
    }
    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('fail')
    // initial call + 5 retries = 6 total
    expect(fn).toHaveBeenCalledTimes(6)
  })
})

// ---------------------------------------------------------------------------
// §3.4 Batch Insert Helper
// Tests the generic batchProcess utility (shared/utils/batch.ts)
// ---------------------------------------------------------------------------
describe('§3.4 Batch Insert', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0191", "section": "01", "sectionName": "General", "title": "UT-BA-001: single batch \u2014 within limit"}
  it('UT-BA-001: single batch — within limit', async () => {
    const { batchProcess } = await import('@/shared/utils/batch')
    const items = Array.from({ length: 50 }, (_, i) => i)
    const batches: number[][] = []
    await batchProcess(items, 100, async (batch) => {
      batches.push(batch)
    })
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(50)
    expect(batches[0]).toEqual(items)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0192", "section": "01", "sectionName": "General", "title": "UT-BA-002: multiple batches"}
  it('UT-BA-002: multiple batches', async () => {
    const { batchProcess } = await import('@/shared/utils/batch')
    const items = Array.from({ length: 250 }, (_, i) => i)
    const batches: number[][] = []
    await batchProcess(items, 100, async (batch) => {
      batches.push(batch)
    })
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(100)
    expect(batches[1]).toHaveLength(100)
    expect(batches[2]).toHaveLength(50)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0193", "section": "01", "sectionName": "General", "title": "UT-BA-003: empty input"}
  it('UT-BA-003: empty input', async () => {
    const { batchProcess } = await import('@/shared/utils/batch')
    const fn = vi.fn()
    await batchProcess([], 100, fn)
    expect(fn).not.toHaveBeenCalled()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0194", "section": "01", "sectionName": "General", "title": "UT-BA-004: exact batch boundary"}
  it('UT-BA-004: exact batch boundary', async () => {
    const { batchProcess } = await import('@/shared/utils/batch')
    const items = Array.from({ length: 200 }, (_, i) => i)
    const batches: number[][] = []
    await batchProcess(items, 100, async (batch) => {
      batches.push(batch)
    })
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(100)
    expect(batches[1]).toHaveLength(100)
  })
})

// ---------------------------------------------------------------------------
// §3.5 Error Types
// ---------------------------------------------------------------------------
describe('§3.5 Error Types', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0195", "section": "01", "sectionName": "General", "title": "UT-ER-001: AppError \u2014 message and code"}
  it('UT-ER-001: AppError — message and code', () => {
    const err = new AppError('something went wrong', 'INTERNAL', 500)
    expect(err.message).toBe('something went wrong')
    expect(err.code).toBe('INTERNAL')
    expect(err.statusCode).toBe(500)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AppError)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0196", "section": "01", "sectionName": "General", "title": "UT-ER-002: ValidationError extends AppError"}
  it('UT-ER-002: ValidationError extends AppError', () => {
    const details = [{ field: 'name', message: 'required' }]
    const err = new ValidationError('Validation failed', details)
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.details).toEqual(details)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err).toBeInstanceOf(Error)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0197", "section": "01", "sectionName": "General", "title": "UT-ER-003: NotFoundError extends AppError"}
  it('UT-ER-003: NotFoundError extends AppError', () => {
    const err = new NotFoundError('Subject not found')
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toContain('Subject')
    expect(err).toBeInstanceOf(AppError)
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err).toBeInstanceOf(Error)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0198", "section": "01", "sectionName": "General", "title": "UT-ER-004: error serialization"}
  it('UT-ER-004: error serialization', () => {
    const details = [{ field: 'email', message: 'invalid format' }]
    const err = new ValidationError('Invalid input', details)
    // Errors are not directly JSON.stringify-able for `message` (non-enumerable),
    // but we can verify the enumerable properties are present
    const json = JSON.parse(JSON.stringify(err))
    expect(json.code).toBe('VALIDATION_ERROR')
    expect(json.statusCode).toBe(400)
    expect(json.details).toEqual(details)
    // name is set on the instance
    expect(err.name).toBe('ValidationError')
  })
})
