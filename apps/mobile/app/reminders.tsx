import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, radius, shadows } from '../src/theme';

/**
 * Reminders tab — placeholder until the Core-side reminders endpoint
 * is wired.
 *
 * Review #18: this screen previously rendered `getUpcomingReminders()`
 * from `src/ai/memory.ts` — the legacy in-memory store that the live
 * `/remember` path no longer writes to (that path goes through Brain's
 * staging pipeline now). Users created reminders through chat, saw
 * nothing here, and assumed the feature was broken. An honest
 * placeholder beats a stale buffer until the Brain/Core surface for
 * listing reminders lands.
 */
export default function RemindersScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.emptyState}>
        <View style={styles.card}>
          <Text style={styles.icon}>{'\u25CB'}</Text>
          <Text style={styles.title}>Reminders</Text>
          <Text style={styles.subtitle}>Upcoming events and nudges</Text>
          <Text style={styles.subtitle}>Reminder listing from Brain staging is coming soon.</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  emptyState: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
  },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  icon: { fontSize: 32, color: colors.textMuted, marginBottom: spacing.md },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.textPrimary,
    letterSpacing: 0.3,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20,
    textAlign: 'center',
  },
});
