/**
 * Approval inbox — list of pending `workflow_task kind=approval` tasks
 * that need the operator's review before execution.
 *
 * Data flow: the `useServiceInbox` hook wraps the paired Core's
 * `listWorkflowTasks({kind:'approval', state:'pending_approval'})` call;
 * the two actions (approve / deny) forward to the Core client.
 * Refresh on mount + focus + pull-to-refresh.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { subscribeNotifications } from '@dina/brain/notifications';

import { colors, spacing, radius, shadows, textStyles } from '../src/theme';
import {
  listPendingApprovals,
  listResolvedApprovals,
  approvePending,
  denyPending,
  InboxNotConfiguredError,
  type InboxEntry,
  type ResolvedInboxEntry,
} from '../src/hooks/useServiceInbox';
import { openPersonaDB, isPersistenceReady } from '../src/storage/init';

/**
 * Which view is showing. `pending` is the DEFAULT and first tab — it's
 * the actionable inbox. `completed` is a read-only history of resolved
 * approvals (approved / denied / expired), newest-first.
 */
type ApprovalsTab = 'pending' | 'completed';

const TABS: readonly { key: ApprovalsTab; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
];

export default function ApprovalsScreen() {
  const [tab, setTab] = useState<ApprovalsTab>('pending');
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [resolved, setResolved] = useState<ResolvedInboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErrorMessage(null);
    try {
      // Fetch both buckets together so switching tabs is instant (no
      // per-tab spinner) and a resolution on one surface is reflected in
      // both lists on the next refresh. Both are cheap in-process reads.
      const [pendingList, resolvedList] = await Promise.all([
        listPendingApprovals(50),
        listResolvedApprovals(50),
      ]);
      setEntries(pendingList);
      setResolved(resolvedList);
    } catch (err) {
      if (err instanceof InboxNotConfiguredError) {
        // The inbox client is wired during boot (same block as the
        // service-config client); a null here means the screen loaded
        // before startup finished — recoverable, NOT a pairing problem.
        // Avoid the misleading "wired"/"onboarding"/"pair" jargon.
        setErrorMessage(
          'Couldn’t load approvals yet — Dina may still be starting up. Reopen Dina and try again.',
        );
      } else {
        setErrorMessage((err as Error).message ?? 'Failed to load approvals');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refresh ONLY the resolved bucket — used after a local approve/deny so
  // the just-resolved task appears in the Completed tab without a full
  // reload flicker on the Pending list (which we've already mutated
  // optimistically). Swallows errors: a stale Completed list is harmless.
  const refreshResolved = useCallback(async () => {
    try {
      setResolved(await listResolvedApprovals(50));
    } catch {
      // Non-fatal — Completed history will catch up on next focus/refresh.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  // R-M6-I2 — subscribe to the unified notifications inbox so an approval
  // that arrives WHILE this screen is open re-fetches the list immediately.
  // Without this, an agent's `dina validate` (or any other surface that
  // mints an approval task) would mint the task + bump the tab-bar badge
  // (driven by useUnreadCount('approval')), but the visible list stayed
  // at the snapshot taken on the last focus. Verified live: tab-cycling
  // away and back surfaced the card; this listener removes the manual step.
  //
  // We re-`load()` on every approval-kind `appended` event — `load()` is
  // already idempotent + uses the existing `requireClient()` path. Same
  // O(n) bound as the badge subscription. The hook is also tracked in a
  // ref so we don't issue overlapping fetches if multiple events queue:
  // a second event during an in-flight load coalesces to one refetch.
  const reloadInFlight = useRef(false);
  useEffect(() => {
    const off = subscribeNotifications((event) => {
      // Only `'appended'` carries a kind discriminator. `'marked_read'`
      // can't add a new approval, and `'hydrated'` is a cold-start fan-in
      // that the `useFocusEffect` already handles on mount.
      if (event.type !== 'appended') return;
      if (event.item.kind !== 'approval') return;
      if (reloadInFlight.current) return;
      reloadInFlight.current = true;
      void load().finally(() => {
        reloadInFlight.current = false;
      });
    });
    return off;
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const confirmAndRun = useCallback(
    async (entry: InboxEntry, verb: 'Approve' | 'Deny', action: () => Promise<unknown>) => {
      const headline =
        entry.kind === 'intent_validation'
          ? `${verb} "${entry.capability}"?`
          : `${verb} "${entry.serviceName || entry.capability}"?`;
      const subline =
        entry.kind === 'intent_validation'
          ? `${entry.requesterDID !== '' ? `agent ${entry.requesterDID.slice(0, 28)}…\n` : ''}${entry.paramsPreview || '(no target)'}`
          : `${entry.requesterDID.slice(0, 28)}…\n${entry.paramsPreview || '(no params)'}`;
      Alert.alert(
        headline,
        subline,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: verb,
            style: verb === 'Deny' ? 'destructive' : 'default',
            onPress: async () => {
              setPendingActionId(entry.id);
              try {
                await action();
                setEntries((list) => list.filter((e) => e.id !== entry.id));
                // Pull the just-resolved task into the Completed history.
                void refreshResolved();
              } catch (err) {
                Alert.alert('Error', (err as Error).message ?? `Failed to ${verb.toLowerCase()}`);
              } finally {
                setPendingActionId(null);
              }
            },
          },
        ],
      );
    },
    [refreshResolved],
  );

  /**
   * Approval-kind classifier used by the renderer to pick between the
   * inline 3-button card (Deny / Approve Once / Approve) and the
   * standard 2-button card (Deny / Approve). dina_details §13.4 shows
   * the 3-button shape for agent vault reads; we extend the same to
   * MODERATE `dina validate` intents since they ALSO support a session
   * grant on the server side. HIGH validates + everything else stay
   * 2-button (no scope choice — a single confirmation is all there is).
   */
  const supportsSessionScope = useCallback((item: InboxEntry): boolean => {
    if (item.kind === 'vault_read') return true;
    if (item.kind === 'intent_validation' && item.riskLevel === 'MODERATE') return true;
    return false;
  }, []);

  /** Direct approval driver — no popup; called from the inline buttons. */
  const runApprove = useCallback(
    (item: InboxEntry, scope: 'single' | 'session'): void => {
      setPendingActionId(item.id);
      void approvePending(item.id, item.kind, scope)
        .then(() => {
          setEntries((list) => list.filter((e) => e.id !== item.id));
          // Surface the approved task in the Completed history.
          void refreshResolved();
        })
        .catch((err) => Alert.alert('Error', (err as Error).message ?? 'Failed to approve'))
        .finally(() => setPendingActionId(null));
    },
    [refreshResolved],
  );

  const handleApprove = useCallback(
    (item: InboxEntry) => {
      // Kinds without a session-scope choice — single confirmation flow.
      confirmAndRun(item, 'Approve', async () => {
        if (item.kind === 'staging_persona_access' && isPersistenceReady()) {
          try {
            await openPersonaDB(item.capability);
          } catch {
            // Already open or init failed — let Core attempt the drain anyway.
          }
        }
        return approvePending(item.id, item.kind);
      });
    },
    [confirmAndRun],
  );

  const renderItem = useCallback(
    ({ item }: { item: InboxEntry }) => {
      const busy = pendingActionId === item.id;
      const ageSec = Math.floor((Date.now() - item.createdAt) / 1000);
      const age =
        ageSec < 60
          ? `${ageSec}s ago`
          : ageSec < 3600
            ? `${Math.floor(ageSec / 60)}m ago`
            : `${Math.floor(ageSec / 3600)}h ago`;
      const ttl =
        item.expiresAt !== undefined
          ? ` · expires in ${Math.max(0, item.expiresAt - Math.floor(Date.now() / 1000))}s`
          : '';
      const isIntent = item.kind === 'intent_validation';
      const isStagingAccess = item.kind === 'staging_persona_access';
      const isVaultRead = item.kind === 'vault_read';
      const headline = isIntent
        ? 'Agent action approval'
        : isStagingAccess
          ? 'Memory access approval'
          : isVaultRead
            ? 'Vault read approval'
            : item.serviceName || 'Unnamed service';
      const tagText = isIntent && item.riskLevel !== undefined ? item.riskLevel : item.capability;
      const tagStyle =
        isIntent && item.riskLevel === 'HIGH'
          ? [styles.capability, styles.riskHigh]
          : isIntent && item.riskLevel === 'MODERATE'
            ? [styles.capability, styles.riskModerate]
            : styles.capability;
      const requesterPrefix = isIntent ? 'agent' : isStagingAccess ? 'source' : isVaultRead ? 'requester' : 'from';
      const riskHint =
        isIntent && item.riskLevel === 'MODERATE'
          ? 'Once per session'
          : isIntent && item.riskLevel === 'HIGH'
            ? 'Every invocation'
            : null;
      return (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.serviceName} numberOfLines={1}>
              {headline}
            </Text>
            <Text style={tagStyle}>{tagText}</Text>
          </View>
          {isIntent ? (
            <Text style={styles.intentAction}>{item.capability}</Text>
          ) : null}
          {riskHint !== null ? (
            <Text style={styles.riskHint}>{riskHint}</Text>
          ) : null}
          {item.requesterDID !== '' ? (
            <Text style={styles.requester} numberOfLines={1}>
              {requesterPrefix} {shortenDID(item.requesterDID)}
            </Text>
          ) : null}
          {item.paramsPreview !== '' ? (
            <Text style={styles.paramsPreview} numberOfLines={3}>
              {item.paramsPreview}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {age}
            {ttl}
          </Text>
          <View style={styles.actions}>
            <Pressable
              testID={`approvals-deny-${item.id}`}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                styles.denyButton,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
              disabled={busy}
              onPress={() =>
                confirmAndRun(item, 'Deny', () =>
                  denyPending(item.id, 'denied_by_operator', item.kind),
                )
              }
            >
              <Text style={styles.denyText}>Deny</Text>
            </Pressable>
            {supportsSessionScope(item) && (
              // dina_details §13.4 inline 3-button — `Approve Once`
              // grants single-use (`scope='single'`); the right-hand
              // `Approve` grants for the current dina session
              // (`scope='session'`). Direct call paths — no popup.
              <Pressable
                testID={`approvals-approve-once-${item.id}`}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.button,
                  styles.approveOnceButton,
                  pressed && styles.pressed,
                  busy && styles.disabled,
                ]}
                disabled={busy}
                onPress={() => runApprove(item, 'single')}
              >
                <Text style={styles.approveOnceText}>Approve Once</Text>
              </Pressable>
            )}
            <Pressable
              testID={`approvals-approve-${item.id}`}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                styles.approveButton,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
              disabled={busy}
              onPress={() =>
                supportsSessionScope(item) ? runApprove(item, 'session') : handleApprove(item)
              }
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Text style={styles.approveText}>Approve</Text>
              )}
            </Pressable>
          </View>
        </View>
      );
    },
    [pendingActionId, confirmAndRun, handleApprove, supportsSessionScope, runApprove],
  );

  // Read-only row for the Completed tab. No action buttons — just the
  // service/action, the resolved outcome badge, and when it resolved.
  const renderResolvedItem = useCallback(({ item }: { item: ResolvedInboxEntry }) => {
    const isIntent = item.kind === 'intent_validation';
    const isStagingAccess = item.kind === 'staging_persona_access';
    const isVaultRead = item.kind === 'vault_read';
    const headline = isIntent
      ? 'Agent action approval'
      : isStagingAccess
        ? 'Memory access approval'
        : isVaultRead
          ? 'Vault read approval'
          : item.serviceName || 'Unnamed service';
    const outcomeStyle =
      item.outcome === 'approved'
        ? [styles.outcomeBadge, styles.outcomeApproved]
        : item.outcome === 'expired'
          ? [styles.outcomeBadge, styles.outcomeExpired]
          : [styles.outcomeBadge, styles.outcomeDenied];
    const outcomeLabel =
      item.outcome === 'approved' ? 'Approved' : item.outcome === 'expired' ? 'Expired' : 'Denied';
    return (
      <View style={[styles.card, styles.cardResolved]}>
        <View style={styles.cardHeader}>
          <Text style={styles.serviceName} numberOfLines={1}>
            {headline}
          </Text>
          <Text style={outcomeStyle}>{outcomeLabel}</Text>
        </View>
        {isIntent && item.capability !== '' ? (
          <Text style={styles.intentAction}>{item.capability}</Text>
        ) : null}
        {item.paramsPreview !== '' ? (
          <Text style={styles.paramsPreview} numberOfLines={2}>
            {item.paramsPreview}
          </Text>
        ) : null}
        <Text style={styles.meta}>{formatResolvedAt(item.resolvedAt)}</Text>
      </View>
    );
  }, []);

  if (loading && entries.length === 0 && resolved.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }

  const showPending = tab === 'pending';
  const listData = showPending ? entries : resolved;

  return (
    <View style={styles.container}>
      {errorMessage !== null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
      <View style={styles.tabRow}>
        {TABS.map((t) => {
          const active = tab === t.key;
          const count = t.key === 'pending' ? entries.length : resolved.length;
          return (
            <Pressable
              key={t.key}
              testID={`approvals-tab-${t.key}`}
              accessibilityRole="button"
              onPress={() => setTab(t.key)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {t.label}
                {count > 0 ? ` · ${count}` : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {listData.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyCard}>
            <Ionicons
              name={showPending ? 'checkmark-circle-outline' : 'time-outline'}
              size={36}
              color={showPending ? colors.success : colors.textMuted}
              style={{ marginBottom: spacing.md }}
            />
            <Text style={styles.emptyTitle}>
              {showPending ? 'All caught up' : 'No history yet'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {showPending
                ? 'Apps and agents check in here before doing anything that needs your OK.'
                : 'Approvals you’ve resolved will show up here for the record.'}
            </Text>
          </View>
        </View>
      ) : showPending ? (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={<Text style={styles.listHeader}>{entries.length} PENDING</Text>}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textMuted}
            />
          }
        />
      ) : (
        <FlatList
          data={resolved}
          keyExtractor={(item) => item.id}
          renderItem={renderResolvedItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={<Text style={styles.listHeader}>{resolved.length} RESOLVED</Text>}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textMuted}
            />
          }
        />
      )}
    </View>
  );
}

/** Relative timestamp for a resolved approval — "just now" / "5m ago". */
function formatResolvedAt(ms: number, now: number = Date.now()): string {
  const delta = Math.round((now - ms) / 1000);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function shortenDID(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 16)}…${did.slice(-4)}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  tabRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  tab: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  tabActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  tabText: {
    ...textStyles.buttonSmall,
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.white,
  },
  listHeader: {
    ...textStyles.eyebrow,
    letterSpacing: 1.2,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  cardResolved: {
    // Resolved rows are read-only history — dial back the surface so they
    // read as past events, not actionable cards.
    opacity: 0.92,
    backgroundColor: colors.bgSecondary,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.xs,
  },
  outcomeBadge: {
    ...textStyles.monoSmall,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  outcomeApproved: {
    backgroundColor: colors.successBgSoft ?? colors.bgTertiary,
    color: colors.success,
  },
  outcomeDenied: {
    backgroundColor: colors.errorBgSoft,
    color: colors.error,
  },
  outcomeExpired: {
    backgroundColor: colors.bgTertiary,
    color: colors.textSecondary,
  },
  serviceName: {
    ...textStyles.bodyLargeStrong,
    flex: 1,
    marginRight: spacing.sm,
  },
  capability: {
    ...textStyles.monoSmall,
    color: colors.textSecondary,
    backgroundColor: colors.bgTertiary,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  riskModerate: {
    backgroundColor: colors.warningBgSoft,
    color: colors.warningTextMid,
  },
  riskHigh: {
    backgroundColor: colors.errorBgSoft,
    color: colors.errorTextDeep,
  },
  intentAction: {
    ...textStyles.mono,
    marginBottom: spacing.xs,
  },
  riskHint: {
    ...textStyles.caption,
    marginBottom: spacing.xs,
    letterSpacing: 0.2,
  },
  requester: {
    ...textStyles.mono,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  paramsPreview: {
    ...textStyles.monoSmall,
    marginBottom: spacing.xs,
  },
  meta: {
    ...textStyles.caption,
    letterSpacing: 0.2,
    marginBottom: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  button: {
    // Equal flex share of the row width — Deny / Approve Once /
    // Approve render as a unified segmented control regardless of
    // label length. Avoids the content-sized 76px/110px/76px mismatch
    // that made the buttons look different sizes.
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
    // All buttons carry a 1px border for identical height. Filled
    // Approve uses a same-color border so its outline matches.
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveButton: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  approveText: textStyles.buttonSmall,
  // "Approve Once" — single-use action. Visually weighted between
  // Deny (destructive) and Approve (primary session) so the operator
  // can scan the row left-to-right with intent escalating per button.
  approveOnceButton: {
    backgroundColor: 'transparent',
    borderColor: colors.accent,
  },
  approveOnceText: {
    ...textStyles.buttonSmall,
    color: colors.accent,
  },
  denyButton: {
    // Soft-red bg + matching red border so Deny reads as destructive
    // alongside its red text. Pairs visually with the chat card's
    // Deny styling.
    backgroundColor: colors.errorBgSoft,
    borderColor: colors.error,
  },
  denyText: {
    ...textStyles.buttonSmall,
    color: colors.error,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  emptyState: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
  },
  emptyCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  emptyTitle: {
    ...textStyles.h2,
    letterSpacing: 0.3,
  },
  emptySubtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    textAlign: 'center',
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
