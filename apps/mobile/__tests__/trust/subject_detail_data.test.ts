/**
 * Tests for `src/trust/subject_detail_data.ts` (TN-MOB-012).
 *
 * Pure data layer — input → header bundle + 3 grouped review lists.
 * The screen layer (`app/trust/[subjectId].tsx`) renders these
 * directly; this file pins:
 *   - empty / single / many reviews edge cases
 *   - ring-grouping correctness (self+contact → friends; fof; rest → strangers)
 *   - within-group sort: trust score desc, recency desc, name asc
 *   - null-trust handling (`-Infinity` rank — never displaces rated)
 *   - subtitle derivation (matches subject_card behaviour)
 *   - showNumericScore N≥3 + non-null score discipline
 *   - ringCounts arithmetic
 *   - reviewCount clamping (negative / non-finite → 0)
 */

import { deriveSubjectCard } from '../../src/trust/subject_card';
import {
  MAX_ALTERNATIVES,
  deriveAlternatives,
  deriveFlagWarning,
  deriveSubjectDetail,
  type AlternativeInput,
  type FlagSummary,
  type SubjectDetailInput,
} from '../../src/trust/subject_detail_data';

import type { SubjectReview } from '../../src/trust/subject_card';

function makeReview(overrides: Partial<SubjectReview> = {}): SubjectReview {
  return {
    ring: 'contact',
    reviewerDid: 'did:plc:sancho',
    reviewerTrustScore: 0.7,
    reviewerName: 'Sancho',
    headline: 'Worth every penny',
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<SubjectDetailInput> = {}): SubjectDetailInput {
  return {
    title: 'Aeron chair',
    category: 'office_furniture/chair',
    subjectTrustScore: 0.82,
    reviewCount: 5,
    reviews: [],
    ...overrides,
  };
}

describe('deriveSubjectDetail — header', () => {
  it('passes through title verbatim', () => {
    const detail = deriveSubjectDetail(makeInput({ title: 'Aeron chair' }));
    expect(detail.header.title).toBe('Aeron chair');
  });

  it('humanises category to a subtitle ("office_furniture/chair" → "Office furniture")', () => {
    const detail = deriveSubjectDetail(makeInput({ category: 'office_furniture/chair' }));
    expect(detail.header.subtitle).toBe('Office furniture');
  });

  it('subtitle is null when category is null', () => {
    const detail = deriveSubjectDetail(makeInput({ category: null }));
    expect(detail.header.subtitle).toBeNull();
  });

  it('subtitle is null when category is whitespace-only', () => {
    const detail = deriveSubjectDetail(makeInput({ category: '   ' }));
    expect(detail.header.subtitle).toBeNull();
  });

  it('showNumericScore=true at the N=3 boundary with a non-null score', () => {
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore: 0.7, reviewCount: 3 }),
    );
    expect(detail.header.showNumericScore).toBe(true);
  });

  it('showNumericScore=false when reviewCount < 3', () => {
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore: 0.95, reviewCount: 2 }),
    );
    expect(detail.header.showNumericScore).toBe(false);
  });

  it('showNumericScore=false when score is null even with N≥3', () => {
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore: null, reviewCount: 5 }),
    );
    expect(detail.header.showNumericScore).toBe(false);
  });

  it('reviewCount clamps to 0 for negative input', () => {
    const detail = deriveSubjectDetail(makeInput({ reviewCount: -1 }));
    expect(detail.header.reviewCount).toBe(0);
  });

  it('reviewCount clamps to 0 for NaN', () => {
    const detail = deriveSubjectDetail(makeInput({ reviewCount: NaN }));
    expect(detail.header.reviewCount).toBe(0);
  });

  it('reviewCount floors fractional values', () => {
    const detail = deriveSubjectDetail(makeInput({ reviewCount: 4.7 }));
    expect(detail.header.reviewCount).toBe(4);
  });
});

// ─── V2 actionability layer — header chips ────────────────────────────────
//
// TN-V2-P1-004: the detail header mirrors the card surface for the
// host + language + place-location chips. The data layer here imports
// the same normalisers from `subject_card.ts` so the chip contracts
// don't drift between surfaces. Tests below pin only the detail-side
// glue (field plumbed through, gating on subjectKind, parity with
// card normalisation). Comprehensive normalisation edge cases live
// in `subject_card.test.ts` so we don't duplicate them here.

