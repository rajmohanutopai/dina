import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Alert } from 'react-native';

import {
  getActiveSubscriptions,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  type SubscriptionUIItem,
} from '../src/hooks/useSubscriptions';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

/**
 * Subscriptions screen (PSVC-4) — the owner's standing poll-mode watches.
 *
 * Each row is a durable subscription (PUSH §3.2 / Phase 0): Dina polls the
 * provider on a schedule and surfaces answers through the normal silence
 * tiers. The owner can pause (keep it, stop polling), resume, or cancel (end
 * it). Reads the in-process `WatchService` via `useSubscriptions`; refreshes on
 * focus (there is no subscribe API yet, and a subscription is usually created
 * moments before the user navigates here).
 */
export default function SubscriptionsScreen() {
  const [items, setItems] = useState<SubscriptionUIItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const refresh = useCallback(() => {
    void getActiveSubscriptions()
      .then(setItems)
      .finally(() => setHydrated(true));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const onToggle = useCallback(
    (item: SubscriptionUIItem) => {
      const action = item.status === 'paused' ? resumeSubscription : pauseSubscription;
      void action(item.watch_id).then(() => refresh());
    },
    [refresh],
  );

  const onCancel = useCallback(
    (item: SubscriptionUIItem) => {
      Alert.alert(
        'Cancel subscription?',
        `Dina will stop watching ${item.capability} from this provider. This can't be undone.`,
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Cancel it',
            style: 'destructive',
            onPress: () => {
              void cancelSubscription(item.watch_id).then(() => refresh());
            },
          },
        ],
        { cancelable: true },
      );
    },
    [refresh],
  );

  if (!hydrated) {
    return <View style={styles.container} testID="subscriptions-screen" />;
  }

  if (items.length === 0) {
    return (
      <View style={styles.container} testID="subscriptions-screen">
        <View style={styles.emptyState} testID="subscriptions-empty">
          <Ionicons
            name="radio-outline"
            size={40}
            color={colors.textMuted}
            style={{ marginBottom: spacing.md }}
          />
          <Text style={styles.emptyTitle}>No subscriptions yet</Text>
          <Text style={styles.emptyBody}>
            Ask Dina to watch something in Chat — like &ldquo;tell me if my flight is delayed&rdquo; — and
            it appears here as a standing subscription you control.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="subscriptions-screen">
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={items}
        keyExtractor={(item) => item.subscription_id}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderItem={({ item }) => (
          <SubscriptionRow item={item} onToggle={onToggle} onCancel={onCancel} />
        )}
      />
    </View>
  );
}

function SubscriptionRow({
  item,
  onToggle,
  onCancel,
}: {
  item: SubscriptionUIItem;
  onToggle: (item: SubscriptionUIItem) => void;
  onCancel: (item: SubscriptionUIItem) => void;
}) {
  const paused = item.status === 'paused';
  return (
    <View style={styles.row} testID={`subscription-row-${item.subscription_id}`}>
      <View style={styles.rowMain}>
        <Text style={styles.capability} numberOfLines={1}>
          {item.capability}
        </Text>
        {item.condition !== null ? (
          <Text style={styles.condition} numberOfLines={2}>
            {item.condition}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <Text
            style={paused ? styles.statusPaused : styles.statusActive}
            testID={`subscription-status-${item.subscription_id}`}
          >
            {paused ? 'Paused' : item.cadenceLabel}
          </Text>
          <View style={styles.personaBadge}>
            <Text style={styles.personaText}>{item.persona}</Text>
          </View>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          testID={`subscription-toggle-${item.subscription_id}`}
          onPress={() => onToggle(item)}
          accessibilityRole="button"
          accessibilityLabel={paused ? 'Resume subscription' : 'Pause subscription'}
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons
            name={paused ? 'play-outline' : 'pause-outline'}
            size={22}
            color={colors.accent}
          />
        </Pressable>
        <Pressable
          testID={`subscription-cancel-${item.subscription_id}`}
          onPress={() => onCancel(item)}
          accessibilityRole="button"
          accessibilityLabel="Cancel subscription"
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="trash-outline" size={20} color={colors.error} />
        </Pressable>
      </View>
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
  capability: { ...textStyles.bodyStrong, color: colors.textPrimary },
  condition: { ...textStyles.caption, color: colors.textMuted, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs, gap: spacing.sm },
  statusActive: { ...textStyles.caption, color: colors.accent },
  statusPaused: { ...textStyles.caption, color: colors.textMuted },
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
