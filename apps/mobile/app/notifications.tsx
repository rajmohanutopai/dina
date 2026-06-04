/**
 * Activity tab — unified inbox of every surface (5.67).
 *
 * The bottom-tab + header label is "Activity"; this screen is the
 * event/action/safety surface (notifications, approvals, reminders,
 * nudges, service results). Shows reminders + approvals + nudges +
 * briefings + ask-approval cards in one chronological feed. Source of
 * truth is the brain-side inbox store (5.66) + the workflow-task
 * approval inbox (`useApprovalInbox`). Each notification row deep-links
 * back to the originating surface via the item's `deepLink` field; rows
 * with no deep link stay inert.
 *
 * Filter chips: Needs action / Unread / All / Reminders.
 *   - "Needs action" → ACTIONABLE approval cards (Deny / Approve Once /
 *     Approve right there) pulled from the pending approvals. This is
 *     the inline-actions surface — no navigation to a separate screen.
 *   - "All" → resolved approval cards + ALL notifications, newest-first.
 *   - "Unread" → unread notifications.
 *   - "Reminders" → reminder notifications.
 *
 * The filter is applied in-memory against the live subscriptions so
 * flipping is instant. Action-first order (spec 5.2 / 14.4): pending
 * safety decisions lead so Activity isn't just passive notifications.
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
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

import {
  useApprovalInbox,
  ApprovalActionCard,
  ResolvedApprovalCard,
  ApprovalsEmptyState,
  type InboxEntry,
  type ResolvedInboxEntry,
} from '../src/components/approval_inbox';
import { resolveSafeDeepLink } from '../src/notifications/deep_link';
import { type FilterKey } from '../src/notifications/screen_filter';
import { colors, radius, spacing, textStyles } from '../src/theme';

const FILTERS: readonly { key: FilterKey; label: string }[] = [
  // Action-first order (spec 5.2): pending safety decisions lead.
  { key: 'needs_action', label: 'Needs action' },
  { key: 'unread', label: 'Unread' },
  { key: 'all', label: 'All' },
  { key: 'reminder', label: 'Reminders' },
];

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const KIND_ICON: Record<NotificationKind, IoniconName> = {
  reminder: 'notifications-outline',
  approval: 'checkmark-circle-outline',
  nudge: 'chatbubble-ellipses-outline',
  briefing: 'newspaper-outline',
  ask_approval: 'shield-checkmark-outline',
};

/**
 * A single row in the unified Activity list. Discriminated so the
 * FlatList renderer can switch between the actionable approval card,
 * the read-only resolved card, and the standard notification row.
 */
type Row =
  | { t: 'pending'; entry: InboxEntry }
  | { t: 'resolved'; entry: ResolvedInboxEntry }
  | { t: 'notif'; item: NotificationItem };

function rowKey(row: Row): string {
  switch (row.t) {
    case 'pending':
      return `pending:${row.entry.id}`;
    case 'resolved':
      return `resolved:${row.entry.id}`;
    case 'notif':
      return `notif:${row.item.id}`;
  }
}

function rowTimestamp(row: Row): number {
  switch (row.t) {
    case 'pending':
      return row.entry.createdAt;
    case 'resolved':
      return row.entry.resolvedAt;
    case 'notif':
      return row.item.firedAt;
  }
}

