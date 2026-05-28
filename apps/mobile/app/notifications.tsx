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

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, RefreshControl } from 'react-native';

import {
  getUnreadCount,
  hydrateNotifications,
  listNotifications,
  markNotificationRead,
  subscribeNotifications,
  type NotificationItem,
  type NotificationKind,
} from '@dina/brain/notifications';

import { resolveSafeDeepLink } from '../src/notifications/deep_link';
import { applyNotificationFilter, type FilterKey } from '../src/notifications/screen_filter';
import { colors, radius, spacing, textStyles } from '../src/theme';

const FILTERS: readonly { key: FilterKey; label: string }[] = [
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
    const link = item.deepLink;
    if (link === undefined || link === '') return;
    // `resolveSafeDeepLink` normalises the link (Brain emits
    // `dina://approvals/<id>`; there's no `[id].tsx` route, so it maps to the
    // `/approvals` index) AND allowlists it — external schemes + sensitive
    // routes are refused (P1.3). A rejected link simply doesn't navigate.
    const safe = resolveSafeDeepLink(link);
    if (safe !== null) router.push(safe as never);
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

/**
 * Translate a Brain-emitted deep link into a route the mobile app's
 * Expo Router knows about. Keeps the deep-link contract on the wire
 * stable (Brain still emits `dina://approvals/<id>` for backwards
 * compatibility with admin CLI / web) while letting mobile drop the
 * id and land on the index page that lists all open approvals.
 *
 * Adding a dynamic `app/approvals/[id].tsx` route would be the more
 * direct fix; until then this normaliser keeps the notification tap
 * from landing on "Unmatched Route". Pass-through for any other shape.
 */
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
  chipText: textStyles.bodySmall,
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
    backgroundColor: colors.bgTertiary,
  },
  rowBody: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  rowTitle: {
    ...textStyles.bodyStrong,
    marginBottom: 2,
  },
  rowSubtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  rowMeta: {
    ...textStyles.tiny,
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
    ...textStyles.body,
    color: colors.textMuted,
  },
  emptySubtitle: {
    ...textStyles.bodySmall,
    marginTop: spacing.xs,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    opacity: 0.8,
  },
});