describe('deriveSubjectDetail — header chips (TN-V2-P1-004)', () => {
  it('host chip mirrors card normalisation (lowercase + trim)', () => {
    const detail = deriveSubjectDetail(makeInput({ host: '  AMAZON.CO.UK  ' }));
    expect(detail.header.host).toBe('amazon.co.uk');
  });

  it('language chip mirrors card normalisation (uppercase + trim)', () => {
    const detail = deriveSubjectDetail(makeInput({ language: 'pt-br' }));
    expect(detail.header.language).toBe('PT-BR');
  });

  it('host + language default to null when omitted', () => {
    const detail = deriveSubjectDetail(makeInput({}));
    expect(detail.header.host).toBeNull();
    expect(detail.header.language).toBeNull();
    expect(detail.header.location).toBeNull();
  });

  it('null/empty/whitespace host coerce to null (string | null contract)', () => {
    expect(deriveSubjectDetail(makeInput({ host: null })).header.host).toBeNull();
    expect(deriveSubjectDetail(makeInput({ host: '' })).header.host).toBeNull();
    expect(deriveSubjectDetail(makeInput({ host: '   ' })).header.host).toBeNull();
  });

  it('renders location chip for place subjects with valid coords', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        subjectKind: 'place',
        coordinates: { lat: 37.7749, lng: -122.4194 },
      }),
    );
    expect(detail.header.location).toBe('37.77°N, 122.42°W');
  });

  it('drops the location chip when subjectKind is not "place" (wire bug guard)', () => {
    // Mirrors the card-side gate: coords on a non-place subject is a
    // wire-format invariant violation, drop the chip.
    const detail = deriveSubjectDetail(
      makeInput({
        subjectKind: 'product',
        coordinates: { lat: 37.77, lng: -122.42 },
      }),
    );
    expect(detail.header.location).toBeNull();
  });

  it('drops the location chip when subjectKind is omitted (legacy callers)', () => {
    const detail = deriveSubjectDetail(
      makeInput({ coordinates: { lat: 37.77, lng: -122.42 } }),
    );
    expect(detail.header.location).toBeNull();
  });

  it('drops the location chip for out-of-range or non-finite coords', () => {
    expect(
      deriveSubjectDetail(
        makeInput({ subjectKind: 'place', coordinates: { lat: 91, lng: 0 } }),
      ).header.location,
    ).toBeNull();
    expect(
      deriveSubjectDetail(
        makeInput({
          subjectKind: 'place',
          coordinates: { lat: Number.NaN, lng: 0 },
        }),
      ).header.location,
    ).toBeNull();
  });

  it('all three chips can co-exist (place subject with website + language)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        host: 'sfmoma.org',
        language: 'en',
        subjectKind: 'place',
        coordinates: { lat: 37.7857, lng: -122.401 },
      }),
    );
    expect(detail.header.host).toBe('sfmoma.org');
    expect(detail.header.language).toBe('EN');
    expect(detail.header.location).toBe('37.79°N, 122.40°W');
  });

  it('chip parity — same input produces same chip values on card + detail', () => {
    // Pinned to catch contract drift between surfaces. The card and
    // detail share normaliser functions in `subject_card.ts`, but a
    // future "optimisation" that inlined either could subtly diverge.
    const cardInput = {
      title: 'SFMOMA',
      category: null,
      subjectTrustScore: 0.7,
      reviewCount: 10,
      reviews: [],
      host: 'SFMOMA.org',
      language: 'en',
      subjectKind: 'place' as const,
      coordinates: { lat: 37.7857, lng: -122.401 },
    };
    const card = deriveSubjectCard(cardInput);
    const detail = deriveSubjectDetail(cardInput);
    expect(detail.header.host).toBe(card.host);
    expect(detail.header.language).toBe(card.language);
    expect(detail.header.location).toBe(card.location);
  });
});

// ─── V2 actionability layer — header price chip ────────────────────────────
//
// TN-V2-RANK-013: the detail header gains a fourth context chip for
// the producer's published price tier ($/$$/$$$). Mirrors the card
// surface: same chip semantics, same normaliser, same null-rendering
// contract. As with host/language/location, the data layer here pins
// only the detail-side glue (field plumbed through, parity with
// card normalisation, default-null behaviour). Comprehensive
// normalisation edge cases (4-dollar, lowercase, unrelated strings)
// live in `subject_card.test.ts` so we don't duplicate them.

describe('deriveSubjectDetail — header price chip (TN-V2-RANK-013)', () => {
  it('passes through valid tiers ($, $$, $$$)', () => {
    expect(deriveSubjectDetail(makeInput({ priceTier: '$' })).header.priceTier).toBe('$');
    expect(deriveSubjectDetail(makeInput({ priceTier: '$$' })).header.priceTier).toBe('$$');
    expect(deriveSubjectDetail(makeInput({ priceTier: '$$$' })).header.priceTier).toBe(
      '$$$',
    );
  });

  it('priceTier defaults to null when omitted', () => {
    const detail = deriveSubjectDetail(makeInput({}));
    expect(detail.header.priceTier).toBeNull();
  });

  it('null / undefined priceTier coerce to null (string | null contract)', () => {
    expect(deriveSubjectDetail(makeInput({ priceTier: null })).header.priceTier).toBeNull();
    expect(
      deriveSubjectDetail(makeInput({ priceTier: undefined })).header.priceTier,
    ).toBeNull();
  });

  it('chip parity — same input produces same priceTier on card + detail', () => {
    // Pinned to catch contract drift between surfaces. Card and
    // detail share `normalisePriceTier`; a future inline optimisation
    // could silently diverge — this asserts they MUST agree.
    const sharedInput = {
      title: 'Aeron chair',
      category: null,
      subjectTrustScore: 0.7,
      reviewCount: 10,
      reviews: [],
      priceTier: '$$' as const,
    };
    const card = deriveSubjectCard(sharedInput);
    const detail = deriveSubjectDetail(sharedInput);
    expect(detail.header.priceTier).toBe(card.priceTier);
    expect(detail.header.priceTier).toBe('$$');
  });

  it('all four chips can co-exist (place subject with website + language + price)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        host: 'sfmoma.org',
        language: 'en',
        subjectKind: 'place',
        coordinates: { lat: 37.7857, lng: -122.401 },
        priceTier: '$$',
      }),
    );
    expect(detail.header.host).toBe('sfmoma.org');
    expect(detail.header.language).toBe('EN');
    expect(detail.header.location).toBe('37.79°N, 122.40°W');
    expect(detail.header.priceTier).toBe('$$');
  });
});

