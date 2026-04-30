/**
 * Cross-cutting accessibility tests for the trust-network screens
 * (TN-TEST-061 / Plan §13.4).
 *
 * Three a11y dimensions enforced:
 *   1. **VoiceOver labels** — every interactive element (Pressable,
 *      TouchableOpacity, button) has either a non-empty
 *      `accessibilityLabel` OR a non-empty visible `Text` child that
 *      VoiceOver can read.
 *   2. **accessibilityRole** — every interactive element declares its
 *      role so screen readers announce it correctly ("button" for
 *      CTAs, "link" for navigation, etc.).
 *   3. **Tap target sizes** — primary CTAs respect a 44pt floor (iOS
 *      HIG), so users can hit them reliably with a finger. Inline
 *      affordances (paired buttons inside a row) get a 36pt floor as
 *      a documented exception.
 *
 * **Contrast ratios are NOT enforced here** — they live in the
 * `colors` palette in `src/theme.ts` and would need a colour-contrast
 * library that imports actual sRGB→Lab conversion (we'd be testing
 * the library, not our code). Pinned in the design-system layer
 * (`src/theme.ts`) instead. See plan §13.4 for the contrast audit
 * cadence.
 *
 * **Why a single cross-cutting test file** (rather than one a11y test
 * per screen): a11y invariants apply UNIFORMLY across the surface.
 * Co-locating them lets a contributor verify "every CTA in the trust
 * tab clears the bar" in one read; per-screen a11y tests would either
 * duplicate the rules or silently drift. Per-screen render tests
 * already pin specific labels (`getByLabelText('Add namespace_2')`);
 * this file pins the GENERIC invariants that all screens must satisfy.
 *
 * Test approach: render each screen with realistic synthetic props,
 * walk the rendered tree via `UNSAFE_root` (an RTL escape hatch — its
 * use is documented + scoped to a11y testing, not feature behaviour),
 * and assert each interactive element clears the bar.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import NamespaceScreen from '../../app/trust/namespace';
import OutboxScreen from '../../app/trust/outbox';
import ReviewerProfileScreen from '../../app/trust/reviewer/[did]';
import SearchScreen, { type SearchResult } from '../../app/trust/search';
import TrustFeedScreen, { type FeedItem } from '../../app/trust/index';
import SubjectDetailScreen from '../../app/trust/[subjectId]';
import WriteScreen from '../../app/trust/write';

import type { SubjectDetailInput } from '../../src/trust/subject_detail_data';

import type { OutboxRow } from '../../src/trust/outbox';
import type { TrustProfile } from '@dina/core';
import type { SubjectCardDisplay } from '../../src/trust/subject_card';
import type { FacetBar } from '../../src/trust/facets';

// ─── Test fixtures ────────────────────────────────────────────────────────

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const NOW_ISO = '2026-04-30T10:00:00Z';
const NOW = 1_700_000_000_000;

const PRIOR_OP = {
  verificationMethods: {
    namespace_0: 'multikey-0',
    namespace_1: 'multikey-1',
  },
};

function makeOutboxRow(overrides: Partial<OutboxRow<{ text: string }>> = {}): OutboxRow<{ text: string }> {
  return {
    clientId: 'cid-default',
    draftBody: { text: 'A draft' },
    status: 'rejected',
    enqueuedAt: NOW_ISO,
    submittedAt: NOW_ISO,
    atUri: 'at://x/y/1',
    rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
    ...overrides,
  };
}

function makeSubjectCardDisplay(): SubjectCardDisplay {
  return {
    title: 'Aeron chair',
    subtitle: 'Office furniture',
    score: { score: 80, label: '80', bandName: 'High', band: 'high', colorToken: 'high' },
    showNumericScore: true,
    reviewCount: 5,
    friendsPill: { friendsCount: 1, strangersCount: 4 },
    topReviewer: null,
  };
}

function makeSearchResult(id: string): SearchResult {
  return { subjectId: id, display: makeSubjectCardDisplay() };
}

function makeFeedItem(id: string): FeedItem {
  return { subjectId: id, display: makeSubjectCardDisplay() };
}

const SOME_FACETS: FacetBar = {
  primary: [{ value: 'Furniture', count: 5 }],
  overflow: [{ value: 'Books', count: 1 }],
};

function makeReviewerProfile(): TrustProfile {
  return {
    did: DID,
    overallTrustScore: 0.85,
    attestationSummary: { total: 10, positive: 7, neutral: 2, negative: 1 },
    vouchCount: 3,
    endorsementCount: 5,
    reviewerStats: {
      totalAttestationsBy: 10,
      corroborationRate: 0.7,
      evidenceRate: 0.4,
      helpfulRatio: 0.92,
    },
    activeDomains: ['github.com'],
    lastActive: NOW - 60_000,
  };
}

// ─── Tap-target floor (iOS HIG) ────────────────────────────────────────────

/**
 * Minimum tap-target height for primary CTAs (iOS HIG: 44 × 44pt).
 * Inline / paired buttons are allowed a smaller floor (documented
 * inside the screen's stylesheet).
 */
