/**
 * Trust Network — outbox / stuck-publish recovery (TN-MOB-017 / Plan §3.5.1).
 *
 * Lists the user's stuck or rejected publish attempts and exposes a
 * "Try again" affordance per row. The state machine + selectors live
 * in `src/trust/outbox.ts` (TN-MOB-004 + TN-MOB-007); this screen is
 * presentational over those data primitives.
 *
 * Why a presentational shell over the runner:
 *   - The runner owns NetInfo subscription, PDS createRecord, xRPC
 *     attestationStatus polling, keystore persistence — all RN-coupled
 *     surfaces that don't render in Jest.
 *   - The screen renders `selectInboxFailureRows(rows)` (terminal-
 *     failure state) plus the in-flight count (queued-offline +
 *     submitted-pending). Two read-only selectors, both deterministic
 *     pure functions, both already covered by `outbox.test.ts`.
 *   - "Try again" → callback to the runner's retry path; the screen
 *     doesn't decide retry policy.
 *
 * Data source contract:
 *   - `rows` is the canonical outbox state from the runner (passed in
 *     via the screen-level wrapper that subscribes to the keystore-
 *     persisted state). Empty array = nothing in the outbox.
 *   - `onRetry(clientId)` fires when the user taps "Try again" on a
 *     failure row.
 *   - `onDismiss(clientId)` fires when the user swipes / long-presses
 *     to remove a terminal row from the outbox.
 *
 * The screen's three states:
 *   1. **Empty** (no rows in any state): "Nothing in your outbox" — the
 *      friendly default; not an error.
 *   2. **In-flight only** (queued + pending, no failures): "Reviews
 *      will publish when back online" — informational, hopeful.
 *   3. **Failures present**: list of rows with rejection reason +
 *      "Try again" CTA + "Remove" affordance.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
} from 'react-native';

import { colors, fonts, spacing, radius } from '../../src/theme';
import {
  selectInboxFailureRows,
  inFlightCount,
  type OutboxRow,
  type OutboxStatus,
} from '../../src/trust/outbox';
import {
  subscribeOutbox,
  dismissLocal,
  type AttestationDraftBody,
} from '../../src/trust/outbox_store';

export interface OutboxScreenProps<DraftBody = unknown> {
  /**
   * All outbox rows from the runner — terminal + non-terminal mixed.
   * Defaults to `[]` so the screen renders the friendly empty state
   * ("Nothing in your outbox") when no runner is attached.
   */
  rows?: readonly OutboxRow<DraftBody>[];
  /** Fired when the user taps "Try again" on a failure row. */
  onRetry?: (clientId: string) => void;
  /** Fired when the user dismisses a terminal row. */
  onDismiss?: (clientId: string) => void;
  /**
   * Render a one-line preview of the row's `draftBody`. The screen
   * doesn't know the draft's shape — the wrapper at the screen-level
   * provides this so different draft schemas (attestation / endorsement
   * / vouch) render correctly.
   */
  renderDraftPreview?: (draft: DraftBody) => string;
}

/**
 * Display label for each terminal failure status. Surfaced in the
 * row header so the user knows whether to retry-on-network vs.
 * retry-now vs. fix-and-recompose.
 */
const STATUS_LABEL: Record<Extract<OutboxStatus, 'rejected' | 'stuck-pending' | 'stuck-offline'>, string> = {
  'rejected': 'Rejected',
  'stuck-pending': 'Stuck — no AppView response',
  'stuck-offline': 'Queued > 24 h',
};

/**
 * Maps `OutboxRejectReason` to a human-readable explanation. Open-
 * coded rather than i18n'd at this stage — V1 ships en-only; the keys
 * are stable so a future i18n bundle can lift them out unchanged.
 */
const REJECT_REASON_LABEL: Record<string, string> = {
  rate_limit: 'Rate limit exceeded — try again later',
  signature_invalid: 'Signature invalid — recompose required',
  schema_invalid: 'Record format rejected — recompose required',
  namespace_disabled: 'Namespace not declared in your DID document',
  feature_off: 'Trust Network temporarily unavailable',
  pds_suspended: 'Your PDS host is suspended by the operator',
};

function rejectReasonText<DraftBody>(row: OutboxRow<DraftBody>): string {
  const reason = row.rejection?.reason;
  if (!reason) return '';
  return REJECT_REASON_LABEL[reason] ?? `Rejected: ${reason}`;
}