// ─── V2 actionability layer — recency + region chips ──────────────────────
//
// TN-V2-RANK-011 + RANK-012: detail header mirrors the card surface
// for the recency badge + region pill. Pinned: detail-side glue
// only (field plumbed through, parity with card normalisation,
// default-null behaviour). Comprehensive normalisation edge cases
// (per-category thresholds, future-dated lastActiveMs, multi-region
// formatting) live in `subject_card.test.ts`.

const NOW_MS = 1_700_000_000_000;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

describe('deriveSubjectDetail — header recency badge (TN-V2-RANK-011)', () => {
  it('derives recency string when subject is stale', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        category: 'tech/laptop',
        lastActiveMs: NOW_MS - 3 * MS_PER_YEAR,
      }),
      { nowMs: NOW_MS },
    );
    expect(detail.header.recency).toBe('3 years old');
  });

  it('recency is null when subject is fresh', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        category: 'tech/laptop',
        lastActiveMs: NOW_MS - 6 * 30 * 24 * 60 * 60 * 1000,
      }),
      { nowMs: NOW_MS },
    );
    expect(detail.header.recency).toBeNull();
  });

  it('recency defaults to null when lastActiveMs is omitted', () => {
    const detail = deriveSubjectDetail(makeInput({}), { nowMs: NOW_MS });
    expect(detail.header.recency).toBeNull();
  });

  it('recency defaults to null when context is omitted (Date.now() default)', () => {
    // No context → nowMs falls back to Date.now(); a recent
    // lastActiveMs is still null.
    const detail = deriveSubjectDetail(
      makeInput({
        category: 'tech/laptop',
        lastActiveMs: Date.now() - 24 * 60 * 60 * 1000,
      }),
    );
    expect(detail.header.recency).toBeNull();
  });
});

describe('deriveSubjectDetail — header region pill (TN-V2-RANK-012)', () => {
  it('derives region pill when viewer NOT in availability list', () => {
    const detail = deriveSubjectDetail(
      makeInput({ availabilityRegions: ['UK'] }),
      { viewerRegion: 'US' },
    );
    expect(detail.header.regionPill).toBe('📍 UK only');
  });

  it('regionPill is null when viewer IS in availability list', () => {
    const detail = deriveSubjectDetail(
      makeInput({ availabilityRegions: ['UK', 'US'] }),
      { viewerRegion: 'US' },
    );
    expect(detail.header.regionPill).toBeNull();
  });

  it('regionPill defaults to null when context is omitted (no viewer signal)', () => {
    const detail = deriveSubjectDetail(makeInput({ availabilityRegions: ['UK'] }));
    expect(detail.header.regionPill).toBeNull();
  });

  it('regionPill defaults to null when availabilityRegions is omitted', () => {
    const detail = deriveSubjectDetail(makeInput({}), { viewerRegion: 'US' });
    expect(detail.header.regionPill).toBeNull();
  });
});

// ─── TN-V2-RANK-015: flag-warning banner ──────────────────────────────────
//
// Pins the rules of the negative-space banner contract:
//   1. Null/missing summary → null (no banner — silence on
//      non-flagged subjects).
//   2. Zero / negative / non-finite count → null (defensive against
//      bad wire data; "0 contacts flagged" is reassurance theatre).
//   3. Scope → noun mapping (subject → "product", brand → "brand",
//      category → "category").
//   4. Singular vs plural ("1 contact" vs "N contacts").
//   5. Defensive ceiling clamp on runaway counts.

describe('deriveFlagWarning — null/missing inputs', () => {
  it('returns null when summary is null', () => {
    expect(deriveFlagWarning(null)).toBeNull();
  });

  it('returns null when summary is undefined', () => {
    expect(deriveFlagWarning(undefined)).toBeNull();
  });
});

describe('deriveFlagWarning — count guards', () => {
  it('returns null when count is 0 (no signal)', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: 0, scope: 'brand' }),
    ).toBeNull();
  });

  it('returns null when count is negative', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: -3, scope: 'brand' }),
    ).toBeNull();
  });

  it('returns null when count is NaN / Infinity', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: Number.NaN, scope: 'brand' }),
    ).toBeNull();
    expect(
      deriveFlagWarning({
        contactsFlaggedCount: Number.POSITIVE_INFINITY,
        scope: 'brand',
      }),
    ).toBeNull();
  });

  it('clamps non-integer counts to floor (defensive)', () => {
    const result = deriveFlagWarning({
      contactsFlaggedCount: 3.7,
      scope: 'brand',
    });
    expect(result).not.toBeNull();
    expect(result?.count).toBe(3);
  });

  it('clamps wildly large counts to a defensive ceiling', () => {
    // The viewer's network cannot realistically have 1B+ flaggers
    // on one brand — that's a wire-format violation. Cap at 1M
    // rather than render "1000000000 of your contacts flagged this".
    const result = deriveFlagWarning({
      contactsFlaggedCount: 1_000_000_000,
      scope: 'brand',
    });
    expect(result).not.toBeNull();
    expect(result?.count).toBe(1_000_000);
  });
});

