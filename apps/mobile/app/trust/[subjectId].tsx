/**
 * Trust Network — subject detail screen (TN-MOB-012 / Plan §8.5).
 *
 * Drilled into from a search-result card or the trust-feed landing.
 * The screen renders:
 *
 *   1. Header card: title, subtitle, score badge (numeric or band),
 *      review count, ring-count summary line.
 *   2. Friends section: reviews from self + contacts (top section —
 *      most-trusted voices).
 *   3. Friends-of-friends section: reviews from 2-hop network.
 *   4. Strangers section: reviews from everyone else.
 *
 * Empty sections are hidden — a subject with reviews from contacts
 * but none from strangers shows just two sections, not three with
 * one empty. Drives the visual signal "this subject's reach into
 * your network is exactly what you see".
 *
 * Render contract — same presentational pattern as the other trust
 * screens (TN-MOB-011/014/015/016/017): the runner subscribes to
 * `com.dina.trust.subjectGet` + the per-attestation enrichment, and
 * passes the resulting `SubjectDetailInput` to this component.
 *
 * Three render states pinned by tests:
 *   1. **Loading** — `data === null` AND `error === null`.
 *   2. **Error** — `error !== null`. Soft error panel + Retry CTA.
 *   3. **Loaded** — header + grouped review sections.
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
import {
  deriveSubjectDetail,
  type SubjectDetailInput,
} from '../../src/trust/subject_detail_data';
import { BAND_COLOUR, BAND_LABEL } from '../../src/trust/band_theme';
import type { SubjectReview } from '../../src/trust/subject_card';
import { trustBandFor, type TrustBand } from '../../src/trust/score_helpers';

export interface SubjectDetailScreenProps {
  subjectId: string;
  /** Pre-fetched subject detail input. `null` while loading. */
  data: SubjectDetailInput | null;
  /** Loading-error string. `null` when there's no error. */
  error?: string | null;
  /** Fired when the user taps Retry on the error state. */
  onRetry?: () => void;
  /** Fired when the user taps a reviewer row — drills into reviewer profile. */
  onSelectReviewer?: (reviewerName: string) => void;
  /** Fired when the user taps the "Write a review" CTA. */
  onWriteReview?: (subjectId: string) => void;
}

export default function SubjectDetailScreen(
  props: SubjectDetailScreenProps,
): React.ReactElement {
  const { subjectId, data, error = null, onRetry, onSelectReviewer, onWriteReview } = props;

  if (error !== null) {
    return (
      <View style={styles.container} testID="subject-detail-error">
        <View style={styles.panel}>
          <Ionicons name="alert-circle-outline" size={36} color={colors.error} />
          <Text style={styles.panelTitle}>Couldn&apos;t load this subject</Text>
          <Text style={styles.panelBody}>{error}</Text>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              style={({ pressed }) => [styles.retryBtn, pressed && styles.retryBtnPressed]}
              testID="subject-detail-retry"
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

  if (data === null) {
    return (
      <View style={styles.container} testID="subject-detail-loading">
        <View style={styles.panel}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading subject…</Text>
        </View>
      </View>
    );
  }

  const detail = deriveSubjectDetail(data);
  const { header } = detail;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="subject-detail-screen"
    >
      {/* ─── Header card ─────────────────────────────────────────── */}
      <View style={styles.headerCard}>
        <Text style={styles.title} numberOfLines={2}>
          {header.title}
        </Text>
        {header.subtitle && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {header.subtitle}
          </Text>
        )}
        <View style={styles.headerRow}>
          <View
            style={[styles.scoreBadge, { backgroundColor: BAND_COLOUR[header.score.band] }]}
            testID={`subject-detail-band-${header.score.band}`}
          >
            <Text style={styles.scoreText}>
              {header.showNumericScore ? header.score.label : BAND_LABEL[header.score.band]}
            </Text>
          </View>
          <Text style={styles.reviewCount}>
            {header.reviewCount} {header.reviewCount === 1 ? 'review' : 'reviews'}
          </Text>
        </View>
        <Text style={styles.ringSummary} testID="subject-detail-ring-summary">
          {header.ringCounts.friends} from your network · {header.ringCounts.fof} from
          friends-of-friends · {header.ringCounts.strangers} from strangers
        </Text>
      </View>

      {onWriteReview && (
        <Pressable
          onPress={() => onWriteReview(subjectId)}
          style={({ pressed }) => [
            styles.writeBtn,
            pressed && styles.writeBtnPressed,
          ]}
          testID="subject-detail-write-cta"
          accessibilityRole="button"
          accessibilityLabel="Write a review"
        >
          <Ionicons name="create-outline" size={18} color={colors.bgSecondary} />
          <Text style={styles.writeBtnLabel}>Write a review</Text>
        </Pressable>
      )}

      {/* ─── Reviews grouped by ring ─────────────────────────────── */}
      <ReviewSection
        title="Your network"
        subtitle="Reviews from contacts and yourself"
        reviews={detail.friendsReviews}
        emptyHint={null}
        testIdPrefix="friends"
        onSelectReviewer={onSelectReviewer}
      />
      <ReviewSection
        title="Friends of friends"
        subtitle={null}
        reviews={detail.fofReviews}
        emptyHint={null}
        testIdPrefix="fof"
        onSelectReviewer={onSelectReviewer}
      />
      <ReviewSection
        title="Strangers"
        subtitle={null}
        reviews={detail.strangerReviews}
        emptyHint={
          detail.friendsReviews.length === 0 &&
          detail.fofReviews.length === 0 &&
          detail.strangerReviews.length === 0
            ? 'No reviews yet — be the first.'
            : null
        }
        testIdPrefix="strangers"
        onSelectReviewer={onSelectReviewer}
      />
    </ScrollView>
  );
}

