/**
 * Agents — admin screen for authorizing remote clients that act on
 * the user's behalf (port of main-dina `dina-admin device pair` +
 * `device list`). Today every entry here is a `dina-agent` install
 * (or a thing that wraps it like OpenClaw or `dina-cli`); there is
 * no Dina-to-Dina pairing — that's Contacts (DIDs).
 *
 * Mints a new 8-character pairing code that the agent presents via
 * `dina configure --pairing-code`. The screen talks to Core via the
 * in-process ceremony / registry modules — no HTTP round-trip needed
 * because Admin UI runs inside the same JS runtime as Core.
 *
 * Reached via the "Agents" row on the main Settings screen. Route
 * stays `/paired-devices` to avoid breaking the deep-link surface.
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
import { colors, fonts, spacing, radius, shadows } from '../src/theme';
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
  // Empty default; the placeholder below shows `openclaw-user` as a
  // hint. Pre-filling forced anyone pairing dina-cli or a phone to
  // clear the field before typing — a self-defeating "convenience".
  const [deviceName, setDeviceName] = useState('');
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
      <Stack.Screen options={{ title: 'Agents' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Section title={`CONNECTED (${devices.length})`}>
          {devices.length === 0 ? (
            <Text style={styles.empty}>No agents connected yet.</Text>
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

        <Section title="AUTHORIZE A NEW AGENT">
          <Text style={styles.help}>
            Agents act on your behalf — today that means{' '}
            <Text style={styles.mono}>dina-agent</Text> (
            <Text style={styles.mono}>pip install dina-agent</Text>), used directly or via wrappers
            like OpenClaw and <Text style={styles.mono}>dina-cli</Text>.{'\n\n'}
            Generate an 8-character code, then hand it to the agent:{'\n'}• dina-agent / openclaw:
            paste into <Text style={styles.mono}>USER_PAIRING_CODE</Text> in docker/.env.{'\n'}•
            dina-cli: run <Text style={styles.mono}>dina configure --pairing-code &lt;code&gt;</Text>.
          </Text>

          <Text style={styles.label}>Agent name</Text>
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
  // 8-character Crockford-Base32 codes read easier split 4-4:
  // `ABCD EFGH`. Anything else falls through unchanged.
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
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
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
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
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.textPrimary,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontFamily: fonts.sans,
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
  roleLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    color: colors.textPrimary,
  },
  roleLabelActive: { color: colors.accent },
  roleHint: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    alignItems: 'center',
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: {
    fontFamily: fonts.sansSemibold,
    color: colors.white,
    fontSize: 15,
  },
  code: {
    fontFamily: fonts.monoMedium,
    fontSize: 42,
    color: colors.accent,
    textAlign: 'center',
    letterSpacing: 8,
    fontVariant: ['tabular-nums'],
    marginVertical: spacing.sm,
  },
  codeHint: {
    fontFamily: fonts.sans,
    textAlign: 'center',
    fontSize: 12,
    color: colors.textSecondary,
  },
  codeMeta: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  codeExpiring: { color: colors.error },
  empty: {
    fontFamily: fonts.sans,
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
  deviceName: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.textPrimary,
  },
  deviceMeta: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  deviceDID: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textSecondary,
  },
  refreshButton: { alignSelf: 'flex-end', padding: spacing.sm },
  refreshText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.accent,
  },
  mono: { fontFamily: fonts.mono, fontSize: 12 },
});
