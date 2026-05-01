/**
 * Trust Network — landing screen (TN-MOB-011 / Plan §8.1).
 *
 * The Trust tab's home — a search bar across the top, a facet bar
 * for quick category filtering, and the network feed below (recent
 * attestations from the user's 1-hop reviewers, Plan §7's "feed.network"
 * surface).
 *
 * Replaces the placeholder that shipped before TN-MOB-001/002 finished.
 *
 * Render contract — same presentational pattern as the other trust
 * screens (TN-MOB-014/015/017): all data is injected via props, the
 * runner that subscribes to the xRPC + manages query state wraps this
 * component.
 *
 *   - `q` + `onQChange` + `onSubmitSearch` — search bar wiring.
 *   - `feed` (subject-card display rows from `feed.network`) +
 *     `facets` (derived from the same set) + state flags.
 *   - `onSelectSubject` drills into `app/trust/<subjectId>`.
 *   - `onTapFacet` re-queries with the active facet — same handler
 *     as the search results screen, sharing the `FacetBarView`.
 *
 * Three render states:
 *   1. **Empty feed** — viewer has no recent attestations from
 *      contacts. Encourages search.
 *   2. **Loading** — initial fetch in flight.
 *   3. **Feed** — facet bar + scrolling card list.
 *
 * The empty state is intentionally hopeful, not error-shaped — most
 * V1-cohort users will land here with no contacts having posted yet,
 * and the right copy is "search to find subjects" not "something went
 * wrong".
 *
 * **First-run modal integration** (Plan §13.5 / TN-MOB-022 / TN-MOB-027):
 * the orientation modal mounts unconditionally as a sibling of the
 * feed body — visibility is driven by the injected `firstRunVisible`
 * prop and dismissal delegates to `onDismissFirstRun`. The runner
 * subscribes to `isFirstRunModalDismissed` at mount, sets the prop on
 * load, and on dismissal fires `markFirstRunModalDismissed` before
 * flipping the prop back. The screen itself stays presentational —
 * keystore I/O remains in the runner.
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from 'react-native';

import { colors, fonts, spacing, radius } from '../../src/theme';
import { FacetBarView } from '../../src/trust/components/facet_bar_view';
import { FirstRunModalView } from '../../src/trust/components/first_run_modal_view';
import { SubjectCardView } from '../../src/trust/components/subject_card_view';
import { useNetworkFeed } from '../../src/trust/runners/use_network_feed';
import { useReviewerProfile } from '../../src/trust/runners/use_reviewer_profile';
import { deriveReviewerProfileDisplay } from '../../src/trust/reviewer_profile_data';
import { getBootedNode } from '../../src/hooks/useNodeBootstrap';

import type { FacetBar } from '../../src/trust/facets';
// Re-export FeedItem from the runner module so existing test imports
// (`import type { FeedItem } from '<screen>'`) keep working without
// pulling on the screen's React tree.
export type { FeedItem } from '../../src/trust/runners/use_network_feed';
import type { FeedItem } from '../../src/trust/runners/use_network_feed';

/**
 * Module-level constants used as default-prop sentinels. Defining them
 * outside the component avoids re-allocating on every render — that
 * keeps `feed`/`facets` reference-stable so memoised children and
 * effect deps don't see a fresh array each render.
 */
const EMPTY_FEED: readonly FeedItem[] = [];
const EMPTY_FACETS: FacetBar = { primary: [], overflow: [] };

export interface TrustFeedScreenProps {
  /** Current text in the search box. */
  q?: string;
  /** Fired on every text change so the runner can debounce. */
  onQChange?: (next: string) => void;
  /** Fired when the user submits the search (return key or magnifier tap). */
  onSubmitSearch?: (q: string) => void;
  /**
   * The network-feed cards for this viewer. Defaults to `[]` so the
   * screen can be rendered as an Expo Router default export with no
   * runner — the empty state ("Your network is quiet") fires.
   */
  feed?: readonly FeedItem[];
  /** Derived facets from the feed set. Defaults to an empty bar. */
  facets?: FacetBar;
  /** Currently-active facet (drives chip selected state). */
  activeFacet?: string | null;
  /** Whether the runner is mid-fetch. */
  isLoading?: boolean;
  /** Tap handler for a feed card. */
  onSelectSubject?: (subjectId: string) => void;
  /** Tap handler for a facet chip. `null` for "All". */
  onTapFacet?: (value: string | null) => void;
  /** Tap handler for the overflow "More" chip. */
  onShowMoreFacets?: () => void;
  /**
   * First-run orientation modal visibility. When true the screen
   * overlays `FirstRunModalView` on top of the feed body. Default
   * `false` so a screen mounted without explicit wiring (tests, mock
   * runners) does NOT show the modal.
   */
  firstRunVisible?: boolean;
  /**
   * Fired when the user taps the modal's dismiss CTA. Runner persists
   * via `markFirstRunModalDismissed` then flips `firstRunVisible`
   * back to false. Optional — when omitted the modal renders with no
   * effective dismiss action (the modal's own renderer no-ops on
   * undefined onDismiss).
   */
  onDismissFirstRun?: () => void;
  /**
   * Pre-derived self-profile bundle for the "My trust profile" card
   * at the top of the screen. When omitted, the screen runs its own
   * `useReviewerProfile` against the booted DID. Tests pass an
   * explicit value (or `null` for the unbooted state) to keep the
   * screen presentational.
   */
  selfDisplay?: SelfProfileCardData | null;
  /**
   * Fired when the user taps the self-profile card. Default
   * implementation pushes `/trust/reviewer/<myDid>`.
   */
  onOpenMyProfile?: () => void;
}