const PRIMARY_CTA_MIN_HEIGHT = 44;

/**
 * Pull a flat list of `{type, props}` entries from the rendered tree.
 * `UNSAFE_root` is an RTL escape hatch — we use it deliberately for
 * a11y traversal (per-element invariant assertions), NOT for feature
 * behaviour testing (where queries like `getByLabelText` are correct).
 */
interface RenderedElement {
  type: string;
  props: Record<string, unknown>;
}

function flattenTree(root: { children: ReadonlyArray<unknown> }): RenderedElement[] {
  const out: RenderedElement[] = [];
  walk(root);
  return out;

  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    const n = node as { type?: unknown; props?: Record<string, unknown>; children?: ReadonlyArray<unknown> };
    if (typeof n.type === 'string' && n.props) {
      out.push({ type: n.type, props: n.props });
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c);
    }
  }
}

/**
 * Whether a rendered element is "interactive" — a Pressable or any
 * synonym carrying an `onPress` handler. RTL's mock RN host exposes
 * Pressable as host string `'Pressable'`.
 */
function isInteractive(el: RenderedElement): boolean {
  return el.type === 'Pressable' && typeof el.props.onPress === 'function';
}

/**
 * Whether the element has SOME label affordance — accessibilityLabel
 * directly OR via children's Text content. RTL's mock RN flattens
 * Text children into the props.children chain; we accept either.
 */
function hasLabelAffordance(el: RenderedElement): boolean {
  const aLabel = el.props.accessibilityLabel;
  if (typeof aLabel === 'string' && aLabel.length > 0) return true;
  // Fall back to checking visible Text children. The RTL host tree
  // has `children` as a deeply-nested structure; we check shallowly
  // for any string content.
  return hasVisibleTextDescendant(el.props.children);
}

function hasVisibleTextDescendant(children: unknown): boolean {
  if (children == null) return false;
  if (typeof children === 'string') return children.length > 0;
  if (Array.isArray(children)) {
    return children.some((c) => hasVisibleTextDescendant(c));
  }
  if (typeof children === 'object') {
    const c = children as { props?: Record<string, unknown> };
    if (c.props) return hasVisibleTextDescendant(c.props.children);
  }
  return false;
}

/**
 * Read the resolved minHeight from a Pressable's style. Style can be
 * a function (the `({pressed}) => [...]` form) or a flat object —
 * normalise both shapes. Returns `null` when no minHeight is declared.
 */
function readMinHeight(style: unknown, isPressed = false): number | null {
  if (style === null || style === undefined) return null;
  let resolved: unknown = style;
  if (typeof resolved === 'function') {
    resolved = (resolved as (state: { pressed: boolean }) => unknown)({ pressed: isPressed });
  }
  if (Array.isArray(resolved)) {
    let max: number | null = null;
    for (const s of resolved) {
      const n = readMinHeight(s, isPressed);
      if (n !== null && (max === null || n > max)) max = n;
    }
    return max;
  }
  if (typeof resolved === 'object' && resolved !== null) {
    const mh = (resolved as { minHeight?: unknown }).minHeight;
    if (typeof mh === 'number') return mh;
  }
  return null;
}

