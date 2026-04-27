/**
 * Admin — mobile mirror of `dina-admin` on main-dina.
 *
 * Single scrollable page broken into sections, matching the top-level
 * dina-admin CLI surface. Sections are ordered by how load-bearing
 * they are for real-world ops:
 *
 *   1. Identity    — who this node publishes as, key fingerprints,
 *                    Re-publish PLC doc (future).
 *   2. Security    — auto-start vs manual-start, wipe vault.
 *   3. Devices     — drills into paired-devices (existing).
 *   4. Model       — drills into BYOK settings (existing).
 *   5. Policies    — risk thresholds (stub).
 *   6. Diagnostics — degradations + runtime warnings for support
 *                    copy/paste.
 *
 * Everything is read-only + drill-down for MVP. Edits are linked out
 * to existing sub-pages where they already work (paired-devices, BYOK)
 * and stubbed with "Coming soon" alerts where they don't.
 */

import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { colors, fonts, radius, shadows, spacing } from '../src/theme';
import { getBootedNode, getBootDegradations } from '../src/hooks/useNodeBootstrap';
import { getRuntimeWarnings, subscribeRuntimeWarnings } from '../src/services/runtime_warnings';
import { loadPersistedDid } from '../src/services/identity_record';
import { signOutLocal, eraseEverythingLocal } from '../src/services/local_data_wipe';
import { sendChatMessage } from '../src/services/chat_d2d';

