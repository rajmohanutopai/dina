/**
 * Network → Reviews module.
 *
 * The sibling of `NetworkServicesCard` on the Network tab. The two modules
 * are conceptual twins (a "consume" row + a "your own / publish" row), so
 * they share one grouped-card look: a header (icon + title + one-line
 * description) over two icon rows split by a hairline divider.
 *
 *   - "Browse reviews" — the network feed + search (→ /peerlens/browse).
 *   - "Your review activity" — your reviewer dashboard, with the live count
 *     of reviews you have written (→ your reviewer profile).
 *
 * Presentational by design — the count subtitle and both handlers are
 * injected so the Network screen owns the boot/router wiring (matching the
 * screen's prop-injection pattern). Row testIDs (`network-row-browse`,
 * `network-row-activity`) are preserved from the prior flat-row layout so
 * the render tests + Maestro flows keep working across the regroup.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

export interface NetworkReviewsCardProps {
  /** Subtitle for the activity row, e.g. "2 reviews written". */
  activitySubtitle: string;
  /** Tap "Browse reviews" — routes to the network feed + search. */
  onBrowse: () => void;
  /** Tap "Your review activity" — routes to your reviewer dashboard. */
  onOpenActivity: () => void;
  /** Tap "How Ranked Reviews work" — routes to the explainer page. */
  onHowItWorks: () => void;
}

export function NetworkReviewsCard({
  activitySubtitle,
  onBrowse,
  onOpenActivity,
  onHowItWorks,
}: NetworkReviewsCardProps): React.ReactElement {
  return (
    <View style={styles.card} testID="network-reviews-card">
      <View style={styles.header}>
        <Ionicons name="star-outline" size={18} color={colors.textPrimary} />
        <Text style={styles.heading} accessibilityRole="header">
          Reviews
        </Text>
      </View>
      <Text style={styles.subtitle}>
        Browse reviews from the network, or see the ones you have written.
      </Text>

      <ReviewRow
        testID="network-row-browse"
        icon="search-outline"
        label="Browse reviews"
        sublabel="Search reviews from other Dinas"
        onPress={onBrowse}
      />
      <View style={styles.rowDivider} />
      <ReviewRow
        testID="network-row-activity"
        icon="create-outline"
        label="Your review activity"
        sublabel={activitySubtitle}
        onPress={onOpenActivity}
      />
      <View style={styles.rowDivider} />
      {/* Quiet "learn more" row — single line, no sublabel — so it reads as
          secondary to the two action rows above. The first-impression home is
          where a newcomer meets the term, so this is where "what is this?"
          gets answered. */}
      <ReviewRow
        testID="network-row-howitworks"
        icon="information-circle-outline"
        label="How Ranked Reviews work"
        onPress={onHowItWorks}
      />
    </View>
  );
}

function ReviewRow({
  testID,
  icon,
  label,
  sublabel,
  onPress,
}: {
  testID: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** Optional second line. Omit for a compact, single-line "learn more" row. */
  sublabel?: string;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={sublabel ? `${label}. ${sublabel}` : label}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Ionicons name={icon} size={18} color={colors.textSecondary} style={styles.rowIcon} />
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {sublabel !== undefined && (
          <Text style={styles.rowSublabel} numberOfLines={1}>
            {sublabel}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  heading: textStyles.bodyStrong,
  subtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  rowPressed: { opacity: 0.6 },
  rowIcon: { width: 22, textAlign: 'center' },
  rowBody: { flex: 1 },
  rowLabel: textStyles.body,
  rowSublabel: {
    ...textStyles.tiny,
    color: colors.textMuted,
    marginTop: 1,
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 22 + spacing.sm,
  },
});
