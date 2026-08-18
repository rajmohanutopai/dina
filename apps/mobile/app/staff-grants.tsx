/**
 * Staff — the §6 grant ceremony: pick a paired staff device, grant a
 * scoped, value-capped authority, set its presence PIN (the first grant
 * REQUIRES one — a grant with no presence path is dead authority), and
 * revoke everything with one tap.
 */

import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { OwnerCommerceHttpError } from '@dina/core';
import { listDevices } from '@dina/core/devices';

import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import { colors, radius, spacing, textStyles } from '../src/theme';

import type { StaffGrantEntry } from '@dina/core';

const SCOPES = [
  { key: 'commerce_confirm', label: 'Confirm order drafts', capped: false },
  { key: 'commerce_submit', label: 'Approve & place orders', capped: true },
  { key: 'commerce_receive_goods', label: 'Receipt deliveries', capped: true },
] as const;

function shortDid(did: string): string {
  return did.length > 20 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did;
}

export default function StaffGrantsScreen(): React.ReactElement {
  const [staffDevices, setStaffDevices] = useState<{ did: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [grants, setGrants] = useState<StaffGrantEntry[]>([]);
  const [scope, setScope] = useState<(typeof SCOPES)[number]>(SCOPES[0]);
  const [cap, setCap] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [presencePrompt, setPresencePrompt] = useState<{ retry: () => Promise<void> } | null>(null);
  const [passphrase, setPassphrase] = useState('');

  const reload = useCallback(async () => {
    const devices = listDevices()
      .filter((device) => !device.revoked && device.role === 'staff' && device.did !== '')
      .map((device) => ({ did: device.did, name: device.deviceName }));
    setStaffDevices(devices);
    if (selected !== null) {
      try {
        const answer = await getOwnerCommerceClient()?.listStaffGrants(selected);
        setGrants(answer?.grants ?? []);
      } catch {
        setGrants([]);
      }
    }
  }, [selected]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  /** Run the ceremony; on `no_user_presence` raise the passphrase sheet. */
  const withPresence = useCallback(
    async (operation: () => Promise<void>) => {
      setBusy(true);
      try {
        await operation();
      } catch (err) {
        if (err instanceof OwnerCommerceHttpError && err.errorKey === 'no_user_presence') {
          setPresencePrompt({ retry: operation });
        } else {
          Alert.alert('Could not grant', (err as Error).message);
        }
      } finally {
        setBusy(false);
        void reload();
      }
    },
    [reload],
  );

  const submitPresence = useCallback(async () => {
    const client = getOwnerCommerceClient();
    if (client === null || presencePrompt === null) return;
    const retry = presencePrompt.retry;
    setBusy(true);
    try {
      await client.provePresence(passphrase);
      setPresencePrompt(null);
      setPassphrase('');
      await retry();
    } catch {
      Alert.alert('Not verified', 'That passphrase did not verify. Try again.');
    } finally {
      setBusy(false);
      void reload();
    }
  }, [passphrase, presencePrompt, reload]);

  const grant = useCallback(() => {
    const client = getOwnerCommerceClient();
    if (client === null || selected === null) return;
    const scopeLabel = scope.label;
    const target = selected;
    void withPresence(async () => {
      await client.createStaffGrant({
        deviceDid: target,
        scope: scope.key,
        installs: 'both',
        ...(scope.capped
          ? {
              // Rupees in, minor units stored — the cap is money.
              maxOrderMinorUnits: String(Math.round(Number(cap) * 100)),
              currency: 'INR',
            }
          : {}),
        ...(pin.trim() !== '' ? { pin: pin.trim() } : {}),
      });
      setPin('');
      setCap('');
      Alert.alert('Granted', `${scopeLabel} for ${shortDid(target)}.`);
    });
  }, [selected, scope, cap, pin, withPresence]);

  const revokeAll = useCallback(() => {
    if (selected === null) return;
    Alert.alert('Revoke this staff device?', 'Every grant, its PIN and any presence proof end now.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await getOwnerCommerceClient()?.revokeStaffGrants(selected);
            } catch (err) {
              Alert.alert('Could not revoke', (err as Error).message);
            }
            void reload();
          })();
        },
      },
    ]);
  }, [selected, reload]);

  return (
    <View style={styles.container} testID="staff-grants-screen">
      <Stack.Screen options={{ title: 'Staff' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.hint}>
          Staff phones pair under Settings → Paired Devices with the role “staff”. A grant gives
          exactly one commerce operation, capped in rupees where money moves; everything above the
          cap becomes a card for you.
        </Text>

        <Text style={styles.sectionTitle}>Device</Text>
        {staffDevices.length === 0 && (
          <Text style={styles.empty} testID="staff-none">
            No staff devices paired yet.
          </Text>
        )}
        {staffDevices.map((device) => (
          <Pressable
            key={device.did}
            style={[styles.row, selected === device.did && styles.rowSelected]}
            onPress={() => setSelected(device.did)}
            testID={`staff-device-${device.did}`}
          >
            <Text style={[styles.rowTitle, styles.rowText]}>{device.name}</Text>
            <Text style={styles.rowMeta}>{shortDid(device.did)}</Text>
          </Pressable>
        ))}

        {selected !== null && (
          <>
            <Text style={styles.sectionTitle}>Grant</Text>
            {SCOPES.map((entry) => (
              <Pressable
                key={entry.key}
                style={[styles.row, scope.key === entry.key && styles.rowSelected]}
                onPress={() => setScope(entry)}
                testID={`staff-scope-${entry.key}`}
              >
                <Text style={[styles.rowTitle, styles.rowText]}>{entry.label}</Text>
              </Pressable>
            ))}
            {scope.capped && (
              <TextInput
                style={styles.input}
                value={cap}
                onChangeText={setCap}
                placeholder="Cap in ₹ (e.g. 25000)"
                placeholderTextColor={colors.textSecondary}
                keyboardType="numeric"
                testID="staff-cap-input"
              />
            )}
            <TextInput
              style={styles.input}
              value={pin}
              onChangeText={setPin}
              placeholder="Presence PIN (required on the first grant)"
              placeholderTextColor={colors.textSecondary}
              keyboardType="numeric"
              secureTextEntry
              testID="staff-pin-input"
            />
            <Pressable
              style={[styles.grantButton, busy && styles.busy]}
              disabled={busy || (scope.capped && cap.trim() === '')}
              onPress={grant}
              testID="staff-grant"
            >
              {busy ? (
                <ActivityIndicator color={colors.bgPrimary} />
              ) : (
                <Text style={styles.grantLabel}>Grant</Text>
              )}
            </Pressable>

            <Text style={styles.sectionTitle}>Standing grants</Text>
            {grants.filter((g) => g.revoked_at === null).length === 0 && (
              <Text style={styles.empty}>None yet.</Text>
            )}
            {grants
              .filter((g) => g.revoked_at === null)
              .map((g) => (
                <View key={g.scope} style={styles.row}>
                  <Text style={[styles.rowTitle, styles.rowText]}>
                    {SCOPES.find((entry) => entry.key === g.scope)?.label ?? g.scope}
                  </Text>
                  {g.max_order_minor_units !== '' && (
                    <Text style={styles.rowMeta}>
                      ≤ ₹{(Number(g.max_order_minor_units) / 100).toFixed(0)}
                    </Text>
                  )}
                </View>
              ))}
            <Pressable style={styles.revokeButton} onPress={revokeAll} testID="staff-revoke">
              <Text style={styles.revokeLabel}>Revoke this device</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      {/* §6.2 — granting standing authority needs a person present. */}
      <Modal visible={presencePrompt !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="presence-sheet">
            <Text style={styles.sectionTitle}>Confirm it’s you</Text>
            <Text style={styles.hint}>
              A grant hands this device real authority, so Dina checks a person is here.
            </Text>
            <TextInput
              testID="presence-passphrase"
              style={styles.input}
              secureTextEntry
              placeholder="Your passphrase"
              placeholderTextColor={colors.textSecondary}
              value={passphrase}
              onChangeText={setPassphrase}
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => {
                  setPresencePrompt(null);
                  setPassphrase('');
                }}
              >
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable testID="presence-submit" onPress={() => void submitPresence()}>
                <Text style={styles.link}>Verify</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  hint: { ...textStyles.caption, color: colors.textSecondary },
  sectionTitle: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  empty: { ...textStyles.body, color: colors.textSecondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowSelected: { borderWidth: 1, borderColor: colors.accent },
  rowText: { flex: 1 },
  rowTitle: { ...textStyles.body, color: colors.textPrimary },
  rowMeta: { ...textStyles.caption, color: colors.textSecondary },
  input: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    ...textStyles.body,
  },
  grantButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  busy: { opacity: 0.6 },
  grantLabel: { ...textStyles.button, color: colors.bgPrimary },
  revokeButton: {
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.error,
    marginTop: spacing.sm,
  },
  revokeLabel: { ...textStyles.button, color: colors.error },
  link: { ...textStyles.body, color: colors.core },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.lg,
    marginTop: spacing.md,
  },
});