export default function AdminScreen(): React.ReactElement {
  const router = useRouter();
  const node = getBootedNode();
  const degradations = getBootDegradations();
  const runtimeWarnings = useSyncExternalStore(
    subscribeRuntimeWarnings,
    getRuntimeWarnings,
    getRuntimeWarnings,
  );

  const [persistedDid, setPersistedDid] = useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void loadPersistedDid().then((d) => {
      if (!cancelled) setPersistedDid(d);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSignOut = useCallback(() => {
    Alert.alert(
      'Sign out from this device?',
      'Removes this device’s keys and disconnects it from your Dina. Encrypted data on this device stays on disk but is unreadable without the keys. Re-onboard with your recovery phrase to come back — your data on this device will be recoverable.\n\nYour Dina identity on the network is unaffected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await signOutLocal();
                Alert.alert('Signed out', 'Close and reopen the app to onboard again.');
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                Alert.alert('Couldn’t sign out', msg);
              }
            })();
          },
        },
      ],
    );
  }, []);

  const onEraseEverything = useCallback(() => {
    Alert.alert(
      'Erase everything on this device?',
      'Permanently deletes all data on this device — chat history, reminders, contacts, vault entries, and your keys. This cannot be undone on this device.\n\nYour Dina identity on the network and any data on other paired devices are unaffected. Re-onboard with your recovery phrase to start fresh on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Erase everything',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await eraseEverythingLocal();
                Alert.alert(
                  'Erased',
                  'All data on this device has been deleted. Close and reopen the app to onboard again.',
                );
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                Alert.alert('Couldn’t erase', msg);
              }
            })();
          },
        },
      ],
    );
  }, []);

  // iOS lacks a programmatic clipboard without a native module; the
  // system Share sheet has "Copy" as a built-in action, so we route
  // both "copy DID" + "copy JSON" through it rather than adding
  // expo-clipboard / @react-native-clipboard just for two call sites.
  const copy = (value: string): void => {
    void Share.share({ message: value });
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Admin', headerShown: true }} />
      <ScrollView contentContainerStyle={styles.scroll} style={styles.root}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.eyebrow}>ADMIN</Text>
          <Text style={styles.title}>
            {node === null ? 'Node not booted' : `Running as ${shortRole(node.role)}`}
          </Text>
          <Text style={styles.subtitle}>
            Everything you’d do from <Text style={styles.code}>dina-admin</Text> on the desktop
            install, on-device.
          </Text>
        </View>

        {/* Identity */}
        <Section title="Identity">
          <Row label="DID" value={persistedDid ?? node?.did ?? '—'} copyable onCopy={copy} mono />
          <Row label="Role" value={shortRole(node?.role)} />
          <Row label="Brain client" value={node === null ? 'offline' : 'connected'} />
          <Placeholder
            title="Re-publish PLC document"
            body="Update services (MsgBox endpoint, handle) on plc.directory."
          />
        </Section>

        {/* Security */}
        <Section title="Security">
          <Row label="Encryption" value="AES-256-GCM" />
          <Row label="KDF" value="Argon2id (64 MiB, t=3, p=4)" />
          <Row label="Key storage" value="Device Keychain" />
          <Placeholder
            title="Change passphrase"
            body="Re-wrap your master seed with a new passphrase."
          />
          <Placeholder
            title="Auto-start vs manual-start"
            body="Require passphrase on every launch for extra safety."
          />
        </Section>

        {/* Devices */}
        <Section title="Devices">
          <DrillRow label="Paired devices" onPress={() => router.push('/paired-devices')} />
        </Section>

        {/* Model */}
        <Section title="Language model">
          <DrillRow
            label="BYOK providers (OpenAI / Gemini)"
            onPress={() => router.push('/settings')}
          />
        </Section>

        {/* Policies */}
        <Section title="Policies">
          <Placeholder
            title="Risk thresholds"
            body="Gate which agent actions require explicit approval."
          />
        </Section>

        {/* Dev-only self-test — routes a real D2D coordination.request
            through the full core pipeline (sendD2D → sealed envelope →
            /forward) with the dev contact DID as recipient. Appears only
            when EXPO_PUBLIC_DINA_DEV_CONTACT is set. Lets us exercise
            the relay path without fighting simulator keyboard input. */}
        {(process.env.EXPO_PUBLIC_DINA_DEV_CONTACT ?? '') !== '' ? (
          <Section title="Dev self-test">
            <DevSendTestRow />
          </Section>
        ) : null}

        {/* Diagnostics */}
        <Section title="Diagnostics">
          <Text style={styles.diagGroupLabel}>Boot degradations</Text>
          {degradations.length === 0 ? (
            <Text style={styles.diagEmpty}>All boot inputs wired ✓</Text>
          ) : (
            degradations.map((d) => (
              <View key={d.code} style={styles.diagItem}>
                <Text style={styles.diagCode}>{d.code}</Text>
                <Text style={styles.diagMessage}>{d.message}</Text>
              </View>
            ))
          )}

          <Text style={[styles.diagGroupLabel, styles.diagGroupSpacer]}>Runtime warnings</Text>
          {runtimeWarnings.length === 0 ? (
            <Text style={styles.diagEmpty}>No active warnings</Text>
          ) : (
            runtimeWarnings.map((w) => (
              <View key={w.code} style={styles.diagItem}>
                <Text style={styles.diagCode}>{w.code}</Text>
                <Text style={styles.diagMessage}>{w.message}</Text>
              </View>
            ))
          )}

          <Pressable
            onPress={() => copy(JSON.stringify({ degradations, runtimeWarnings }, null, 2))}
            style={({ pressed }) => [styles.copyAll, pressed && styles.pressed]}
          >
            <Text style={styles.copyAllText}>Copy JSON for support</Text>
          </Pressable>
        </Section>

        {/* Danger zone */}
        <Section title="Danger zone" danger>
          <View style={styles.dangerNote}>
            <Text style={styles.dangerNoteText}>
              These actions only affect this device. Your Dina identity on the network is
              recoverable from your recovery phrase.
            </Text>
          </View>
          <Pressable
            onPress={onSignOut}
            style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
          >
            <Text style={styles.dangerTitle}>Sign out from this device</Text>
            <Text style={styles.dangerBody}>
              Removes this device’s keys. Encrypted data on this device stays on disk and is
              recoverable when you re-onboard with your recovery phrase.
            </Text>
          </Pressable>
          <Pressable
            onPress={onEraseEverything}
            style={({ pressed }) => [styles.dangerBtn, styles.dangerBtnDivider, pressed && styles.pressed]}
          >
            <Text style={styles.dangerTitle}>Erase everything on this device</Text>
            <Text style={styles.dangerBody}>
              Permanently deletes all data on this device — chat, reminders, contacts, vault
              entries, and keys. Cannot be undone on this device.
            </Text>
          </Pressable>
        </Section>
      </ScrollView>
    </>
  );
}