/**
 * Stable empty-rows sentinel — see destructure default in `OutboxScreen`.
 * Frozen + cast through `unknown` because `OutboxScreen` is generic over
 * `DraftBody`: a single shared `[]` is structurally compatible with every
 * instantiation, so we hand the empty array to the destructure default
 * with the per-call generic type for free.
 */
const EMPTY_ROWS: readonly never[] = Object.freeze([]);

export default function OutboxScreen<DraftBody = unknown>(
  props: OutboxScreenProps<DraftBody> = {},
): React.ReactElement {
  // Subscribe to the local outbox store when running uncontrolled
  // (production path). Tests + a future runner pass `rows` directly so
  // the subscription is bypassed via the destructure default.
  const [storeRows, setStoreRows] = React.useState<
    readonly OutboxRow<AttestationDraftBody>[]
  >([]);
  React.useEffect(() => {
    if (props.rows !== undefined) return;
    return subscribeOutbox(setStoreRows);
  }, [props.rows]);
  // The empty array sentinel is hoisted out of the render tree via the
  // module-level `EMPTY_ROWS` so dependency-tracked memoisation in
  // `selectInboxFailureRows` / `inFlightCount` doesn't see a fresh
  // reference on every mount.
  const {
    rows = (storeRows as unknown as readonly OutboxRow<DraftBody>[]),
    onRetry,
    onDismiss = (clientId: string) => dismissLocal(clientId),
    renderDraftPreview = ((draft: unknown) => {
      // Default preview: the attestation's headline. Falls back to a
      // generic label if a non-attestation draft ever lands in the
      // outbox (defensive — current store only stores attestations).
      const d = draft as Partial<AttestationDraftBody>;
      return typeof d.headline === 'string' && d.headline.length > 0
        ? d.headline
        : 'Draft';
    }) as (draft: DraftBody) => string,
  } = props;
  const failures = React.useMemo(() => selectInboxFailureRows(rows), [rows]);
  const inFlight = React.useMemo(() => inFlightCount(rows), [rows]);
  // Queued (non-terminal, non-failure) rows — surfaced as an explicit
  // list so the user sees what they've drafted, not just a count.
  const queued = React.useMemo(
    () => rows.filter((r) => r.status === 'queued-offline'),
    [rows],
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="outbox-screen"
    >
      <View style={styles.header}>
        <Text style={styles.title}>Outbox</Text>
        <Text style={styles.subtitle}>
          Reviews waiting to publish, plus any that didn&apos;t go through.
        </Text>
      </View>

      {inFlight > 0 && (
        <View style={styles.inFlightBanner} testID="outbox-inflight-banner">
          <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.inFlightText}>
            {inFlight} {inFlight === 1 ? 'review' : 'reviews'} queued — will publish when back online.
          </Text>
        </View>
      )}

      {rows.length === 0 ? (
        <View style={styles.empty} testID="outbox-empty">
          <Ionicons name="paper-plane-outline" size={36} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Nothing in your outbox</Text>
          <Text style={styles.emptyBody}>
            Reviews you publish will appear here briefly while they&apos;re being delivered.
          </Text>
        </View>
      ) : (
        <>
          {queued.length > 0 && (
            <View style={styles.list} testID="outbox-queued-list">
              {queued.map((row) => (
                <QueuedRow
                  key={row.clientId}
                  row={row}
                  onDismiss={onDismiss}
                  renderDraftPreview={renderDraftPreview}
                />
              ))}
            </View>
          )}
          {failures.length === 0 ? (
            <View style={styles.empty} testID="outbox-no-failures">
              <Ionicons name="checkmark-circle-outline" size={36} color={colors.success} />
              <Text style={styles.emptyTitle}>All caught up</Text>
              <Text style={styles.emptyBody}>
                No stuck or rejected reviews. We&apos;ll let you know if anything needs attention.
              </Text>
            </View>
          ) : (
            <View style={styles.list}>
              {failures.map((row) => (
                <FailureRow
                  key={row.clientId}
                  row={row}
                  onRetry={onRetry}
                  onDismiss={onDismiss}
                  renderDraftPreview={renderDraftPreview}
                />
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

/**
 * A queued (not-yet-published) draft row. Shows the headline + a
 * dismiss affordance. No retry — queued rows transition forward
 * automatically when the network is reachable; for the local-only
 * outbox they sit until dismissed.
 */
interface QueuedRowProps<DraftBody> {
  row: OutboxRow<DraftBody>;
  onDismiss?: (clientId: string) => void;
  renderDraftPreview?: (draft: DraftBody) => string;
}

function QueuedRow<DraftBody>(props: QueuedRowProps<DraftBody>): React.ReactElement {
  const { row, onDismiss, renderDraftPreview } = props;
  const preview = renderDraftPreview ? renderDraftPreview(row.draftBody) : '';
  return (
    <View
      style={styles.row}
      testID={`outbox-queued-${row.clientId}`}
      accessibilityLabel={`Queued: ${preview || 'Draft'}`}
    >
      <View style={styles.rowHeader}>
        <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.rowStatus}>Queued</Text>
      </View>
      {preview.length > 0 && (
        <Text style={styles.rowPreview} numberOfLines={2}>
          {preview}
        </Text>
      )}
      {onDismiss && (
        <Pressable
          onPress={() => onDismiss(row.clientId)}
          style={({ pressed }) => [styles.dismissBtn, pressed && styles.dismissBtnPressed]}
          testID={`outbox-queued-dismiss-${row.clientId}`}
          accessibilityRole="button"
          accessibilityLabel="Dismiss draft"
        >
          <Ionicons name="close" size={14} color={colors.textMuted} />
          <Text style={styles.dismissLabel}>Dismiss</Text>
        </Pressable>
      )}
    </View>
  );
}

interface FailureRowProps<DraftBody> {
  row: OutboxRow<DraftBody>;
  onRetry?: (clientId: string) => void;
  onDismiss?: (clientId: string) => void;
  renderDraftPreview?: (draft: DraftBody) => string;
}

function FailureRow<DraftBody>(props: FailureRowProps<DraftBody>): React.ReactElement {
  const { row, onRetry, onDismiss, renderDraftPreview } = props;
  // Status is one of the failure-row triple — `selectInboxFailureRows`
  // guarantees this. Re-narrow for the display map.
  const statusLabel =
    STATUS_LABEL[row.status as 'rejected' | 'stuck-pending' | 'stuck-offline'];
  const reasonText = row.status === 'rejected' ? rejectReasonText(row) : '';
  const preview = renderDraftPreview ? renderDraftPreview(row.draftBody) : '';

  return (
    <View
      style={styles.row}
      testID={`outbox-row-${row.clientId}`}
      accessibilityLabel={`${statusLabel}${reasonText ? '. ' + reasonText : ''}`}
    >
      <View style={styles.rowHeader}>
        <Ionicons
          name={row.status === 'rejected' ? 'alert-circle' : 'time'}
          size={16}
          color={row.status === 'rejected' ? colors.error : colors.warning}
        />
        <Text style={styles.rowStatus}>{statusLabel}</Text>
      </View>
      {preview.length > 0 && (
        <Text style={styles.rowPreview} numberOfLines={2}>
          {preview}
        </Text>
      )}
      {reasonText.length > 0 && <Text style={styles.rowReason}>{reasonText}</Text>}
      <View style={styles.rowActions}>
        {onRetry && (
          <Pressable
            onPress={() => onRetry(row.clientId)}
            style={({ pressed }) => [styles.retryBtn, pressed && styles.retryBtnPressed]}
            testID={`outbox-retry-${row.clientId}`}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Ionicons name="refresh" size={14} color={colors.bgSecondary} />
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        )}
        {onDismiss && (
          <Pressable
            onPress={() => onDismiss(row.clientId)}
            style={({ pressed }) => [styles.dismissBtn, pressed && styles.dismissBtnPressed]}
            testID={`outbox-dismiss-${row.clientId}`}
            accessibilityRole="button"
            accessibilityLabel="Remove"
          >
            <Text style={styles.dismissLabel}>Remove</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  header: { marginBottom: spacing.lg },
  title: { fontFamily: fonts.heading, fontSize: 22, color: colors.textPrimary },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  inFlightBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgTertiary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.lg,
  },
  inFlightText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    flex: 1,
  },
  empty: {
    paddingVertical: spacing.xxl,
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
    paddingHorizontal: spacing.lg,
  },
  list: {
    gap: spacing.sm,
  },
  row: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  rowStatus: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
  },
  rowPreview: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  rowReason: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  rowActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    gap: spacing.xs,
    minHeight: 36,
  },
  retryBtnPressed: { backgroundColor: colors.accentHover },
  retryLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.bgSecondary,
  },
  dismissBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  dismissBtnPressed: { backgroundColor: colors.bgTertiary },
  dismissLabel: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
  },
});