describe('deriveFlagWarning — copy', () => {
  it('singular "1 contact" for count=1', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: 1, scope: 'brand' })?.text,
    ).toBe('1 of your contacts flagged this brand');
    // Wait — singular should say "1 of your contact" or "1 of your
    // contacts"? Standard English uses "contacts" for the prepositional
    // phrase regardless of count ("1 of your contacts" = "1 contact
    // out of your contacts"). Pinning the standard reading.
    //
    // Actually re-checking: common usage IS "1 of your contacts" —
    // the preposition keeps the plural. So count=1 still uses
    // "contacts". Leaving the assertion as-is to pin that reading.
  });

  it('plural "N contacts" for count > 1', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: 2, scope: 'brand' })?.text,
    ).toBe('2 of your contacts flagged this brand');
    expect(
      deriveFlagWarning({ contactsFlaggedCount: 17, scope: 'brand' })?.text,
    ).toBe('17 of your contacts flagged this brand');
  });

  it('uses "product" noun for scope=subject', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: 2, scope: 'subject' })?.text,
    ).toBe('2 of your contacts flagged this product');
  });

  it('uses "brand" noun for scope=brand', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: 2, scope: 'brand' })?.text,
    ).toBe('2 of your contacts flagged this brand');
  });

  it('uses "category" noun for scope=category', () => {
    expect(
      deriveFlagWarning({ contactsFlaggedCount: 2, scope: 'category' })?.text,
    ).toBe('2 of your contacts flagged this category');
  });

  it('preserves the scope in the output for the screen layer', () => {
    // The screen may want to render different visual treatment based
    // on scope (e.g., a stronger colour for "brand"-flagged than
    // "category"-flagged). Pin that the field passes through.
    const result = deriveFlagWarning({ contactsFlaggedCount: 2, scope: 'category' });
    expect(result?.scope).toBe('category');
  });

  it('rejects unknown scope values defensively (wire-format guard)', () => {
    // Future-incompatible wire data shouldn't crash the banner.
    // The fallback uses the count + a generic noun.
    const result = deriveFlagWarning({
      contactsFlaggedCount: 2,
      scope: 'unknown_scope' as unknown as FlagSummary['scope'],
    });
    // Either return null OR render with a generic noun. We render
    // with a fallback noun so the safety signal isn't lost — pin
    // that behaviour here.
    expect(result?.text).toBe('2 of your contacts flagged this subject');
  });
});

describe('deriveSubjectDetail — flag-warning wired through (TN-V2-RANK-015)', () => {
  it('passes the warning onto the header when summary has count > 0', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        flagSummary: { contactsFlaggedCount: 3, scope: 'brand' },
      }),
    );
    expect(detail.header.flagWarning).not.toBeNull();
    expect(detail.header.flagWarning?.count).toBe(3);
    expect(detail.header.flagWarning?.text).toBe(
      '3 of your contacts flagged this brand',
    );
  });

  it('header.flagWarning is null when summary is omitted', () => {
    const detail = deriveSubjectDetail(makeInput({}));
    expect(detail.header.flagWarning).toBeNull();
  });

  it('header.flagWarning is null when count is 0', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        flagSummary: { contactsFlaggedCount: 0, scope: 'brand' },
      }),
    );
    expect(detail.header.flagWarning).toBeNull();
  });
});

describe('chip parity — recency + region pill on card vs detail', () => {
  // Both modules share the helpers from subject_card.ts. This pin
  // catches drift if a future "optimisation" inlines either side.
  it('card and detail produce identical recency for the same input', () => {
    const sharedInput = {
      title: 'Old laptop',
      category: 'tech/laptop',
      subjectTrustScore: 0.6,
      reviewCount: 10,
      reviews: [],
      lastActiveMs: NOW_MS - 5 * MS_PER_YEAR,
    };
    const card = deriveSubjectCard(sharedInput, { nowMs: NOW_MS });
    const detail = deriveSubjectDetail(sharedInput, { nowMs: NOW_MS });
    expect(card.recency).toBe('5 years old');
    expect(detail.header.recency).toBe(card.recency);
  });

  it('card and detail produce identical regionPill for the same input', () => {
    const sharedInput = {
      title: 'UK-only product',
      category: null,
      subjectTrustScore: 0.6,
      reviewCount: 10,
      reviews: [],
      availabilityRegions: ['UK'],
    };
    const card = deriveSubjectCard(sharedInput, { viewerRegion: 'US' });
    const detail = deriveSubjectDetail(sharedInput, { viewerRegion: 'US' });
    expect(card.regionPill).toBe('📍 UK only');
    expect(detail.header.regionPill).toBe(card.regionPill);
  });
});

