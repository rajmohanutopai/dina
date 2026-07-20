import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Alert } from 'react-native';

import {
  getActiveRuns,
  pauseRun,
  resumeRun,
  stopRun,
  getRunDecisions,
  decideRunMessage,
  confirmRunRisk,
  type RunUIItem,
  type RunDecisions,
  type RunPendingItem,
} from '../src/hooks/useRuns';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

/**
 * Interactive runs screen (ISVC-9) — the owner's live provider sessions.
 *
 * Each row is a bounded interactive run (INTERACTIVE_SERVICES §5): Dina pulls
 * from a provider on a pacing loop, staging each response through the silence
 * tiers. The owner can pause/resume the loop or stop a run, and — inline per run
 * (E76-11) — approve/deny/acknowledge each classified message and confirm a
 * MODERATE/HIGH action's risk, all through the owner-only `OwnerRunClient`.
 * Refreshes on focus.
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
        renderItem={({ item }) => (
          <RunRow item={item} onToggle={onToggle} onStop={onStop} onChanged={refresh} />
        )}
      />
    </View>
  );
}

function RunRow({
  item,
  onToggle,
  onStop,
  onChanged,
}: {
  item: RunUIItem;
  onToggle: (item: RunUIItem) => void;
  onStop: (item: RunUIItem) => void;
  onChanged: () => void;
}) {
  const paused = item.state === 'paused';
  return (
    <View style={styles.rowWrap} testID={`run-row-${item.run_id}`}>
      <View style={styles.row}>
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
              <Ionicons
                name={paused ? 'play-outline' : 'pause-outline'}
                size={22}
                color={colors.accent}
              />
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
      {item.terminal ? null : <RunDecisionsSection runId={item.run_id} onChanged={onChanged} />}
    </View>
  );
}

/**
 * E76-11 — the owner decision surface for a run's classified messages. Fetches
 * `/status`'s `pending` (approve/deny/acknowledge) + `pending_risk` (confirm a
 * MODERATE/HIGH action), and wires every decision through the owner-only
 * `OwnerRunClient` (`decideRunMessage` / `confirmRunRisk`). Without this the
 * classified stream is never owner-visible and no action can ever dispatch.
 */
function RunDecisionsSection({ runId, onChanged }: { runId: string; onChanged: () => void }) {
  const [decisions, setDecisions] = useState<RunDecisions>({ pending: [], pendingRisk: [] });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void getRunDecisions(runId).then(setDecisions);
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    (fn: () => Promise<string | null>) => {
      setBusy(true);
      void fn()
        .then(() => {
          load();
          onChanged();
        })
        .finally(() => setBusy(false));
    },
    [load, onChanged],
  );

  if (decisions.pending.length === 0 && decisions.pendingRisk.length === 0) return null;

  const label = (m: RunPendingItem): string =>
    m.kind === 'action'
      ? `Action${m.action_type ? ` · ${m.action_type}` : ''} #${m.sequence}`
      : `Update #${m.sequence}`;

  // 81B-06 — the bounded, Core-rendered CardSpec view above each decision so the
  // owner sees WHAT they are approving/denying, not just an opaque digest.
  const CardText = ({ m }: { m: RunPendingItem }) =>
    m.title || m.body ? (
      <View style={styles.decisionCard}>
        {m.title ? (
          <Text
            style={styles.decisionCardTitle}
            numberOfLines={2}
            testID={`run-card-title-${m.message_id}`}
          >
            {m.title}
          </Text>
        ) : null}
        {m.body ? (
          <Text style={styles.decisionCardBody} numberOfLines={4}>
            {m.body}
          </Text>
        ) : null}
      </View>
    ) : null;

  // Service attribution (which provider/service these decisions belong to).
  const attribution = decisions.serviceUri ?? decisions.providerDid ?? null;

  return (
    <View style={styles.decisions} testID={`run-decisions-${runId}`}>
      {attribution ? (
        <Text
          style={styles.decisionAttribution}
          numberOfLines={1}
          testID={`run-attribution-${runId}`}
        >
          {attribution}
        </Text>
      ) : null}
      {decisions.pending.map((m) => (
        <View key={m.message_id} testID={`run-decision-${m.message_id}`}>
          <CardText m={m} />
          <View style={styles.decisionRow}>
            <Text style={styles.decisionLabel} numberOfLines={1}>
              {label(m)}
            </Text>
            <View style={styles.decisionBtns}>
            {m.kind === 'action' ? (
              <>
                <DecisionBtn
                  testID={`run-approve-${m.message_id}`}
                  text="Approve"
                  tone="accent"
                  disabled={busy}
                  onPress={() =>
                    act(() =>
                      decideRunMessage(runId, m.message_id, 'approve', m.decision_revision ?? 0),
                    )
                  }
                />
                <DecisionBtn
                  testID={`run-deny-${m.message_id}`}
                  text="Deny"
                  tone="error"
                  disabled={busy}
                  onPress={() =>
                    act(() =>
                      decideRunMessage(runId, m.message_id, 'deny', m.decision_revision ?? 0),
                    )
                  }
                />
              </>
            ) : (
              <DecisionBtn
                testID={`run-ack-${m.message_id}`}
                text="Got it"
                tone="muted"
                disabled={busy}
                onPress={() =>
                  act(() =>
                    decideRunMessage(runId, m.message_id, 'acknowledge', m.decision_revision ?? 0),
                  )
                }
              />
            )}
            </View>
          </View>
        </View>
      ))}
      {decisions.pendingRisk.map((m) => (
        <View key={m.message_id} testID={`run-risk-${m.message_id}`}>
          <CardText m={m} />
          <View style={styles.decisionRow}>
            <Text style={styles.decisionLabel} numberOfLines={1}>
              Confirm {label(m)}
            </Text>
            <View style={styles.decisionBtns}>
              <DecisionBtn
                testID={`run-confirm-${m.message_id}`}
                text="Confirm"
                tone="accent"
                disabled={busy}
                onPress={() => act(() => confirmRunRisk(runId, m.message_id))}
              />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function DecisionBtn({
  text,
  tone,
  disabled,
  onPress,
  testID,
}: {
  text: string;
  tone: 'accent' | 'error' | 'muted';
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const color = tone === 'error' ? colors.error : tone === 'muted' ? colors.textMuted : colors.accent;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={text}
      hitSlop={6}
      style={({ pressed }) => [
        styles.decisionBtn,
        { borderColor: color },
        (pressed || disabled) && { opacity: 0.5 },
      ]}
    >
      <Text style={[styles.decisionBtnText, { color }]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  list: { flex: 1 },
  listContent: { padding: spacing.md, paddingBottom: spacing.xl },
  separator: { height: spacing.sm },
  rowWrap: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    ...shadows.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  decisions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.bgTertiary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  decisionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  decisionAttribution: { ...textStyles.caption, color: colors.textMuted },
  decisionCard: { marginBottom: spacing.xs, gap: 2 },
  decisionCardTitle: { ...textStyles.bodyStrong, color: colors.textPrimary },
  decisionCardBody: { ...textStyles.caption, color: colors.textMuted },
  decisionLabel: { ...textStyles.caption, color: colors.textPrimary, flex: 1, marginRight: spacing.sm },
  decisionBtns: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  decisionBtn: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  decisionBtnText: { ...textStyles.caption },
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
