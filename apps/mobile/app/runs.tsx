import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Alert } from 'react-native';

import { getActiveRuns, pauseRun, resumeRun, stopRun, type RunUIItem } from '../src/hooks/useRuns';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

/**
 * Interactive runs screen (ISVC-9) — the owner's live provider sessions.
 *
 * Each row is a bounded interactive run (INTERACTIVE_SERVICES §5): Dina pulls
 * from a provider on a pacing loop, staging each response through the silence
 * tiers. The owner can pause/resume the loop or stop a run. Per-message
 * decisions (approve/deny an action) surface through the Activity approval
 * inbox. Reads the in-process `RunService` via `useRuns`; refreshes on focus.
 */
export default function RunsScreen() {
  const [items, setItems] = useState<RunUIItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const refresh = useCallback(() => {
    void getActiveRuns()
      .then(setItems)
      .finally(() => setHydrated(true));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const onToggle = useCallback(
    (item: RunUIItem) => {
      const action = item.state === 'paused' ? resumeRun : pauseRun;
      void action(item.run_id).then(() => refresh());
    },
    [refresh],
  );

  const onStop = useCallback(
    (item: RunUIItem) => {
      Alert.alert(
        'Stop this run?',
        'Dina will drain any pending work and end the session. This can’t be undone.',
        [
          { text: 'Keep running', style: 'cancel' },
          {
            text: 'Stop',
            style: 'destructive',
            onPress: () => {
              void stopRun(item.run_id).then(() => refresh());
            },
          },
        ],
        { cancelable: true },
      );
    },
    [refresh],
  );

  if (!hydrated) {
    return <View style={styles.container} testID="runs-screen" />;
  }

  if (items.length === 0) {
    return (
      <View style={styles.container} testID="runs-screen">
        <View style={styles.emptyState} testID="runs-empty">
          <Ionicons
            name="sync-circle-outline"
            size={40}
            color={colors.textMuted}
            style={{ marginBottom: spacing.md }}
          />
          <Text style={styles.emptyTitle}>No interactive runs</Text>
          <Text style={styles.emptyBody}>
            When you start an interactive session with a provider, it appears here so you can pause,
            resume, or stop it.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="runs-screen">
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={items}
        keyExtractor={(item) => item.run_id}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderItem={({ item }) => <RunRow item={item} onToggle={onToggle} onStop={onStop} />}
      />
    </View>
  );
}

function RunRow({
  item,
  onToggle,
  onStop,
}: {
  item: RunUIItem;
  onToggle: (item: RunUIItem) => void;
  onStop: (item: RunUIItem) => void;
}) {
  const paused = item.state === 'paused';
  return (
    <View style={styles.row} testID={`run-row-${item.run_id}`}>
      <View style={styles.rowMain}>
        <Text style={styles.provider} numberOfLines={1}>
          {item.provider_did}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.state} testID={`run-state-${item.run_id}`}>
            {item.state}
          </Text>
          <Text style={styles.progress}>{item.progressLabel}</Text>
          <View style={styles.personaBadge}>
            <Text style={styles.personaText}>{item.persona}</Text>
          </View>
        </View>
      </View>
      {item.terminal ? null : (
        <View style={styles.actions}>
          <Pressable
            testID={`run-toggle-${item.run_id}`}
            onPress={() => onToggle(item)}
            accessibilityRole="button"
            accessibilityLabel={paused ? 'Resume run' : 'Pause run'}
            hitSlop={8}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name={paused ? 'play-outline' : 'pause-outline'} size={22} color={colors.accent} />
          </Pressable>
          <Pressable
            testID={`run-stop-${item.run_id}`}
            onPress={() => onStop(item)}
            accessibilityRole="button"
            accessibilityLabel="Stop run"
            hitSlop={8}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name="stop-circle-outline" size={22} color={colors.error} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  list: { flex: 1 },
  listContent: { padding: spacing.md, paddingBottom: spacing.xl },
  separator: { height: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    ...shadows.sm,
  },
  rowMain: { flex: 1 },
  provider: { ...textStyles.bodyStrong, color: colors.textPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs, gap: spacing.sm },
  state: { ...textStyles.caption, color: colors.accent },
  progress: { ...textStyles.caption, color: colors.textMuted },
  personaBadge: {
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  personaText: { ...textStyles.caption, color: colors.textMuted },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginLeft: spacing.sm },
  iconBtn: { padding: spacing.xs },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { ...textStyles.bodyStrong, color: colors.textPrimary, marginBottom: spacing.sm },
  emptyBody: { ...textStyles.body, color: colors.textMuted, textAlign: 'center' },
});
