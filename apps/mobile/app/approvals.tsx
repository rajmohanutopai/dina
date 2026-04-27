/**
 * Approval inbox — list of pending `workflow_task kind=approval` tasks
 * that need the operator's review before execution.
 *
 * Data flow: the `useServiceInbox` hook wraps the paired Core's
 * `listWorkflowTasks({kind:'approval', state:'pending_approval'})` call;
 * the two actions (approve / deny) forward to the Core client.
 * Refresh on mount + focus + pull-to-refresh.
 */

import React, { useState, useCallback } from 'react';
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
import { colors, fonts, spacing, radius, shadows } from '../src/theme';
import {
  listPendingApprovals,
  approvePending,
  denyPending,
  InboxNotConfiguredError,
  type InboxEntry,
} from '../src/hooks/useServiceInbox';

export default function ApprovalsScreen() {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErrorMessage(null);
    try {
      const list = await listPendingApprovals(50);
      setEntries(list);
    } catch (err) {
      if (err instanceof InboxNotConfiguredError) {
        setErrorMessage(
          "Approvals inbox isn't wired yet — finish onboarding to pair the node first.",
        );
      } else {
        setErrorMessage((err as Error).message ?? 'Failed to load approvals');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

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
    [],
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
      const headline = isIntent
        ? 'Agent action approval'
        : item.serviceName || 'Unnamed service';
      const tagText = isIntent && item.riskLevel !== undefined ? item.riskLevel : item.capability;
      const tagStyle =
        isIntent && item.riskLevel === 'HIGH'
          ? [styles.capability, styles.riskHigh]
          : isIntent && item.riskLevel === 'MODERATE'
            ? [styles.capability, styles.riskModerate]
            : styles.capability;
      const requesterPrefix = isIntent ? 'agent' : 'from';
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
            <Pressable
              style={({ pressed }) => [
                styles.button,
                styles.approveButton,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
              disabled={busy}
              onPress={() => confirmAndRun(item, 'Approve', () => approvePending(item.id))}
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
    [pendingActionId, confirmAndRun],
  );

  if (loading && entries.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {errorMessage !== null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
      {entries.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyCard}>
            <Ionicons
              name="checkmark-circle-outline"
              size={36}
              color={colors.success}
              style={{ marginBottom: spacing.md }}
            />
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySubtitle}>
              No service queries are waiting for your approval right now.
            </Text>
          </View>
        </View>
      ) : (
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
      )}
    </View>
  );
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
  listHeader: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: colors.textMuted,
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
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.xs,
  },
  serviceName: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
    flex: 1,
    marginRight: spacing.sm,
  },
  capability: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textSecondary,
    backgroundColor: colors.bgTertiary,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  riskModerate: {
    backgroundColor: '#FEF3C7',
    color: '#92400E',
  },
  riskHigh: {
    backgroundColor: '#FEE2E2',
    color: '#991B1B',
  },
  intentAction: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  requester: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  paramsPreview: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    lineHeight: 18,
  },
  meta: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.2,
    marginBottom: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveButton: {
    backgroundColor: colors.accent,
  },
  approveText: {
    fontFamily: fonts.sansSemibold,
    color: colors.white,
    fontSize: 14,
  },
  denyButton: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  denyText: {
    fontFamily: fonts.sansSemibold,
    color: colors.error,
    fontSize: 14,
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
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.textPrimary,
    letterSpacing: 0.3,
  },
  emptySubtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  errorText: {
    fontFamily: fonts.sans,
    color: colors.error,
    fontSize: 13,
    lineHeight: 18,
  },
});
