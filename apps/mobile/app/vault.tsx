import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, radius, shadows } from '../src/theme';

/**
 * Vault tab — placeholder until the Core-side "list vault items"
 * endpoint lands.
 *
 * Issue #16: this screen previously rendered `getAllMemories()` from
 * `src/ai/memory.ts` — a legacy in-memory store that the live
 * `/remember` path no longer writes to (that path goes through Brain's
 * staging pipeline now). Showing that list was actively misleading —
 * users saved something, saw "0" on this tab, and thought the write had
 * failed. Until the Core endpoint lands we show an honest "coming soon"
 * card rather than a stale buffer.
 */
export default function VaultScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.emptyState}>
        <View style={styles.card}>
          <Text style={styles.icon}>{'\u229E'}</Text>
          <Text style={styles.title}>Vault</Text>
          <Text style={styles.subtitle}>Your memories, encrypted and private</Text>
          <Text style={styles.subtitle}>Vault listing from Brain staging is coming soon.</Text>
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
