/**
 * Notifications tab — unified inbox of every surface (5.67).
 *
 * Shows reminders + approvals + nudges + briefings + ask-approval
 * cards in one chronological feed.  Source of truth is the
 * brain-side inbox store (5.66).  Each row deep-links back to the
 * originating surface via the item's `deepLink` field; rows with no
 * deep link stay inert.
 *
 * Filter chips: All / Unread / Reminders / Approvals.  The filter is
 * applied in-memory against the live subscription so flipping is
 * instant.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  getUnreadCount,
  hydrateNotifications,
  listNotifications,
  markNotificationRead,
  subscribeNotifications,
  type NotificationItem,
  type NotificationKind,
} from '@dina/brain/src/notifications/inbox';
import { applyNotificationFilter, type FilterKey } from '../src/notifications/screen_filter';
import { colors, fonts, radius, spacing } from '../src/theme';

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'reminder', label: 'Reminders' },
  { key: 'approval', label: 'Approvals' },
];

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const KIND_ICON: Record<NotificationKind, IoniconName> = {
  reminder: 'notifications-outline',
  approval: 'checkmark-circle-outline',
  nudge: 'chatbubble-ellipses-outline',
  briefing: 'newspaper-outline',
  ask_approval: 'shield-checkmark-outline',
};

export default function NotificationsScreen(): React.JSX.Element {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>(() => listNotifications());
  const [filter, setFilter] = useState<FilterKey>('all');
  const [refreshing, setRefreshing] = useState(false);

  // Live subscription — re-pull on every event.  Cheap (N typically <100).
  useEffect(() => {
    const off = subscribeNotifications(() => {
      setItems(listNotifications());
    });
    return off;
  }, []);

  const filtered = useMemo(() => applyNotificationFilter(items, filter), [items, filter]);
  const unreadCount = getUnreadCount();

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      // Cold-replay from the persistent log if one is wired.  Falls
      // back to a no-op when no repo is installed; either way ends
      // up re-listing the live store.
      await hydrateNotifications({ force: true });
      setItems(listNotifications());
    } finally {
      setRefreshing(false);
    }
  };

  const onPress = (item: NotificationItem): void => {
    if (item.readAt === null) markNotificationRead(item.id);
    if (item.deepLink !== undefined && item.deepLink !== '') {
      router.push(item.deepLink as never);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const showCount = f.key === 'unread' && unreadCount > 0;
          return (
            <Pressable
              key={f.key}
              testID={`filter-${f.key}`}
              onPress={() => setFilter(f.key)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {f.label}
                {showCount ? ` · ${unreadCount}` : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              name="checkmark-done-outline"
              size={32}
              color={colors.textMuted}
              style={{ marginBottom: spacing.sm }}
            />
            <Text style={styles.emptyText}>
              {filter === 'unread' ? 'All caught up' : 'No notifications yet'}
            </Text>
            {/* The bare "No notifications yet" line gave a first-time
                user no sense of what *would* live here — they'd guess
                push messages? alerts? Each filter has a different
                surface so the hint is filter-aware. */}
            <Text style={styles.emptySubtitle}>
              {filter === 'unread'
                ? 'You’ve read everything in this view.'
                : filter === 'reminder'
                  ? 'Reminders Dina sets from your Remember notes will appear here.'
                  : filter === 'approval'
                    ? 'Approval requests from agents and services will appear here.'
                    : 'Reminders, approvals, and chat events will appear here.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isUnread = item.readAt === null;
          return (
            <Pressable
              testID={`notif-row-${item.id}`}
              onPress={() => onPress(item)}
              style={({ pressed }) => [
                styles.row,
                isUnread && styles.rowUnread,
                pressed && styles.rowPressed,
              ]}
              disabled={item.deepLink === undefined && !isUnread}
            >
              <View style={[styles.iconWrap, isUnread && styles.iconWrapUnread]}>
                <Ionicons
                  name={KIND_ICON[item.kind]}
                  size={18}
                  color={isUnread ? colors.accent : colors.textSecondary}
                />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                {item.body !== '' && (
                  <Text style={styles.rowSubtitle} numberOfLines={2}>
                    {item.body}
                  </Text>
                )}
                <Text style={styles.rowMeta}>{formatRelative(item.firedAt)}</Text>
              </View>
              {isUnread && <View style={styles.dot} />}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function formatRelative(ms: number, now: number = Date.now()): string {
  const delta = Math.round((now - ms) / 1000);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
  return `${Math.round(delta / 86400)} d ago`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  chipActive: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary,
  },
  chipText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textPrimary,
  },
  chipTextActive: {
    color: colors.bgPrimary,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xxl,
  },
  separator: {
    height: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowUnread: {
    backgroundColor: colors.bgSecondary,
    borderColor: 'rgba(28,25,23,0.15)',
  },
  rowPressed: {
    backgroundColor: colors.bgTertiary,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm + 2,
  },
  iconWrapUnread: {
    backgroundColor: '#F0EAE0',
  },
  rowBody: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  rowTitle: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: colors.textPrimary,
    marginBottom: 2,
  },
  rowSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
    marginBottom: 4,
  },
  rowMeta: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    marginTop: 14,
  },
  empty: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  emptyText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textMuted,
  },
  emptySubtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.xs,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    lineHeight: 18,
    opacity: 0.8,
  },
});
