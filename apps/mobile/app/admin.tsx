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

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getBootedNode, getBootDegradations } from '../src/hooks/useNodeBootstrap';
import { shareArchive } from '../src/hooks/useShareExport';
import { sendChatMessage } from '../src/services/chat_d2d';
import {
  clearBootHistory,
  getBootHistory,
  type BootDiagRecord,
} from '../src/services/diagnostics_history';
import {
  getDisplayNameOverride,
  hydrateDisplayNameOverride,
  setDisplayNameOverride,
  subscribeDisplayNameOverride,
} from '../src/services/display_name_override';
import { loadPersistedDid } from '../src/services/identity_record';
import { signOutLocal, eraseEverythingLocal } from '../src/services/local_data_wipe';
import { wireNativeBackup } from '../src/services/native_backup_wiring';
import {
  isRestoreConfigured,
  pickBackupBytes,
  previewBackup,
  restoreBackup,
} from '../src/services/restore_import';
import { getRuntimeWarnings, subscribeRuntimeWarnings } from '../src/services/runtime_warnings';
import { colors, radius, shadows, spacing, textStyles } from '../src/theme';

export default function AdminScreen(): React.ReactElement {
  const router = useRouter();
  const node = getBootedNode();
  const degradations = getBootDegradations();
  const runtimeWarnings = useSyncExternalStore(
    subscribeRuntimeWarnings,
    getRuntimeWarnings,
    getRuntimeWarnings,
  );

  // Persisted recent-boot history (survives relaunch). The live channels
  // above are current-boot only; this is what lets us debug a PAST boot.
  const [history, setHistory] = useState<BootDiagRecord[]>([]);
  const refreshHistory = useCallback(() => {
    void getBootHistory().then(setHistory);
  }, []);
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

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
      'Removes this device’s keys and disconnects it from your Dina. Encrypted data on this device stays on disk but is unreadable without the keys. Re-onboard with your recovery phrase to come back; your data on this device will be recoverable.\n\nYour Dina identity on the network is unaffected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await signOutLocal();
                Alert.alert(
                  'Signed out',
                  'This device is disconnected. Re-onboard with your recovery phrase to come back.',
                );
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
      'Permanently deletes all data on this device: chat history, reminders, contacts, vault entries, and your keys. This cannot be undone on this device.\n\nYour Dina identity on the network is unaffected. Re-onboard with your recovery phrase to start fresh on this device.',
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
                  'All data on this device has been deleted. Set up Dina again to start fresh.',
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
      <ScrollView contentContainerStyle={styles.scroll} style={styles.root}>
        {/* Subtitle. The page already wears "Admin" in the native
            header — a second body-side title (the previous italic-
            display "Running as requester") read as ceremonious for
            what's really a status line. Now: one calm sentence that
            sets context, then straight into the cards. */}
        <View style={styles.intro}>
          <Text style={styles.introBody}>
            Identity, diagnostics, and device actions.{' '}
            {node === null
              ? 'Node not booted.'
              : `Running as ${shortRole(node.role)} · brain ${
                  node === null ? 'offline' : 'connected'
                }.`}
          </Text>
        </View>

        {/* Identity — kept to the two truly identity-shaped rows
            (the DID a support agent would ask for, and the local
            display name the user can edit). The Role + Brain
            client status moved up into the intro line; the
            "Re-publish PLC document" Coming-Soon placeholder is
            dropped until that feature actually lands. */}
        <Section title="Identity">
          <Row
            label="DID"
            value={persistedDid ?? node?.did ?? '—'}
            copyable
            onCopy={copy}
            mono
            truncate
          />
          <DisplayNameRow />
        </Section>

        {/* Policies drill-down — single row, but it earns its own
            section because the screen behind it is a substantive
            agent-policy editor. Title kept as a noun so the row
            label can stay short. */}
        <Section title="Policies">
          <DrillRow label="Agent policies" onPress={() => router.push('/policy')} />
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

          <Text style={[styles.diagGroupLabel, styles.diagGroupSpacer]}>Recent boots</Text>
          {history.length === 0 ? (
            <Text style={styles.diagEmpty}>No history yet</Text>
          ) : (
            history.map((rec, i) => (
              <View key={`${rec.at}-${i}`} style={styles.diagItem}>
                <Text style={styles.diagCode}>{new Date(rec.at).toLocaleString()}</Text>
                <Text style={styles.diagMessage}>
                  {rec.degradations.length === 0 && rec.warnings.length === 0
                    ? 'clean'
                    : [...rec.degradations, ...rec.warnings].map((e) => e.code).join(', ')}
                </Text>
              </View>
            ))
          )}

          <Pressable
            testID="admin-copy-diagnostics"
            accessibilityRole="button"
            onPress={() => copy(JSON.stringify({ degradations, runtimeWarnings, history }, null, 2))}
            style={({ pressed }) => [styles.copyAll, pressed && styles.pressed]}
          >
            <Text style={styles.copyAllText}>Copy JSON for support</Text>
          </Pressable>
          <Pressable
            testID="admin-clear-diag-history"
            accessibilityRole="button"
            onPress={() => {
              void clearBootHistory().then(refreshHistory);
            }}
            style={({ pressed }) => [styles.clearHistoryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.clearHistoryText}>Clear boot history</Text>
          </Pressable>
        </Section>

        {/* Backup & restore (issues.txt §3) */}
        <Section title="Backup & restore">
          <BackupRestoreSection />
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
            testID="admin-sign-out"
            accessibilityRole="button"
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
            testID="admin-erase-everything"
            accessibilityRole="button"
            onPress={onEraseEverything}
            style={({ pressed }) => [styles.dangerBtn, styles.dangerBtnDivider, pressed && styles.pressed]}
          >
            <Text style={styles.dangerTitle}>Erase everything on this device</Text>
            <Text style={styles.dangerBody}>
              Permanently deletes all data on this device: chat, reminders, contacts, vault
              entries, and keys. Cannot be undone on this device.
            </Text>
          </Pressable>
        </Section>
      </ScrollView>
    </>
  );
}

