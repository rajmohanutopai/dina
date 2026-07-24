/**
 * Agents — admin screen for authorizing remote clients that act on
 * the user's behalf (port of main-dina `dina-admin device pair` +
 * `device list`). Today every entry here is a `dina-agent` install
 * (or a thing that wraps it like OpenClaw or `dina-cli`); there is
 * no Dina-to-Dina pairing — that's Contacts (DIDs). Mobile supports
 * the signed agent data APIs, but the filesystem-aware coding gate
 * itself runs only on Home Node Lite.
 *
 * Mints a pairing code and wraps it (with relay URL + node DID) into a
 * one-paste `dina1:…` setup string the agent consumes via
 * `dina configure` (interactive paste) or `--setup-code`. The screen
 * talks to Core via the in-process ceremony / registry modules — no
 * HTTP round-trip needed because Admin UI runs inside the same JS
 * runtime as Core.
 *
 * Reached via the "Agents" row on the main Settings screen. Route
 * stays `/paired-devices` to avoid breaking the deep-link surface.
 * Hidden from the tab bar.
 */

import { Stack } from 'expo-router';
import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
  Share,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getNodeDID, type AgentScope } from '@dina/core';
import {
  generatePairingCode,
  listDevices,
  revokeDeviceDurable,
  type DeviceRole,
  type PairedDevice,
} from '@dina/core/devices';

import { buildAgentSetupCode } from '../src/services/agent_setup_code';
import { resolveMsgBoxURL } from '../src/services/msgbox_wiring';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

interface LiveCode {
  code: string;
  expiresAt: number; // unix seconds
  deviceName: string;
  role: DeviceRole;
  scope: AgentScope;
  /**
   * The one-paste `dina1:…` string bundling relay URL + node DID +
   * this pairing code — the only pairing artifact the UI shows.
   */
  setupCode: string;
}

