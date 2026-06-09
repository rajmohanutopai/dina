/**
 * PeerLens — the Network home (launchpad).
 *
 * The Network tab's home is a quiet set of entry points, not a feed. Three
 * groups:
 *   - Services — Find a service (→ Chat, the real discovery path) and Publish a
 *     service / My services (→ /my-listings). Rendered by `NetworkServicesCard`.
 *   - Reviews — Browse reviews (→ /peerlens/browse, the network feed + search).
 *   - Your review activity (→ your reviewer profile, with the review count).
 *
 * The feed + search that used to live here moved to `browse.tsx`; the publishing
 * controls (Pending reviews / Publish as / Review preferences) moved onto the
 * self-profile ("Your reviews"). All destinations are existing routes — this
 * screen is a pure presentational menu over them.
 *
 * Presentational with default-prop seams: tests inject the handlers + the review
 * count; production lands on the default export and the `useAuthoredAttestations`
 * runner fills the count + `router.push` wires the rows.
 *
 * The first-run orientation modal mounts as an overlay (prop-driven visibility),
 * unchanged from the prior home.
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';

import { NetworkServicesCard } from '../../src/components/network_services_card';
import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { FirstRunModalView } from '../../src/peerlens/components/first_run_modal_view';
import { useAuthoredAttestations } from '../../src/peerlens/runners/use_authored_attestations';
import { colors, spacing, radius, textStyles } from '../../src/theme';

export interface NetworkHomeProps {
  /** Count shown under "Your review activity". Defaults to the authored runner. */
  reviewsWritten?: number;
  /** Provider-aware Services card copy. Defaults from the booted node role. */
  isProvider?: boolean;
  /** First-run orientation modal visibility (prop-driven). */
  firstRunVisible?: boolean;
  onDismissFirstRun?: () => void;
  /** Row handlers — production defaults route to the existing screens. */
  onFindService?: () => void;
  onPublishOrManage?: () => void;
  onBrowseReviews?: () => void;
  onOpenActivity?: () => void;
}

export default function TrustFeedScreen(props: NetworkHomeProps = {}): React.ReactElement {
  const router = useRouter();
  const viewerDid = getBootedNode()?.did ?? '';
  const bootedRole = getBootedNode()?.role;
  const isReviewsControlled = props.reviewsWritten !== undefined;
  const [nonce, setNonce] = React.useState(0);
  const authored = useAuthoredAttestations({
    authorDid: viewerDid,
    enabled: !isReviewsControlled && viewerDid !== '',
    retryNonce: nonce,
  });
  // Refresh the count on focus so a just-published review is reflected.
  useFocusEffect(
    React.useCallback(() => {
      if (isReviewsControlled || viewerDid === '') return;
      setNonce((n) => n + 1);
    }, [isReviewsControlled, viewerDid]),
  );

  const {
    reviewsWritten = authored.rows.length,
    isProvider = bootedRole === 'provider' || bootedRole === 'both',
    firstRunVisible = false,
    onDismissFirstRun,
    onFindService = () => router.push('/'),
    onPublishOrManage = () => router.push('/my-listings'),
    onBrowseReviews = () => router.push('/peerlens/browse'),
    onOpenActivity = () => {
      if (viewerDid === '' || !viewerDid.startsWith('did:')) return;
      router.push({ pathname: '/peerlens/reviewer/[did]', params: { did: viewerDid } });
    },
  } = props;

  const activitySubtitle =
    reviewsWritten > 0
      ? `${reviewsWritten} review${reviewsWritten === 1 ? '' : 's'} written`
      : 'Reviews you’ve written';

  return (
    <View style={styles.container} testID="trust-feed-screen">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* ─── Services ───────────────────────────────────────────────── */}
        <NetworkServicesCard
          isProvider={isProvider}
          onFindService={onFindService}
          onPublishOrManage={onPublishOrManage}
        />

        {/* ─── Reviews ────────────────────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Reviews</Text>
          <LaunchRow
            testID="network-row-browse"
            title="Browse reviews"
            subtitle="Search reviews from other Dinas"
            onPress={onBrowseReviews}
          />
        </View>

        {/* ─── Your review activity ───────────────────────────────────── */}
        <LaunchRow
          testID="network-row-activity"
          title="Your review activity"
          subtitle={activitySubtitle}
          onPress={onOpenActivity}
        />
      </ScrollView>

      {/* First-run orientation modal — a SIBLING of the scroll view (not a
          child of its content) so its `position:absolute` backdrop covers the
          full Network viewport and blocks interaction, rather than sizing to
          the scroll content container. */}
      <FirstRunModalView visible={firstRunVisible} onDismiss={onDismissFirstRun} />
    </View>
  );
}

/** A launchpad menu row: title + subtitle + chevron. */
function LaunchRow({
  title,
  subtitle,
  testID,
  onPress,
}: {
  title: string;
  subtitle: string;
  testID: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { flex: 1 },
  // NOTE: NetworkServicesCard supplies its OWN `marginHorizontal: spacing.lg`,
  // so the content keeps only VERTICAL padding and every other child carries the
  // same `marginHorizontal` — otherwise the services card would be inset twice
  // (narrower than the rows below it).
  content: { paddingVertical: spacing.lg, gap: spacing.lg },
  section: { gap: spacing.sm },
  sectionTitle: { ...textStyles.bodyStrong, marginHorizontal: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing.lg,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    minHeight: 56,
  },
  rowPressed: { backgroundColor: colors.bgTertiary },
  rowText: { flexShrink: 1, gap: 2 },
  rowTitle: { ...textStyles.body },
  rowSubtitle: { ...textStyles.bodySmall, color: colors.textSecondary },
});
