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
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { getBootedNode } from '../../../src/hooks/useNodeBootstrap';

/**
 * How long the screen waits for `profile` before surfacing a friendly
 * "couldn't reach trust network" error. See same constant in
 * `[subjectId].tsx` for the rationale.
 */
const LOAD_BUDGET_MS = 5000;
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
import { useReviewerProfile } from '../../../src/trust/runners/use_reviewer_profile';
import { IdentityModal } from '../../../src/components/identity/identity_modal';
import { shortHandle } from '../../../src/trust/handle_display';

import type { TrustProfile } from '@dina/core';

export interface ReviewerProfileScreenProps {
  /**
   * The reviewer's profile from `com.dina.trust.getProfile`. `null`
   * while loading. Defaults to `null` so the screen mounts as a
   * routable Expo Router default export with the loading state
   * showing — the runner that resolves the profile slots in later.
   */
  profile?: TrustProfile | null;
  /**
   * Pseudonymous namespace fragment (e.g. `'namespace_2'`) when the
   * deep-link landed on a per-namespace slice. Surfaced under the DID
   * in the header so the user knows which compartment they're seeing.
   * When omitted in production, the URL `?namespace=…` query param is
   * consulted via `useLocalSearchParams`.
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
  props: ReviewerProfileScreenProps = {},
): React.ReactElement {
  // Hooks must run unconditionally (Rules of Hooks). The route param
  // is consulted only as a fallback when the caller didn't supply
  // `namespace`. Tests pass it explicitly and the param is ignored.
  const params = useLocalSearchParams<{
    namespace?: string | string[];
    did?: string | string[];
  }>();
  const paramNamespace = Array.isArray(params.namespace)
    ? params.namespace[0]
    : params.namespace;
  const paramDidRaw = Array.isArray(params.did) ? params.did[0] : params.did;
  // Reviewer links encode the DID (`did:plc:…` → `did%3Aplc%3A…`)
  // because the path segment otherwise contains literal colons. Expo
  // Router returns the encoded form here, but the downstream runner
  // bails on `!did.startsWith('did:')` — without this decode the
  // screen sits on the loading spinner forever (no fetch, no error).
  // `safelyDecode` is defensive against `decodeURIComponent` throwing
  // on malformed input (e.g. a stray `%`).
  const paramDid = paramDidRaw !== undefined ? safelyDecode(paramDidRaw) : undefined;
  // Local state lets the screen exit the loading state with a graceful
  // error after the load budget elapses. Skipped in controlled mode
  // (when caller supplies `profile` / `error` props).
  const [autoError, setAutoError] = React.useState<string | null>(null);
  const [retryNonce, setRetryNonce] = React.useState(0);
  // Auto-runner: fetch the profile from AppView when no controlled
  // props are supplied (i.e. production routing — tests pass
  // `profile` or `error` and the runner stays inert).
  const isControlled = props.profile !== undefined || props.error !== undefined;
  const auto = useReviewerProfile({
    did: paramDid ?? '',
    enabled: !isControlled,
    retryNonce,
  });
  // Refresh on focus so a recently-vouched / recently-revoked
  // attestation moves the reviewer's score the next time the user lands
  // here — the runner's deps are stable on a steady DID otherwise.
  useFocusEffect(
    React.useCallback(() => {
      if (isControlled || !paramDid) return;
      setAutoError(null);
      setRetryNonce((n) => n + 1);
    }, [isControlled, paramDid]),
  );
  // Runner state wins over the legacy auto-timeout: when paramDid is
  // present the runner is engaged and authoritative. The autoError
  // remains only as a courtesy fallback for the no-DID degraded path.
  const runnerEngaged = !isControlled && Boolean(paramDid);
  const {
    profile = auto.profile,
    namespace = paramNamespace ?? null,
    error = runnerEngaged ? auto.error : autoError,
    onRetry = () => {
      setAutoError(null);
      setRetryNonce((n) => n + 1);
    },
    nowMs = Date.now(),
  } = props;

  React.useEffect(() => {
    // Auto-timeout fallback only fires in degraded states the runner
    // can't reach: no paramDid (so the runner stays inert), or the
    // screen is mounted in the rare uncontrolled-WITHOUT-runner path.
    // When the runner has engaged for this DID, profile / error from
    // the runner state are authoritative and this fallback is silent.
    if (props.profile !== undefined || props.error !== undefined) return;
    if (paramDid) return;
    const id = setTimeout(() => {
      setAutoError("Couldn't reach the trust network. Check your connection and try again.");
    }, LOAD_BUDGET_MS);
    return () => clearTimeout(id);
  }, [paramDid, retryNonce, props.profile, props.error]);

  // IdentityModal visibility — declared up here so the hook count
  // stays constant across the loading/error/loaded branches below.
  // Rules of Hooks: every useState must run on every render or React
  // throws "Rendered more hooks than during the previous render".
  const [identityOpen, setIdentityOpen] = React.useState(false);

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
  // Self-profile detection — when the user is looking at their OWN
  // DID, the band badge ("VERY LOW" by default for new accounts) reads
  // as a self-judgement rather than a useful signal. Suppress to a
  // softer "You" pill so the screen feels like a self-dashboard, not a
  // verdict.
  const ownDid = getBootedNode()?.did ?? null;
  const isSelf = ownDid !== null && ownDid === display.did;

  // Default render is the short username. The full handle, full DID,
  // and PLC services are revealed in the IdentityModal when the user
  // taps the header — same affordance every other peer-row gets.
  const shortName =
    display.handle !== null ? shortHandle(display.handle) : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="reviewer-profile-screen"
    >
      {/* ─── Header card: identity + score + band ─────────────────── */}
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <Pressable
            style={styles.headerIdentity}
            onPress={() => setIdentityOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Show full identity for ${shortName ?? display.did}`}
            testID="reviewer-identity-tap"
          >
            {/* Default: short username only — `alice` rather than
                `alice.pds.dinakernel.com`. The full handle, DID, and
                PLC services are exposed in the IdentityModal on tap. */}
            {shortName !== null ? (
              <>
                <Text
                  style={styles.headerHandle}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  accessibilityLabel={`Reviewer ${shortName}`}
                  testID="reviewer-handle"
                >
                  {shortName}
                </Text>
                <Text style={styles.headerHint} testID="reviewer-handle-hint">
                  Tap for full identity
                </Text>
              </>
            ) : (
              <Text
                style={styles.headerDid}
                numberOfLines={1}
                ellipsizeMode="middle"
                accessibilityLabel={`Reviewer ${display.did}`}
              >
                {display.did}
              </Text>
            )}
            {namespace && (
              <Text style={styles.headerNamespace} testID="reviewer-namespace">
                #{namespace}
              </Text>
            )}
          </Pressable>
          {isSelf ? (
            <View
              style={[styles.scoreBadge, styles.selfBadge]}
              testID="reviewer-self-badge"
            >
              <Text style={styles.scoreLabel}>You</Text>
            </View>
          ) : (
            <View
              style={[styles.scoreBadge, { backgroundColor: BAND_COLOUR[display.band] }]}
              testID={`reviewer-band-${display.band}`}
            >
              <Text style={styles.scoreLabel}>
                {display.hasNumericScore ? display.scoreLabel : BAND_LABEL[display.band]}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.headerMeta}>
          <Ionicons name="time-outline" size={14} color={colors.textMuted} />
          <Text style={styles.headerMetaText}>Last active {lastActive}</Text>
        </View>
      </View>

      <IdentityModal
        visible={identityOpen}
        onClose={() => setIdentityOpen(false)}
        did={display.did}
        initialHandle={display.handle}
      />

      {/* ─── Stats grid ─────────────────────────────────────────── */}
      <View style={styles.statsGrid} testID="reviewer-stats-grid">
        <StatCell
          label="Reviews written"
          testKey="attestations"
          value={display.reviewsWritten}
        />
        <StatCell label="Vouches" testKey="vouches" value={display.vouchCount} />
        <StatCell
          label="Endorsements"
          testKey="endorsements"
          value={display.endorsementCount}
        />
        <StatCell
          label="Helpful"
          testKey="helpful"
          value={
            display.helpfulRatioDisplay !== null
              ? `${display.helpfulRatioDisplay}%`
              : '—'
          }
        />
        <StatCell
          label="Corroborated"
          testKey="corroborated"
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
  /**
   * Stable test/AX hook — independent of the visible label so we can
   * relabel ("Attestations" → "Reviews written") without breaking the
   * test suite or accessibility expectations.
   */
  testKey: string;
  value: number | string;
}

/**
 * `decodeURIComponent` throws on malformed sequences (`%XX` with non-
 * hex). Wrap so a malformed deep link surfaces as the original string
 * (which the runner will then validate via `startsWith('did:')`)
 * rather than an uncaught render error.
 */
function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function StatCell(props: StatCellProps): React.ReactElement {
  return (
    <View style={styles.statCell} testID={`reviewer-stat-${props.testKey}`}>
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
  // Primary line when a handle is resolved — readable, sans-serif,
  // sized like a name header rather than the mono small-caps DID.
  headerHandle: {
    fontFamily: fonts.sansMedium,
    fontSize: 16,
    color: colors.textPrimary,
  },
  // Tap-affordance hint below the short username. Tells the user
  // there's more to see (full handle, DID, PLC services) without
  // showing the noise inline.
  headerHint: {
    fontFamily: fonts.sans,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 2,
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
  selfBadge: {
    backgroundColor: colors.textSecondary,
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