interface ReviewSectionProps {
  title: string;
  subtitle: string | null;
  reviews: readonly SubjectReview[];
  /** Hint shown when ALL sections are empty. `null` for the per-section silent-empty case. */
  emptyHint: string | null;
  testIdPrefix: 'friends' | 'fof' | 'strangers';
  onSelectReviewer?: (reviewerName: string) => void;
}

function ReviewSection(props: ReviewSectionProps): React.ReactElement | null {
  const { title, subtitle, reviews, emptyHint, testIdPrefix, onSelectReviewer } = props;
  if (reviews.length === 0 && emptyHint === null) return null;

  return (
    <View style={styles.section} testID={`subject-detail-section-${testIdPrefix}`}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {reviews.length > 0 && (
          <Text style={styles.sectionCount}>{reviews.length}</Text>
        )}
      </View>
      {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}

      {reviews.length === 0 ? (
        <Text style={styles.emptyHint}>{emptyHint}</Text>
      ) : (
        <View style={styles.reviewList}>
          {reviews.map((review, idx) => (
            <ReviewRow
              key={`${review.reviewerName}-${review.createdAtMs}-${idx}`}
              review={review}
              testID={`subject-detail-review-${testIdPrefix}-${idx}`}
              onPress={onSelectReviewer}
            />
          ))}
        </View>
      )}
    </View>
  );
}

interface ReviewRowProps {
  review: SubjectReview;
  testID: string;
  onPress?: (reviewerName: string) => void;
}

function ReviewRow(props: ReviewRowProps): React.ReactElement {
  const { review, testID, onPress } = props;
  // Use the canonical band derivation rather than hand-coding the
  // threshold ladder — keeps the screen in lockstep with score_helpers
  // when the bands ever change (currently 0.8 / 0.5 / 0.3, but those
  // are tunable in `@dina/protocol`'s `score_bands.ts`).
  const band: TrustBand = trustBandFor(review.reviewerTrustScore);

  return (
    <Pressable
      onPress={onPress ? () => onPress(review.reviewerName) : undefined}
      style={({ pressed }) => [styles.reviewRow, pressed && onPress && styles.reviewRowPressed]}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Review by ${review.reviewerName}, trust ${BAND_LABEL[band]}`}
    >
      <View style={styles.reviewHeader}>
        <Text style={styles.reviewerName}>{review.reviewerName}</Text>
        <View style={[styles.miniBand, { backgroundColor: BAND_COLOUR[band] }]}>
          <Text style={styles.miniBandText}>{BAND_LABEL[band]}</Text>
        </View>
      </View>
      <Text style={styles.headline} numberOfLines={3}>
        “{review.headline}”
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  panel: {
    flex: 1,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  panelTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
  panelBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  loadingText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.md,
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
  headerCard: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.textPrimary,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  scoreBadge: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minWidth: 56,
    alignItems: 'center',
  },
  scoreText: {
    fontFamily: fonts.headingBold,
    fontSize: 14,
    color: colors.bgSecondary,
  },
  reviewCount: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textSecondary,
  },
  ringSummary: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  writeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: spacing.sm,
    minHeight: 48,
  },
  writeBtnPressed: { backgroundColor: colors.accentHover },
  writeBtnLabel: {
    fontFamily: fonts.headingBold,
    fontSize: 15,
    color: colors.bgSecondary,
  },
  section: { gap: spacing.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
  },
  sectionCount: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textMuted,
  },
  sectionSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  emptyHint: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
    paddingVertical: spacing.md,
  },
  reviewList: { gap: spacing.sm },
  reviewRow: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  reviewRowPressed: { backgroundColor: colors.bgTertiary },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reviewerName: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
  },
  miniBand: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  miniBandText: {
    fontFamily: fonts.headingBold,
    fontSize: 10,
    color: colors.bgSecondary,
  },
  headline: {
    fontFamily: fonts.serif,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 19,
  },
});