// ─── Cross-screen invariants ──────────────────────────────────────────────

interface ScreenFixture {
  name: string;
  /** Render → returns the RTL renderer object exposing UNSAFE_root. */
  render: () => ReturnType<typeof render>;
  /**
   * Pressables with explicitly-shorter tap-target by design (paired
   * inline affordances). Their testID prefixes are listed here so the
   * tap-target invariant skips them. The shorter floor (36pt) is
   * still enforced.
   */
  inlineAffordancePrefixes?: ReadonlyArray<string>;
}

const SCREENS: ReadonlyArray<ScreenFixture> = [
  {
    name: 'NamespaceScreen (loaded)',
    render: () =>
      render(
        <NamespaceScreen
          did={DID}
          prior={PRIOR_OP}
          onAddNamespace={() => undefined}
          onSelectNamespace={() => undefined}
        />,
      ),
  },
  {
    name: 'NamespaceScreen (loading)',
    render: () => render(<NamespaceScreen did={DID} prior={null} />),
  },
  {
    name: 'OutboxScreen (failures)',
    render: () =>
      render(
        <OutboxScreen
          rows={[makeOutboxRow({ clientId: 'r1' })]}
          onRetry={() => undefined}
          onDismiss={() => undefined}
        />,
      ),
    // Retry + Dismiss are paired inline affordances inside a row card.
    inlineAffordancePrefixes: ['outbox-retry-', 'outbox-dismiss-'],
  },
  {
    name: 'OutboxScreen (empty)',
    render: () => render(<OutboxScreen rows={[]} />),
  },
  {
    name: 'ReviewerProfileScreen (loaded)',
    render: () =>
      render(<ReviewerProfileScreen profile={makeReviewerProfile()} nowMs={NOW} />),
  },
  {
    name: 'ReviewerProfileScreen (error)',
    render: () =>
      render(
        <ReviewerProfileScreen
          profile={null}
          error="Network unreachable"
          onRetry={() => undefined}
        />,
      ),
  },
  {
    name: 'SearchScreen (results)',
    render: () =>
      render(
        <SearchScreen
          results={[makeSearchResult('s1'), makeSearchResult('s2')]}
          facets={SOME_FACETS}
          onSelectSubject={() => undefined}
          onTapFacet={() => undefined}
          onShowMoreFacets={() => undefined}
        />,
      ),
    // Facet chips are inline affordances inside a horizontal chip-row,
    // not standalone CTAs — they earn the 36pt floor (same reasoning
    // as the outbox row buttons).
    inlineAffordancePrefixes: ['facet-chip-'],
  },
  {
    name: 'SearchScreen (empty)',
    render: () =>
      render(
        <SearchScreen
          results={[]}
          facets={{ primary: [], overflow: [] }}
          q="aeron"
        />,
      ),
  },
  {
    name: 'TrustFeedScreen (feed)',
    render: () =>
      render(
        <TrustFeedScreen
          feed={[makeFeedItem('f1'), makeFeedItem('f2')]}
          facets={SOME_FACETS}
          q="aeron"
          onQChange={() => undefined}
          onSubmitSearch={() => undefined}
          onSelectSubject={() => undefined}
          onTapFacet={() => undefined}
        />,
      ),
    inlineAffordancePrefixes: ['facet-chip-'],
  },
  {
    name: 'TrustFeedScreen (empty with query)',
    render: () =>
      render(
        <TrustFeedScreen
          feed={[]}
          facets={{ primary: [], overflow: [] }}
          q="aeron"
          onSubmitSearch={() => undefined}
        />,
      ),
  },
  {
    name: 'SubjectDetailScreen (loaded)',
    render: () =>
      render(
        <SubjectDetailScreen
          subjectId="sub-1"
          data={{
            title: 'Aeron chair',
            category: 'office_furniture/chair',
            subjectTrustScore: 0.82,
            reviewCount: 5,
            reviews: [
              {
                ring: 'contact',
                reviewerTrustScore: 0.85,
                reviewerName: 'Sancho',
                headline: 'Worth every penny',
                createdAtMs: 1_700_000_000_000,
              },
            ],
          } satisfies SubjectDetailInput}
          onWriteReview={() => undefined}
          onSelectReviewer={() => undefined}
        />,
      ),
  },
  {
    name: 'WriteScreen (compose)',
    render: () =>
      render(
        <WriteScreen
          subjectTitle="Aeron chair"
          onPublish={() => undefined}
          onCancel={() => undefined}
        />,
      ),
  },
  {
    name: 'WriteScreen (edit + cosig warning)',
    render: () =>
      render(
        <WriteScreen
          subjectTitle="Aeron chair"
          editing={{ originalUri: 'at://x/y/1', cosigCount: 2 }}
          onPublish={() => undefined}
          onCancel={() => undefined}
        />,
      ),
  },
];

