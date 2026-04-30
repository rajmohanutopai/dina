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

import type { FacetBar } from '../../src/trust/facets';
import type { SubjectCardDisplay } from '../../src/trust/subject_card';

/** One feed item — `{subjectId, display}`. */
export interface FeedItem {
  readonly subjectId: string;
  readonly display: SubjectCardDisplay;
}

export interface TrustFeedScreenProps {
  /** Current text in the search box. */
  q?: string;
  /** Fired on every text change so the runner can debounce. */
  onQChange?: (next: string) => void;
  /** Fired when the user submits the search (return key or magnifier tap). */
  onSubmitSearch?: (q: string) => void;
  /** The network-feed cards for this viewer. */
  feed: readonly FeedItem[];
  /** Derived facets from the feed set. */
  facets: FacetBar;
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
}

export default function TrustFeedScreen(
  props: TrustFeedScreenProps,
): React.ReactElement {
  const {
    q = '',
    onQChange,
    onSubmitSearch,
    feed,
    facets,
    activeFacet = null,
    isLoading = false,
    onSelectSubject,
    onTapFacet,
    onShowMoreFacets,
    firstRunVisible = false,
    onDismissFirstRun,
  } = props;

  return (
    <View style={styles.container} testID="trust-feed-screen">
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
            Search for subjects (products, places, content) above — you can review them
            even before your contacts do.
          </Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
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
