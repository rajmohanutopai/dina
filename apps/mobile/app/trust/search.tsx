/**
 * Trust Network — search results screen (TN-MOB-016 / Plan §8.3).
 *
 * Renders a list of `SubjectCardDisplay` results (from
 * `com.dina.trust.search`) with a horizontal facet bar above (from
 * `deriveFacets`). Tapping a card drills into the subject detail;
 * tapping a facet refines the query.
 *
 * The screen is presentational over the existing data layer:
 *   - `subject_card.ts:deriveSubjectCard` produces the card display.
 *   - `facets.ts:deriveFacets` produces the chip-row data.
 * The runner that calls the xRPC, manages pagination, and persists
 * the active facet wraps this component and feeds it props.
 *
 * Three states pinned by tests:
 *   1. **Loading** — `isLoading=true` AND `results.length===0`.
 *   2. **Empty** — `isLoading=false` AND `results.length===0`. "No
 *      results for <q>" copy if `q` provided, else generic empty.
 *   3. **Results** — facet bar + result cards.
 *
 * A separate **Error** state is rendered when `error` prop is set.
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';

import { colors, fonts, spacing, radius } from '../../src/theme';
import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import { SubjectCardView } from '../../src/trust/components/subject_card_view';
import { FacetBarView } from '../../src/trust/components/facet_bar_view';
import { ViewerFilterChipsView } from '../../src/trust/components/viewer_filter_chips_view';
import {
  applicableFilters,
  applyFilters,
  type ViewerFilterId,
} from '../../src/trust/preferences/viewer_filters';
import { useTrustSearch } from '../../src/trust/runners/use_trust_search';

import type { SubjectCardDisplay } from '../../src/trust/subject_card';
import type { FacetBar } from '../../src/trust/facets';

/** One result entry — `{subjectId, display}`. The wrapper derives display via `deriveSubjectCard`. */
export interface SearchResult {
  readonly subjectId: string;
  readonly display: SubjectCardDisplay;
}

/**
 * Module-level empty defaults. Hoisted out of the render so memoised
 * children + dep arrays don't see fresh references on every mount.
 */
const EMPTY_RESULTS: readonly SearchResult[] = [];
const EMPTY_FACETS: FacetBar = { primary: [], overflow: [] };

export interface SearchScreenProps {
  /** The user's query — surfaced in the empty-state copy. */
  q?: string;
  /** Pre-computed search results, ready to render. Defaults to `[]`. */
  results?: readonly SearchResult[];
  /** Pre-computed facet bar from the same result set. Defaults empty. */
  facets?: FacetBar;
  /** Currently-active facet value (drives the chip's selected state). */
  activeFacet?: string | null;
  /** Whether the runner is mid-flight on a fetch. */
  isLoading?: boolean;
  /** Loading-error string. `null` when no error. */
  error?: string | null;
  /** Tap handler for a result card. */
  onSelectSubject?: (subjectId: string) => void;
  /** Tap handler for a facet chip — `null` for the "All" reset chip. */
  onTapFacet?: (value: string | null) => void;
  /** Tap handler for the overflow "More" chip. */
  onShowMoreFacets?: () => void;
  /** Retry CTA in the error state. */
  onRetry?: () => void;
}

