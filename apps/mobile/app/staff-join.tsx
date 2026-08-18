/**
 * Staff join (§6.3) — a clerk pastes the `dina1:` code their manager
 * shared, and this phone becomes a staff device OF that business node.
 * No vault, no seed: `pairStaffDevice` mints one device key, pairs over
 * the relay, and the identity persists in its own keychain row.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { pairStaffDevice } from '@dina/core';

import { saveStaffIdentity } from '../src/services/staff_identity_store';
import { makeStaffWebSocket } from '../src/services/staff_transport_rn';
import { colors, radius, spacing, textStyles } from '../src/theme';

export default function StaffJoinScreen(): React.ReactElement {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const join = useCallback(() => {
    void (async () => {
      if (code.trim() === '') return;
      setBusy(true);
      try {
        const identity = await pairStaffDevice({
          setupCode: code.trim(),
          makeWebSocket: makeStaffWebSocket,
          timeoutMs: 30_000,
        });
        await saveStaffIdentity(identity);
        Alert.alert('Joined', `This phone is now a staff device for ${identity.deviceName || 'the business'}.`);
        router.replace('/staff-home');
      } catch (err) {
        Alert.alert('Could not join', (err as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [code, router]);

  return (
    <View style={styles.container} testID="staff-join-screen">
      <Stack.Screen options={{ title: 'Join as staff' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.hint}>
          Ask the business owner to open Settings → Staff and share a staff setup code. Paste it
          here — this phone will act on their orders without ever holding their vault.
        </Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="dina1:…"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          testID="staff-code-input"
        />
        <Pressable
          style={[styles.button, (busy || code.trim() === '') && styles.busy]}
          disabled={busy || code.trim() === ''}
          onPress={join}
          testID="staff-join"
        >
          {busy ? (
            <ActivityIndicator color={colors.bgPrimary} />
          ) : (
            <Text style={styles.buttonLabel}>Join this business</Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { padding: spacing.lg },
  hint: { ...textStyles.body, color: colors.textSecondary, marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    minHeight: 88,
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
});
