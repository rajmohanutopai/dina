/**
 * Unit tests for `deriveAuthoredAttestationRows` — projects search
 * hits into the "Reviews written" row model used on the reviewer
 * profile screen.
 */

import {
  deriveAuthoredAttestationRows,
  type AuthoredAttestationRow,
} from '../../src/trust/authored_attestations_data';
import type { SearchAttestationHit } from '../../src/trust/appview_runtime';

function makeHit(overrides: Partial<SearchAttestationHit> = {}): SearchAttestationHit {
  return {
    uri: 'at://did:plc:author/com.dina.trust.attestation/1',
    authorDid: 'did:plc:author',
    authorHandle: null,
    cid: 'bafy123',
    subjectId: 'sub-1',
    subjectRefRaw: { type: 'product', name: 'Aeron Chair' },
    category: 'office_furniture/chair',
    sentiment: 'positive',
    text: 'Worth every penny',
    confidence: 'high',
    recordCreatedAt: '2026-04-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('deriveAuthoredAttestationRows', () => {
  it('projects a basic hit into a row', () => {
    const rows = deriveAuthoredAttestationRows([makeHit()]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.uri).toBe('at://did:plc:author/com.dina.trust.attestation/1');
    expect(r.subjectId).toBe('sub-1');
    expect(r.subjectTitle).toBe('Aeron Chair');
    expect(r.category).toBe('office_furniture/chair');
    expect(r.sentiment).toBe('positive');
    expect(r.headline).toBe('Worth every penny');
    expect(r.body).toBe('');
    expect(r.confidence).toBe('high');
    expect(r.createdAtMs).toBe(Date.parse('2026-04-30T12:00:00.000Z'));
  });

  it('splits a multi-paragraph text into headline + body on the first blank line', () => {
    // Mirrors `composeText` from the publish path: round-tripping
    // through publish → search → edit-prefill rebuilds the same
    // headline/body pair.
    const rows = deriveAuthoredAttestationRows([
      makeHit({ text: 'Worth every penny\n\nMy back stopped hurting in week 2.' }),
    ]);
    expect(rows[0].headline).toBe('Worth every penny');
    expect(rows[0].body).toBe('My back stopped hurting in week 2.');
  });

  it('keeps subsequent blank lines inside the body (only first separator splits)', () => {
    // The composeText join uses a single \n\n; if a reviewer wrote
    // a body with its own blank lines we mustn't shred them.
    const rows = deriveAuthoredAttestationRows([
      makeHit({ text: 'Lede\n\nFirst para.\n\nSecond para.' }),
    ]);
    expect(rows[0].headline).toBe('Lede');
    expect(rows[0].body).toBe('First para.\n\nSecond para.');
  });

  it('forwards subjectKind / subjectUri / subjectDid for edit-publish round-trip', () => {
    // Edit publish needs the SubjectRef tuple to reproduce the same
    // `subject_id` hash. Without these fields the publish path bails
    // and the edit silently never lands.
    const r = deriveAuthoredAttestationRows([
      makeHit({
        subjectRefRaw: {
          type: 'content',
          name: 'A blog post',
          uri: 'https://example.com/post-1',
          did: 'did:plc:author',
        },
      }),
    ])[0];
    expect(r.subjectKind).toBe('content');
    expect(r.subjectUri).toBe('https://example.com/post-1');
    expect(r.subjectDid).toBe('did:plc:author');
  });

  it('subjectUri / subjectDid collapse to null when absent or blank on the wire', () => {
    const r = deriveAuthoredAttestationRows([
      makeHit({ subjectRefRaw: { type: 'product', name: 'Aeron Chair' } }),
    ])[0];
    expect(r.subjectKind).toBe('product');
    expect(r.subjectUri).toBeNull();
    expect(r.subjectDid).toBeNull();
  });

  it('confidence forwards from the wire when present, null when absent', () => {
    expect(
      deriveAuthoredAttestationRows([makeHit({ confidence: 'speculative' })])[0]
        .confidence,
    ).toBe('speculative');
    expect(
      deriveAuthoredAttestationRows([makeHit({ confidence: null })])[0]
        .confidence,
    ).toBeNull();
    expect(
      deriveAuthoredAttestationRows([makeHit({ confidence: undefined })])[0]
        .confidence,
    ).toBeNull();
  });

  it('preserves wire order (recent-first comes from the xRPC sort)', () => {
    const a = makeHit({ uri: 'at://x/1', subjectId: 's1' });
    const b = makeHit({ uri: 'at://x/2', subjectId: 's2' });
    const c = makeHit({ uri: 'at://x/3', subjectId: 's3' });
    const rows = deriveAuthoredAttestationRows([a, b, c]);
    expect(rows.map((r) => r.uri)).toEqual([
      'at://x/1',
      'at://x/2',
      'at://x/3',
    ]);
  });

  it('drops hits with a missing/blank subjectId', () => {
    const rows = deriveAuthoredAttestationRows([
      makeHit({ subjectId: '' }),
      makeHit({ subjectId: 'sub-2', uri: 'at://x/2' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectId).toBe('sub-2');
  });

  it('falls back through name → did → uri → domain → subjectId for the title', () => {
    // name wins
    expect(
      deriveAuthoredAttestationRows([
        makeHit({ subjectRefRaw: { type: 'product', name: 'Foo', did: 'did:plc:x' } }),
      ])[0].subjectTitle,
    ).toBe('Foo');
    // name absent → did
    expect(
      deriveAuthoredAttestationRows([
        makeHit({ subjectRefRaw: { type: 'did', did: 'did:plc:zaxx' } }),
      ])[0].subjectTitle,
    ).toBe('did:plc:zaxx');
    // name + did absent → uri
    expect(
      deriveAuthoredAttestationRows([
        makeHit({ subjectRefRaw: { type: 'content', uri: 'https://example.com' } }),
      ])[0].subjectTitle,
    ).toBe('https://example.com');
    // name + did + uri absent → domain
    expect(
      deriveAuthoredAttestationRows([
        makeHit({ subjectRefRaw: { type: 'organization', domain: 'example.com' } }),
      ])[0].subjectTitle,
    ).toBe('example.com');
    // none populated → subjectId fallback
    expect(
      deriveAuthoredAttestationRows([
        makeHit({ subjectRefRaw: { type: 'claim' }, subjectId: 'sub-fallback' }),
      ])[0].subjectTitle,
    ).toBe('sub-fallback');
  });

  it('whitespace-only subject candidates fall through to the next field', () => {
    const rows = deriveAuthoredAttestationRows([
      makeHit({
        subjectRefRaw: { type: 'product', name: '   ', did: 'did:plc:winner' },
      }),
    ]);
    expect(rows[0].subjectTitle).toBe('did:plc:winner');
  });

  it('null/empty category collapses to null (screen hides the slot)', () => {
    expect(
      deriveAuthoredAttestationRows([makeHit({ category: '' })])[0].category,
    ).toBeNull();
    // `category: null as any` simulates a wire-shape relaxation; treat
    // the same as empty rather than rendering `'null'` literally.
    expect(
      deriveAuthoredAttestationRows([
        // Cast to satisfy the SearchAttestationHit type while still
        // exercising the runtime null-tolerance branch.
        makeHit({ category: '   ' }),
      ])[0].category,
    ).toBeNull();
  });

  it('preserves a categorical category verbatim', () => {
    const rows = deriveAuthoredAttestationRows([
      makeHit({ category: 'place/cafe' }),
    ]);
    expect(rows[0].category).toBe('place/cafe');
  });

  it('null text becomes empty string headline (screen hides on empty)', () => {
    const rows = deriveAuthoredAttestationRows([makeHit({ text: null })]);
    expect(rows[0].headline).toBe('');
    expect(rows[0].body).toBe('');
  });

  it('malformed createdAt falls back to 0 instead of NaN', () => {
    const rows = deriveAuthoredAttestationRows([
      makeHit({ recordCreatedAt: 'not-a-date' }),
    ]);
    expect(rows[0].createdAtMs).toBe(0);
  });

  it('returns [] for empty input', () => {
    const rows = deriveAuthoredAttestationRows([]);
    expect(rows).toEqual([]);
  });

  it('readonly array input compiles', () => {
    // Pin the contract that callers can pass `ReadonlyArray<...>` —
    // the runner returns frozen state, and we don't want the caller
    // to have to cast.
    const ro: ReadonlyArray<SearchAttestationHit> = [makeHit()];
    const rows: AuthoredAttestationRow[] = deriveAuthoredAttestationRows(ro);
    expect(rows).toHaveLength(1);
  });
});