function DevSendTestRow(): React.ReactElement {
  const [status, setStatus] = useState<'idle' | 'sending' | 'ok' | 'err'>('idle');
  const [detail, setDetail] = useState<string>('');
  const ranRef = React.useRef<boolean>(false);

  const dev = process.env.EXPO_PUBLIC_DINA_DEV_CONTACT ?? '';
  const [didStr] = dev.split('|');
  const autoSend = (process.env.EXPO_PUBLIC_DINA_DEV_AUTOSEND ?? '') === '1';

  const onPress = React.useCallback(async (): Promise<void> => {
    setStatus('sending');
    setDetail('');
    try {
      const msg = await sendChatMessage(didStr ?? '', `dev-test ${new Date().toISOString()}`);
      setStatus('ok');
      setDetail(`Sent id=${msg.id.slice(0, 8)}\u2026`);
    } catch (err) {
      setStatus('err');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }, [didStr]);

  // Dev autopilot: when EXPO_PUBLIC_DINA_DEV_AUTOSEND=1 is set, fire the
  // send exactly once on mount. Lets us run an end-to-end D2D smoke
  // without simulating composer taps.
  React.useEffect(() => {
    if (!autoSend || ranRef.current) return;
    ranRef.current = true;
    void onPress();
  }, [autoSend, onPress]);

  return (
    <View style={devTestStyles.wrap}>
      <Text style={devTestStyles.label}>Send coordination.request to:</Text>
      <Text style={devTestStyles.did}>{didStr ?? '—'}</Text>
      <Pressable
        onPress={() => {
          void onPress();
        }}
        disabled={status === 'sending'}
        style={({ pressed }) => [
          devTestStyles.btn,
          pressed && { opacity: 0.7 },
          status === 'sending' && { opacity: 0.5 },
        ]}
      >
        <Text style={devTestStyles.btnText}>
          {status === 'sending' ? 'Sending\u2026' : 'Send dev test'}
        </Text>
      </Pressable>
      {status !== 'idle' && detail !== '' ? (
        <Text style={[devTestStyles.detail, status === 'err' && devTestStyles.detailErr]}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const devTestStyles = StyleSheet.create({
  wrap: {
    padding: spacing.md,
  },
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  did: {
    marginTop: 2,
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.textPrimary,
  },
  btn: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignSelf: 'flex-start',
  },
  btnText: {
    fontFamily: fonts.sansSemibold,
    color: '#FFFFFF',
    fontSize: 13,
  },
  detail: {
    marginTop: spacing.sm,
    fontSize: 12,
    lineHeight: 17,
    color: colors.success,
    fontFamily: fonts.mono,
  },
  detailErr: {
    color: colors.error,
  },
});

function Section({
  title,
  danger,
  children,
}: {
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, danger && styles.sectionDanger]}>
        {title.toUpperCase()}
      </Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function Row(props: {
  label: string;
  value: string;
  copyable?: boolean;
  onCopy?: (v: string) => void;
  mono?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{props.label}</Text>
      <View style={styles.rowValueWrap}>
        <Text style={[styles.rowValue, props.mono && styles.rowValueMono]} numberOfLines={2}>
          {props.value}
        </Text>
        {props.copyable && props.value !== '—' ? (
          <Pressable onPress={() => props.onCopy?.(props.value)} hitSlop={10}>
            <Text style={styles.copyGlyph}>{'\u29C9'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function DrillRow({ label, onPress }: { label: string; onPress: () => void }): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.drillRow, pressed && styles.pressed]}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.drillArrow}>{'\u203A'}</Text>
    </Pressable>
  );
}

function Placeholder({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderTitle}>{title}</Text>
      <Text style={styles.placeholderBody}>{body}</Text>
      <Text style={styles.placeholderBadge}>COMING SOON</Text>
    </View>
  );
}

function shortRole(role?: string): string {
  if (role === undefined || role === null) return '—';
  if (role === 'requester') return 'requester';
  if (role === 'provider') return 'provider';
  if (role === 'both') return 'provider + requester';
  return role;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgPrimary },
  scroll: { paddingBottom: spacing.xxl },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  eyebrow: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 2.4,
    color: colors.textMuted,
  },
  title: {
    marginTop: spacing.xs,
    fontFamily: fonts.serif,
    fontStyle: 'italic',
    fontSize: 30,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: fonts.sans,
    marginTop: spacing.sm,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.textPrimary,
  },
  section: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginBottom: spacing.sm,
    paddingLeft: 4,
  },
  sectionDanger: { color: colors.error },
  sectionCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    ...shadows.sm,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  rowLabel: {
    fontFamily: fonts.sansSemibold,
    width: 110,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 2,
  },
  rowValueWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  rowValue: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  rowValueMono: {
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  copyGlyph: {
    fontSize: 16,
    color: colors.textMuted,
  },
  drillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  drillArrow: {
    fontFamily: fonts.sans,
    marginLeft: 'auto',
    fontSize: 18,
    color: colors.textMuted,
  },
  placeholder: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  placeholderTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    color: colors.textPrimary,
  },
  placeholderBody: {
    fontFamily: fonts.sans,
    marginTop: 3,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  placeholderBadge: {
    fontFamily: fonts.sansSemibold,
    marginTop: 6,
    fontSize: 9,
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  diagGroupLabel: {
    fontFamily: fonts.sansSemibold,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  diagGroupSpacer: {
    marginTop: spacing.md,
  },
  diagEmpty: {
    fontFamily: fonts.sans,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    fontSize: 13,
    color: colors.success,
  },
  diagItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  diagCode: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.warning,
    letterSpacing: 0.2,
  },
  diagMessage: {
    fontFamily: fonts.sans,
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
  },
  copyAll: {
    margin: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
  },
  copyAllText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.textPrimary,
  },
  dangerNote: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  dangerNoteText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  dangerBtn: {
    padding: spacing.md,
  },
  dangerBtnDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  dangerTitle: {
    fontFamily: fonts.headingBold,
    fontSize: 15,
    color: colors.error,
  },
  dangerBody: {
    fontFamily: fonts.sans,
    marginTop: 3,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  pressed: { opacity: 0.7 },
});
