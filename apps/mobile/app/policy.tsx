/**
 * Agent policy screen — configure which actions require approval.
 *
 * Shows every known action grouped by risk level (SAFE / MODERATE / HIGH /
 * BLOCKED). Tapping a non-locked action lets the operator change its level.
 * BRAIN_DENIED actions are shown but greyed out — they cannot be changed.
 *
 * The "+" header button adds a custom action name with a chosen risk level.
 * Custom (overridden) rows show a "Remove" option that deletes the override;
 * for DEFAULT_POLICY actions this resets to the hardcoded default, for
 * custom-added actions it removes them from the list entirely.
 *
 * Data source: GET /v1/policy/actions (merged default + KV overrides).
 * Write path: PUT /v1/policy/actions/:action, DELETE /v1/policy/actions/:action.
 */

import React, { useState, useCallback, useLayoutEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Platform,
  TextInput,
  Modal,
} from 'react-native';
import { useFocusEffect, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, textStyles } from '../src/theme';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import type { ActionPolicyEntry, RiskLevel } from '@dina/core';

type RiskGroup = {
  title: string;
  risk: RiskLevel;
  description: string;
  data: ActionPolicyEntry[];
};

const RISK_ORDER: RiskLevel[] = ['SAFE', 'MODERATE', 'HIGH', 'BLOCKED'];

const RISK_META: Record<RiskLevel, { label: string; description: string; color: string }> = {
  SAFE: {
    label: 'SAFE',
    description: 'Auto-approved. No prompt shown.',
    color: colors.riskLow,
  },
  MODERATE: {
    label: 'MODERATE',
    description: 'Requires approval once per session',
    color: colors.riskMed,
  },
  HIGH: {
    label: 'HIGH',
    description: 'Requires approval every invocation',
    color: colors.riskHigh,
  },
  BLOCKED: {
    label: 'BLOCKED',
    description: 'Always denied. The agent cannot perform this.',
    color: colors.riskAdmin,
  },
};