/**
 * Data the self-profile card displays.
 *
 * Reddit-style framing: neutral counts only. We deliberately omit
 * the trust band ("VERY LOW" / "HIGH" / colour-coded badge) for the
 * SELF surface — a fresh account naturally lands in the lowest
 * band, and surfacing that as a red verdict on the user's own
 * landing screen reads as a personal judgment rather than
 * information. The full band display + score lives one tap away on
 * the reviewer profile screen, where it's a tool rather than a
 * verdict.
 */
export interface SelfProfileCardData {
  readonly handle: string | null;
  /**
   * Numeric trust score on `[0, 100]`, or `null` when unrated
   * (fewer than the cold-start threshold of attestations). Rendered
   * as "—" when null. NOT colour-coded — see component header.
   */
  readonly scoreDisplay: number | null;
  readonly reviewsWritten: number;
  readonly vouchCount: number;
  readonly endorsementCount: number;
}

export default function TrustFeedScreen(
  props: TrustFeedScreenProps,
): React.ReactElement {
  // `useRouter` is consulted as a navigation fallback when the caller
  // didn't supply explicit `onSubmitSearch` / `onSelectSubject` props.
  // Tests pass the callbacks directly (controlled mode); production —
  // where Expo Router renders the default export with no props — gets
  // sensible drill-down navigation via `router.push`.
  const router = useRouter();
  // When no parent runner supplies `q`/`onQChange`, the screen owns the
  // search input state so typed characters echo (the production landing
  // route mounts the default export with no props — without this local
  // state the TextInput's value would always be ''). Tests that pass
  // controlled props bypass this entirely.
  const isSearchControlled = props.q !== undefined || props.onQChange !== undefined;
  const [localQ, setLocalQ] = React.useState('');
  // Auto-runner: fetch the user's 1-hop network feed when no caller
  // supplies controlled feed state. Tests that pass `feed` / `isLoading`
  // explicitly stay presentational; production lands here with no props
  // and the runner kicks in. Empty 1-hop network → empty `feed` →
  // existing "Your network is quiet" UX still fires.
  const isFeedControlled =
    props.feed !== undefined || props.isLoading !== undefined;
  const viewerDid = getBootedNode()?.did ?? '';
  const [feedNonce, setFeedNonce] = React.useState(0);
  const auto = useNetworkFeed({
    viewerDid,
    enabled: !isFeedControlled && viewerDid !== '',
    retryNonce: feedNonce,
  });
  // Self-profile fetch — fuels the "your trust profile" card at the
  // top of the screen. Same xRPC call the reviewer-profile screen
  // uses, just pointed at the viewer's own DID. Disabled when
  // controlled (tests inject their own header) or pre-boot.
  const isSelfControlled = props.selfDisplay !== undefined;
  const self = useReviewerProfile({
    did: viewerDid,
    enabled: !isSelfControlled && viewerDid !== '',
    retryNonce: feedNonce,
  });
  // Refetch on focus so a freshly-published attestation by a contact
  // shows up the next time the user lands here — same pattern as the
  // other trust runners (search / subject detail / reviewer profile).
  useFocusEffect(
    React.useCallback(() => {
      if (isFeedControlled || viewerDid === '') return;
      setFeedNonce((n) => n + 1);
    }, [isFeedControlled, viewerDid]),
  );
  // Project the runner's `TrustProfile` into the card's display shape.
  // The full `deriveReviewerProfileDisplay` result has lots of fields
  // the card doesn't need (per-sentiment counts, helpful ratio, etc.);
  // we project to the minimal `SelfProfileCardData` shape so the
  // controlled-prop path and the auto-runner path produce the same
  // type. `null` means "no card" — pre-boot or unknown profile.
  const autoSelfDisplay: SelfProfileCardData | null = React.useMemo(() => {
    if (self.profile === null) return null;
    const d = deriveReviewerProfileDisplay(self.profile);
    return {
      handle: d.handle,
      // Surface the numeric score only when the cold-start threshold
      // is met (`hasNumericScore`); otherwise render as `null` →
      // em-dash. Doesn't colour-code or label-shame either way.
      scoreDisplay: d.hasNumericScore ? d.scoreDisplay : null,
      reviewsWritten: d.reviewsWritten,
      vouchCount: d.vouchCount,
      endorsementCount: d.endorsementCount,
    };
  }, [self.profile]);
  const {
    q = isSearchControlled ? '' : localQ,
    onQChange = isSearchControlled ? undefined : setLocalQ,
    onSubmitSearch = (next: string) => {
      const trimmed = next.trim();
      if (trimmed.length === 0) return;
      router.push({ pathname: '/trust/search', params: { q: trimmed } });
    },
    feed = auto.feed.length > 0 ? auto.feed : EMPTY_FEED,
    isLoading = auto.isLoading,
    facets = EMPTY_FACETS,
    activeFacet = null,
    onSelectSubject = (subjectId: string) => {
      router.push({ pathname: '/trust/[subjectId]', params: { subjectId } });
    },
    onTapFacet,
    onShowMoreFacets,
    firstRunVisible = false,
    onDismissFirstRun,
    selfDisplay = autoSelfDisplay,
    onOpenMyProfile = () => {
      if (viewerDid === '' || !viewerDid.startsWith('did:')) return;
      router.push({
        pathname: '/trust/reviewer/[did]',
        params: { did: viewerDid },
      });
    },
  } = props;

  return (
    <View style={styles.container} testID="trust-feed-screen">
      {/* ─── Self-profile card ───────────────────────────────────────
          Tappable card at the top of the trust tab showing the
          viewer's own neutral counts (Reddit-style: "90 Karma · 33
          Contributions" framing). Deliberately NO band badge or
          colour-coded score — a fresh account naturally falls in
          the lowest band and a red "VERY LOW" pill on the user's
          own landing screen reads as a personal verdict, not
          information. Tap drills into the full reviewer profile
          where the band display lives behind another tap. */}
      {selfDisplay !== null && selfDisplay !== undefined ? (
        <Pressable
          onPress={onOpenMyProfile}
          style={({ pressed }) => [
            styles.selfCard,
            pressed && styles.selfCardPressed,
          ]}
          testID="trust-feed-self-card"
          accessibilityRole="button"
          accessibilityLabel={
            `Your trust profile — ${selfDisplay.reviewsWritten} reviews written, ` +
            `${selfDisplay.vouchCount} vouches, ${selfDisplay.endorsementCount} endorsements`
          }
        >
          <View style={styles.selfCardHeader}>
            <Text style={styles.selfCardHeading}>
              {selfDisplay.handle ?? 'Your trust profile'}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={colors.textMuted}
            />
          </View>
          <View style={styles.selfCardStats} testID="trust-feed-self-stats">
            <SelfStat
              value={selfDisplay.scoreDisplay !== null ? String(selfDisplay.scoreDisplay) : '—'}
              label="Trust score"
              testKey="score"
            />
            <SelfStat
              value={String(selfDisplay.reviewsWritten)}
              label={selfDisplay.reviewsWritten === 1 ? 'Review' : 'Reviews'}
              testKey="reviews"
            />
            <SelfStat
              value={String(selfDisplay.vouchCount)}
              label={selfDisplay.vouchCount === 1 ? 'Vouch' : 'Vouches'}
              testKey="vouches"
            />
            <SelfStat
              value={String(selfDisplay.endorsementCount)}
              label={selfDisplay.endorsementCount === 1 ? 'Endorsement' : 'Endorsements'}
              testKey="endorsements"
            />
          </View>
        </Pressable>
      ) : null}

      {/* ─── Search bar ─────────────────────────────────────────────── */}
      <View style={styles.searchBarContainer}>
        <View style={styles.searchBar}>
          <Ionicons
            name="search-outline"
            size={18}
            color={colors.textMuted}
            style={styles.searchIcon}
          />
          <TextInput
            value={q}
            onChangeText={onQChange}
            onSubmitEditing={
              onSubmitSearch ? (e) => onSubmitSearch(e.nativeEvent.text) : undefined
            }
            placeholder="Search subjects, reviewers, places…"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            testID="trust-search-input"
            accessibilityLabel="Search the trust network"
          />
          {q.length > 0 ? (
            <Pressable
              onPress={() => onQChange?.('')}
              style={({ pressed }) => [
                styles.searchClearBtn,
                pressed && styles.searchClearBtnPressed,
              ]}
              testID="trust-search-clear"
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* ─── Facet bar ──────────────────────────────────────────────── */}
      <FacetBarView
        facets={facets}
        activeValue={activeFacet}
        onTap={onTapFacet}
        onShowMore={onShowMoreFacets}
      />

      {/* ─── Body: loading / empty / feed ───────────────────────────── */}
      {isLoading && feed.length === 0 ? (
        <View style={styles.loading} testID="trust-feed-loading">
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading network feed…</Text>
        </View>
      ) : feed.length === 0 ? (
        <View style={styles.empty} testID="trust-feed-empty">
          <Ionicons name="people-outline" size={40} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Your network is quiet</Text>
          <Text style={styles.emptyBody}>
            Search above for what you want to review. If nothing matches, you can
            create the first review for it from there.
          </Text>
          {/*
            Why no unconditional "Write a review" CTA here: jumping
            straight to /trust/write?createKind=product lets a user
            mint a duplicate subject for something already in the
            network — they never see existing matches first. The
            search-first path is the only entry to writing: type
            above → "Search '<q>'" → if results, tap an existing
            subject and "Write a review" from its detail page; if no
            results, the search empty state offers "Review '<q>'"
            with the typed term pre-filled. Either way, the user has
            checked for an existing subject before writing.
          */}
          {onSubmitSearch && q.trim().length > 0 && (
            <Pressable
              onPress={() => onSubmitSearch(q.trim())}
              style={({ pressed }) => [
                styles.searchCta,
                pressed && styles.searchCtaPressed,
              ]}
              testID="trust-feed-search-cta"
              accessibilityRole="button"
              accessibilityLabel={`Search for ${q.trim()}`}
            >
              <Ionicons name="search" size={16} color={colors.bgSecondary} />
              <Text style={styles.searchCtaLabel}>Search “{q.trim()}”</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.feedContainer}
          testID="trust-feed-list"
        >
          {feed.map((item) => (
            <SubjectCardView
              key={item.subjectId}
              subjectId={item.subjectId}
              display={item.display}
              onPress={onSelectSubject}
            />
          ))}
        </ScrollView>
      )}

      {/* ─── First-run orientation modal (absolute overlay) ───────── */}
      <FirstRunModalView
        visible={firstRunVisible}
        onDismiss={onDismissFirstRun}
      />
    </View>
  );
}

/**
 * Reddit-style stat cell: large neutral number above a small label.
 * No colour, no badge — neutral counts only. The display chrome
 * lives in `styles.*` so all four cells render identically.
 */
function SelfStat(props: {
  value: string;
  label: string;
  testKey: string;
}): React.ReactElement {
  return (
    <View style={styles.selfStatCell} testID={`trust-feed-self-stat-${props.testKey}`}>
      <Text style={styles.selfStatValue}>{props.value}</Text>
      <Text style={styles.selfStatLabel}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  selfCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: 64,
    gap: spacing.sm,
  },
  selfCardPressed: { opacity: 0.7 },
  selfCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selfCardHeading: {
    flex: 1,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
  },
  // 2-column wrapped grid (Reddit-style). Four stats laid out as
  // a single row collapsed "Endorsements" to a second line on
  // narrow phones; the 2-column form gives each label ~half the
  // card width which fits the longest copy ("Endorsements") without
  // wrap. `gap` provides both row + column spacing in a single
  // declaration, so the second row aligns under the first.
  selfCardStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.sm,
    columnGap: spacing.md,
    paddingTop: spacing.xs,
  },
  selfStatCell: {
    // `(50% - half of column gap)` keeps two cells per row with the
    // gap respected; on the iOS RN runtime `flexBasis: '48%'` is the
    // robust equivalent (slightly conservative — RN's percentage
    // sizing is fussy with borders + paddingHorizontal).
    flexBasis: '47%',
    flexGrow: 1,
    alignItems: 'flex-start',
    gap: 2,
  },
  selfStatValue: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.textPrimary,
  },
  selfStatLabel: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
  },
  searchBarContainer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  searchIcon: { marginRight: spacing.sm },
  searchInput: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: spacing.sm,
  },
  searchClearBtn: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    marginLeft: spacing.xs,
  },
  searchClearBtnPressed: {
    opacity: 0.5,
  },
  loading: {
    flex: 1,
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
  },
  loadingText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  empty: {
    flex: 1,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
  searchCta: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    gap: spacing.xs,
    minHeight: 44,
    marginTop: spacing.md,
  },
  searchCtaPressed: { backgroundColor: colors.accentHover },
  searchCtaLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.bgSecondary,
  },
  feedContainer: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
});
