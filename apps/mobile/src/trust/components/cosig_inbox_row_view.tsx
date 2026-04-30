/**
 * Visual row for the cosig inbox (TN-MOB-040 / Plan §10).
 *
 * Renders one `CosigInboxRowDisplay` (the projection from
 * `src/trust/cosig_inbox.ts:buildCosigInboxRow`) as a tap-targetable
 * card with sender title, optional body preview, an expiry badge,
 * and per-state action buttons (Endorse / Decline) when the row is
 * still actionable.
 *
 * The component is presentational over the data layer:
 *   - State classification (`pending` / `accepted` / `declined` /
 *     `expired`) and the action set come from
 *     `buildCosigInboxRow` — already pinned by `cosig_inbox.test.ts`.
 *   - Tap handlers delegate the side-effects (PDS createRecord for
 *     endorse, local-state writes for decline) to the runner.
 *
 * **Why a separate component file** rather than inline in the inbox
 * screen: the same row appears in two places — the cosig inbox tab
 * and the global notifications inbox (Plan §10 row 7) — both of
 * which mount different parents. Sharing the row component keeps
 * the visual treatment + accessibility surface consistent.
 *
 * **Expiry copy formatting**: rendered inline as "expires in 2d 3h"
 * for pending rows. Buckets:
 *   - msUntilExpiry > 24h → "Nd ago"
 *   - 1h..24h → "Nh"
 *   - 1m..60m → "Nm"
 *   - 0..60s → "<1m"
 *   - already past 0 (pending) → never reached because state would
 *     have been classified `expired` and this row doesn't render the
 *     expiry copy in that branch.
 *
 * Closed rows (`accepted`, `declined`, `expired`) hide the expiry
 * badge — the terminal state is the signal, not the clock.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

import { colors, fonts, spacing, radius } from '../../theme';
import type { CosigInboxRowDisplay, CosigInboxAction } from '../cosig_inbox';

const STATE_LABEL: Record<CosigInboxRowDisplay['state'], string> = {
  pending: 'Awaiting your response',
  accepted: 'Endorsed',
  declined: 'Declined',
  expired: 'Expired',
};

const STATE_ICON: Record<CosigInboxRowDisplay['state'], 'time' | 'checkmark-circle' | 'close-circle' | 'hourglass'> = {
  pending: 'time',
  accepted: 'checkmark-circle',
  declined: 'close-circle',
  expired: 'hourglass',
};

const STATE_COLOUR: Record<CosigInboxRowDisplay['state'], string> = {
  pending: colors.accent,
  accepted: colors.success,
  declined: colors.textMuted,
  expired: colors.warning,
};

export interface CosigInboxRowViewProps {
  /** Stable identifier (e.g., the request URI) for testID + key. */
  rowId: string;
  /** Pre-computed display projection from `buildCosigInboxRow`. */
  display: CosigInboxRowDisplay;
  /**
   * Tap handler for the row body — used by the inbox screen to
   * navigate to the deep link in `display.deepLink`.
   */
  onPress?: (rowId: string, deepLink: string) => void;
  /**
   * Per-action tap handler. Fires for `endorse` / `decline` taps.
   * Only invoked when the row is actionable (`actions` is non-empty).
   */
  onAction?: (rowId: string, action: CosigInboxAction) => void;
}

export function CosigInboxRowView(
  props: CosigInboxRowViewProps,
): React.ReactElement {
  const { rowId, display, onPress, onAction } = props;
  const showExpiry = display.state === 'pending' && display.msUntilExpiry > 0;

  return (
    <Pressable
      onPress={onPress ? () => onPress(rowId, display.deepLink) : undefined}
      style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}
      testID={`cosig-inbox-row-${rowId}`}
      accessibilityRole="button"
      accessibilityLabel={`${display.title}. ${STATE_LABEL[display.state]}`}
    >
      <View style={styles.header}>
        <Ionicons
          name={STATE_ICON[display.state]}
          size={16}
          color={STATE_COLOUR[display.state]}
        />
        <Text
          style={[styles.stateLabel, { color: STATE_COLOUR[display.state] }]}
          testID={`cosig-inbox-state-${rowId}`}
        >
          {STATE_LABEL[display.state]}
        </Text>
        {showExpiry && (
          <Text style={styles.expiry} testID={`cosig-inbox-expiry-${rowId}`}>
            · expires in {formatExpiryDelta(display.msUntilExpiry)}
          </Text>
        )}
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {display.title}
      </Text>
      {display.bodyPreview && (
        <Text style={styles.bodyPreview} numberOfLines={3}>
          “{display.bodyPreview}”
        </Text>
      )}
      {display.actions.length > 0 && (
        <View style={styles.actions}>
          {display.actions.includes('endorse') && (
            <Pressable
              onPress={onAction ? () => onAction(rowId, 'endorse') : undefined}
              style={({ pressed }) => [
                styles.endorseBtn,
                pressed && styles.endorseBtnPressed,
              ]}
              testID={`cosig-inbox-endorse-${rowId}`}
              accessibilityRole="button"
              accessibilityLabel="Endorse"
            >
              <Ionicons name="checkmark" size={14} color={colors.bgSecondary} />
              <Text style={styles.endorseLabel}>Endorse</Text>
            </Pressable>
          )}
          {display.actions.includes('decline') && (
            <Pressable
              onPress={onAction ? () => onAction(rowId, 'decline') : undefined}
              style={({ pressed }) => [
                styles.declineBtn,
                pressed && styles.declineBtnPressed,
              ]}
              testID={`cosig-inbox-decline-${rowId}`}
              accessibilityRole="button"
              accessibilityLabel="Decline"
            >
              <Text style={styles.declineLabel}>Decline</Text>
            </Pressable>
          )}
        </View>
      )}
    </Pressable>
  );
}

/**
 * Format `msUntilExpiry` (positive ms) as a short human string.
 * Pure helper — exported for tests so the expiry-bucket boundaries
 * can be pinned without rendering the full row.
 */
export function formatExpiryDelta(msUntilExpiry: number): string {
  if (!Number.isFinite(msUntilExpiry) || msUntilExpiry <= 0) return '<1m';
  const minutes = Math.floor(msUntilExpiry / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMinutes = minutes - hours * 60;
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours - days * 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  rowPressed: { backgroundColor: colors.bgTertiary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  stateLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
  },
  expiry: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  title: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  bodyPreview: {
    fontFamily: fonts.serif,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  endorseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    gap: spacing.xs,
    minHeight: 36,
  },
  endorseBtnPressed: { backgroundColor: colors.accentHover },
  endorseLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.bgSecondary,
  },
  declineBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  declineBtnPressed: { backgroundColor: colors.bgTertiary },
  declineLabel: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
  },
});
