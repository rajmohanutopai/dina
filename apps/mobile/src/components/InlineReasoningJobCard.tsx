/**
 * Mobile projection of a Core-owned connected-Brain job.
 *
 * The card never trusts lifecycle metadata as authority. Cancel goes through
 * the boot-minted owner client; every other transition is polled back from
 * Core and patched into this durable chat row.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';

import { cancelConnectedBrainChatJob } from '../reasoning/connected_brain_chat';
import { colors, radius, shadows, spacing, textStyles } from '../theme';

import { MessageTimestamp } from './MessageTimestamp';

export interface InlineReasoningJobCardProps {
  message: ChatMessage;
}

export function InlineReasoningJobCard({
  message,
}: InlineReasoningJobCardProps): React.JSX.Element | null {
  const lifecycle = readLifecycle(message);
  const [cancelling, setCancelling] = useState(false);
  if (lifecycle === null || lifecycle.kind !== 'reasoning_job') return null;
  if (lifecycle.status === 'complete') return null;

  const terminal =
    lifecycle.status === 'failed' ||
    lifecycle.status === 'cancelled' ||
    lifecycle.status === 'expired';
  const label =
    lifecycle.status === 'queued'
      ? 'Waiting for connected agent'
      : lifecycle.status === 'working'
        ? 'Connected agent is working'
        : lifecycle.status === 'pending_approval'
          ? 'Waiting for your approval'
          : lifecycle.status === 'cancelled'
            ? 'Request cancelled'
            : lifecycle.status === 'expired'
              ? 'Request expired'
              : 'Connected-agent request failed';

  const onCancel = useCallback(async (): Promise<void> => {
    if (terminal || cancelling) return;
    setCancelling(true);
    try {
      await cancelConnectedBrainChatJob(lifecycle.taskId, message.threadId);
    } finally {
      setCancelling(false);
    }
  }, [cancelling, lifecycle.taskId, message.threadId, terminal]);

  return (
    <View
      testID={`chat-card-reasoning-job-${lifecycle.status}`}
      style={[styles.card, terminal && styles.terminalCard]}
    >
      <View style={styles.heading}>
        {terminal ? (
          <Ionicons name="alert-circle-outline" size={18} color={colors.textMuted} />
        ) : (
          <ActivityIndicator size="small" color={colors.textPrimary} />
        )}
        <Text style={styles.title}>{label}</Text>
      </View>
      <Text style={styles.body}>{message.content}</Text>
      {!terminal ? (
        <TouchableOpacity
          testID="reasoning-job-cancel"
          accessibilityRole="button"
          accessibilityLabel="Cancel connected-agent request"
          disabled={cancelling}
          onPress={() => {
            void onCancel();
          }}
          style={styles.cancelButton}
        >
          <Text style={styles.cancelText}>{cancelling ? 'Cancelling...' : 'Cancel'}</Text>
        </TouchableOpacity>
      ) : null}
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginHorizontal: spacing.sm,
    marginVertical: spacing.xs,
    padding: spacing.md,
    ...shadows.sm,
  },
  terminalCard: {
    backgroundColor: colors.bgTertiary,
  },
  heading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  title: {
    ...textStyles.bodyStrong,
    color: colors.textPrimary,
    flex: 1,
  },
  body: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  cancelButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  cancelText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
});
