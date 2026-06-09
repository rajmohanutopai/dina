/**
 * PeerLens — Browse reviews (the network feed).
 *
 * Reached from the Network launchpad's "Browse reviews" row. Hosts what used to
 * live on the Network home: a search bar across the top, a facet bar, and the
 * 1-hop network feed below (recent attestations from the viewer's reviewers).
 * The Network home is now a launchpad menu (`index.tsx`); this screen owns the
 * feed/search surface so the home can stay a quiet set of entry points.
 *
 * Presentational over the data layer (same pattern as the other PeerLens
 * screens): all state is injectable via props; with none supplied the
 * `useNetworkFeed` runner fills the feed and a local query state drives the
 * search box. Submitting the search pushes to `/peerlens/search` (results
 * screen); tapping a feed card drills into the subject.
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

import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { FacetBarView } from '../../src/peerlens/components/facet_bar_view';
import { SubjectCardView } from '../../src/peerlens/components/subject_card_view';
import { useNetworkFeed } from '../../src/peerlens/runners/use_network_feed';
import { colors, spacing, radius, textStyles } from '../../src/theme';

import type { FacetBar } from '../../src/peerlens/facets';
// Re-export FeedItem so test imports (`import type { FeedItem } from '<screen>'`)
// resolve against the screen they render, as the old index screen did.
export type { FeedItem } from '../../src/peerlens/runners/use_network_feed';
import type { FeedItem } from '../../src/peerlens/runners/use_network_feed';

const EMPTY_FEED: readonly FeedItem[] = [];
const EMPTY_FACETS: FacetBar = { primary: [], overflow: [] };

export interface BrowseScreenProps {
  q?: string;
  onQChange?: (next: string) => void;
  onSubmitSearch?: (q: string) => void;
  feed?: readonly FeedItem[];
  isLoading?: boolean;
  facets?: FacetBar;
  activeFacet?: string | null;
  onSelectSubject?: (subjectId: string) => void;
  onTapFacet?: (value: string | null) => void;
  onShowMoreFacets?: () => void;
}

export default function BrowseScreen(props: BrowseScreenProps = {}): React.ReactElement {
  const router = useRouter();
  const isSearchControlled = props.q !== undefined || props.onQChange !== undefined;
  const [localQ, setLocalQ] = React.useState('');
  const isFeedControlled = props.feed !== undefined || props.isLoading !== undefined;
  const viewerDid = getBootedNode()?.did ?? '';
  const [feedNonce, setFeedNonce] = React.useState(0);
  const auto = useNetworkFeed({
    viewerDid,
    enabled: !isFeedControlled && viewerDid !== '',
    retryNonce: feedNonce,
  });
  useFocusEffect(
    React.useCallback(() => {
      if (isFeedControlled || viewerDid === '') return;
      setFeedNonce((n) => n + 1);
    }, [isFeedControlled, viewerDid]),
  );
  const {
    q = isSearchControlled ? '' : localQ,
    onQChange = isSearchControlled ? undefined : setLocalQ,
    onSubmitSearch = (next: string) => {
      const trimmed = next.trim();
      if (trimmed.length === 0) return;
      router.push({ pathname: '/peerlens/search', params: { q: trimmed } });
    },
    feed = auto.feed.length > 0 ? auto.feed : EMPTY_FEED,
    isLoading = auto.isLoading,
    facets = EMPTY_FACETS,
    activeFacet = null,
    onSelectSubject = (subjectId: string) => {
      router.push({ pathname: '/peerlens/[subjectId]', params: { subjectId } });
    },
    onTapFacet,
    onShowMoreFacets,
  } = props;

  return (
    <View style={styles.container} testID="browse-screen">
      <View style={styles.searchBarContainer}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={colors.textMuted} style={styles.searchIcon} />
          <TextInput
            value={q}
            onChangeText={onQChange}
            onSubmitEditing={onSubmitSearch ? (e) => onSubmitSearch(e.nativeEvent.text) : undefined}
            placeholder="Search reviews, reviewers, places…"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            testID="trust-search-input"
            accessibilityLabel="Search reviews"
          />
          {q.length > 0 ? (
            <Pressable
              onPress={() => onQChange?.('')}
              style={({ pressed }) => [styles.searchClearBtn, pressed && styles.searchClearBtnPressed]}
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

      <FacetBarView facets={facets} activeValue={activeFacet} onTap={onTapFacet} onShowMore={onShowMoreFacets} />

      {isLoading && feed.length === 0 ? (
        <View style={styles.loading} testID="trust-feed-loading">
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading network feed…</Text>
        </View>
      ) : feed.length === 0 ? (
        <View style={styles.empty} testID="trust-feed-empty">
          <Ionicons name="people-outline" size={40} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Your review network is quiet</Text>
          <Text style={styles.emptyBody}>
            Search above for what you want to review. If nothing matches, you can create the first
            review for it from there.
          </Text>
          {onSubmitSearch && q.trim().length > 0 && (
            <Pressable
              onPress={() => onSubmitSearch(q.trim())}
              style={({ pressed }) => [styles.searchCta, pressed && styles.searchCtaPressed]}
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
        <ScrollView contentContainerStyle={styles.feedContainer} testID="trust-feed-list">
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  searchBarContainer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  searchIcon: { marginRight: spacing.sm },
  searchInput: { ...textStyles.body, flex: 1, color: colors.textPrimary, paddingVertical: spacing.sm },
  searchClearBtn: { padding: spacing.xs },
  searchClearBtnPressed: { opacity: 0.6 },
  loading: { flex: 1, paddingVertical: spacing.xxl, alignItems: 'center', gap: spacing.md },
  loadingText: textStyles.bodySmall,
  empty: { flex: 1, paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { ...textStyles.h3, marginTop: spacing.md },
  emptyBody: { ...textStyles.bodySmall, color: colors.textSecondary, textAlign: 'center' },
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
  searchCtaLabel: { ...textStyles.body, color: colors.bgSecondary },
  feedContainer: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
});
