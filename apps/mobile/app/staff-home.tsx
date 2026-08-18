/**
 * Staff home (§6.3) — the clerk's whole app. Prove presence with the
 * PIN, read the grant-filtered inbox, receipt a delivery. Every gate is
 * server-side: this screen only carries the requests over the sealed
 * relay and renders what Core answers, including the over-cap "waiting
 * for the owner" card as a normal outcome.
 */

import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { StaffCoreClient, staffTransportFor, type StaffInboxItem } from '@dina/core';

import { clearStaffIdentity, loadStaffIdentity } from '../src/services/staff_identity_store';
import { makeStaffWebSocket } from '../src/services/staff_transport_rn';
import { colors, radius, spacing, textStyles } from '../src/theme';

const KIND_LABEL: Record<string, string> = {
  unreceipted_delivery: 'Delivery to receipt',
  pending_confirm: 'Order draft to confirm',
  pending_decision: 'Order awaiting a decision',
  short_acceptance: 'Short acceptance — dispute',
  unacknowledged_payment: 'Payment to acknowledge',
  pending_quote: 'Quote awaiting approval',
  open_tender: 'Tender collecting quotes',
};

export default function StaffHomeScreen(): React.ReactElement {
  const router = useRouter();
  const clientRef = useRef<StaffCoreClient | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [present, setPresent] = useState(false);
  const [pin, setPin] = useState('');
  const [items, setItems] = useState<StaffInboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureClient = useCallback(async (): Promise<StaffCoreClient | null> => {
    if (clientRef.current !== null) return clientRef.current;
    const identity = await loadStaffIdentity();
    if (identity === null) {
      router.replace('/staff-join');
      return null;
    }
    setBusinessName(identity.deviceName);
    clientRef.current = new StaffCoreClient(staffTransportFor(identity, makeStaffWebSocket, 30_000));
    return clientRef.current;
  }, [router]);

  const refreshInbox = useCallback(async () => {
    const client = await ensureClient();
    if (client === null) return;
    try {
      const answer = await client.inbox();
      setItems(answer.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [ensureClient]);

  useFocusEffect(
    useCallback(() => {
      if (present) void refreshInbox();
    }, [present, refreshInbox]),
  );

  const prove = useCallback(() => {
    void (async () => {
      const client = await ensureClient();
      if (client === null || pin.trim() === '') return;
      setBusy(true);
      try {
        await client.provePresence(pin.trim());
        setPin('');
        setPresent(true);
        await refreshInbox();
      } catch (err) {
        Alert.alert('Not verified', (err as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [ensureClient, pin, refreshInbox]);

  const receipt = useCallback(
    (item: StaffInboxItem) => {
      void (async () => {
        const client = await ensureClient();
        if (client === null || item.kind !== 'unreceipted_delivery') return;
        setBusy(true);
        try {
          // The subject IS the note digest. A staff phone receipts what
          // arrived in full by default; a short count is the dispute
          // lane, driven from the item's own screen on a richer surface.
          const outcome = await client.issueDeliveryReceipt({
            deliveryNoteDigest: item.subject,
            lines: [],
          });
          if (outcome.kind === 'pending_approval') {
            Alert.alert(
              'Sent to the owner',
              'This delivery is over your limit, so the owner has to approve it. It will go through once they do.',
            );
          } else {
            Alert.alert('Receipted', 'The delivery is recorded.');
          }
          await refreshInbox();
        } catch (err) {
          Alert.alert('Could not receipt', (err as Error).message);
        } finally {
          setBusy(false);
        }
      })();
    },
    [ensureClient, refreshInbox],
  );

  const leave = useCallback(() => {
    Alert.alert('Leave this business?', 'This phone will stop being a staff device.', [
      { text: 'Stay', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await clearStaffIdentity();
            clientRef.current = null;
            router.replace('/staff-join');
          })();
        },
      },
    ]);
  }, [router]);

  return (
    <View style={styles.container} testID="staff-home-screen">
      <Stack.Screen options={{ title: businessName || 'Staff' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {!present ? (
          <View>
            <Text style={styles.hint}>Enter your staff PIN to start.</Text>
            <TextInput
              style={styles.input}
              value={pin}
              onChangeText={setPin}
              placeholder="PIN"
              placeholderTextColor={colors.textSecondary}
              keyboardType="numeric"
              secureTextEntry
              testID="staff-pin-input"
            />
            <Pressable
              style={[styles.button, (busy || pin.trim() === '') && styles.busy]}
              disabled={busy || pin.trim() === ''}
              onPress={prove}
              testID="staff-prove"
            >
              {busy ? (
                <ActivityIndicator color={colors.bgPrimary} />
              ) : (
                <Text style={styles.buttonLabel}>Start</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <View>
            <Text style={styles.sectionTitle}>Needs attention</Text>
            {error !== null && <Text style={styles.error}>{error}</Text>}
            {items.length === 0 && error === null && (
              <Text style={styles.empty} testID="staff-inbox-empty">
                Nothing waiting.
              </Text>
            )}
            {items.map((item) => (
              <Pressable
                key={`${item.kind}-${item.subject}`}
                style={styles.itemRow}
                disabled={item.kind !== 'unreceipted_delivery' || busy}
                onPress={() => receipt(item)}
                testID={`staff-item-${item.kind}-${item.subject}`}
              >
                <View style={styles.itemText}>
                  <Text style={styles.itemTitle}>{KIND_LABEL[item.kind] ?? item.kind}</Text>
                  {item.kind === 'unreceipted_delivery' && (
                    <Text style={styles.itemMeta}>Tap to receipt in full</Text>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        )}
        <Pressable style={styles.leave} onPress={leave} testID="staff-leave">
          <Text style={styles.leaveLabel}>Leave this business</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  hint: { ...textStyles.body, color: colors.textSecondary, marginBottom: spacing.md },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...textStyles.body,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  busy: { opacity: 0.6 },
  buttonLabel: { ...textStyles.button, color: colors.bgPrimary },
  error: { ...textStyles.body, color: colors.error },
  empty: { ...textStyles.body, color: colors.textSecondary },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  itemText: { flex: 1 },
  itemTitle: { ...textStyles.body, color: colors.textPrimary },
  itemMeta: { ...textStyles.caption, color: colors.textSecondary, marginTop: 2 },
  leave: {
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.error,
    marginTop: spacing.xl,
  },
  leaveLabel: { ...textStyles.button, color: colors.error },
});