export default function PairedDevicesScreen() {
  const insets = useSafeAreaInsets();
  const bottomPad = insets.bottom + 49 + spacing.md;
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  // Empty default; the placeholder below shows `openclaw-user` as a
  // hint. Pre-filling forced anyone pairing dina-cli or a phone to
  // clear the field before typing — a self-defeating "convenience".
  const [deviceName, setDeviceName] = useState('');
  // Hardcoded — every paired entry is a `dina-agent` install today.
  // See the help text above the form for the rationale, and the
  // commented-out picker for the seam to restore if we ever add
  // Rich / Thin / CLI roles.
  const role: DeviceRole = 'agent';
  // This screen installs the Dina skill into interactive coding-agent hosts
  // (Claude Code, Codex, OpenClaw, etc.). Core derives this privilege from the
  // paired device record; omitting it would intentionally downgrade the agent
  // to the legacy `runner` scope and make the installed plugin unusable.
  const scope: AgentScope = 'coding';
  const [generating, setGenerating] = useState(false);
  const [liveCode, setLiveCode] = useState<LiveCode | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [sharedSetup, setSharedSetup] = useState(false);

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

  // Revoke a paired device. Cascades through the registry to
  // unregister the DID from auth/caller_type so subsequent signed
  // requests fail with caller-type 'unknown' (auth middleware
  // rejects). Confirmation dialog is mandatory — revocation breaks
  // any agent-daemon currently polling against this DID and the user
  // would have to re-pair to recover.
  const handleRevoke = useCallback(
    (device: PairedDevice) => {
      if (device.revoked) return;
      Alert.alert(
        `Revoke "${device.deviceName}"?`,
        'The agent will lose access immediately. Any in-flight signed requests will fail and the agent must be re-paired with a new code to regain access.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Revoke',
            style: 'destructive',
            onPress: () => {
              // issues.txt §5 — durable revoke: persist revoked=1 to SQL
              // BEFORE reporting success so a restart can't re-trust the
              // device. If persistence fails, access is still cut in-memory
              // but we must NOT claim a durable revoke — surface a warning.
              void (async () => {
                try {
                  const result = await revokeDeviceDurable(device.deviceId);
                  refreshDevices();
                  if (!result.durable) {
                    Alert.alert(
                      'Revoke not fully saved',
                      'Access was cut on this device, but the change could not be saved durably. It may not survive a restart, so please retry.',
                    );
                  }
                } catch (err) {
                  Alert.alert('Revoke failed', err instanceof Error ? err.message : String(err));
                }
              })();
            },
          },
        ],
      );
    },
    [refreshDevices],
  );

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

  // Share the one-paste setup string (AirDrop / Notes / clipboard apps).
  // Short-lived + single-use, same sensitivity envelope as the embedded
  // pairing code — the share sheet is the user's trust decision.
  const handleShareSetup = useCallback(() => {
    if (liveCode === null) return;
    Share.share({ message: liveCode.setupCode }).catch(() => {});
    setSharedSetup(true);
    setTimeout(() => setSharedSetup(false), 2000);
  }, [liveCode]);

  const handleGenerate = useCallback(() => {
    const name = deviceName.trim();
    if (name === '') {
      Alert.alert('Device name required', 'Give the device a name before generating a code.');
      return;
    }
    setGenerating(true);
    try {
      // Pairing codes are short-lived shared secrets — never log the
      // code value itself. iOS native logs persist for hours after a
      // generation, and `xcrun simctl log show` would surface a recent
      // code to anyone with simulator access (or anyone reading a
      // device sysdiagnose). Log only the metadata that can't be used
      // to pair: device name + role + non-secret scope.
      const { code, expiresAt } = generatePairingCode({ deviceName: name, role, scope });
      // The setup string IS the product — there is no bare-number
      // fallback (greenfield: every dina-agent understands `dina1:`,
      // and the number alone was never enough to configure anyway).
      // If the node identity isn't ready, fail loudly and let the user
      // retry rather than handing them a third of a setup.
      const nodeDid = getNodeDID();
      if (nodeDid === null) {
        throw new Error('Node identity not ready yet — wait for boot to finish and retry.');
      }
      const setupCode = buildAgentSetupCode({
        msgboxUrl: resolveMsgBoxURL(),
        homenodeDid: nodeDid,
        deviceName: name,
        code,
      });
      setLiveCode({ code, expiresAt, deviceName: name, role, scope, setupCode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[paired-devices] generate failed:', message);
      Alert.alert('Could not generate setup code', message);
    } finally {
      setGenerating(false);
    }
  }, [deviceName, role, scope]);

  const secondsRemaining = liveCode === null ? 0 : Math.max(0, liveCode.expiresAt - now);

  return (
    <>
      <Stack.Screen options={{ title: 'Agents' }} />
      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        bottomOffset={24}
      >
        <Section title={`CONNECTED (${devices.length})`}>
          {devices.length === 0 ? (
            <Text style={styles.empty}>No agents connected yet.</Text>
          ) : (
            devices.map((d) => (
              <View key={d.deviceId} style={styles.deviceRow}>
                <View style={styles.deviceRowMain}>
                  <Text style={styles.deviceName}>{d.deviceName}</Text>
                  <Text style={styles.deviceMeta}>
                    {d.role}
                    {d.scope !== undefined ? ` · ${d.scope}` : ''}
                  </Text>
                </View>
                <Text style={styles.deviceDID} numberOfLines={1} ellipsizeMode="middle">
                  {d.did}
                </Text>
                <Text style={styles.deviceMeta}>
                  Paired {new Date(d.createdAt).toLocaleDateString()}
                  {d.lastSeen > 0 ? ` • active ${new Date(d.lastSeen).toLocaleDateString()}` : ''}
                  {d.revoked ? ' • revoked' : ''}
                </Text>
                {!d.revoked && (
                  <Pressable
                    testID="paired-devices-revoke"
                    onPress={() => handleRevoke(d)}
                    style={({ pressed }) => [
                      styles.revokeButton,
                      pressed && styles.revokeButtonPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Revoke ${d.deviceName}`}
                  >
                    <Text style={styles.revokeText}>Revoke access</Text>
                  </Pressable>
                )}
              </View>
            ))
          )}
          <Pressable
            testID="paired-devices-refresh"
            onPress={refreshDevices}
            style={styles.refreshButton}
            accessibilityRole="button"
          >
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </Section>

        <Section title="AUTHORIZE A NEW AGENT">
          <Text style={styles.help}>
            Agents act on your behalf. They run as <Text style={styles.mono}>dina-agent</Text>,
            submit Ed25519 signed requests to this device, and only do what you allow.
            {'\n\n'}
            This mobile setup enables Dina memory, Ask, validation, and PII tools. The Claude Code
            safety-gate plugin requires a Home Node Lite setup code instead; do not enable its
            fail-closed hook against this mobile node.
            {'\n\n'}
            To pair a new agent:{'\n'}
            1. Install on the agent host: <Text style={styles.mono}>pip install dina-agent</Text>.
            {'\n'}
            2. Generate a setup code below.{'\n'}
            3. On the agent host, run <Text style={styles.mono}>dina init</Text> and paste the
            setup code when asked — it pairs, then installs the Dina skill for the agents on that
            machine.
            {'\n\n'}
            The agent then registers its own keypair against the embedded pairing code. The code
            expires shortly after it's issued.
          </Text>

          <Text style={styles.label}>Agent name</Text>
          <TextInput
            testID="paired-devices-agent-name"
            style={styles.input}
            value={deviceName}
            onChangeText={setDeviceName}
            placeholder="e.g. my-agent"
            autoCapitalize="none"
            autoCorrect={false}
          />

          {/*
            Role picker removed: today every paired entry is a
            interactive coding-agent install, and the legacy `rich` /
            `thin` / `cli` branches aren't wired into mobile. Delegation
            runners have a different privilege boundary and should get a
            separate setup surface rather than a picker that can silently
            mint the wrong authority here.
          */}

          <Pressable
            testID="paired-devices-generate"
            style={[styles.primaryButton, generating && styles.primaryButtonDisabled]}
            disabled={generating}
            onPress={handleGenerate}
            accessibilityRole="button"
          >
            {generating ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.primaryButtonText}>Generate Setup Code</Text>
            )}
          </Pressable>
        </Section>

        {liveCode !== null && (
          <Section title="SETUP CODE">
            <Text style={styles.help}>
              Paste this one string into <Text style={styles.mono}>dina configure</Text> on the
              agent host — it carries the relay address, this node's identity, and the pairing code,
              so there's nothing else to type.
            </Text>
            <Text
              testID="paired-devices-setup-code"
              selectable
              numberOfLines={2}
              ellipsizeMode="middle"
              style={styles.setupCode}
            >
              {liveCode.setupCode}
            </Text>
            <Pressable
              testID="paired-devices-share-setup"
              onPress={handleShareSetup}
              style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel="Share setup code"
            >
              <Text style={styles.copyButtonText}>
                {sharedSetup ? 'Shared!' : 'Share Setup Code'}
              </Text>
            </Pressable>
            <Text style={styles.codeMeta}>
              Pairing <Text style={styles.mono}>{liveCode.deviceName}</Text> as{' '}
              <Text style={styles.mono}>{liveCode.scope}</Text>
            </Text>
            <Text style={[styles.codeMeta, secondsRemaining < 60 && styles.codeExpiring]}>
              Expires in {formatDuration(secondsRemaining)}
            </Text>
          </Section>
        )}
      </KeyboardAwareScrollView>
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
  content: { padding: spacing.md },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    ...textStyles.label,
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
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  label: {
    ...textStyles.bodySmallStrong,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  input: {
    ...textStyles.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
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
    ...textStyles.bodyStrong,
    color: colors.white,
  },
  copyButton: {
    alignSelf: 'center',
    marginTop: spacing.xs,
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  copyButtonPressed: { opacity: 0.7 },
  copyButtonText: textStyles.buttonSmall,
  setupCode: {
    ...textStyles.monoSmall,
    color: colors.textPrimary,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.xs,
  },
  codeMeta: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  codeExpiring: { color: colors.error },
  empty: {
    ...textStyles.body,
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
  deviceName: textStyles.bodyStrong,
  deviceMeta: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
  },
  deviceDID: {
    ...textStyles.monoSmall,
    color: colors.textSecondary,
  },
  refreshButton: { alignSelf: 'flex-end', padding: spacing.sm },
  refreshText: {
    ...textStyles.bodySmall,
    color: colors.accent,
  },
  revokeButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.error,
  },
  revokeButtonPressed: { opacity: 0.6 },
  revokeText: {
    ...textStyles.caption,
    color: colors.error,
  },
  mono: textStyles.monoSmall,
});
