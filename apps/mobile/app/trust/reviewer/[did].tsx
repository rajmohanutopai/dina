/**
 * Trust Network — reviewer profile screen (TN-MOB-015 / Plan §8.5).
 *
 * Drilled into from any reviewer entry on the subject card spotlight,
 * the subject-detail reviewer list, the cosig inbox sender line, or
 * the network feed reviewer chip — all of which compose deep links via
 * `src/trust/reviewer_link.ts`. The route key `[did]` is the reviewer's
 * DID; an optional `?namespace=<fragment>` query param lands the screen
 * on the per-namespace stats slice (TN-DB-002).
 *
 * Render contract:
 *   - **Loading** — `profile === null` and `error === null`. Spinner +
 *     "Loading reviewer profile…".
 *   - **Error** — `error !== null`. Soft error with a Retry CTA (the
 *     screen-level wrapper plumbs the retry handler).
 *   - **Loaded** — header card (DID, score, band, namespace if any) +
 *     stats grid (attestations / vouches / endorsements / helpful
 *     ratio) + active-domains chip row + last-active line.
 *
 * Why a presentational shell over the data layer:
 *   - Same separation as TN-MOB-014 / TN-MOB-017 — the runner owns the
 *     xRPC call (`TrustQueryClient.getProfile`) + cache + retry
 *     policy; this screen renders whatever data the wrapper passes.
 *   - The same screen renders both root-identity profiles (no
 *     namespace) and per-namespace profile slices (with namespace);
 *     the wrapper decides which xRPC to call.
 *   - Tests pass synthetic `TrustProfile` objects — no need to mock
 *     the network layer.
 *
 * The screen is plan §8.5 read-only — no compose / write affordances.
 * "Vouch for this reviewer" / "Report" actions are TN-MOB-013 +
 * TN-MOB-019 surfaces and live in their own screens.
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

import { colors, fonts, spacing, radius } from '../../../src/theme';
import {
  deriveReviewerProfileDisplay,
  formatLastActive,
} from '../../../src/trust/reviewer_profile_data';
import { BAND_COLOUR, BAND_LABEL } from '../../../src/trust/band_theme';

import type { TrustProfile } from '@dina/core';

export interface ReviewerProfileScreenProps {
  /**
   * The reviewer's profile from `com.dina.trust.getProfile`. `null`
   * while loading.
   */
  profile: TrustProfile | null;
  /**
   * Pseudonymous namespace fragment (e.g. `'namespace_2'`) when the
   * deep-link landed on a per-namespace slice. Surfaced under the DID
   * in the header so the user knows which compartment they're seeing.
   */
  namespace?: string | null;
  /** Loading-error string. `null` when there's no error. */
  error?: string | null;
  /** Fired when the user taps Retry on the error state. */
  onRetry?: () => void;
  /**
   * Reference timestamp for "last active" formatting. Injectable so
   * tests pin exact outputs; production passes `Date.now()`.
   */
  nowMs?: number;
}


