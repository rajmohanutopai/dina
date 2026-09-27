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
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { PresenceSheet } from '../src/components/PresenceSheet';
import { usePresenceGate } from '../src/hooks/usePresenceGate';
import { confirmDecision } from '../src/services/confirm_decision';
import { getOwnerCommerceClient } from '../src/services/owner_commerce_client';
import {
  CONNECT_OWNER_DEVICE_MESSAGE,
  errorKeyOf,
  ownerErrorText,
} from '../src/services/owner_errors';
import { getOwnerSetupClient } from '../src/services/owner_setup_client';
import { showMessage } from '../src/services/show_message';
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
  /** Why the device list is empty when it could not load (a browser not connected). */
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [grants, setGrants] = useState<StaffGrantEntry[]>([]);
  const [scope, setScope] = useState<(typeof SCOPES)[number]>(SCOPES[0]);
  const [cap, setCap] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    // Core's paired staff devices (the phone's own Core, or the Home Node's
    // for a browser connected as the owner).
    try {
      const status = await getOwnerSetupClient()?.status();
      setStaffDevices(
        (status?.staff_devices ?? [])
          .filter((device) => device.did !== '')
          .map((device) => ({ did: device.did, name: device.name })),
      );
      setListError(null);
    } catch (err) {
      setStaffDevices([]);
      setListError(
        errorKeyOf(err) === 'owner_device_not_connected'
          ? CONNECT_OWNER_DEVICE_MESSAGE
          : 'Could not load the staff devices. Try again shortly.',
      );
    }
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

  const { run: runGated, sheet: presenceSheet } = usePresenceGate({
    prove: async (passphrase) => {
      const client = getOwnerCommerceClient();
      if (client === null) throw new Error('Dina is still starting up.');
      await client.provePresence(passphrase);
    },
    onError: (err) => showMessage('Could not grant', ownerErrorText(err)),
    onSettled: () => void reload(),
    reason: 'A grant hands this device real authority, so Dina checks a person is here.',
  });

  /** Run an owner action; a lapsed presence raises the passphrase sheet, then retries. */
  const withPresence = useCallback(
    async (operation: () => Promise<void>) => {
      setBusy(true);
      try {
        await runGated(operation);
      } finally {
        setBusy(false);
      }
    },
    [runGated],
  );

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
      showMessage('Granted', `${scopeLabel} for ${shortDid(target)}.`);
    });
  }, [selected, scope, cap, pin, withPresence]);

  const revokeAll = useCallback(() => {
    if (selected === null) return;
    const target = selected;
    void (async () => {
      const revoke = await confirmDecision(
        'Revoke this staff device?',
        'Every grant, its PIN and any presence proof end now.',
        'Revoke',
        true,
        'Keep',
      );
      if (!revoke) return;
      try {
        await getOwnerCommerceClient()?.revokeStaffGrants(target);
      } catch (err) {
        showMessage('Could not revoke', ownerErrorText(err));
      }
      void reload();
    })();
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
            {listError ?? 'No staff devices paired yet.'}
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
      <PresenceSheet {...presenceSheet} />
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
});
