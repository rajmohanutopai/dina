/**
 * Paired Devices — admin screen for device-pairing (port of main-dina
 * `dina-admin device pair` + `device list`).
 *
 * Shows the currently-paired devices (dina-agent containers, rich
 * devices, thin clients) and lets the admin mint a new 6-digit
 * pairing code that the device presents via
 * `dina configure --pairing-code`. The screen talks to Core via the
 * in-process ceremony / registry modules — no HTTP round-trip needed
 * because Admin UI runs inside the same JS runtime as Core.
 *
 * Reached via the "Paired Devices" row on the main Settings screen.
 * Hidden from the tab bar.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Stack } from 'expo-router';
import { colors, spacing, radius, shadows } from '../src/theme';
import { generatePairingCode } from '@dina/core/src/pairing/ceremony';
import { listDevices, type PairedDevice, type DeviceRole } from '@dina/core/src/devices/registry';

const ROLE_OPTIONS: readonly { value: DeviceRole; label: string; hint: string }[] = [
  {
    value: 'agent',
    label: 'Agent',
    hint: 'Headless runner (dina-agent / openclaw). Claims delegation tasks.',
  },
  { value: 'rich', label: 'Rich', hint: 'Companion device with full UI.' },
  { value: 'thin', label: 'Thin', hint: 'Limited device — view + approve only.' },
  { value: 'cli', label: 'CLI', hint: 'Command-line interface.' },
];

interface LiveCode {
  code: string;
  expiresAt: number; // unix seconds
  deviceName: string;
  role: DeviceRole;
}

export default function PairedDevicesScreen() {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [deviceName, setDeviceName] = useState('openclaw-user');
  const [role, setRole] = useState<DeviceRole>('agent');
  const [generating, setGenerating] = useState(false);
  const [liveCode, setLiveCode] = useState<LiveCode | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const refreshDevices = useCallback(() => {
    try {
      setDevices(listDevices());
    } catch (err) {
      // `listDevices()` reads the in-memory registry; failures here
      // mean the module hasn't been hydrated. Not fatal — just show
      // an empty list.
      console.warn('[paired-devices] listDevices failed', err);
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  // Tick the expiry countdown every second while a code is live.
  useEffect(() => {
    if (liveCode === null) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [liveCode]);

  // Auto-clear expired codes so the UI doesn't misleadingly keep
  // showing a code the ceremony module has already purged.
  useEffect(() => {
    if (liveCode !== null && liveCode.expiresAt <= now) {
      setLiveCode(null);
    }
  }, [liveCode, now]);

  const handleGenerate = useCallback(() => {
    const name = deviceName.trim();
    if (name === '') {
      Alert.alert('Device name required', 'Give the device a name before generating a code.');
      return;
    }
    setGenerating(true);
    try {
      const { code, expiresAt } = generatePairingCode({ deviceName: name, role });
      setLiveCode({ code, expiresAt, deviceName: name, role });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert('Could not generate code', message);
    } finally {
      setGenerating(false);
    }
  }, [deviceName, role]);

  // Clipboard dep isn't shipped yet — user long-presses the code to
  // use the OS-native selection. Added as a follow-up once
  // expo-clipboard lands in package.json.

  const secondsRemaining = liveCode === null ? 0 : Math.max(0, liveCode.expiresAt - now);

  return (
    <>
      <Stack.Screen options={{ title: 'Paired Devices' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Section title="PAIR A NEW DEVICE">
          <Text style={styles.help}>
            Generate a 6-digit code, then give it to the device you want to pair.{'\n'}• dina-agent
            / openclaw: paste into <Text style={styles.mono}>USER_PAIRING_CODE</Text> in
            docker/.env.{'\n'}• dina-cli: run{' '}
            <Text style={styles.mono}>dina configure --pairing-code &lt;code&gt;</Text>.
          </Text>

          <Text style={styles.label}>Device name</Text>
          <TextInput
            style={styles.input}
            value={deviceName}
            onChangeText={setDeviceName}
            placeholder="e.g. openclaw-user"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Role</Text>
          <View style={styles.rolePicker}>
            {ROLE_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[styles.roleOption, role === opt.value && styles.roleOptionActive]}
                onPress={() => setRole(opt.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: role === opt.value }}
              >
                <Text style={[styles.roleLabel, role === opt.value && styles.roleLabelActive]}>
                  {opt.label}
                </Text>
                <Text style={styles.roleHint}>{opt.hint}</Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            style={[styles.primaryButton, generating && styles.primaryButtonDisabled]}
            disabled={generating}
            onPress={handleGenerate}
            accessibilityRole="button"
          >
            {generating ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.primaryButtonText}>Generate Pairing Code</Text>
            )}
          </Pressable>
        </Section>

        {liveCode !== null && (
          <Section title="CURRENT CODE">
            <Text selectable style={styles.code}>
              {formatCode(liveCode.code)}
            </Text>
            <Text style={styles.codeHint}>Long-press to copy.</Text>
            <Text style={styles.codeMeta}>
              Pairing <Text style={styles.mono}>{liveCode.deviceName}</Text> as{' '}
              <Text style={styles.mono}>{liveCode.role}</Text>
            </Text>
            <Text style={[styles.codeMeta, secondsRemaining < 60 && styles.codeExpiring]}>
              Expires in {formatDuration(secondsRemaining)}
            </Text>
          </Section>
        )}

        <Section title={`PAIRED (${devices.length})`}>
          {devices.length === 0 ? (
            <Text style={styles.empty}>No devices paired yet.</Text>
          ) : (
            devices.map((d) => (
              <View key={d.deviceId} style={styles.deviceRow}>
                <View style={styles.deviceRowMain}>
                  <Text style={styles.deviceName}>{d.deviceName}</Text>
                  <Text style={styles.deviceMeta}>{d.role}</Text>
                </View>
                <Text style={styles.deviceDID} numberOfLines={1} ellipsizeMode="middle">
                  {d.did}
                </Text>
                <Text style={styles.deviceMeta}>
                  Paired {new Date(d.createdAt).toLocaleDateString()}
                  {d.lastSeen > 0 ? ` • active ${new Date(d.lastSeen).toLocaleDateString()}` : ''}
                  {d.revoked ? ' • revoked' : ''}
                </Text>
              </View>
            ))
          )}
          <Pressable
            onPress={refreshDevices}
            style={styles.refreshButton}
            accessibilityRole="button"
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </Section>
      </ScrollView>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Section(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.card}>{props.children}</View>
    </View>
  );
}

function formatCode(code: string): string {
  // 6-digit codes read easier split 3-3: `123 456`.
  if (code.length !== 6) return code;
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    marginLeft: spacing.sm,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    ...shadows.sm,
  },
  help: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: 15,
    color: colors.textPrimary,
  },
  rolePicker: { marginTop: spacing.xs },
  roleOption: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.xs,
  },
  roleOptionActive: {
    borderColor: colors.accent,
    backgroundColor: colors.bgTertiary,
  },
  roleLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  roleLabelActive: { color: colors.accent },
  roleHint: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: colors.white, fontSize: 15, fontWeight: '600' },
  code: {
    fontSize: 42,
    fontWeight: '700',
    color: colors.accent,
    textAlign: 'center',
    letterSpacing: 8,
    fontVariant: ['tabular-nums'],
    marginVertical: spacing.sm,
  },
  codeHint: { textAlign: 'center', fontSize: 12, color: colors.textSecondary },
  codeMeta: { fontSize: 13, color: colors.textSecondary, marginTop: spacing.xs },
  codeExpiring: { color: colors.error },
  empty: {
    fontSize: 14,
    color: colors.textSecondary,
    fontStyle: 'italic',
    textAlign: 'center',
    padding: spacing.md,
  },
  deviceRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  deviceRowMain: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  deviceName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  deviceMeta: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  deviceDID: { fontSize: 11, color: colors.textSecondary, fontFamily: 'Menlo' },
  refreshButton: { alignSelf: 'flex-end', padding: spacing.sm },
  refreshText: { fontSize: 13, color: colors.accent },
  mono: { fontFamily: 'Menlo', fontSize: 12 },
});