export default function NotificationsScreen(): React.JSX.Element {
  const router = useRouter();
  // A `?filter=` deep link selects the initial tab. Approval notifications
  // route to `?filter=needs_action` so the actionable card is on screen,
  // not Activity's default "Unread". Unknown values fall back to 'unread'.
  const params = useLocalSearchParams<{ filter?: string }>();
  const paramFilter: FilterKey | null = FILTERS.some((f) => f.key === params.filter)
    ? (params.filter as FilterKey)
    : null;
  const [items, setItems] = useState<NotificationItem[]>(() => listNotifications());
  const [filter, setFilter] = useState<FilterKey>(paramFilter ?? 'unread');
  // Honour the deep-link filter even when Activity is already mounted
  // (e.g. an approval notification tapped while the screen is open).
  useEffect(() => {
    if (paramFilter !== null) setFilter(paramFilter);
  }, [paramFilter]);
  const [refreshing, setRefreshing] = useState(false);

  const approvals = useApprovalInbox();

  // Live subscription — re-pull on every event.  Cheap (N typically <100).
  useEffect(() => {
    const off = subscribeNotifications(() => {
      setItems(listNotifications());
    });
    return off;
  }, []);

  // Build the FlatList data per filter.
  const rows = useMemo<Row[]>(() => {
    switch (filter) {
      case 'needs_action':
        // ONLY the actionable pending approval cards (Deny / Approve
        // Once / Approve inline). This is the key inline-actions fix.
        return approvals.pending.map((entry) => ({ t: 'pending', entry }));
      case 'unread':
        return items
          .filter((i) => i.readAt === null)
          .map((item) => ({ t: 'notif', item }));
      case 'reminder':
        return items
          .filter((i) => i.kind === 'reminder')
          .map((item) => ({ t: 'notif', item }));
      case 'all': {
        // Merge pending cards + resolved cards + ALL notifications,
        // newest-first by their own timestamp.
        const merged: Row[] = [
          ...approvals.pending.map((entry): Row => ({ t: 'pending', entry })),
          ...approvals.resolved.map((entry): Row => ({ t: 'resolved', entry })),
          ...items.map((item): Row => ({ t: 'notif', item })),
        ];
        merged.sort((a, b) => rowTimestamp(b) - rowTimestamp(a));
        return merged;
      }
    }
  }, [filter, items, approvals.pending, approvals.resolved]);

  const unreadCount = getUnreadCount();
  const pendingCount = approvals.pending.length;

  const emptyTitle =
    items.length === 0 || filter !== 'unread' ? 'No notifications yet' : 'All caught up';
  const emptySubtitle =
    items.length === 0
      ? 'Reminders, approvals, and chat events will appear here.'
      : filter === 'unread'
        ? 'You’ve read everything in this view.'
        : filter === 'reminder'
          ? 'Reminders Dina sets from your Remember notes will appear here.'
          : 'Reminders, approvals, and chat events will appear here.';

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      // Cold-replay from the persistent log if one is wired.  Falls
      // back to a no-op when no repo is installed; either way ends
      // up re-listing the live store.  Also re-pull the approval inbox.
      await Promise.all([hydrateNotifications({ force: true }), approvals.reload()]);
      setItems(listNotifications());
    } finally {
      setRefreshing(false);
    }
  };

  const onPressNotif = (item: NotificationItem): void => {
    if (item.readAt === null) markNotificationRead(item.id);
    const link = item.deepLink;
    if (link === undefined || link === '') return;
    // `resolveSafeDeepLink` normalises the link (Brain emits
    // `dina://approvals/<id>`, which now maps to `/notifications` — the
    // inline approval cards on the Needs-action filter cover the action)
    // AND allowlists it — external schemes + sensitive routes are
    // refused (P1.3). A rejected link simply doesn't navigate.
    const safe = resolveSafeDeepLink(link);
    if (safe !== null) router.push(safe as never);
  };

  return (
    <View style={styles.container}>
      {/* A genuine approval-load failure is only relevant when the user is
          actually looking at approvals (Needs action). Scoping it here
          keeps a flaky/late approval load from blocking Unread / All /
          Reminders, which load independently. The benign "not ready yet"
          case sets no error (see useApprovalInbox) — the empty state
          covers it. */}
      {approvals.error !== null && filter === 'needs_action' ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{approvals.error}</Text>
        </View>
      ) : null}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count =
            f.key === 'unread' && unreadCount > 0
              ? unreadCount
              : f.key === 'needs_action' && pendingCount > 0
                ? pendingCount
                : 0;
          return (
            <Pressable
              key={f.key}
              testID={`filter-${f.key}`}
              onPress={() => setFilter(f.key)}
              accessibilityRole="button"
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {f.label}
                {count > 0 ? ` · ${count}` : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          filter === 'needs_action' ? (
            <ApprovalsEmptyState />
          ) : (
            <View style={styles.empty}>
              <Ionicons
                name="checkmark-done-outline"
                size={32}
                color={colors.textMuted}
                style={{ marginBottom: spacing.sm }}
              />
              <Text style={styles.emptyText}>{emptyTitle}</Text>
              {/* The bare "No notifications yet" line gave a first-time
                  user no sense of what *would* live here — they'd guess
                  push messages? alerts? Each filter has a different
                  surface so the hint is filter-aware. */}
              <Text style={styles.emptySubtitle}>{emptySubtitle}</Text>
            </View>
          )
        }
        renderItem={({ item: row }) => {
          if (row.t === 'pending') {
            const entry = row.entry;
            return (
              <ApprovalActionCard
                entry={entry}
                busy={approvals.busyId === entry.id}
                supportsSessionScope={approvals.supportsSessionScope(entry)}
                onApprove={(scope) => approvals.approve(entry, scope)}
                onApproveSimple={() => approvals.approve(entry)}
                onDeny={() => approvals.deny(entry)}
              />
            );
          }
          if (row.t === 'resolved') {
            return <ResolvedApprovalCard entry={row.entry} />;
          }
          const item = row.item;
          const isUnread = item.readAt === null;
          return (
            <Pressable
              testID={`notif-row-${item.id}`}
              onPress={() => onPressNotif(item)}
              accessibilityRole="button"
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
  errorBanner: {
    backgroundColor: colors.errorBgSoft,
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  errorText: {
    ...textStyles.bodySmall,
    color: colors.error,
  },
});