export default function SearchScreen(props: SearchScreenProps): React.ReactElement {
  // Hooks must be called unconditionally. `useLocalSearchParams`
  // surfaces the `?q=…` query that `TrustFeedScreen` passes via
  // `router.push`; `useRouter` is the navigation fallback for
  // subject-card taps when no `onSelectSubject` callback is wired.
  const params = useLocalSearchParams<{ q?: string | string[] }>();
  const paramQ = Array.isArray(params.q) ? params.q[0] : params.q;
  const router = useRouter();
  const q = props.q ?? paramQ ?? '';
  // Auto-runner: fire the AppView search round-trip when the caller
  // didn't provide any controlled state (tests always pass at least
  // one of `results`/`isLoading`/`error`, so they keep the screen pure).
  const isControlled =
    props.results !== undefined ||
    props.isLoading !== undefined ||
    props.error !== undefined;
  const [retryNonce, setRetryNonce] = React.useState(0);
  // Refetch when the screen regains focus — covers re-deep-linking with
  // the same query (Expo Router doesn't remount, so q-keyed effects
  // wouldn't otherwise refire) and any state change that happened while
  // the user was on another tab.
  useFocusEffect(
    React.useCallback(() => {
      if (isControlled) return;
      setRetryNonce((n) => n + 1);
    }, [isControlled]),
  );
  const auto = useTrustSearch({ q, enabled: !isControlled, retryNonce });
  const {
    results = auto.results,
    facets = EMPTY_FACETS,
    activeFacet = null,
    isLoading = auto.isLoading,
    error = auto.error,
    onSelectSubject = (subjectId: string) => {
      router.push({ pathname: '/trust/[subjectId]', params: { subjectId } });
    },
    onTapFacet,
    onShowMoreFacets,
    onRetry = () => setRetryNonce((n) => n + 1),
  } = props;

  if (error !== null) {
    return (
      <View style={styles.container} testID="search-error">
        <View style={styles.errorPanel}>
          <Ionicons name="alert-circle-outline" size={36} color={colors.error} />
          <Text style={styles.errorTitle}>Search failed</Text>
          <Text style={styles.errorBody}>{error}</Text>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              style={({ pressed }) => [styles.retryBtn, pressed && styles.retryBtnPressed]}
              testID="search-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              <Ionicons name="refresh" size={16} color={colors.bgSecondary} />
              <Text style={styles.retryLabel}>Retry</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  const trimmedQ = q && q.trim().length > 0 ? q.trim() : '';

  // ─── Viewer-profile filter chips (TN-V2-RANK-005 / RANK-016) ────────────
  // Off by default, opts in per session — `activeFilters` is a session-
  // local Set, NOT persisted. The user toggles a chip → re-render with
  // the chip's predicate applied to `results`. Cluster A's keystore-
  // resident profile is the source of truth; this chip-state is just
  // ephemeral UI.
  const { profile: viewerProfile } = useViewerPreferences();
  const filters = React.useMemo(() => applicableFilters(viewerProfile), [viewerProfile]);
  const [activeFilters, setActiveFilters] = React.useState<ReadonlySet<ViewerFilterId>>(
    () => new Set<ViewerFilterId>(),
  );
  const onToggleFilter = React.useCallback((id: ViewerFilterId) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const displayedResults = React.useMemo(
    () => applyFilters(results, viewerProfile, activeFilters),
    [results, viewerProfile, activeFilters],
  );

  return (
    <View style={styles.container} testID="search-screen">
      {trimmedQ.length > 0 && (
        <View style={styles.queryEcho} testID="search-query-echo">
          <Ionicons name="search" size={14} color={colors.textMuted} />
          <Text style={styles.queryEchoText} numberOfLines={1}>
            “{trimmedQ}”
          </Text>
        </View>
      )}
      <FacetBarView
        facets={facets}
        activeValue={activeFacet}
        onTap={onTapFacet}
        onShowMore={onShowMoreFacets}
      />
      <ViewerFilterChipsView
        filters={filters}
        active={activeFilters}
        onToggle={onToggleFilter}
      />

      {isLoading && displayedResults.length === 0 ? (
        <View style={styles.loading} testID="search-loading">
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Searching…</Text>
        </View>
      ) : displayedResults.length === 0 ? (
        <View style={styles.empty} testID="search-empty">
          <Ionicons name="search-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No results</Text>
          <Text style={styles.emptyBody}>
            {trimmedQ.length > 0
              ? `Nothing found for “${trimmedQ}”. Try a different search or write the first review.`
              : 'Try a search above, or browse by category.'}
          </Text>
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/trust/write',
                params: {
                  createKind: 'product',
                  ...(trimmedQ.length > 0 ? { initialName: trimmedQ } : {}),
                },
              })
            }
            style={({ pressed }) => [
              styles.writeCta,
              pressed && styles.writeCtaPressed,
            ]}
            testID="search-write-cta"
            accessibilityRole="button"
            accessibilityLabel={
              trimmedQ.length > 0 ? `Write the first review for ${trimmedQ}` : 'Write a review'
            }
          >
            <Ionicons name="create-outline" size={16} color={colors.bgSecondary} />
            <Text style={styles.writeCtaLabel}>
              {trimmedQ.length > 0 ? `Review “${trimmedQ}”` : 'Write a review'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.resultsContainer}
          testID="search-results"
        >
          {displayedResults.map((r) => (
            <SubjectCardView
              key={r.subjectId}
              subjectId={r.subjectId}
              display={r.display}
              onPress={onSelectSubject}
            />
          ))}
          {/* Subtle in-flight indicator at the bottom for paginated loads */}
          {isLoading && displayedResults.length > 0 && (
            <View style={styles.paginationLoading} testID="search-pagination-loading">
              <ActivityIndicator color={colors.textMuted} size="small" />
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  queryEcho: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    gap: spacing.xs,
  },
  queryEchoText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textSecondary,
    flexShrink: 1,
  },
  writeCta: {
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
  writeCtaPressed: { backgroundColor: colors.accentHover },
  writeCtaLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.bgSecondary,
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
  errorPanel: {
    flex: 1,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  errorTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
  errorBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  retryBtn: {
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
  retryBtnPressed: { backgroundColor: colors.accentHover },
  retryLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.bgSecondary,
  },
  resultsContainer: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  paginationLoading: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
});