describe('a11y — VoiceOver labels (every interactive element has one)', () => {
  for (const fixture of SCREENS) {
    it(`${fixture.name}: every Pressable has a label or visible text`, () => {
      const r = fixture.render();
      const elements = flattenTree(r.UNSAFE_root as unknown as { children: ReadonlyArray<unknown> });
      const interactives = elements.filter(isInteractive);
      // Some screens render zero interactives (loading, empty); that's
      // fine — the invariant is "of the ones that render, all have labels".
      for (const el of interactives) {
        expect(hasLabelAffordance(el)).toBe(true);
      }
    });
  }
});

describe('a11y — accessibilityRole (every interactive element declares one)', () => {
  for (const fixture of SCREENS) {
    it(`${fixture.name}: every Pressable declares accessibilityRole`, () => {
      const r = fixture.render();
      const elements = flattenTree(r.UNSAFE_root as unknown as { children: ReadonlyArray<unknown> });
      const interactives = elements.filter(isInteractive);
      for (const el of interactives) {
        expect(typeof el.props.accessibilityRole).toBe('string');
        expect((el.props.accessibilityRole as string).length).toBeGreaterThan(0);
      }
    });
  }
});

describe('a11y — tap-target sizes (44pt floor for primary CTAs)', () => {
  for (const fixture of SCREENS) {
    it(`${fixture.name}: primary CTAs respect 44pt floor`, () => {
      const r = fixture.render();
      const elements = flattenTree(r.UNSAFE_root as unknown as { children: ReadonlyArray<unknown> });
      const interactives = elements.filter(isInteractive);
      const inlinePrefixes = fixture.inlineAffordancePrefixes ?? [];
      for (const el of interactives) {
        const testID = String(el.props.testID ?? '');
        const isInline = inlinePrefixes.some((p) => testID.startsWith(p));
        const minH = readMinHeight(el.props.style);
        if (isInline) {
          // Inline affordances: 36pt floor, documented in the screen's
          // stylesheet. They're paired inside a parent row whose tap
          // target dominates.
          if (minH !== null) expect(minH).toBeGreaterThanOrEqual(36);
        } else {
          // Primary CTAs: 44pt floor (iOS HIG).
          // Note: not every Pressable is a CTA — list rows are also
          // pressables but their parent container provides the tap
          // target. We require the floor only when minHeight IS
          // declared; rows that don't declare it pass-through. This
          // is honest scope: assert what's asserted, don't fabricate
          // a contract row-renderers don't claim to meet.
          if (minH !== null) expect(minH).toBeGreaterThanOrEqual(PRIMARY_CTA_MIN_HEIGHT);
        }
      }
    });
  }
});

describe('a11y — disabled-state announcement (CTAs surface disabled state)', () => {
  it('NamespaceScreen Add CTA exposes disabled in accessibilityState when prior is null', () => {
    const { getByTestId } = render(<NamespaceScreen did={DID} prior={null} />);
    const cta = getByTestId('namespace-add-cta');
    expect(cta.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('NamespaceScreen Add CTA exposes busy state when isAdding=true', () => {
    const { getByTestId } = render(
      <NamespaceScreen did={DID} prior={PRIOR_OP} isAdding />,
    );
    const cta = getByTestId('namespace-add-cta');
    expect(cta.props.accessibilityState).toMatchObject({ busy: true });
  });
});
