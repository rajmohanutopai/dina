import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, SectionList, Pressable, Alert } from 'react-native';

import {
  getUpcomingReminders,
  groupByDay,
  dismissReminder,
  type ReminderUIItem,
  type ReminderGroup,
} from '../src/hooks/useReminders';
import { colors, fonts, spacing, radius, shadows } from '../src/theme';

/**
 * Reminders tab — shows upcoming + overdue reminders from Brain's
 * staging pipeline.
 *
 * `useReminders` reads from `@dina/core/reminders` —
 * the same store `post_publish.handlePostPublish → planReminders` writes
 * to — so the tab surfaces what the chat created.
 *
 * Refresh on focus: the reminder service has no subscribe API today,
 * and reminders are usually created from chat in the seconds before
 * the user switches tabs. A focus-time re-read is good enough.
 */
export default function RemindersScreen() {
  const [sections, setSections] = useState<ReminderGroup[]>([]);

  const refresh = useCallback(() => {
    setSections(groupByDay(getUpcomingReminders()));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const onDismiss = useCallback(
    (item: ReminderUIItem) => {
      Alert.alert(
        'Dismiss reminder?',
        item.message,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Dismiss',
            style: 'destructive',
            onPress: () => {
              dismissReminder(item.id);
              refresh();
            },
          },
        ],
        { cancelable: true },
      );
    },
    [refresh],
  );

  if (sections.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyState}>
          <Ionicons
            name="notifications-outline"
            size={40}
            color={colors.textMuted}
            style={{ marginBottom: spacing.md }}
          />
          <Text style={styles.emptyTitle}>No reminders yet</Text>
          <Text style={styles.emptyBody}>
            Tell Dina about an event in Chat — pick{' '}
            <Text style={styles.code}>Remember</Text> and any dates inside will turn into
            reminders here.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SectionList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        sections={sections.map((g) => ({ title: g.label, data: g.reminders }))}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => <ReminderRow item={item} onDismiss={onDismiss} />}
      />
    </View>
  );
}

function ReminderRow({
  item,
  onDismiss,
}: {
  item: ReminderUIItem;
  onDismiss: (item: ReminderUIItem) => void;
}) {
  const dueLabelStyle = item.isOverdue ? styles.dueOverdue : styles.due;
  return (
    <Pressable
      onLongPress={() => onDismiss(item)}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityLabel={`Reminder: ${item.message}. ${item.dueLabel}. Long-press to dismiss.`}
    >
      <View style={styles.rowMain}>
        <Text style={styles.message} numberOfLines={3}>
          {item.message}
        </Text>
        <View style={styles.metaRow}>
          <Text style={dueLabelStyle}>
            {formatTime(item.dueAt)} · {item.dueLabel}
          </Text>
          <View style={styles.personaBadge}>
            <Text style={styles.personaText}>{item.persona}</Text>
          </View>
          {item.isRecurring ? (
            <Text style={styles.recurring}>{item.recurringLabel}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hours = d.getHours();
  const mins = d.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${String(mins).padStart(2, '0')} ${ampm}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  sectionHeader: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.textMuted,
    textTransform: 'uppercase',
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bgPrimary,
  },
  separator: {
    height: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...shadows.sm,
  },
  rowPressed: {
    backgroundColor: colors.bgTertiary,
  },
  rowMain: { flex: 1 },
  message: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  due: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  dueOverdue: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.error,
  },
  personaBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.sm,
  },
  personaText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    color: colors.textSecondary,
    letterSpacing: 0.3,
    textTransform: 'lowercase',
  },
  recurring: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.textPrimary,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 20,
    textAlign: 'center',
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.textPrimary,
    backgroundColor: colors.bgTertiary,
    paddingHorizontal: 4,
    borderRadius: 3,
  },
});
