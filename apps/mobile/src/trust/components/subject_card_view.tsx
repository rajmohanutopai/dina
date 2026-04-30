/**
 * Visual subject card (TN-MOB-016 + TN-MOB-011 / Plan §8.3).
 *
 * Renders a single `SubjectCardDisplay` (the pure data projection
 * from `src/trust/subject_card.ts`) into the search-result card
 * layout described in plan §8.3:
 *
 *   ┌──────────────────────────────────────────┐
 *   │  Aeron chair · Office furniture          │   ← title + subtitle
 *   │  82  HIGH                14 reviews      │   ← score + count
 *   │  ★ 2 friends · 12 strangers              │   ← friends pill
 *   │  "Worth every penny"                     │   ← top reviewer
 *   │  — Sancho · contact · trust HIGH         │
 *   └──────────────────────────────────────────┘
 *
 * Both the search results screen (TN-MOB-016) and the trust feed
 * landing screen (TN-MOB-011) render lists of these cards. Shared
 * component → consistent visual treatment + one accessibility
 * surface to maintain.
 *
 * **Why a separate component file** rather than inline in each screen:
 *   - Same card on three surfaces (search, feed, "More like this"
 *     suggestions on the subject detail screen). Inlining would
 *     drift visually.
 *   - The screen tests can mock subject-card props without dragging
 *     in the full `SubjectCardDisplay` derivation logic.
 *   - The component owns its OWN a11y contract — every consumer gets
 *     the same VoiceOver experience.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

import { colors, fonts, spacing, radius } from '../../theme';
import { BAND_COLOUR, BAND_LABEL } from '../band_theme';
import type { SubjectCardDisplay } from '../subject_card';

export interface SubjectCardViewProps {
  /** Stable identifier used by callers for navigation + testID. */
  subjectId: string;
  /** The pre-computed display projection. Card is purely a renderer. */
  display: SubjectCardDisplay;
  /** Tap handler — receives the subjectId so caller can route. */
  onPress?: (subjectId: string) => void;
}

export function SubjectCardView(props: SubjectCardViewProps): React.ReactElement {
  const { subjectId, display, onPress } = props;
  const accessibilityLabel = buildA11yLabel(display);

  return (
    <Pressable
      onPress={onPress ? () => onPress(subjectId) : undefined}
      style={({ pressed }) => [styles.card, pressed && onPress && styles.cardPressed]}
      testID={`subject-card-${subjectId}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {/* Title + subtitle */}
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {display.title}
        </Text>
        {display.subtitle && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {display.subtitle}
          </Text>
        )}
      </View>

      {/* Score badge + review count */}
      <View style={styles.scoreRow}>
        <View
          style={[styles.scoreBadge, { backgroundColor: BAND_COLOUR[display.score.band] }]}
          testID={`subject-card-band-${subjectId}`}
        >
          <Text style={styles.scoreText}>
            {display.showNumericScore ? display.score.label : BAND_LABEL[display.score.band]}
          </Text>
        </View>
        <Text style={styles.reviewCount}>
          {display.reviewCount} {display.reviewCount === 1 ? 'review' : 'reviews'}
        </Text>
      </View>

      {/* Friends pill — only when at least one contact reviewed */}
      {display.friendsPill && (
        <View style={styles.friendsPill} testID={`subject-card-friends-${subjectId}`}>
          <Ionicons name="star" size={12} color={colors.warning} />
          <Text style={styles.friendsText}>
            {display.friendsPill.friendsCount}{' '}
            {display.friendsPill.friendsCount === 1 ? 'friend' : 'friends'}
            {display.friendsPill.strangersCount > 0 ? (
              <Text style={styles.strangersText}>
                {' · '}
                {display.friendsPill.strangersCount}{' '}
                {display.friendsPill.strangersCount === 1 ? 'stranger' : 'strangers'}
              </Text>
            ) : null}
          </Text>
        </View>
      )}

      {/* Top reviewer headline + attribution */}
      {display.topReviewer && (
        <View style={styles.topReviewer} testID={`subject-card-reviewer-${subjectId}`}>
          <Text style={styles.headline} numberOfLines={2}>
            “{display.topReviewer.headline}”
          </Text>
          <Text style={styles.attribution} numberOfLines={1}>
            — {display.topReviewer.reviewerName} · {display.topReviewer.ring} · trust{' '}
            {BAND_LABEL[display.topReviewer.band]}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * Compose the VoiceOver label for the whole card. Includes the
 * critical pieces a screen-reader user needs to decide whether to
 * tap: title, score band, review count, contact-network signal.
 *
 * Pure helper, exported for tests.
 */
export function buildA11yLabel(display: SubjectCardDisplay): string {
  const parts: string[] = [display.title];
  if (display.subtitle) parts.push(display.subtitle);
  parts.push(`trust ${BAND_LABEL[display.score.band]}`);
  parts.push(
    `${display.reviewCount} ${display.reviewCount === 1 ? 'review' : 'reviews'}`,
  );
  if (display.friendsPill) {
    parts.push(
      `${display.friendsPill.friendsCount} ${
        display.friendsPill.friendsCount === 1 ? 'friend' : 'friends'
      }`,
    );
  }
  return parts.join(', ');
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  cardPressed: { backgroundColor: colors.bgTertiary },
  header: { gap: spacing.xs },
  title: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  scoreBadge: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 48,
    alignItems: 'center',
  },
  scoreText: {
    fontFamily: fonts.headingBold,
    fontSize: 13,
    color: colors.bgSecondary,
  },
  reviewCount: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
  },
  friendsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  friendsText: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  strangersText: {
    fontFamily: fonts.sans,
    color: colors.textMuted,
  },
  topReviewer: { gap: spacing.xs, marginTop: spacing.xs },
  headline: {
    fontFamily: fonts.serif,
    fontSize: 13,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  attribution: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
  },
});
