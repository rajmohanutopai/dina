/**
 * `InlineReminderCard` — chat-thread inline renderer for fired
 * reminders (5.64). The `useReminderFireWatcher` hook posts a
 * `'reminder'`-typed thread message when a pending reminder's
 * `due_at` elapses; this card renders it with relative time + Mark
 * done / Snooze 1h actions.
 *
 * Mark done → `completeReminder(id)`. If the reminder was recurring,
 * the service auto-creates the next occurrence; the card just shows
 * "Done." regardless. Snooze → `snoozeReminder(id, 60*60*1000)` and
 * we re-post a new fire-time card on the next watcher tick. The
 * card disables both buttons after first action; the message stays
 * in the thread for chronological reference.
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ChatMessage } from '@dina/brain/chat';
import { completeReminder, snoozeReminder } from '@dina/core/reminders';
import { addSystemMessage } from '@dina/brain/chat';
import { colors, fonts, radius, spacing } from '../theme';
import { MessageTimestamp } from './MessageTimestamp';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const SNOOZE_MS = 60 * 60 * 1000; // 1h

export interface InlineReminderCardProps {
  message: ChatMessage;
}

interface ReminderMetadata {
  kind: 'reminder';
  reminderId: string;
  shortId: string;
  reminderKind: string;
  persona: string;
  dueAt: number;
  recurring: string;
}

function readMetadata(m: ChatMessage): ReminderMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'reminder') return null;
  if (typeof md.reminderId !== 'string' || md.reminderId === '') return null;
  if (typeof md.dueAt !== 'number') return null;
  return {
    kind: 'reminder',
    reminderId: md.reminderId,
    shortId: typeof md.shortId === 'string' ? md.shortId : '',
    reminderKind: typeof md.reminderKind === 'string' ? md.reminderKind : 'manual',
    persona: typeof md.persona === 'string' ? md.persona : '',
    dueAt: md.dueAt,
    recurring: typeof md.recurring === 'string' ? md.recurring : '',
  };
}

function formatRelative(dueAtMs: number, nowMs: number = Date.now()): string {
  const deltaSec = Math.round((dueAtMs - nowMs) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 60) return deltaSec >= 0 ? 'now' : 'just now';
  const min = Math.round(abs / 60);
  if (min < 60) return deltaSec >= 0 ? `in ${min} min` : `${min} min ago`;
  const hr = Math.round(abs / 3600);
  if (hr < 24) return deltaSec >= 0 ? `in ${hr} h` : `${hr} h ago`;
  const day = Math.round(abs / 86400);
  return deltaSec >= 0 ? `in ${day} d` : `${day} d ago`;
}

const KIND_ICON: Record<string, IoniconName> = {
  birthday: 'gift-outline',
  appointment: 'calendar-outline',
  payment_due: 'card-outline',
  deadline: 'alarm-outline',
  arrival: 'walk-outline',
  custom: 'notifications-outline',
};

export function InlineReminderCard({ message }: InlineReminderCardProps): React.JSX.Element | null {
  const meta = readMetadata(message);
  const [resolved, setResolved] = useState<'done' | 'snoozed' | null>(null);

  const onMarkDone = useCallback(() => {
    if (meta === null || resolved !== null) return;
    try {
      completeReminder(meta.reminderId);
      setResolved('done');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      addSystemMessage(message.threadId, `Couldn't mark done: ${detail}`);
    }
  }, [meta, message.threadId, resolved]);

  const onSnooze = useCallback(() => {
    if (meta === null || resolved !== null) return;
    try {
      snoozeReminder(meta.reminderId, SNOOZE_MS);
      addSystemMessage(message.threadId, `Snoozed for 1 hour.`);
      setResolved('snoozed');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      addSystemMessage(message.threadId, `Couldn't snooze: ${detail}`);
    }
  }, [meta, message.threadId, resolved]);

  if (meta === null) return null;

  const iconName: IoniconName =
    KIND_ICON[meta.reminderKind] ?? 'notifications-outline';
  const relative = formatRelative(meta.dueAt);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name={iconName} size={16} color={colors.textMuted} />
        <Text style={styles.label}>REMINDER · {relative.toUpperCase()}</Text>
      </View>
      <Text style={styles.body}>{message.content}</Text>
      {meta.persona !== '' && meta.persona !== 'general' && (
        <Text style={styles.personaLine}>/{meta.persona}</Text>
      )}
      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`reminder-snooze-${meta.reminderId}`}
            style={[styles.btn, styles.snooze]}
            onPress={onSnooze}
            activeOpacity={0.7}
          >
            <Text style={styles.snoozeText}>Snooze 1h</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`reminder-done-${meta.reminderId}`}
            style={[styles.btn, styles.done]}
            onPress={onMarkDone}
            activeOpacity={0.7}
          >
            <Text style={styles.doneText}>Mark done</Text>
          </TouchableOpacity>
        </View>
      )}
      {resolved === 'done' && <Text style={styles.statusLine}>Done.</Text>}
      {resolved === 'snoozed' && <Text style={styles.statusLine}>Snoozed.</Text>}
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
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
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  body: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    color: colors.textPrimary,
    lineHeight: 22,
    marginBottom: spacing.xs,
  },
  personaLine: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 88,
    alignItems: 'center',
  },
  done: {
    backgroundColor: colors.textPrimary,
  },
  doneText: {
    fontFamily: fonts.sansSemibold,
    color: colors.bgPrimary,
    fontSize: 14,
  },
  snooze: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  snoozeText: {
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
