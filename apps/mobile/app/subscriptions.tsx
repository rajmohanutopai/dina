import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Alert, TextInput } from 'react-native';

import {
  getActiveSubscriptions,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  createSubscription,
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
  const [showForm, setShowForm] = useState(false);

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

  const header = (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>Subscriptions</Text>
      <Pressable
        testID="subscription-new-toggle"
        onPress={() => setShowForm((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={showForm ? 'Close new subscription form' : 'New subscription'}
        hitSlop={8}
        style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name={showForm ? 'close' : 'add'} size={18} color={colors.accent} />
        <Text style={styles.newBtnText}>{showForm ? 'Close' : 'New'}</Text>
      </Pressable>
    </View>
  );

  const form = showForm ? (
    <NewSubscriptionForm
      onCreated={() => {
        setShowForm(false);
        refresh();
      }}
    />
  ) : null;

  return (
    <View style={styles.container} testID="subscriptions-screen">
      {header}
      {form}
      {items.length === 0 ? (
        <View style={styles.emptyState} testID="subscriptions-empty">
          <Ionicons
            name="radio-outline"
            size={40}
            color={colors.textMuted}
            style={{ marginBottom: spacing.md }}
          />
          <Text style={styles.emptyTitle}>No subscriptions yet</Text>
          <Text style={styles.emptyBody}>
            Ask Dina to watch something in Chat — like &ldquo;tell me if my flight is delayed&rdquo; — or
            tap New to create a standing subscription you control.
          </Text>
        </View>
      ) : (
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
      )}
    </View>
  );
}

/** #7 — owner-facing create form for a poll-mode standing subscription. Minimal
 *  bounded inputs; on submit calls the owner-only `/v1/watch/create` route. */
function NewSubscriptionForm({ onCreated }: { onCreated: () => void }) {
  const [capability, setCapability] = useState('');
  const [providerDid, setProviderDid] = useState('');
  const [serviceUri, setServiceUri] = useState('');
  const [persona, setPersona] = useState('general');
  const [minutes, setMinutes] = useState('5');
  const [target, setTarget] = useState('');
  const [condition, setCondition] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    capability.trim() !== '' &&
    providerDid.trim() !== '' &&
    serviceUri.trim() !== '' &&
    persona.trim() !== '' &&
    Number(minutes) > 0 &&
    !busy;

  const submit = () => {
    setBusy(true);
    setError(null);
    void createSubscription({
      persona: persona.trim(),
      serviceUri: serviceUri.trim(),
      providerDid: providerDid.trim(),
      capability: capability.trim(),
      pollIntervalSec: Math.round(Number(minutes) * 60),
      ...(target.trim() !== '' ? { target: target.trim() } : {}),
      ...(condition.trim() !== '' ? { condition: condition.trim() } : {}),
    })
      .then((watchId) => {
        if (watchId === null) setError('Could not create the subscription.');
        else onCreated();
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.form} testID="subscription-new-form">
      <FormField label="What to watch (capability)" value={capability} onChange={setCapability} placeholder="e.g. transit.eta" testID="sub-field-capability" />
      <FormField label="Provider DID" value={providerDid} onChange={setProviderDid} placeholder="did:plc:…" testID="sub-field-provider" />
      <FormField label="Service URI" value={serviceUri} onChange={setServiceUri} placeholder="at://…" testID="sub-field-service" />
      <FormField label="Persona" value={persona} onChange={setPersona} placeholder="general" testID="sub-field-persona" />
      <FormField label="Check every (minutes)" value={minutes} onChange={setMinutes} placeholder="5" keyboardType="numeric" testID="sub-field-minutes" />
      <FormField label="What to poll (optional, e.g. flight=BA117)" value={target} onChange={setTarget} placeholder="key=value, key2=value2" testID="sub-field-target" />
      <FormField label="Notify only when result contains (optional)" value={condition} onChange={setCondition} placeholder="e.g. delayed" testID="sub-field-condition" />
      {error !== null ? <Text style={styles.formError}>{error}</Text> : null}
      <Pressable
        testID="subscription-create-submit"
        onPress={submit}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityLabel="Create subscription"
        style={({ pressed }) => [
          styles.submitBtn,
          !canSubmit && styles.submitBtnDisabled,
          pressed && canSubmit && { opacity: 0.7 },
        ]}
      >
        <Text style={styles.submitBtnText}>{busy ? 'Creating…' : 'Create subscription'}</Text>
      </Pressable>
    </View>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  keyboardType?: 'numeric';
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        testID={testID}
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerTitle: { ...textStyles.bodyStrong, color: colors.textPrimary },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: spacing.xs },
  newBtnText: { ...textStyles.caption, color: colors.accent },
  form: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
    ...shadows.sm,
  },
  field: { gap: 4 },
  fieldLabel: { ...textStyles.caption, color: colors.textMuted },
  input: {
    ...textStyles.body,
    color: colors.textPrimary,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.bgTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  formError: { ...textStyles.caption, color: colors.error },
  submitBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: { ...textStyles.bodyStrong, color: colors.bgPrimary },
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