describe('subtitle parity — deriveSubjectDetail vs deriveSubjectCard', () => {
  // The subtitle derivation is duplicated across `subject_card.ts`
  // and `subject_detail_data.ts` — see the "Same subtitle derivation
  // as subject_card.ts ... deferred until a third call site" comment
  // in subject_detail_data.ts. Two implementations of the same rule
  // are an open drift surface; this suite pins the parity contract
  // so any future divergence (subtle whitespace handling, edge-case
  // null-vs-empty, capitalisation rule) fails loudly here regardless
  // of which side moved.
  //
  // Method: run both helpers on the same category input and compare
  // their `subtitle` outputs. Both surfaces feed the same
  // `SubjectCardDisplay`-like contract; they MUST agree.

  // Both helpers need their own input shape — `deriveSubjectCard`
  // takes the full SubjectCardInput, `deriveSubjectDetail` takes a
  // SubjectDetailInput. We feed them the SAME `category` field via
  // each helper's input builder.
  function pairSubtitles(category: string | null | undefined): {
    card: string | null;
    detail: string | null;
  } {
    const card = deriveSubjectCard({
      title: 'X',
      category: category as string | null | undefined,
      subjectTrustScore: 0.5,
      viewerDid: 'did:plc:viewer',
      reviewCount: 0,
      reviews: [],
    });
    const detail = deriveSubjectDetail(makeInput({ category }));
    return { card: card.subtitle, detail: detail.header.subtitle };
  }

  const PARITY_INPUTS: readonly {
    label: string;
    category: string | null | undefined;
  }[] = [
    { label: 'happy path "office_furniture/chair"', category: 'office_furniture/chair' },
    { label: 'single segment "books"', category: 'books' },
    { label: 'null', category: null },
    { label: 'undefined', category: undefined },
    { label: 'empty string', category: '' },
    { label: 'whitespace-only', category: '   ' },
    { label: 'leading slash "/foo"', category: '/foo' },
    { label: 'trailing slash "foo/"', category: 'foo/' },
    { label: 'lone slash "/"', category: '/' },
    { label: 'multiple slashes "/a/b/c"', category: '/a/b/c' },
    { label: 'underscores collapse "  multi_word_thing  "', category: '  multi_word_thing  ' },
    // Contract-drift regression: an earlier subject_card.ts impl
    // returned '' for these inputs. Pinned here as a parity edge.
    { label: 'all-underscore "__"', category: '__' },
    { label: 'all-underscore "/__/"', category: '/__/' },
    { label: 'all-underscore "  __  "', category: '  __  ' },
    { label: 'triple underscore "___"', category: '___' },
  ];

  it.each(PARITY_INPUTS)(
    'card and detail produce identical subtitle for $label',
    ({ category }) => {
      const { card, detail } = pairSubtitles(category);
      expect(card).toBe(detail);
    },
  );

  it('the "string | null" contract is honoured: parity outputs are never the empty string', () => {
    // Defence against a future edit re-introducing the `''` return.
    // Both implementations must collapse "nothing renderable" to
    // null, never to ''.
    for (const { category } of PARITY_INPUTS) {
      const { card, detail } = pairSubtitles(category);
      expect(card).not.toBe('');
      expect(detail).not.toBe('');
    }
  });
});

describe('ring → friends parity — subject_card vs subject_detail_data', () => {
  // Both modules apply the same ring-classification rule:
  //
  //   - subject_card.ts     : `r.ring === 'self' || r.ring === 'contact'`
  //                           increments the friends count; everything
  //                           else (fof + stranger) increments strangers.
  //                           (Binary card pill view.)
  //   - subject_detail_data : `r.ring === 'self' || r.ring === 'contact'`
  //                           pushes into the friends bucket; fof gets
  //                           its own bucket; stranger gets its own.
  //                           (Ternary detail-section view.)
  //
  // The shapes diverge intentionally — the card collapses fof into
  // strangers because it has a binary pill; the detail screen breaks
  // fof out as a distinct row. But the SHARED semantic is "self and
  // contact are friends; nobody else is". A refactor that changed
  // self → strangers in one module but not the other would silently
  // diverge — the card would say "1 stranger" while the detail screen
  // shows "1 friend". This suite pins parity so any drift fails loudly.

  function pairFriendsClassification(ring: SubjectReview['ring']): {
    cardCountedAsFriend: boolean;
    detailGroupedAsFriend: boolean;
  } {
    const onlyReview = makeReview({
      ring,
      reviewerName: 'X',
      reviewerTrustScore: 0.5,
    });
    // Card path: friendsPill is non-null when at least one review
    // counted as a friend. With a single review, this is the binary
    // signal we need.
    const card = deriveSubjectCard({
      title: 'X',
      category: null,
      subjectTrustScore: 0.5,
      viewerDid: 'did:plc:viewer',
      reviewCount: 1,
      reviews: [onlyReview],
    });
    const cardCountedAsFriend = card.friendsPill !== null;

    // Detail path: friendsReviews is non-empty when at least one
    // review went into the friends bucket.
    const detail = deriveSubjectDetail(
      makeInput({ reviews: [onlyReview] }),
    );
    const detailGroupedAsFriend = detail.friendsReviews.length > 0;
    return { cardCountedAsFriend, detailGroupedAsFriend };
  }

  it.each([
    { ring: 'self' as const, expectedFriend: true },
    { ring: 'contact' as const, expectedFriend: true },
    { ring: 'fof' as const, expectedFriend: false },
    { ring: 'stranger' as const, expectedFriend: false },
  ])(
    'ring=$ring: card and detail agree on friend-classification (expected=$expectedFriend)',
    ({ ring, expectedFriend }) => {
      const { cardCountedAsFriend, detailGroupedAsFriend } =
        pairFriendsClassification(ring);
      expect(cardCountedAsFriend).toBe(expectedFriend);
      expect(detailGroupedAsFriend).toBe(expectedFriend);
      // Always assert parity directly: even if the expected value
      // was wrong, BOTH modules must agree with each other.
      expect(cardCountedAsFriend).toBe(detailGroupedAsFriend);
    },
  );

  it('parity holds across all four rings simultaneously', () => {
    // Single comprehensive pin — feed all four rings at once and
    // assert the card's friends count matches the detail's friends-
    // bucket size. If any ring's classification drifted in either
    // module, the totals would diverge.
    const reviews: SubjectReview[] = [
      makeReview({ ring: 'self', reviewerName: 'Me', reviewerTrustScore: 0.5 }),
      makeReview({ ring: 'contact', reviewerName: 'Sancho', reviewerTrustScore: 0.6 }),
      makeReview({ ring: 'fof', reviewerName: 'Albert', reviewerTrustScore: 0.4 }),
      makeReview({ ring: 'stranger', reviewerName: 'X', reviewerTrustScore: 0.3 }),
      makeReview({ ring: 'stranger', reviewerName: 'Y', reviewerTrustScore: 0.2 }),
    ];

    const card = deriveSubjectCard({
      title: 'X',
      category: null,
      subjectTrustScore: 0.5,
      viewerDid: 'did:plc:viewer',
      reviewCount: reviews.length,
      reviews,
    });
    const detail = deriveSubjectDetail(makeInput({ reviews }));

    // 2 friends (self + contact), 3 non-friends (fof + 2 strangers).
    expect(card.friendsPill).not.toBeNull();
    expect(card.friendsPill?.friendsCount).toBe(2);
    expect(detail.friendsReviews).toHaveLength(2);
    expect(card.friendsPill?.friendsCount).toBe(detail.friendsReviews.length);
  });
});