export default function ReviewerProfileScreen(
  props: ReviewerProfileScreenProps,
): React.ReactElement {
  const { profile, namespace = null, error = null, onRetry, nowMs = Date.now() } = props;

  if (error !== null) {
    return (
      <View style={styles.container} testID="reviewer-profile-error">
        <View style={styles.errorPanel}>
          <Ionicons name="alert-circle-outline" size={36} color={colors.error} />
          <Text style={styles.errorTitle}>Couldn&apos;t load this profile</Text>
          <Text style={styles.errorBody}>{error}</Text>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              style={({ pressed }) => [
                styles.retryBtn,
                pressed && styles.retryBtnPressed,
              ]}
              testID="reviewer-profile-retry"
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

  if (profile === null) {
    return (
      <View style={styles.container} testID="reviewer-profile-loading">
        <View style={styles.loading}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading reviewer profile…</Text>
        </View>
      </View>
    );
  }

  const display = deriveReviewerProfileDisplay(profile);
  const lastActive = formatLastActive(display.lastActiveMs, nowMs);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="reviewer-profile-screen"
    >
      {/* ─── Header card: identity + score + band ─────────────────── */}
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <View style={styles.headerIdentity}>
            <Text
              style={styles.headerDid}
              numberOfLines={1}
              ellipsizeMode="middle"
              accessibilityLabel={`Reviewer ${display.did}`}
            >
              {display.did}
            </Text>
            {namespace && (
              <Text style={styles.headerNamespace} testID="reviewer-namespace">
                #{namespace}
              </Text>
            )}
          </View>
          <View
            style={[styles.scoreBadge, { backgroundColor: BAND_COLOUR[display.band] }]}
            testID={`reviewer-band-${display.band}`}
          >
            <Text style={styles.scoreLabel}>
              {display.hasNumericScore ? display.scoreLabel : BAND_LABEL[display.band]}
            </Text>
          </View>
        </View>
        <View style={styles.headerMeta}>
          <Ionicons name="time-outline" size={14} color={colors.textMuted} />
          <Text style={styles.headerMetaText}>Last active {lastActive}</Text>
        </View>
      </View>

      {/* ─── Stats grid ─────────────────────────────────────────── */}
      <View style={styles.statsGrid} testID="reviewer-stats-grid">
        <StatCell label="Attestations" value={display.totalAttestations} />
        <StatCell label="Vouches" value={display.vouchCount} />
        <StatCell label="Endorsements" value={display.endorsementCount} />
        <StatCell
          label="Helpful"
          value={
            display.helpfulRatioDisplay !== null
              ? `${display.helpfulRatioDisplay}%`
              : '—'
          }
        />
        <StatCell
          label="Corroborated"
          value={
            display.corroborationRateDisplay !== null
              ? `${display.corroborationRateDisplay}%`
              : '—'
          }
        />
      </View>

      {/* ─── Sentiment breakdown ────────────────────────────────── */}
      <View style={styles.sentimentRow} testID="reviewer-sentiment-row">
        <SentimentChip
          label="Positive"
          count={display.positiveCount}
          colour={colors.success}
        />
        <SentimentChip
          label="Neutral"
          count={display.neutralCount}
          colour={colors.textMuted}
        />
        <SentimentChip
          label="Negative"
          count={display.negativeCount}
          colour={colors.warning}
        />
      </View>

      {/* ─── Active domains chip-row ────────────────────────────── */}
      {display.activeDomains.length > 0 && (
        <View style={styles.section} testID="reviewer-domains-section">
          <Text style={styles.sectionTitle}>Active in</Text>
          <View style={styles.chipRow}>
            {display.activeDomains.map((domain) => (
              <View key={domain} style={styles.chip}>
                <Text style={styles.chipText}>{domain}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

interface StatCellProps {
  label: string;
  value: number | string;
}

function StatCell(props: StatCellProps): React.ReactElement {
  return (
    <View style={styles.statCell} testID={`reviewer-stat-${props.label.toLowerCase()}`}>
      <Text style={styles.statValue}>{props.value}</Text>
      <Text style={styles.statLabel}>{props.label}</Text>
    </View>
  );
}

interface SentimentChipProps {
  label: string;
  count: number;
  colour: string;
}

function SentimentChip(props: SentimentChipProps): React.ReactElement {
  return (
    <View
      style={styles.sentimentChip}
      testID={`reviewer-sentiment-${props.label.toLowerCase()}`}
      accessibilityLabel={`${props.count} ${props.label.toLowerCase()}`}
    >
      <View style={[styles.sentimentDot, { backgroundColor: props.colour }]} />
      <Text style={styles.sentimentCount}>{props.count}</Text>
      <Text style={styles.sentimentLabel}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
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
  headerCard: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerIdentity: { flex: 1, gap: spacing.xs },
  headerDid: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textPrimary,
  },
  headerNamespace: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  scoreBadge: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minWidth: 56,
    alignItems: 'center',
  },
  scoreLabel: {
    fontFamily: fonts.headingBold,
    fontSize: 14,
    color: colors.bgSecondary,
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  headerMetaText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statCell: {
    flexBasis: '30%',
    flexGrow: 1,
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    gap: spacing.xs,
  },
  statValue: {
    fontFamily: fonts.headingBold,
    fontSize: 20,
    color: colors.textPrimary,
  },
  statLabel: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
  },
  sentimentRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  sentimentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  sentimentDot: { width: 8, height: 8, borderRadius: 4 },
  sentimentCount: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
  },
  sentimentLabel: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
  },
  section: { gap: spacing.sm },
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: 14,
    color: colors.textPrimary,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.bgTertiary,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
  },
  chipText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textSecondary,
  },
});
