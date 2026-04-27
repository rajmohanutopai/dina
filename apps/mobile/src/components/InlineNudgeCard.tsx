/**
 * `InlineNudgeCard` — chat-thread inline renderer for proactive nudges
 * (reconnection, reminder context, pending promises, health alerts —
 * 5.62). Reads structured metadata written by `useChatNudges.createNudge`
 * and renders title + body + an action chip + a Dismiss affordance.
 *
 * Tap the action chip → `actOnNudge(id)` returns an action descriptor
 * (e.g. `{actionType: 'message', contactDID}`); future work routes
 * those into the appropriate screen (chat-with-contact, etc.). Tap
 * Dismiss → `dismissNudge(id)`. Either path marks the nudge dismissed
 * in the in-memory store; the message itself stays in the thread but
 * the action UI hides.
 *
 * Tier indicator (1 = fiduciary, 2 = solicited, 3 = engagement) is
 * shown as a small dot color so the user sees urgency at a glance.
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import type { ChatMessage } from '@dina/brain/src/chat/thread';
import { actOnNudge, dismissNudge, type NudgeKind } from '../hooks/useChatNudges';
import { colors, fonts, radius, spacing } from '../theme';
import { MessageTimestamp } from './MessageTimestamp';

export interface InlineNudgeCardProps {
  message: ChatMessage;
  /**
   * Optional handler invoked when the user taps the action chip on a
   * non-dismiss nudge. Receives the action descriptor returned by
   * `actOnNudge`. Default is no-op so the card stands on its own when
   * the embedding screen doesn't care to route.
   */
  onAct?: (action: { actionType: string; contactDID?: string }) => void;
}

interface NudgeMetadata {
  kind: 'nudge';
  nudgeId: string;
  nudgeKind: NudgeKind;
  title: string;
  body: string;
  tier: 1 | 2 | 3;
  actionLabel: string | null;
  actionType: 'message' | 'view' | 'dismiss' | null;
  contactDID: string | null;
  contactName: string | null;
}

function readMetadata(m: ChatMessage): NudgeMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'nudge') return null;
  if (typeof md.nudgeId !== 'string' || md.nudgeId === '') return null;
  if (typeof md.title !== 'string') return null;
  if (typeof md.body !== 'string') return null;
  const tierRaw = md.tier;
  const tier: 1 | 2 | 3 = tierRaw === 1 || tierRaw === 2 || tierRaw === 3 ? tierRaw : 3;
  return {
    kind: 'nudge',
    nudgeId: md.nudgeId,
    nudgeKind: (md.nudgeKind as NudgeKind) ?? 'general',
    title: md.title,
    body: md.body,
    tier,
    actionLabel: typeof md.actionLabel === 'string' ? md.actionLabel : null,
    actionType:
      md.actionType === 'message' || md.actionType === 'view' || md.actionType === 'dismiss'
        ? md.actionType
        : null,
    contactDID: typeof md.contactDID === 'string' ? md.contactDID : null,
    contactName: typeof md.contactName === 'string' ? md.contactName : null,
  };
}

const TIER_DOT: Record<1 | 2 | 3, string> = {
  1: colors.error, // fiduciary — interrupt
  2: colors.warning, // solicited — notify
  3: colors.textMuted, // engagement — quiet
};

export function InlineNudgeCard({ message, onAct }: InlineNudgeCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  const [resolved, setResolved] = useState<'acted' | 'dismissed' | null>(null);

  const onPressAction = useCallback(() => {
    if (meta === null || resolved !== null) return;
    const action = actOnNudge(meta.nudgeId);
    if (action !== null && onAct !== undefined) {
      const payload: { actionType: string; contactDID?: string } = {
        actionType: action.actionType,
      };
      if (action.contactDID !== undefined) payload.contactDID = action.contactDID;
      onAct(payload);
    }
    setResolved('acted');
  }, [meta, onAct, resolved]);

  const onPressDismiss = useCallback(() => {
    if (meta === null || resolved !== null) return;
    dismissNudge(meta.nudgeId);
    setResolved('dismissed');
  }, [meta, resolved]);

  if (meta === null) return null;

  const showAction = meta.actionLabel !== null && meta.actionType !== 'dismiss';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={[styles.tierDot, { backgroundColor: TIER_DOT[meta.tier] }]} />
        <Text style={styles.label}>{tierLabel(meta.tier)}</Text>
      </View>
      <Text style={styles.title}>{meta.title}</Text>
      <Text style={styles.body}>{meta.body}</Text>
      {meta.contactName !== null && (
        <Text style={styles.contactLine} numberOfLines={1}>
          {meta.contactName}
        </Text>
      )}
      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`nudge-dismiss-${meta.nudgeId}`}
            style={[styles.btn, styles.dismiss]}
            onPress={onPressDismiss}
            activeOpacity={0.7}
          >
            <Text style={styles.dismissText}>Dismiss</Text>
          </TouchableOpacity>
          {showAction && (
            <TouchableOpacity
              testID={`nudge-act-${meta.nudgeId}`}
              style={[styles.btn, styles.action]}
              onPress={onPressAction}
              activeOpacity={0.7}
            >
              <Text style={styles.actionText}>{meta.actionLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {resolved === 'acted' && <Text style={styles.statusLine}>Done.</Text>}
      {resolved === 'dismissed' && <Text style={styles.statusLine}>Dismissed.</Text>}
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

function tierLabel(tier: 1 | 2 | 3): string {
  switch (tier) {
    case 1:
      return 'IMPORTANT';
    case 2:
      return 'NUDGE';
    case 3:
      return 'SUGGESTION';
  }
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  tierDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: colors.textPrimary,
    marginBottom: 2,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  contactLine: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 88,
    alignItems: 'center',
  },
  action: {
    backgroundColor: colors.textPrimary,
  },
  actionText: {
    fontFamily: fonts.sansSemibold,
    color: colors.bgPrimary,
    fontSize: 14,
  },
  dismiss: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  dismissText: {
    fontFamily: fonts.sansMedium,
    color: colors.textPrimary,
    fontSize: 14,
  },
  statusLine: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
