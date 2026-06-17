/**
 * "No Home Node reachable" — the web thin-client's boot-failure screen.
 *
 * On web, Dina is a thin client of a home-node-lite brain-server; it has
 * no local node to fall back to. When `bootWebThinNode` can't reach the
 * brain-server (server down) or the node has no identity yet, there is
 * nothing to show but an honest "can't reach your Home Node" state with a
 * Retry (design D2). This is web-only — native always has its in-process
 * node and never renders this.
 */

import React from 'react';
import { Pressable, Text, View, StyleSheet, Platform } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

export function NoHomeNodeScreen({
  detail,
  onRetry,
}: {
  detail?: string;
  onRetry?: () => void;
}): React.ReactElement {
  const retry =
    onRetry ??
    ((): void => {
      // Default web retry: a full reload re-runs the boot probe.
      if (Platform.OS === 'web' && typeof globalThis !== 'undefined') {
        (globalThis as { location?: { reload?: () => void } }).location?.reload?.();
      }
    });

  return (
    <View style={styles.root} testID="no-home-node-screen">
      <Text style={styles.brand}>Dina</Text>
      <Text style={styles.headline}>No Home Node reachable</Text>
      <Text style={styles.sub}>
        Dina on the web connects to your Home Node. It isn&apos;t responding right now — check that
        your node is running, then try again.
      </Text>
      {detail !== undefined && detail !== '' ? (
        <Text style={styles.detail} testID="no-home-node-detail">
          {detail}
        </Text>
      ) : null}
      <Pressable style={styles.button} onPress={retry} testID="no-home-node-retry">
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.bgPrimary,
  },
  brand: {
    ...textStyles.wordmark,
    color: colors.accent,
    marginBottom: spacing.sm,
  },
  headline: {
    ...textStyles.h2,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  sub: {
    ...textStyles.body,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 420,
    marginBottom: spacing.lg,
  },
  detail: {
    ...textStyles.caption,
    color: colors.textMuted,
    textAlign: 'center',
    maxWidth: 420,
    marginBottom: spacing.lg,
  },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  buttonText: {
    ...textStyles.button,
    color: colors.bgPrimary,
  },
});
