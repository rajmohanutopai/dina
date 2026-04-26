/**
 * Notifications tab — unified inbox of every surface (5.67).
 *
 * Shows reminders + approvals + nudges + briefings + ask-approval
 * cards in one chronological feed. Source of truth is the brain-side
 * inbox store (5.66). Each row deep-links back to the originating
 * surface via the item's `deepLink` field; rows with no deep link
 * stay inert.
 *
 * Filter chips: All / Unread / Reminders / Approvals. The filter is
 * applied in-memory against the live subscription so flipping is
 * instant.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
} from 'react-native';
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
import {
  applyNotificationFilter,
  type FilterKey,
} from '../src/notifications/screen_filter';
import { colors, fonts, radius, spacing } from '../src/theme';

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'reminder', label: 'Reminders' },
  { key: 'approval', label: 'Approvals' },
];

const KIND_ICON: Record<NotificationKind, string> = {
  reminder: '\u{1F514}', // 🔔
  approval: '\u{2705}', // ✅
  nudge: '\u{1F4AC}', // 💬
  briefing: '\u{1F4F0}', // 📰
  ask_approval: '\u{2705}',
};

export default function NotificationsScreen(): React.JSX.Element {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>(() => listNotifications());
  const [filter, setFilter] = useState<FilterKey>('all');
  const [refreshing, setRefreshing] = useState(false);

  // Live subscription — re-pull on every event. Cheap (N typically <100).
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
      // Cold-replay from the persistent log if one is wired. Falls
      // back to a no-op when no repo is installed; either way ends up
      // re-listing the live store.
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
      <View style={styles.header}>
        <Text style={styles.title}>Notifications</Text>
        {unreadCount > 0 && (
          <Text style={styles.unreadBadge}>
            {unreadCount} unread
          </Text>
        )}
      </View>
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            testID={`filter-${f.key}`}
            onPress={() => setFilter(f.key)}
            style={[styles.chip, filter === f.key && styles.chipActive]}
          >
            <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {filter === 'unread' ? 'All caught up.' : 'No notifications. Pull down to refresh.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`notif-row-${item.id}`}
            onPress={() => onPress(item)}
            style={[styles.row, item.readAt === null && styles.rowUnread]}
            disabled={item.deepLink === undefined && item.readAt !== null}
          >
            <Text style={styles.icon}>{KIND_ICON[item.kind]}</Text>
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
            {item.readAt === null && <View style={styles.dot} />}
          </Pressable>
        )}
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    fontFamily: fonts.serif,
  },
  unreadBadge: {
    fontSize: 13,
    color: colors.textMuted,
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
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
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  chipTextActive: {
    color: colors.bgPrimary,
  },
  list: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowUnread: {
    backgroundColor: colors.bgSecondary,
    borderColor: colors.accent,
  },
  icon: {
    fontSize: 20,
    marginRight: spacing.sm,
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  rowSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
    marginBottom: 4,
  },
  rowMeta: {
    fontSize: 11,
    color: colors.textMuted,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    marginTop: spacing.xs,
    marginLeft: spacing.sm,
  },
  empty: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
