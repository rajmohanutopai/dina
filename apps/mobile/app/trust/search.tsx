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
import { SubjectCardView } from '../../src/trust/components/subject_card_view';
import { FacetBarView } from '../../src/trust/components/facet_bar_view';

import type { SubjectCardDisplay } from '../../src/trust/subject_card';
import type { FacetBar } from '../../src/trust/facets';

/** One result entry — `{subjectId, display}`. The wrapper derives display via `deriveSubjectCard`. */
export interface SearchResult {
  readonly subjectId: string;
  readonly display: SubjectCardDisplay;
}

export interface SearchScreenProps {
  /** The user's query — surfaced in the empty-state copy. */
  q?: string;
  /** Pre-computed search results, ready to render. */
  results: readonly SearchResult[];
  /** Pre-computed facet bar from the same result set. */
  facets: FacetBar;
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
  const {
    q,
    results,
    facets,
    activeFacet = null,
    isLoading = false,
    error = null,
    onSelectSubject,
    onTapFacet,
    onShowMoreFacets,
    onRetry,
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

  return (
    <View style={styles.container} testID="search-screen">
      <FacetBarView
        facets={facets}
        activeValue={activeFacet}
        onTap={onTapFacet}
        onShowMore={onShowMoreFacets}
      />

      {isLoading && results.length === 0 ? (
        <View style={styles.loading} testID="search-loading">
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Searching…</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.empty} testID="search-empty">
          <Ionicons name="search-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No results</Text>
          <Text style={styles.emptyBody}>
            {q && q.trim().length > 0
              ? `Nothing found for “${q.trim()}”. Try a different search or clear filters.`
              : 'Try a search above, or browse by category.'}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.resultsContainer}
          testID="search-results"
        >
          {results.map((r) => (
            <SubjectCardView
              key={r.subjectId}
              subjectId={r.subjectId}
              display={r.display}
              onPress={onSelectSubject}
            />
          ))}
          {/* Subtle in-flight indicator at the bottom for paginated loads */}
          {isLoading && results.length > 0 && (
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