describe('showNumericScore parity — subject_card vs subject_detail_data', () => {
  // Plan §8.3.1: "Numeric score only when N ≥ 3" — both modules apply
  // the same `reviewCount >= MIN_REVIEWS_FOR_NUMERIC && score.score !== null`
  // formula. Iter-59 unified the constant (subject_detail_data now
  // imports MIN_REVIEWS_FOR_NUMERIC from subject_card), but the
  // formula itself is still duplicated logic. A future refactor that
  // tightened the formula in ONE module (e.g., requiring N≥5 only on
  // the detail header but leaving the card at N≥3) would silently
  // diverge — the search card would say "82" while the detail header
  // shows "HIGH" for the same subject.
  //
  // This suite pins parity so any drift fails loudly. Closes the
  // formula-drift bug class even when the constant is shared.

  function pairShowNumeric(
    subjectTrustScore: number | null,
    reviewCount: number,
  ): { card: boolean; detail: boolean } {
    const card = deriveSubjectCard({
      title: 'X',
      category: null,
      subjectTrustScore,
      viewerDid: 'did:plc:viewer',
      reviewCount,
      reviews: [],
    });
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore, reviewCount }),
    );
    return { card: card.showNumericScore, detail: detail.header.showNumericScore };
  }

  // Coverage matrix: `(reviewCount, score)` boundaries
  //
  //   reviewCount: 0, 1, 2 (below threshold), 3 (boundary), 4, 99 (above)
  //   plus -1 (clamps to 0), NaN (clamps to 0), 3.7 (floors to 3)
  //   score: null (unrated), 0, 0.5, 1.0
  //
  // We don't enumerate the cross-product — just enough cases to pin
  // each rule independently AND together.
  const PARITY_INPUTS: readonly {
    label: string;
    score: number | null;
    reviewCount: number;
  }[] = [
    // Below threshold — false regardless of score
    { label: 'N=0, score=null', score: null, reviewCount: 0 },
    { label: 'N=0, score=0.5', score: 0.5, reviewCount: 0 },
    { label: 'N=2, score=0.99', score: 0.99, reviewCount: 2 },
    // At boundary
    { label: 'N=3, score=null (null score → false)', score: null, reviewCount: 3 },
    { label: 'N=3, score=0.0 (zero score is non-null → true)', score: 0.0, reviewCount: 3 },
    { label: 'N=3, score=0.5', score: 0.5, reviewCount: 3 },
    { label: 'N=3, score=1.0', score: 1.0, reviewCount: 3 },
    // Above boundary
    { label: 'N=99, score=0.5', score: 0.5, reviewCount: 99 },
    { label: 'N=99, score=null', score: null, reviewCount: 99 },
    // Boundary defence: clamping inputs
    { label: 'N=-1 (clamps to 0)', score: 0.5, reviewCount: -1 },
    { label: 'N=NaN (clamps to 0)', score: 0.5, reviewCount: Number.NaN },
    { label: 'N=3.7 (floors to 3)', score: 0.5, reviewCount: 3.7 },
    { label: 'N=2.99 (floors to 2 — just below threshold)', score: 0.5, reviewCount: 2.99 },
  ];

  it.each(PARITY_INPUTS)(
    'card and detail agree on showNumericScore for $label',
    ({ score, reviewCount }) => {
      const { card, detail } = pairShowNumeric(score, reviewCount);
      expect(card).toBe(detail);
    },
  );

  it('the formula honors the N≥3 boundary identically across both modules', () => {
    // Direct cross-module assertions on the load-bearing boundary:
    // N=2 → false on both, N=3 → true on both (with non-null score).
    // Pins the `>=` rather than `>` semantic so a future "off-by-one"
    // refactor (e.g., requiring N>=4) lights up here.
    const below = pairShowNumeric(0.5, 2);
    expect(below.card).toBe(false);
    expect(below.detail).toBe(false);

    const at = pairShowNumeric(0.5, 3);
    expect(at.card).toBe(true);
    expect(at.detail).toBe(true);
  });

  it('null score forces showNumericScore=false on both modules even with N >> threshold', () => {
    // Defends the second clause of the formula:
    // `reviewCount >= MIN && score.score !== null`. If a future refactor
    // dropped the `score !== null` check, an unrated subject with many
    // reviews would surface a fake "0" or "—" as a numeric label.
    const { card, detail } = pairShowNumeric(null, 100);
    expect(card).toBe(false);
    expect(detail).toBe(false);
  });
});