export default function PolicyScreen() {
  const navigation = useNavigation();
  const [groups, setGroups] = useState<RiskGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // Add-action modal state (Android fallback; iOS uses Alert.prompt)
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [addModalInput, setAddModalInput] = useState('');

  const load = useCallback(async () => {
    setErrorMessage(null);
    const node = getBootedNode();
    if (node === null) {
      setErrorMessage('Node not booted. Complete onboarding first.');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const result = await node.coreClient.getActionPolicy();
      const byRisk = new Map<RiskLevel, ActionPolicyEntry[]>();
      for (const r of RISK_ORDER) byRisk.set(r, []);
      for (const entry of result.actions) {
        byRisk.get(entry.risk)?.push(entry);
      }
      const built: RiskGroup[] = RISK_ORDER.map((r) => ({
        title: RISK_META[r].label,
        risk: r,
        description: RISK_META[r].description,
        data: byRisk.get(r) ?? [],
      }));
      setGroups(built);
    } catch (err) {
      setErrorMessage((err as Error).message ?? 'Failed to load policy');
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

  const handleChangeRisk = useCallback(
    (entry: ActionPolicyEntry) => {
      if (entry.locked) return;
      const node = getBootedNode();
      if (node === null) return;

      const options: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = [
        { text: 'Cancel', style: 'cancel' },
        ...RISK_ORDER.filter((r) => r !== entry.risk).map((r) => ({
          text: RISK_META[r].label,
          style: r === 'BLOCKED' ? ('destructive' as const) : ('default' as const),
          onPress: () => {
            setPendingAction(entry.action);
            void node.coreClient
              .setActionRisk(entry.action, r)
              .then(() => load())
              .catch((err) =>
                Alert.alert('Error', (err as Error).message ?? 'Failed to update policy'),
              )
              .finally(() => setPendingAction(null));
          },
        })),
      ];

      // Custom-added actions can be removed entirely.
      // DEFAULT_POLICY actions that have been overridden can be reset to their default.
      if (!entry.inDefaultPolicy || !entry.isDefault) {
        const label = entry.inDefaultPolicy ? 'Reset to default' : 'Remove';
        options.push({
          text: label,
          style: 'destructive',
          onPress: () => {
            setPendingAction(entry.action);
            void node.coreClient
              .deleteActionOverride(entry.action)
              .then(() => load())
              .catch((err) =>
                Alert.alert('Error', (err as Error).message ?? 'Failed to remove'),
              )
              .finally(() => setPendingAction(null));
          },
        });
      }

      Alert.alert(
        `Set risk for "${entry.action}"`,
        `Current: ${entry.risk}`,
        options,
      );
    },
    [load],
  );

  const openAddModal = useCallback(() => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Add action',
        'Enter the action name (e.g. send_invoice)',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Next',
            onPress: (name?: string) => {
              const trimmed = name?.trim() ?? '';
              if (!trimmed) return;
              const node = getBootedNode();
              if (node === null) return;
              Alert.alert(
                `Set risk for "${trimmed}"`,
                'Choose the risk level for this action.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  ...RISK_ORDER.map((r) => ({
                    text: RISK_META[r].label,
                    style: r === 'BLOCKED' ? ('destructive' as const) : ('default' as const),
                    onPress: () => {
                      setPendingAction(trimmed);
                      void node.coreClient
                        .setActionRisk(trimmed, r)
                        .then(() => load())
                        .catch((err) =>
                          Alert.alert('Error', (err as Error).message ?? 'Failed to add action'),
                        )
                        .finally(() => setPendingAction(null));
                    },
                  })),
                ],
              );
            },
          },
        ],
        'plain-text',
      );
    } else {
      setAddModalInput('');
      setAddModalVisible(true);
    }
  }, [load]);

  const commitAddModal = useCallback(() => {
    const trimmed = addModalInput.trim();
    setAddModalVisible(false);
    if (!trimmed) return;
    const node = getBootedNode();
    if (node === null) return;
    Alert.alert(
      `Set risk for "${trimmed}"`,
      'Choose the risk level for this action.',
      [
        { text: 'Cancel', style: 'cancel' },
        ...RISK_ORDER.map((r) => ({
          text: RISK_META[r].label,
          style: r === 'BLOCKED' ? ('destructive' as const) : ('default' as const),
          onPress: () => {
            setPendingAction(trimmed);
            void node.coreClient
              .setActionRisk(trimmed, r)
              .then(() => load())
              .catch((err) =>
                Alert.alert('Error', (err as Error).message ?? 'Failed to add action'),
              )
              .finally(() => setPendingAction(null));
          },
        })),
      ],
    );
  }, [addModalInput, load]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={openAddModal}
          style={styles.addButton}
          testID="policy-add-action"
          accessibilityLabel="Add action"
          accessibilityRole="button"
        >
          <Ionicons name="add" size={24} color={colors.accent} />
        </Pressable>
      ),
    });
  }, [navigation, openAddModal]);

  if (loading && groups.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Android fallback for action-name input (iOS uses Alert.prompt) */}
      <Modal
        visible={addModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAddModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add action</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. send_invoice"
              placeholderTextColor={colors.textMuted}
              value={addModalInput}
              onChangeText={setAddModalInput}
              autoFocus
              autoCapitalize="none"
              testID="policy-add-input"
            />
            <View style={styles.modalButtons}>
              <Pressable
                onPress={() => setAddModalVisible(false)}
                style={styles.modalCancel}
                testID="policy-add-cancel"
                accessibilityRole="button"
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={commitAddModal}
                style={styles.modalConfirm}
                testID="policy-add-confirm"
                accessibilityRole="button"
              >
                <Text style={styles.modalConfirmText}>Next</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      {errorMessage !== null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
      <SectionList
        sections={groups}
        keyExtractor={(item) => item.action}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <View style={[styles.riskDot, { backgroundColor: RISK_META[section.risk].color }]} />
            <View>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionDesc}>{section.description}</Text>
            </View>
          </View>
        )}
        renderItem={({ item }) => {
          const busy = pendingAction === item.action;
          return (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                pressed && !item.locked && styles.rowPressed,
                item.locked && styles.rowLocked,
              ]}
              onPress={() => handleChangeRisk(item)}
              disabled={item.locked || busy}
              testID={`policy-row-${item.action}`}
              accessibilityRole="button"
            >
              <View style={styles.rowLeft}>
                <Text style={[styles.actionName, item.locked && styles.actionNameLocked]}>
                  {item.action}
                </Text>
              </View>
              {busy ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : item.locked ? (
                <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
              ) : (
                <Text style={styles.chevron}>{'›'}</Text>
              )}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No actions configured.</Text>
          </View>
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textMuted}
          />
        }
      />
    </View>
  );
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
    paddingBottom: spacing.xl,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bgPrimary,
  },
  riskDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
  },
  sectionTitle: {
    ...textStyles.label,
    color: colors.textPrimary,
  },
  sectionDesc: {
    ...textStyles.caption,
    marginTop: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
    marginRight: spacing.sm,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowLocked: {
    opacity: 0.5,
  },
  actionName: {
    ...textStyles.mono,
    color: colors.textPrimary,
  },
  actionNameLocked: {
    color: colors.textMuted,
  },
  chevron: {
    ...textStyles.h3,
    color: colors.textMuted,
  },
  emptyState: {
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    ...textStyles.body,
    color: colors.textMuted,
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
  addButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.lg,
    width: '100%',
    gap: spacing.md,
  },
  modalTitle: textStyles.bodyLargeStrong,
  modalInput: {
    ...textStyles.mono,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgPrimary,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  modalCancel: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  modalCancelText: {
    ...textStyles.body,
    color: colors.textMuted,
  },
  modalConfirm: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  modalConfirmText: {
    ...textStyles.bodyStrong,
    color: colors.accent,
  },
});
