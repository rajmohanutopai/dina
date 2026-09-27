/**
 * Owner access (WEB_OWNER_SURFACE_PLAN §3.3) — connect this browser as the
 * owner's device.
 *
 * In a browser opened from the Home Node's Core address, the owner connects
 * once: the owner key (the node's `owner_capability`) and, where the node
 * checks one, the passphrase. The browser then keeps a signing key it cannot
 * export and signs every owner request with it; the owner key is not kept.
 * On the phone the in-app user is already the owner, so the screen only says
 * so (Settings does not show the row there).
 */

import { Stack } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  OwnerDeviceError,
  connectOwnerDevice,
  disconnectOwnerDevice,
  ownerAccessState,
  subscribeOwnerAccess,
  type OwnerAccessState,
} from '../src/services/owner_device';
import { getOwnerSetupClient } from '../src/services/owner_setup_client';
import { colors, radius, spacing, textStyles } from '../src/theme';

/** Revoke this browser at Core, signed by the device itself. */
async function revokeThisBrowser(did: string): Promise<void> {
  const client = getOwnerSetupClient();
  if (client === null) throw new Error('owner access is not available here');
  const status = await client.status();
  const mine = status.owner_devices.find((device) => device.did === did);
  // Already gone at Core (revoked elsewhere): nothing left to revoke.
  if (mine === undefined) return;
  await client.revokeOwnerDevice(mine.device_id);
}

export default function OwnerAccessScreen(): React.ReactElement {
  const [state, setState] = useState<OwnerAccessState | null>(null);
  const [ownerKey, setOwnerKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [deviceName, setDeviceName] = useState('This browser');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setState(await ownerAccessState());
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeOwnerAccess(() => void refresh());
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      await connectOwnerDevice({ ownerKey, passphrase, deviceName });
      setOwnerKey('');
      setPassphrase('');
      setMessage('This browser now acts as the owner.');
    } catch (err) {
      setMessage(err instanceof OwnerDeviceError ? err.message : 'Could not connect. Try again.');
    } finally {
      setBusy(false);
    }
  }, [ownerKey, passphrase, deviceName]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      const { revoked } = await disconnectOwnerDevice(revokeThisBrowser);
      setMessage(
        revoked
          ? 'Disconnected. This browser no longer acts as the owner.'
          : 'Disconnected here. Core could not confirm the revoke; remove this browser from another owner surface.',
      );
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <View style={styles.container} testID="owner-access-screen">
      <Stack.Screen options={{ title: 'Owner access' }} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {state === null && <ActivityIndicator color={colors.textSecondary} />}

        {state?.kind === 'not_applicable' && (
          <Text style={styles.hint} testID="owner-access-not-applicable">
            On the phone, you are already the owner. Nothing to connect.
          </Text>
        )}

        {state?.kind === 'unavailable' && (
          <Text style={styles.hint} testID="owner-access-unavailable">
            {state.reason}
          </Text>
        )}

        {state?.kind === 'connected' && (
          <View testID="owner-access-connected">
            <Text style={styles.hint}>
              This browser acts as the owner of this Home Node. It signs each request with a key it
              cannot export.
            </Text>
            <Text style={styles.label}>Device</Text>
            <Text style={styles.value} testID="owner-access-device-name">
              {state.device.deviceName}
            </Text>
            <Text style={styles.label}>Key</Text>
            <Text style={styles.mono} selectable>
              {state.device.did}
            </Text>
            <Pressable
              style={[styles.buttonDanger, busy && styles.busy]}
              disabled={busy}
              onPress={() => void disconnect()}
              testID="owner-access-disconnect"
              accessibilityRole="button"
            >
              <Text style={styles.buttonDangerLabel}>Disconnect this browser</Text>
            </Pressable>
          </View>
        )}

        {state?.kind === 'disconnected' && (
          <View testID="owner-access-form">
            <Text style={styles.hint}>
              Connect this browser to approve orders, award tenders, manage staff and plugins here.
              You need the owner key from your Home Node (the owner_capability file) once; it is not
              kept.
            </Text>
            <Text style={styles.label}>Owner key</Text>
            <TextInput
              style={styles.input}
              value={ownerKey}
              onChangeText={setOwnerKey}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              testID="owner-access-key"
            />
            <Text style={styles.label}>Passphrase</Text>
            <TextInput
              style={styles.input}
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              testID="owner-access-passphrase"
            />
            <Text style={styles.label}>Name this browser</Text>
            <TextInput
              style={styles.input}
              value={deviceName}
              onChangeText={setDeviceName}
              maxLength={64}
              testID="owner-access-device"
            />
            <Pressable
              style={[
                styles.button,
                (busy || ownerKey.trim() === '' || deviceName.trim() === '') && styles.busy,
              ]}
              disabled={busy || ownerKey.trim() === '' || deviceName.trim() === ''}
              onPress={() => void connect()}
              testID="owner-access-connect"
              accessibilityRole="button"
            >
              {busy ? (
                <ActivityIndicator color={colors.bgPrimary} />
              ) : (
                <Text style={styles.buttonLabel}>Connect this browser</Text>
              )}
            </Pressable>
          </View>
        )}

        {message !== '' && (
          <Text style={styles.message} testID="owner-access-message">
            {message}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg, gap: spacing.sm },
  hint: { ...textStyles.body, color: colors.textSecondary, marginBottom: spacing.md },
  label: { ...textStyles.caption, color: colors.textSecondary, marginTop: spacing.md },
  value: { ...textStyles.body, color: colors.textPrimary },
  mono: { ...textStyles.caption, color: colors.textPrimary, fontFamily: 'monospace' },
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
    marginTop: spacing.lg,
  },
  buttonDanger: {
    borderColor: colors.error,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  busy: { opacity: 0.6 },
  buttonLabel: { ...textStyles.button, color: colors.bgPrimary },
  buttonDangerLabel: { ...textStyles.button, color: colors.error },
  message: { ...textStyles.body, color: colors.textPrimary, marginTop: spacing.md },
});