describe('deriveSubjectDetail — ring grouping', () => {
  it('partitions reviews into friends / fof / strangers correctly', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          // Distinct trust scores so the within-group sort is
          // deterministic by score (Self > Sancho here).
          makeReview({ ring: 'self', reviewerName: 'Self', reviewerTrustScore: 0.9 }),
          makeReview({ ring: 'contact', reviewerName: 'Sancho', reviewerTrustScore: 0.7 }),
          makeReview({ ring: 'fof', reviewerName: 'Albert', reviewerTrustScore: 0.5 }),
          makeReview({ ring: 'stranger', reviewerName: 'Stranger1', reviewerTrustScore: 0.4 }),
          makeReview({ ring: 'stranger', reviewerName: 'Stranger2', reviewerTrustScore: 0.3 }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['Self', 'Sancho']);
    expect(detail.fofReviews.map((r) => r.reviewerName)).toEqual(['Albert']);
    expect(detail.strangerReviews.map((r) => r.reviewerName)).toEqual([
      'Stranger1',
      'Stranger2',
    ]);
  });

  it('self collapses with contacts under the friends bucket', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'self', reviewerName: 'Self', reviewerTrustScore: 0.9 }),
        ],
      }),
    );
    expect(detail.friendsReviews).toHaveLength(1);
    expect(detail.fofReviews).toHaveLength(0);
    expect(detail.strangerReviews).toHaveLength(0);
  });

  it('ringCounts match group sizes', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'contact', reviewerName: 'A' }),
          makeReview({ ring: 'contact', reviewerName: 'B' }),
          makeReview({ ring: 'fof', reviewerName: 'C' }),
          makeReview({ ring: 'stranger', reviewerName: 'D' }),
          makeReview({ ring: 'stranger', reviewerName: 'E' }),
          makeReview({ ring: 'stranger', reviewerName: 'F' }),
        ],
      }),
    );
    expect(detail.header.ringCounts).toEqual({ friends: 2, fof: 1, strangers: 3 });
  });

  it('all groups empty when no reviews', () => {
    const detail = deriveSubjectDetail(makeInput({ reviews: [] }));
    expect(detail.friendsReviews).toEqual([]);
    expect(detail.fofReviews).toEqual([]);
    expect(detail.strangerReviews).toEqual([]);
    expect(detail.header.ringCounts).toEqual({ friends: 0, fof: 0, strangers: 0 });
  });
});

describe('deriveSubjectDetail — within-group ordering', () => {
  it('sorts by trust score descending', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'contact', reviewerName: 'Mid', reviewerTrustScore: 0.5 }),
          makeReview({ ring: 'contact', reviewerName: 'Low', reviewerTrustScore: 0.2 }),
          makeReview({ ring: 'contact', reviewerName: 'High', reviewerTrustScore: 0.9 }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['High', 'Mid', 'Low']);
  });

  it('null trust score sinks to the bottom (treated as -Infinity)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'contact', reviewerName: 'Unrated', reviewerTrustScore: null }),
          makeReview({ ring: 'contact', reviewerName: 'Rated', reviewerTrustScore: 0.1 }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['Rated', 'Unrated']);
  });

  it('breaks ties on trust score by recency (more recent first)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({
            ring: 'contact',
            reviewerName: 'A',
            reviewerTrustScore: 0.7,
            createdAtMs: 1_000_000,
          }),
          makeReview({
            ring: 'contact',
            reviewerName: 'B',
            reviewerTrustScore: 0.7,
            createdAtMs: 2_000_000,
          }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['B', 'A']);
  });

  it('breaks ties on score+recency by reviewerName ascending (stable sort)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({
            ring: 'contact',
            reviewerName: 'Bravo',
            reviewerTrustScore: 0.5,
            createdAtMs: 1_000_000,
          }),
          makeReview({
            ring: 'contact',
            reviewerName: 'Alpha',
            reviewerTrustScore: 0.5,
            createdAtMs: 1_000_000,
          }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['Alpha', 'Bravo']);
  });
});

// ─── TN-V2-RANK-014: alternatives strip ───────────────────────────────────
//
// Pins the four contracts of the alternatives derivation:
//   1. Bad / missing input → empty array (never null).
//   2. Cap at MAX_ALTERNATIVES = 3.
//   3. Filter out the current subject (defensive against bad wire).
//   4. De-duplicate by subjectId.
//   5. Band derived from subjectTrustScore — null/non-finite →
//      'unrated'.

function makeAlternative(overrides: Partial<AlternativeInput> = {}): AlternativeInput {
  return {
    subjectId: 'alt-1',
    title: 'Alt subject',
    category: null,
    subjectTrustScore: 0.8,
    ...overrides,
  };
}

describe('deriveAlternatives — null/missing inputs', () => {
  it('returns empty array when raw is null', () => {
    expect(deriveAlternatives(null, '')).toEqual([]);
  });

  it('returns empty array when raw is undefined', () => {
    expect(deriveAlternatives(undefined, '')).toEqual([]);
  });

  it('returns empty array when raw is an empty array', () => {
    expect(deriveAlternatives([], '')).toEqual([]);
  });

  it('returns empty array when raw is not actually an array (defensive)', () => {
    type Raws = readonly AlternativeInput[];
    expect(
      deriveAlternatives('not-an-array' as unknown as Raws, ''),
    ).toEqual([]);
    expect(
      deriveAlternatives({ length: 3 } as unknown as Raws, ''),
    ).toEqual([]);
  });
});

