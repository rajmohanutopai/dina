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

/**
 * Maturity-badge fallback used when the wire didn't include a
 * subject score (search results today). Single review = "New",
 * 2–5 = "Some", 6+ = "Established". The labels read as freshness
 * rather than trust per se — honest about what we can infer
 * without scoring, and still gives the user a glanceable signal
 * on every card. When AppView starts shipping subject scores in
 * the search response, the band branch wins and this fallback
 * stays out of the way.
 */
// Maturity labels use title case ("Some", "Established") rather than
// the ALL-CAPS used by canonical trust bands ("HIGH", "MODERATE",
// "LOW"). This visually separates "we don't have enough signal yet"
// from "we have a real trust verdict" — without the case difference,
// a search-result card showing "SOME" looks like a band tier (it
// isn't), and the same subject's detail page rendering "MODERATE"
// reads as an inconsistency to the user even though both are correct
// for their own surface.
function maturityLabel(reviewCount: number): string {
  if (reviewCount <= 0) return 'New';
  if (reviewCount === 1) return 'New';
  if (reviewCount <= 5) return 'Some';
  return 'Established';
}

function maturityStyleFor(reviewCount: number): {
  borderColor: string;
  backgroundColor: string;
} {
  // Three calm tints. Avoid traffic-light red/green so the badge
  // can't be misread as a trust verdict — that's what the proper
  // BAND_COLOUR is for once scoring is wired.
  if (reviewCount <= 1) {
    return { borderColor: '#D1D5DB', backgroundColor: '#F3F4F6' };
  }
  if (reviewCount <= 5) {
    return { borderColor: '#BFDBFE', backgroundColor: '#EFF6FF' };
  }
  return { borderColor: '#A7F3D0', backgroundColor: '#ECFDF5' };
}

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

      {/* TN-V2-P1 + RANK-011/012/013: context chips. Two visual
          tiers within the same row:

          1. Warning chips first (regionPill, recency) — surface
             actionability friction the viewer should weigh BEFORE
             the descriptors, since "you can't get this here" or
             "this is 5 years old" outweigh "the website is
             amazon.de" for decision-making.
          2. Descriptor chips (host, language, location, priceTier)
             — what / where / how much.

          The row hides entirely when ALL six chips are null so
          cards without any signal don't gain a blank gap. */}
      {(display.regionPill ||
        display.recency ||
        display.host ||
        display.language ||
        display.location ||
        display.priceTier) && (
        <View style={styles.contextChips} testID={`subject-card-context-${subjectId}`}>
          {display.regionPill && (
            <View
              style={[styles.contextChip, styles.warningChip]}
              testID={`subject-card-region-${subjectId}`}
            >
              <Text style={styles.contextChipText} numberOfLines={1}>
                {display.regionPill}
              </Text>
            </View>
          )}
          {display.recency && (
            <View
              style={[styles.contextChip, styles.warningChip]}
              testID={`subject-card-recency-${subjectId}`}
            >
              <Ionicons name="time-outline" size={11} color={colors.textMuted} />
              <Text style={styles.contextChipText} numberOfLines={1}>
                {display.recency}
              </Text>
            </View>
          )}
          {display.host && (
            <View style={styles.contextChip} testID={`subject-card-host-${subjectId}`}>
              <Ionicons name="globe-outline" size={11} color={colors.textMuted} />
              <Text style={styles.contextChipText} numberOfLines={1}>
                {display.host}
              </Text>
            </View>
          )}
          {display.language && (
            <View style={styles.contextChip} testID={`subject-card-language-${subjectId}`}>
              <Text style={styles.contextChipText} numberOfLines={1}>
                {display.language}
              </Text>
            </View>
          )}
          {display.location && (
            <View style={styles.contextChip} testID={`subject-card-location-${subjectId}`}>
              <Ionicons name="location-outline" size={11} color={colors.textMuted} />
              <Text style={styles.contextChipText} numberOfLines={1}>
                {display.location}
              </Text>
            </View>
          )}
          {display.priceTier && (
            <View style={styles.contextChip} testID={`subject-card-price-${subjectId}`}>
              <Text style={styles.contextChipText} numberOfLines={1}>
                {display.priceTier}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Score badge + review count.
          When AppView returned a subject-level score (network feed,
          future score-enriched search) we render the canonical band.
          Otherwise we fall back to a maturity badge derived from the
          review count alone — so every card has SOME glanceable
          trust signal. The fallback labels read as freshness
          ("New" / "Some" / "Established") rather than trust per se,
          which is honest about what we can infer without scoring. */}
      <View style={styles.scoreRow}>
        {display.score.band !== 'unrated' ? (
          <View
            style={[styles.scoreBadge, { backgroundColor: BAND_COLOUR[display.score.band] }]}
            testID={`subject-card-band-${subjectId}`}
          >
            <Text style={styles.scoreText}>
              {display.showNumericScore ? display.score.label : BAND_LABEL[display.score.band]}
            </Text>
          </View>
        ) : (
          <View
            style={[styles.maturityBadge, maturityStyleFor(display.reviewCount)]}
            testID={`subject-card-maturity-${subjectId}`}
          >
            <Text style={styles.maturityText}>
              {maturityLabel(display.reviewCount)}
            </Text>
          </View>
        )}
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
  // TN-V2-P1 + RANK-011/012/013: include all six context chips in
  // a11y so VoiceOver users hear the same actionability signal
  // sighted users see in the chip row. Order matches the chip-row
  // visual order — warnings (regionPill, recency) first since they
  // are the load-bearing decision signals, then descriptors (host,
  // language, location, priceTier). Without this, screen-reader
  // users tap a result thinking it's locally available and discover
  // otherwise on the detail page. The bare tier symbol "$$$" reads
  // as "dollar dollar dollar" which is correct — VoiceOver speaks
  // symbols verbatim. The "📍" emoji on regionPill is also spoken
  // verbatim ("location pin") — that's a deliberate cue.
  if (display.regionPill) parts.push(display.regionPill);
  if (display.recency) parts.push(display.recency);
  if (display.host) parts.push(display.host);
  if (display.language) parts.push(display.language);
  if (display.location) parts.push(display.location);
  if (display.priceTier) parts.push(display.priceTier);
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
  // TN-V2-P1 context chips — small muted pills under the subtitle.
  // Visual weight intentionally lower than the score badge so the
  // primary signal (trust band + count) still dominates the card.
  contextChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  contextChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
  },
  // TN-V2-RANK-011 + RANK-012 — warning variant for region pill +
  // recency badge. Hairline border on the same muted background so
  // it reads as "still a chip, but the kind that asks you to look
  // twice". Intentionally NOT a screaming red — the goal is gentle
  // friction, not alarm. Shares typography with descriptor chips.
  warningChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  contextChipText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textMuted,
    letterSpacing: 0.3,
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
  maturityBadge: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 48,
    alignItems: 'center',
    borderWidth: 1,
  },
  maturityText: {
    fontFamily: fonts.heading,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
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
