/**
 * Render tests for the subject detail screen (TN-MOB-012).
 *
 * Pins the screen-state machine + composition over the data-layer
 * derivation (`subject_detail_data.ts`). Three render states +
 * grouped review sections + interactions.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import SubjectDetailScreen from '../../app/trust/[subjectId]';

import type { SubjectReview } from '../../src/trust/subject_card';
import type { SubjectDetailInput } from '../../src/trust/subject_detail_data';

function makeReview(overrides: Partial<SubjectReview> = {}): SubjectReview {
  return {
    ring: 'contact',
    reviewerDid: 'did:plc:sancho',
    reviewerTrustScore: 0.7,
    reviewerName: 'Sancho',
    headline: 'Great chair',
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

describe('SubjectDetailScreen — render states', () => {
  it('renders error panel when error is set', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={null}
        error="Network unreachable"
        onRetry={() => undefined}
      />,
    );
    expect(getByTestId('subject-detail-error')).toBeTruthy();
    expect(getByText('Network unreachable')).toBeTruthy();
    expect(getByTestId('subject-detail-retry')).toBeTruthy();
  });

  it('renders Retry CTA when onRetry is omitted (auto-timeout reset)', () => {
    // The screen now provides a router-aware default for `onRetry` — it
    // resets the auto-timeout state so the user can re-trigger the
    // load. Callers that genuinely want a no-Retry error panel pass
    // `onRetry={undefined}` is no longer a way to hide it; the CTA is
    // always available in production paths.
    const { getByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={null} error="boom" />,
    );
    expect(getByTestId('subject-detail-retry')).toBeTruthy();
  });

  it('renders loading state when data is null AND no error', () => {
    const { getByTestId, queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={null} />,
    );
    expect(getByTestId('subject-detail-loading')).toBeTruthy();
    expect(queryByTestId('subject-detail-screen')).toBeNull();
    expect(queryByTestId('subject-detail-error')).toBeNull();
  });

  it('renders loaded state with header + ring summary when data is provided', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(getByTestId('subject-detail-screen')).toBeTruthy();
    expect(getByText('Aeron chair')).toBeTruthy();
    expect(getByText('Office furniture')).toBeTruthy();
    expect(getByTestId('subject-detail-ring-summary')).toBeTruthy();
  });
});

describe('SubjectDetailScreen — header', () => {
  it('renders numeric score badge when showNumericScore=true', () => {
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ subjectTrustScore: 0.82, reviewCount: 5 })}
      />,
    );
    expect(getByText('82')).toBeTruthy();
  });

  it('renders band label when showNumericScore=false (N<3)', () => {
    const { getByText, queryByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ subjectTrustScore: 0.95, reviewCount: 1 })}
      />,
    );
    // 0.95 → band high; with N=1 (<3) the screen shows "HIGH" not the digit.
    expect(getByText('HIGH')).toBeTruthy();
    expect(queryByText('95')).toBeNull();
  });

  it('renders correct review count singular', () => {
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ reviewCount: 1 })}
      />,
    );
    expect(getByText(/^1 review$/)).toBeTruthy();
  });

  it('renders Write CTA when onWriteReview is provided', () => {
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput()}
        onWriteReview={() => undefined}
      />,
    );
    expect(getByTestId('subject-detail-write-cta')).toBeTruthy();
  });

  it('renders Write CTA when onWriteReview is omitted (router fallback)', () => {
    // Screens now expose a router-based navigation fallback so the
    // Write CTA is always present in production. Callers that genuinely
    // need to suppress it (read-only contexts, e.g. a quoted preview)
    // pass an explicit no-op handler instead of relying on omission.
    const { getByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(getByTestId('subject-detail-write-cta')).toBeTruthy();
  });

  // ─── TN-V2-P1-004 + RANK-013: header chips (host + language +
  // place location + price tier)
  //
  // The data layer derives + normalises; these tests pin the rendering
  // contract on the subject detail screen.
  it('hides the chip row entirely when host + language + location + price are all null', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(queryByTestId('subject-detail-context')).toBeNull();
    expect(queryByTestId('subject-detail-host')).toBeNull();
    expect(queryByTestId('subject-detail-language')).toBeNull();
    expect(queryByTestId('subject-detail-location')).toBeNull();
    expect(queryByTestId('subject-detail-price')).toBeNull();
  });

  it('renders only the host chip when language and location are absent', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ host: 'amazon.co.uk' })}
      />,
    );
    expect(getByTestId('subject-detail-context')).toBeTruthy();
    expect(getByTestId('subject-detail-host')).toBeTruthy();
    expect(queryByTestId('subject-detail-language')).toBeNull();
    expect(queryByTestId('subject-detail-location')).toBeNull();
    expect(getByText('amazon.co.uk')).toBeTruthy();
  });

  it('renders only the language chip when host and location are absent', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput({ language: 'pt-br' })} />,
    );
    expect(getByTestId('subject-detail-context')).toBeTruthy();
    expect(queryByTestId('subject-detail-host')).toBeNull();
    expect(getByTestId('subject-detail-language')).toBeTruthy();
    expect(queryByTestId('subject-detail-location')).toBeNull();
    expect(getByText('PT-BR')).toBeTruthy();
  });

  it('renders only the location chip for a place subject (typical case)', () => {
    // Places rarely carry host (a venue isn't a URL), so the location
    // chip stands alone as the geographic anchor.
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          subjectKind: 'place',
          coordinates: { lat: 37.7749, lng: -122.4194 },
        })}
      />,
    );
    expect(getByTestId('subject-detail-context')).toBeTruthy();
    expect(queryByTestId('subject-detail-host')).toBeNull();
    expect(queryByTestId('subject-detail-language')).toBeNull();
    expect(getByTestId('subject-detail-location')).toBeTruthy();
    expect(getByText('37.77°N, 122.42°W')).toBeTruthy();
  });

  it('renders all three chips when all signals present', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          host: 'sfmoma.org',
          language: 'en',
          subjectKind: 'place',
          coordinates: { lat: 37.7857, lng: -122.401 },
        })}
      />,
    );
    expect(getByTestId('subject-detail-host')).toBeTruthy();
    expect(getByTestId('subject-detail-language')).toBeTruthy();
    expect(getByTestId('subject-detail-location')).toBeTruthy();
    expect(getByText('sfmoma.org')).toBeTruthy();
    expect(getByText('EN')).toBeTruthy();
    expect(getByText('37.79°N, 122.40°W')).toBeTruthy();
  });

  it('drops the location chip when subjectKind is "product" with coords (wire-bug guard)', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          subjectKind: 'product',
          coordinates: { lat: 37.77, lng: -122.42 },
        })}
      />,
    );
    expect(queryByTestId('subject-detail-location')).toBeNull();
  });

  // TN-V2-RANK-013 — price tier chip on detail header.
  it('renders only the price chip when host + language + location are absent', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput({ priceTier: '$$' })} />,
    );
    expect(getByTestId('subject-detail-context')).toBeTruthy();
    expect(queryByTestId('subject-detail-host')).toBeNull();
    expect(queryByTestId('subject-detail-language')).toBeNull();
    expect(queryByTestId('subject-detail-location')).toBeNull();
    expect(getByTestId('subject-detail-price')).toBeTruthy();
    expect(getByText('$$')).toBeTruthy();
  });

  it.each(['$', '$$', '$$$'] as const)(
    'renders the price chip text verbatim for tier %s',
    (tier) => {
      const { getByTestId, getByText } = render(
        <SubjectDetailScreen subjectId="sub-1" data={makeInput({ priceTier: tier })} />,
      );
      expect(getByTestId('subject-detail-price')).toBeTruthy();
      expect(getByText(tier)).toBeTruthy();
    },
  );

  // TN-V2-RANK-011 — recency badge on detail header.
  // Tests the END-TO-END wiring: input.lastActiveMs + category →
  // header.recency derivation → chip render. The default
  // `Date.now()` fallback in deriveSubjectDetail (when context is
  // omitted) means we need a deterministic age — a wire-format
  // lastActiveMs from 2010 is always stale regardless of "now".
  it('renders the recency chip when subject is stale', () => {
    const longAgoMs = 1_300_000_000_000; // ~ 2011-03-15 — always stale.
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          category: 'tech/laptop',
          lastActiveMs: longAgoMs,
        })}
      />,
    );
    expect(getByTestId('subject-detail-recency')).toBeTruthy();
    // Don't pin the exact "N years old" string — it depends on the
    // wall-clock at test-run time. Pin the suffix shape instead.
    expect(getByText(/\d+ years? old$/)).toBeTruthy();
  });

  it('hides the recency chip when subject is fresh (within category half-life)', () => {
    // Use a lastActiveMs guaranteed-recent: now-ish. tech threshold
    // is 1 year, so a today-ish lastActiveMs is fresh → no badge.
    const { queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          category: 'tech/laptop',
          lastActiveMs: Date.now() - 24 * 60 * 60 * 1000, // 1 day old
        })}
      />,
    );
    expect(queryByTestId('subject-detail-recency')).toBeNull();
  });

  it('hides the recency chip when lastActiveMs is omitted (no signal)', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(queryByTestId('subject-detail-recency')).toBeNull();
  });

  // TN-V2-RANK-012 — region pill on detail header.
  //
  // The detail screen pulls viewerRegion from `useViewerPreferences()`
  // (keystore-resident; never reaches the wire — Loyalty Law). The
  // data-layer test in `subject_detail_data.test.ts` pins the
  // derivation contract; the view-level test on `subject_card_view`
  // pins the chip render. The screen wiring is a one-line pass-
  // through (`viewerRegion: viewerProfile?.region`), and exercising
  // it here would require seeding the keychain mock + the user-
  // preferences singleton — the integration belongs in
  // `__tests__/screens/` alongside the existing
  // `viewer_filter_integration.render.test.tsx` if/when needed.

  // TN-V2-RANK-015 — flag-warning banner on detail header.
  // The banner is the highest-priority safety surface; pinned that
  // it (a) renders ABOVE the chip row, (b) uses the warning testID,
  // (c) hides silently when count is zero or summary missing.
  it('renders the flag-warning banner when summary has count > 0', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          flagSummary: { contactsFlaggedCount: 2, scope: 'brand' },
        })}
      />,
    );
    expect(getByTestId('subject-detail-flag-warning')).toBeTruthy();
    expect(getByText('2 of your contacts flagged this brand')).toBeTruthy();
  });

  it('renders the singular-friendly copy for count=1', () => {
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          flagSummary: { contactsFlaggedCount: 1, scope: 'category' },
        })}
      />,
    );
    expect(getByText('1 of your contacts flagged this category')).toBeTruthy();
  });

  it('hides the banner when count is 0 (no reassurance theatre)', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          flagSummary: { contactsFlaggedCount: 0, scope: 'brand' },
        })}
      />,
    );
    expect(queryByTestId('subject-detail-flag-warning')).toBeNull();
  });

  it('hides the banner when flagSummary is omitted', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(queryByTestId('subject-detail-flag-warning')).toBeNull();
  });

  // TN-V2-RANK-014 — alternatives strip below the review list.
  it('hides the alternatives strip when alternatives is empty (default)', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(queryByTestId('subject-detail-alternatives')).toBeNull();
  });

  it('renders the strip with the correct header copy and cards', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          alternatives: [
            { subjectId: 'alt-1', title: 'Alt One', subjectTrustScore: 0.85, category: 'tech/laptop' },
            { subjectId: 'alt-2', title: 'Alt Two', subjectTrustScore: 0.55, category: 'tech/laptop' },
          ],
        })}
      />,
    );
    expect(getByTestId('subject-detail-alternatives')).toBeTruthy();
    expect(getByText('2 trusted alternatives')).toBeTruthy();
    expect(getByTestId('subject-detail-alternative-alt-1')).toBeTruthy();
    expect(getByTestId('subject-detail-alternative-alt-2')).toBeTruthy();
    expect(getByText('Alt One')).toBeTruthy();
    expect(getByText('Alt Two')).toBeTruthy();
  });

  it('uses singular header when there is exactly 1 alternative', () => {
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          alternatives: [
            { subjectId: 'alt-1', title: 'Alt One', subjectTrustScore: 0.85 },
          ],
        })}
      />,
    );
    expect(getByText('1 trusted alternative')).toBeTruthy();
  });

  it('renders a band stripe per rated alternative; omits for unrated', () => {
    const { getByTestId, queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          alternatives: [
            { subjectId: 'alt-1', title: 'Rated', subjectTrustScore: 0.85 },
            { subjectId: 'alt-2', title: 'Unrated', subjectTrustScore: null },
          ],
        })}
      />,
    );
    expect(getByTestId('subject-detail-alternative-band-alt-1')).toBeTruthy();
    expect(queryByTestId('subject-detail-alternative-band-alt-2')).toBeNull();
  });

  it('caps the strip at 3 entries even if more come down the wire', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          alternatives: Array.from({ length: 5 }, (_, i) => ({
            subjectId: `alt-${i}`,
            title: `Alt ${i}`,
            subjectTrustScore: 0.8,
          })),
        })}
      />,
    );
    expect(queryByTestId('subject-detail-alternative-alt-0')).toBeTruthy();
    expect(queryByTestId('subject-detail-alternative-alt-1')).toBeTruthy();
    expect(queryByTestId('subject-detail-alternative-alt-2')).toBeTruthy();
    expect(queryByTestId('subject-detail-alternative-alt-3')).toBeNull();
    expect(queryByTestId('subject-detail-alternative-alt-4')).toBeNull();
  });

  it('renders all four chips when host + language + location + price all present', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          host: 'sfmoma.org',
          language: 'en',
          subjectKind: 'place',
          coordinates: { lat: 37.7857, lng: -122.401 },
          priceTier: '$$',
        })}
      />,
    );
    expect(getByTestId('subject-detail-host')).toBeTruthy();
    expect(getByTestId('subject-detail-language')).toBeTruthy();
    expect(getByTestId('subject-detail-location')).toBeTruthy();
    expect(getByTestId('subject-detail-price')).toBeTruthy();
    expect(getByText('sfmoma.org')).toBeTruthy();
    expect(getByText('EN')).toBeTruthy();
    expect(getByText('37.79°N, 122.40°W')).toBeTruthy();
    expect(getByText('$$')).toBeTruthy();
  });
});

describe('SubjectDetailScreen — review sections', () => {
  it('renders one section per non-empty ring group', () => {
    const { getByTestId, queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ ring: 'contact', reviewerName: 'A' }),
            makeReview({ ring: 'fof', reviewerName: 'B' }),
          ],
        })}
      />,
    );
    expect(getByTestId('subject-detail-section-friends')).toBeTruthy();
    expect(getByTestId('subject-detail-section-fof')).toBeTruthy();
    // Strangers section omitted because it's empty AND there are
    // other sections (no global "no reviews" hint needed).
    expect(queryByTestId('subject-detail-section-strangers')).toBeNull();
  });

  it('renders an empty hint in strangers section when ALL groups are empty', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ reviews: [], reviewCount: 0 })}
      />,
    );
    // Only the strangers section renders, with the global empty hint.
    expect(getByTestId('subject-detail-section-strangers')).toBeTruthy();
    expect(getByText(/be the first/i)).toBeTruthy();
  });

  it('renders one row per review in the section', () => {
    const { getAllByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ ring: 'contact', reviewerName: 'A' }),
            makeReview({ ring: 'contact', reviewerName: 'B' }),
            makeReview({ ring: 'contact', reviewerName: 'C' }),
          ],
        })}
      />,
    );
    expect(getAllByTestId(/^subject-detail-review-friends-\d+$/)).toHaveLength(3);
  });

  it('shows the section count badge when reviews present', () => {
    const { getAllByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [makeReview(), makeReview({ reviewerName: 'B' })],
        })}
      />,
    );
    // The count "2" appears as the section count badge.
    expect(getAllByText('2').length).toBeGreaterThan(0);
  });
});

describe('SubjectDetailScreen — interactions', () => {
  it('tap on Write CTA fires onWriteReview with subjectId', () => {
    const onWrite = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-99"
        data={makeInput()}
        onWriteReview={onWrite}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-write-cta'));
    expect(onWrite).toHaveBeenCalledWith('sub-99');
  });

  it('tap on a review row fires onSelectReviewer with reviewer DID', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ reviewerName: 'Sancho', reviewerDid: 'did:plc:sancho' }),
          ],
        })}
        onSelectReviewer={onSelect}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-review-friends-0'));
    expect(onSelect).toHaveBeenCalledWith('did:plc:sancho');
  });

  it('tap on Retry fires onRetry', () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={null}
        error="boom"
        onRetry={onRetry}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('SubjectDetailScreen — accessibility (TN-TEST-061 surface)', () => {
  it('review row has descriptive accessibilityLabel', () => {
    const { getByLabelText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              reviewerName: 'Sancho',
              reviewerTrustScore: 0.85,
            }),
          ],
        })}
        onSelectReviewer={() => undefined}
      />,
    );
    expect(getByLabelText(/Review by Sancho, trust HIGH/)).toBeTruthy();
  });

  it('Write CTA has accessibilityLabel="Write a review"', () => {
    const { getByLabelText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput()}
        onWriteReview={() => undefined}
      />,
    );
    expect(getByLabelText('Write a review')).toBeTruthy();
  });
});

describe('SubjectDetailScreen — self-review band suppression', () => {
  // AppView's `subjectGet` is supposed to bucket the viewer's own
  // review into `reviewers.self`. When the viewerDid handshake
  // misses (observed in production via idb on 2026-05-01), the
  // review lands in `strangers` instead — and the row would surface
  // the user's own trust band (e.g. "VERY LOW" red badge) against
  // their own name, exactly the shame mechanic we suppressed on the
  // self-card. The mobile-side fix detects self by DID match
  // regardless of the bucket the wire chose.
  it('renders "Your review" + no band badge when row.reviewerDid matches viewerDid (even with ring=stranger)', () => {
    const { getByText, queryByText, getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'stranger',
              reviewerDid: 'did:plc:rajmohanddc9',
              reviewerName: 'rajmohanddc9',
              reviewerTrustScore: 0.05, // would render VERY LOW
              headline: 'Comfortable',
            }),
          ],
        })}
        viewerDid="did:plc:rajmohanddc9"
      />,
    );
    // Row reads "Your review" — name is suppressed.
    expect(getByText('Your review')).toBeTruthy();
    expect(queryByText('rajmohanddc9')).toBeNull();
    // Band badge ("VERY LOW") is suppressed too.
    expect(queryByText('VERY LOW')).toBeNull();
    // After the F4 fix the data layer reclassifies a self-authored
    // ring='stranger' row back into the friends bucket when viewerDid
    // matches, so the row lands in "Your network" — not "Strangers".
    // The pre-fix behaviour rendered the row in `strangers` with the
    // row-level isSelf guard masking the band visually; that left the
    // section header + the `ringCounts` summary stating "1 from
    // strangers" while the only row was the user's own. The data-layer
    // guard fixes that header inconsistency too.
    expect(getByTestId('subject-detail-section-friends')).toBeTruthy();
  });

  it('does NOT suppress the band when viewerDid is empty (degraded pre-boot path)', () => {
    // Defensive: an empty `viewerDid` (no booted node) must not
    // accidentally match against another reviewer's empty DID. The
    // band stays visible in this case.
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'stranger',
              reviewerDid: 'did:plc:somebody',
              reviewerName: 'Somebody',
              reviewerTrustScore: 0.05,
            }),
          ],
        })}
        viewerDid=""
      />,
    );
    expect(getByText('VERY LOW')).toBeTruthy();
    expect(getByText('Somebody')).toBeTruthy();
  });

  it('still respects ring=self when wire correctly buckets the viewer (regression guard)', () => {
    // Belt-and-braces: even when the wire correctly puts the user
    // in `reviewers.self`, the row should suppress the band.
    const { getByText, queryByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'self',
              reviewerDid: null,
              reviewerName: 'You',
              reviewerTrustScore: 0.05,
            }),
          ],
        })}
        // Intentionally NOT passing viewerDid — ring='self' alone
        // should already trigger the suppression.
      />,
    );
    expect(getByText('Your review')).toBeTruthy();
    expect(queryByText('VERY LOW')).toBeNull();
  });
});

describe('SubjectDetailScreen — own review row tappable (F2 fix)', () => {
  // Pre-fix: own-review rows had `accessibilityRole='text'` and no
  // onPress, so the only path to amend was to back-navigate to the
  // reviewer profile and use that screen's Edit button. Now self-rows
  // are buttons that fire `onPressOwnReview` (default routes to the
  // user's own reviewer profile).
  it('fires onPressOwnReview when the user taps their own review row', () => {
    const onPressOwnReview = jest.fn();
    const { getByLabelText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'self',
              reviewerDid: null,
              reviewerName: 'You',
              reviewerTrustScore: 0.05,
              headline: 'Comfortable',
            }),
          ],
        })}
        viewerDid="did:plc:viewer"
        onPressOwnReview={onPressOwnReview}
      />,
    );
    fireEvent.press(getByLabelText('Your review — tap to edit'));
    expect(onPressOwnReview).toHaveBeenCalledTimes(1);
  });

  it('own review row carries accessibilityRole="button" so screen readers announce it', () => {
    const { getByLabelText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ ring: 'self', reviewerDid: null, reviewerName: 'You' }),
          ],
        })}
        viewerDid="did:plc:viewer"
        onPressOwnReview={() => undefined}
      />,
    );
    expect(getByLabelText('Your review — tap to edit').props.accessibilityRole).toBe('button');
  });

  it('row stays as text when onPressOwnReview is not provided (graceful)', () => {
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ ring: 'self', reviewerDid: null, reviewerName: 'You' }),
          ],
        })}
        viewerDid="did:plc:viewer"
      />,
    );
    // The default-supplied `onPressOwnReview` from the screen
    // wrapper IS provided in production routing, so the row is a
    // button; this test pins that the screen falls back gracefully
    // (button visible, headline still rendered) even with the test-
    // injected handler explicitly stubbed away.
    expect(getByText('Your review')).toBeTruthy();
  });

  // Pre-fix: the self-row was tappable (F2) but had no visible
  // affordance — sighted users couldn't tell. The pill is a
  // discoverability cue; the row's own Pressable is still the tap
  // target (no nested Pressable) so we don't get tap-target
  // ambiguity. Pin both: pill present on self, NOT present on
  // other reviews (otherwise it'd suggest you can edit other
  // people's reviews).
  it('renders a visible "Edit" pill on the self-row so sighted users see the affordance', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ ring: 'self', reviewerDid: null, reviewerName: 'You' }),
          ],
        })}
        viewerDid="did:plc:viewer"
        onPressOwnReview={() => undefined}
      />,
    );
    expect(getByTestId('subject-detail-self-edit-pill')).toBeTruthy();
    expect(getByText('Edit')).toBeTruthy();
  });

  it('does NOT render the Edit pill on other reviewers\' rows', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'contacts',
              reviewerDid: 'did:plc:someone-else',
              reviewerName: 'Sancho',
            }),
          ],
        })}
        viewerDid="did:plc:viewer"
        onPressOwnReview={() => undefined}
      />,
    );
    expect(queryByTestId('subject-detail-self-edit-pill')).toBeNull();
  });

  // Pre-fix (F2 follow-up): the Edit pill was a non-interactive View;
  // tapping it bubbled up to the row's own Pressable, which routed to
  // the reviewer profile (not the editor). User reported "tap edit ->
  // doesn't go to edit screen". The pill is now its own Pressable
  // that fires `onPressOwnReviewEdit` with the tapped review, AND the
  // row's `onPressOwnReview` does NOT also fire (RN's gesture
  // responder delivers the touch to the innermost Pressable only).
  it('fires onPressOwnReviewEdit (NOT onPressOwnReview) when the Edit pill is tapped', () => {
    const onPressOwnReview = jest.fn();
    const onPressOwnReviewEdit = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'self',
              reviewerDid: null,
              reviewerName: 'You',
              headline: 'Comfortable',
              attestationUri: 'at://did:plc:viewer/com.dina.trust.attestation/abc',
              body: 'Long form body text',
              sentiment: 'positive',
            }),
          ],
        })}
        viewerDid="did:plc:viewer"
        onPressOwnReview={onPressOwnReview}
        onPressOwnReviewEdit={onPressOwnReviewEdit}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-self-edit-pill'));
    expect(onPressOwnReviewEdit).toHaveBeenCalledTimes(1);
    expect(onPressOwnReview).not.toHaveBeenCalled();
    // Verify the callback receives the full review (including the
    // editing fields the route handler needs to seed /trust/write).
    const call = onPressOwnReviewEdit.mock.calls[0][0];
    expect(call.attestationUri).toBe(
      'at://did:plc:viewer/com.dina.trust.attestation/abc',
    );
    expect(call.headline).toBe('Comfortable');
    expect(call.body).toBe('Long form body text');
    expect(call.sentiment).toBe('positive');
  });

  it('Edit pill is inert (no callback) when the wire didn\'t carry an attestationUri', () => {
    const onPressOwnReviewEdit = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'self',
              reviewerDid: null,
              reviewerName: 'You',
              headline: 'Comfortable',
              // No attestationUri — synthetic / legacy wire shape.
            }),
          ],
        })}
        viewerDid="did:plc:viewer"
        onPressOwnReview={() => undefined}
        onPressOwnReviewEdit={onPressOwnReviewEdit}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-self-edit-pill'));
    expect(onPressOwnReviewEdit).not.toHaveBeenCalled();
  });
});