describe('deriveAlternatives — entry filtering', () => {
  it('drops entries with empty subjectId', () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: '' }), makeAlternative({ subjectId: 'b' })],
      '',
    );
    expect(out.map((a) => a.subjectId)).toEqual(['b']);
  });

  it('drops entries with empty title', () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: 'a', title: '' }), makeAlternative({ subjectId: 'b' })],
      '',
    );
    expect(out.map((a) => a.subjectId)).toEqual(['b']);
  });

  it('drops null / undefined entries (defensive)', () => {
    type Raws = readonly AlternativeInput[];
    const out = deriveAlternatives(
      [
        null as unknown as AlternativeInput,
        makeAlternative({ subjectId: 'a' }),
        undefined as unknown as AlternativeInput,
      ] as Raws,
      '',
    );
    expect(out.map((a) => a.subjectId)).toEqual(['a']);
  });

  it('drops the current subject (defensive — server should never include self)', () => {
    const out = deriveAlternatives(
      [
        makeAlternative({ subjectId: 'self', title: 'Self' }),
        makeAlternative({ subjectId: 'other', title: 'Other' }),
      ],
      'self',
    );
    expect(out.map((a) => a.subjectId)).toEqual(['other']);
  });

  it('drops duplicates by subjectId, preserving order', () => {
    const out = deriveAlternatives(
      [
        makeAlternative({ subjectId: 'a', title: 'First' }),
        makeAlternative({ subjectId: 'b', title: 'Second' }),
        makeAlternative({ subjectId: 'a', title: 'Duplicate first' }),
      ],
      '',
    );
    expect(out.map((a) => a.subjectId)).toEqual(['a', 'b']);
    expect(out[0]?.title).toBe('First');
  });
});

describe('deriveAlternatives — capping', () => {
  it('caps at MAX_ALTERNATIVES (3)', () => {
    expect(MAX_ALTERNATIVES).toBe(3);
    const raw = Array.from({ length: 10 }, (_, i) =>
      makeAlternative({ subjectId: `alt-${i}`, title: `Alt ${i}` }),
    );
    const out = deriveAlternatives(raw, '');
    expect(out).toHaveLength(MAX_ALTERNATIVES);
    expect(out.map((a) => a.subjectId)).toEqual(['alt-0', 'alt-1', 'alt-2']);
  });

  it('returns fewer than 3 when input has fewer survivors', () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: 'a' }), makeAlternative({ subjectId: 'b' })],
      '',
    );
    expect(out).toHaveLength(2);
  });
});

describe('deriveAlternatives — band derivation', () => {
  it('high band for score >= 0.7', () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: 'a', subjectTrustScore: 0.85 })],
      '',
    );
    expect(out[0]?.band).toBe('high');
  });

  it('moderate band for 0.4 <= score < 0.7', () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: 'a', subjectTrustScore: 0.55 })],
      '',
    );
    expect(out[0]?.band).toBe('moderate');
  });

  it('low band for 0.2 <= score < 0.4', () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: 'a', subjectTrustScore: 0.3 })],
      '',
    );
    expect(out[0]?.band).toBe('low');
  });

  it("very-low band for score < 0.2", () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: 'a', subjectTrustScore: 0.1 })],
      '',
    );
    expect(out[0]?.band).toBe('very-low');
  });

  it('unrated when score is null', () => {
    const out = deriveAlternatives(
      [makeAlternative({ subjectId: 'a', subjectTrustScore: null })],
      '',
    );
    expect(out[0]?.band).toBe('unrated');
  });

  it('unrated when score is undefined / non-finite', () => {
    const a = deriveAlternatives(
      [makeAlternative({ subjectId: 'a', subjectTrustScore: undefined })],
      '',
    );
    expect(a[0]?.band).toBe('unrated');
    const b = deriveAlternatives(
      [makeAlternative({ subjectId: 'b', subjectTrustScore: Number.NaN })],
      '',
    );
    expect(b[0]?.band).toBe('unrated');
  });
});

describe('deriveSubjectDetail — alternatives wired through', () => {
  it('passes alternatives onto the display', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        alternatives: [
          { subjectId: 'a', title: 'Alt A', subjectTrustScore: 0.8, category: 'tech' },
          { subjectId: 'b', title: 'Alt B', subjectTrustScore: 0.5, category: null },
        ],
      }),
    );
    expect(detail.alternatives).toHaveLength(2);
    expect(detail.alternatives[0]?.subjectId).toBe('a');
    expect(detail.alternatives[0]?.band).toBe('high');
    expect(detail.alternatives[0]?.category).toBe('tech');
  });

  it('alternatives default to empty array when omitted', () => {
    const detail = deriveSubjectDetail(makeInput({}));
    expect(detail.alternatives).toEqual([]);
  });

  it('filters out the current subject when subjectDid matches', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        subjectDid: 'did:plc:self',
        alternatives: [
          { subjectId: 'did:plc:self', title: 'Self' },
          { subjectId: 'did:plc:other', title: 'Other' },
        ],
      }),
    );
    expect(detail.alternatives.map((a) => a.subjectId)).toEqual(['did:plc:other']);
  });

  it('filters out the current subject when subjectIdentifier matches', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        subjectIdentifier: 'asin:B07ABC',
        alternatives: [
          { subjectId: 'asin:B07ABC', title: 'Self' },
          { subjectId: 'asin:B08DEF', title: 'Other' },
        ],
      }),
    );
    expect(detail.alternatives.map((a) => a.subjectId)).toEqual(['asin:B08DEF']);
  });
});