/**
 * Backup & restore (issues.txt §3). Export = encrypt vault data with a
 * passphrase → OS share sheet. Restore = pick a `.dina` file → passphrase
 * → import into the local DBs (clean-install, or confirm-to-overwrite),
 * then relaunch so persistence re-hydrates from the restored SQL.
 */
function BackupRestoreSection(): React.ReactElement {
  const [exportPass, setExportPass] = useState('');
  const [restorePass, setRestorePass] = useState('');
  const [picked, setPicked] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [busy, setBusy] = useState<'idle' | 'export' | 'restore'>('idle');

  // Idempotently wire the native file IO (expo-sharing / -file-system /
  // -document-picker). Safe to call on every mount.
  useEffect(() => {
    wireNativeBackup();
  }, []);

  const onExport = useCallback(() => {
    if (exportPass.trim().length < 8) {
      Alert.alert('Passphrase too short', 'Use at least 8 characters to encrypt your backup.');
      return;
    }
    void (async () => {
      setBusy('export');
      try {
        const result = await shareArchive(exportPass);
        if (result.status === 'failed') {
          Alert.alert('Export failed', result.error ?? 'Unknown error');
        } else {
          setExportPass('');
        }
      } finally {
        setBusy('idle');
      }
    })();
  }, [exportPass]);

  const onChooseFile = useCallback(() => {
    void (async () => {
      try {
        const result = await pickBackupBytes();
        if (result !== null) setPicked(result);
      } catch (err) {
        Alert.alert('Couldn’t open file', err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const onRestore = useCallback(() => {
    if (picked === null) return;
    void (async () => {
      setBusy('restore');
      try {
        // Preflight — confirms the passphrase + that it's a real backup.
        let preview;
        try {
          preview = await previewBackup(picked.bytes, restorePass);
        } catch {
          Alert.alert(
            'Couldn’t read backup',
            'Wrong passphrase, or this isn’t a valid / supported Dina backup file.',
          );
          return;
        }

        const finish = (): void => {
          setPicked(null);
          setRestorePass('');
          Alert.alert(
            'Restored',
            `Restored ${preview.totalPersonas} persona(s). Close and reopen Dina to load your data.`,
          );
        };

        try {
          await restoreBackup(picked.bytes, restorePass);
          finish();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not a clean install/i.test(msg)) {
            Alert.alert(
              'This device already has data',
              'Restoring will overwrite this device’s data with the backup. This can’t be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Overwrite',
                  style: 'destructive',
                  onPress: () => {
                    void (async () => {
                      try {
                        await restoreBackup(picked.bytes, restorePass, { force: true });
                        finish();
                      } catch (e) {
                        Alert.alert('Restore failed', e instanceof Error ? e.message : String(e));
                      }
                    })();
                  },
                },
              ],
            );
          } else {
            Alert.alert('Restore failed', msg);
          }
        }
      } finally {
        setBusy('idle');
      }
    })();
  }, [picked, restorePass]);

  return (
    <View style={styles.backupBox}>
      <Text style={styles.backupNote}>
        An export is an encrypted copy of your data (contacts, memories, reminders, settings).
        It never includes your keys or API secrets. Restore brings it back onto a device after you’ve set up
        your identity.
      </Text>

      {/* Export */}
      <Text style={styles.backupLabel}>Export</Text>
      <TextInput
        testID="admin-export-passphrase"
        style={styles.backupInput}
        value={exportPass}
        onChangeText={setExportPass}
        placeholder="New passphrase to encrypt the backup"
        placeholderTextColor={colors.textSecondary}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        testID="admin-export-backup"
        accessibilityRole="button"
        onPress={onExport}
        disabled={busy !== 'idle'}
        style={({ pressed }) => [styles.backupBtn, pressed && styles.pressed, busy === 'export' && styles.backupBtnBusy]}
      >
        <Text style={styles.backupBtnText}>
          {busy === 'export' ? 'Preparing…' : 'Export encrypted backup'}
        </Text>
      </Pressable>

      {/* Restore */}
      <Text style={[styles.backupLabel, styles.backupLabelSpaced]}>Restore</Text>
      {!isRestoreConfigured() ? (
        <Text style={styles.backupNote}>
          Restore needs the latest app build (document picker). Rebuild the dev client to enable it.
        </Text>
      ) : (
        <>
          <Pressable
            testID="admin-restore-choose-file"
            accessibilityRole="button"
            onPress={onChooseFile}
            style={({ pressed }) => [styles.backupBtnSecondary, pressed && styles.pressed]}
          >
            <Text style={styles.backupBtnSecondaryText}>
              {picked === null ? 'Choose backup file (.dina)' : `Selected: ${picked.name}`}
            </Text>
          </Pressable>
          {picked !== null && (
            <>
              <TextInput
                testID="admin-restore-passphrase"
                style={styles.backupInput}
                value={restorePass}
                onChangeText={setRestorePass}
                placeholder="Backup passphrase"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                testID="admin-restore-backup"
                accessibilityRole="button"
                onPress={onRestore}
                disabled={busy !== 'idle'}
                style={({ pressed }) => [styles.backupBtn, pressed && styles.pressed, busy === 'restore' && styles.backupBtnBusy]}
              >
                <Text style={styles.backupBtnText}>
                  {busy === 'restore' ? 'Restoring…' : 'Restore from backup'}
                </Text>
              </Pressable>
            </>
          )}
        </>
      )}
    </View>
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
        testID="admin-dev-send-test"
        accessibilityRole="button"
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
  label: textStyles.label,
  did: {
    ...textStyles.monoSmall,
    color: colors.textPrimary,
    marginTop: 2,
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
    ...textStyles.bodySmallStrong,
    color: colors.white,
  },
  detail: {
    ...textStyles.monoSmall,
    marginTop: spacing.sm,
    color: colors.success,
  },
  detailErr: {
    color: colors.error,
  },
});

/**
 * "Rename your id" — local-only display name override.
 *
 * Distinct from the published handle on plc.directory. The published
 * handle is what other Dinas see; this override is the friendly label
 * this device renders for the user's own DID. Re-publishing PLC to
 * change the canonical handle is destructive (touches the rotation
 * key, costs an AppView re-index), so the UI keeps the two
 * concerns separate: edit here for free, re-publish behind the
 * "Re-publish PLC document" placeholder when that lands.
 */
function DisplayNameRow(): React.ReactElement {
  const override = useSyncExternalStore(
    subscribeDisplayNameOverride,
    getDisplayNameOverride,
    getDisplayNameOverride,
  );

  // Hydrate from keychain on first mount. The store snapshot stays
  // null until this resolves; that's fine — the row simply renders
  // "Not set" for one frame on the very first admin-page open.
  React.useEffect(() => {
    void hydrateDisplayNameOverride();
  }, []);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const onEdit = (): void => {
    setDraft(override ?? '');
    setEditing(true);
  };

  const onCancel = (): void => {
    setEditing(false);
    setDraft('');
  };

  const onSave = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await setDisplayNameOverride(draft);
      setEditing(false);
      setDraft('');
    } catch (err) {
      Alert.alert(
        'Couldn’t save',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }, [draft]);

  if (editing) {
    return (
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Display name</Text>
        <View style={displayNameStyles.editWrap}>
          <TextInput
            testID="admin-display-name-input"
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. Sancho"
            placeholderTextColor={colors.textSecondary}
            style={displayNameStyles.input}
            autoFocus
            autoCapitalize="words"
            autoCorrect={false}
            spellCheck={false}
            maxLength={64}
            editable={!busy}
          />
          <View style={displayNameStyles.actions}>
            <Pressable
              testID="admin-display-name-cancel"
              accessibilityRole="button"
              onPress={onCancel}
              disabled={busy}
              style={({ pressed }) => [
                displayNameStyles.btn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={displayNameStyles.btnTextSecondary}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="admin-display-name-save"
              accessibilityRole="button"
              onPress={() => {
                void onSave();
              }}
              disabled={busy}
              style={({ pressed }) => [
                displayNameStyles.btn,
                displayNameStyles.btnPrimary,
                pressed && styles.pressed,
                busy && styles.pressed,
              ]}
            >
              <Text style={displayNameStyles.btnTextPrimary}>
                {busy ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          </View>
          <Text style={displayNameStyles.hint}>
            Local only. Does not change your handle on plc.directory.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      testID="admin-display-name-edit"
      accessibilityRole="button"
      onPress={onEdit}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Text style={styles.rowLabel}>Display name</Text>
      <View style={styles.rowValueWrap}>
        <Text
          style={[
            styles.rowValue,
            override === null && displayNameStyles.unset,
          ]}
          numberOfLines={1}
        >
          {override ?? 'Not set. Tap to edit.'}
        </Text>
        <Text style={styles.copyGlyph}>{'✎'}</Text>
      </View>
    </Pressable>
  );
}

const displayNameStyles = StyleSheet.create({
  editWrap: {
    flex: 1,
  },
  input: {
    ...textStyles.body,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bgPrimary,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    justifyContent: 'flex-end',
  },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnPrimary: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  btnTextPrimary: {
    ...textStyles.bodySmallStrong,
    color: colors.white,
  },
  btnTextSecondary: textStyles.bodySmallStrong,
  hint: {
    ...textStyles.tiny,
    marginTop: 6,
    fontStyle: 'italic',
  },
  unset: {
    color: colors.textSecondary,
    fontStyle: 'italic',
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
  /**
   * When true, render the value on a single line with middle
   * truncation. Right for opaque identifiers like a DID — wrapping
   * one across two lines mid-token reads as garbled, and the
   * head+tail of a `did:plc:...ecewk` is what users actually scan
   * for. The Copy glyph still grabs the full value so the truncated
   * display doesn't lose information.
   */
  truncate?: boolean;
}): React.ReactElement {
  const valueLines = props.truncate ? 1 : 2;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{props.label}</Text>
      <View style={styles.rowValueWrap}>
        <Text
          style={[styles.rowValue, props.mono && styles.rowValueMono]}
          numberOfLines={valueLines}
          ellipsizeMode={props.truncate ? 'middle' : 'tail'}
        >
          {props.value}
        </Text>
        {props.copyable && props.value !== '—' ? (
          <Pressable
            testID="admin-row-copy"
            accessibilityRole="button"
            accessibilityLabel={`Copy ${props.label}`}
            onPress={() => props.onCopy?.(props.value)}
            hitSlop={10}
          >
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
      testID="admin-drill-row"
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.drillRow, pressed && styles.pressed]}
    >
      <Text style={styles.drillLabel}>{label}</Text>
      <Text style={styles.drillArrow}>{'\u203A'}</Text>
    </Pressable>
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
  intro: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  introBody: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  section: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    ...textStyles.eyebrow,
    letterSpacing: 1.2,
    marginBottom: spacing.sm,
    paddingLeft: 4,
  },
  sectionDanger: { color: colors.error },
  sectionCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
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
    borderBottomColor: colors.border,
  },
  rowLabel: {
    ...textStyles.label,
    width: 110,
    letterSpacing: 0.5,
    marginTop: 2,
  },
  rowValueWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  rowValue: {
    ...textStyles.body,
    flex: 1,
  },
  rowValueMono: textStyles.monoSmall,
  copyGlyph: {
    ...textStyles.bodyLarge,
    color: colors.textSecondary,
  },
  drillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  drillLabel: textStyles.bodyStrong,
  drillArrow: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  diagGroupLabel: {
    ...textStyles.label,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  diagGroupSpacer: {
    marginTop: spacing.md,
  },
  diagEmpty: {
    ...textStyles.bodySmall,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    color: colors.success,
  },
  diagItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  diagCode: {
    ...textStyles.monoSmall,
    color: colors.warning,
    letterSpacing: 0.2,
  },
  diagMessage: {
    ...textStyles.bodySmall,
    marginTop: 2,
    color: colors.textPrimary,
  },
  copyAll: {
    // De-emphasized link-style button — the prior full-width grey
    // pill made it look like the primary action of the section. It's
    // a support helper; render it small and right-aligned.
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignSelf: 'flex-end',
  },
  copyAllText: {
    ...textStyles.bodySmallStrong,
    color: colors.accent,
  },
  clearHistoryBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignSelf: 'flex-end',
  },
  clearHistoryText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  dangerNote: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dangerNoteText: {
    ...textStyles.caption,
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
    ...textStyles.bodyLargeStrong,
    color: colors.error,
  },
  dangerBody: {
    ...textStyles.bodySmall,
    marginTop: 3,
    color: colors.textSecondary,
  },
  pressed: { opacity: 0.7 },
  // Backup & restore (issues.txt §3)
  backupBox: {
    // sectionCard has no padding (other sections self-pad via `row`); the
    // backup content is bare Views, so pad it to match the card inset.
    padding: spacing.md,
  },
  backupNote: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  backupLabel: {
    ...textStyles.bodyLargeStrong,
    color: colors.textPrimary,
    marginBottom: 4,
  },
  backupLabelSpaced: { marginTop: spacing.lg },
  backupInput: {
    ...textStyles.body,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bgPrimary,
    marginBottom: spacing.sm,
  },
  backupBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  backupBtnBusy: { opacity: 0.6 },
  backupBtnText: {
    ...textStyles.bodyLargeStrong,
    color: colors.white,
  },
  backupBtnSecondary: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  backupBtnSecondaryText: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
});
