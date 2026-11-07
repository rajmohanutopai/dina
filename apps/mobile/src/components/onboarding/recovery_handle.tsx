/**
 * RecoveryHandle — Recover-path step two: user enters their published
 * Dina handle so we can re-bind the device to the existing did:plc.
 *
 * Without this step the recovery flow falls back to a `did:key`
 * identity (suitable for local dev but invisible on AppView and
 * unreachable to peers who knew the user under their published
 * handle). See MT-04-I4 for the full diagnosis.
 *
 * Submission flow:
 *   1. Tap Continue → call `resolveAndVerifyDidPlc(handle, mnemonic)`.
 *   2. Helper resolves handle → DID via PDS xrpc, fetches PLC doc,
 *      verifies our K256 rotation key from the mnemonic is in the
 *      `rotationKeys` array. Returns `{kind: 'ok', did}` only when
 *      the mnemonic cryptographically owns the handle.
 *   3. On `ok`: pass the resolved did:plc to the next step.
 *   4. On any other kind: surface a kind-specific error message and
 *      let the user fix the input.
 *
 * Backup (docs/USER_BACKUP.md §4.5): on arrival the screen asks the backup
 * store for a copy the 24 words open. When there is one, it fills in the
 * handle from inside it, shows its date and item count, and offers to
 * restore it once the identity is back (on unless the owner says no). The
 * rotation-key check above still runs on the handle.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { resolveAndVerifyDidPlc, type ResolveDidResult } from '../../hooks/useOnboarding';
import { locateStep, type Step } from '../../onboarding/state';
import { findBackupForPhrase } from '../../services/cloud_backup';
import { colors, radius, spacing, textStyles } from '../../theme';

import { OnboardingShell } from './shell';

export interface RecoveryHandleProps {
  mnemonic: string[];
  initialHandle?: string;
  onContinue: (handle: string, did: string, restoreBackup: boolean) => void;
  onBack: () => void;
}

interface FoundCopy {
  createdAt: number;
  itemCount: number;
}

export function RecoveryHandle(props: RecoveryHandleProps): React.ReactElement {
  const [handle, setHandle] = useState(props.initialHandle ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<FoundCopy | null>(null);
  const [restore, setRestore] = useState(true);

  useEffect(() => {
    let live = true;
    void findBackupForPhrase(props.mnemonic).then((hit) => {
      if (!live || hit === null) return;
      const { meta } = hit.found;
      setFound({ createdAt: meta.created_at, itemCount: meta.item_count });
      if (meta.handle !== '') setHandle((typed) => (typed.trim() === '' ? meta.handle : typed));
    });
    return () => {
      live = false;
    };
  }, [props.mnemonic]);

  const onSubmit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result: ResolveDidResult = await resolveAndVerifyDidPlc(handle, props.mnemonic);
      if (result.kind === 'ok') {
        props.onContinue(handle.trim().toLowerCase(), result.did, found !== null && restore);
        return;
      }
      setError(result.message);
    } catch (err) {
      // Anything that throws before the lookups (reading saved server
      // settings, the recovery-phrase maths) used to drop silently: the
      // button came back and nothing moved on.
      setError(
        `Couldn't check that handle: ${err instanceof Error ? err.message : String(err)}. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const step: Step = { kind: 'recover_handle', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="What's your Dina handle?"
      subtitle="The handle you picked when you first set up Dina (e.g. alonso77.test-pds.dinakernel.com). We need it to recover your network identity."
      primaryLabel={busy ? 'Verifying…' : 'Continue'}
      onPrimary={() => {
        void onSubmit();
      }}
      primaryDisabled={busy || handle.trim().length === 0}
      onBack={props.onBack}
    >
      <Text style={styles.label}>HANDLE</Text>
      <TextInput
        value={handle}
        onChangeText={setHandle}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType="email-address"
        placeholder="alonso77.test-pds.dinakernel.com"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        editable={!busy}
        testID="recovery-handle-input"
      />

      {found !== null ? (
        <View style={styles.found} testID="recovery-backup-found">
          <Text style={styles.foundText}>
            Found a backup from{' '}
            {new Date(found.createdAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}{' '}
            with {found.itemCount} {found.itemCount === 1 ? 'item' : 'items'}.
          </Text>
          <View style={styles.foundRow}>
            <Text style={[styles.foundText, styles.flex]}>Restore it</Text>
            <Switch
              testID="recovery-backup-restore"
              value={restore}
              onValueChange={setRestore}
              disabled={busy}
              accessibilityLabel="Restore the backup"
            />
          </View>
        </View>
      ) : null}

      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={styles.busyText}>
            Resolving with the PDS and verifying your recovery key…
          </Text>
        </View>
      ) : null}

      {error !== null ? (
        <Text style={styles.error} testID="recovery-handle-error">
          {error}
        </Text>
      ) : null}

      <Text style={styles.hint}>
        Dina checks that the recovery phrase you entered is registered as a rotation key on the
        handle's PLC document, so a wrong phrase or a wrong handle will fail loudly instead of
        silently restoring into the wrong account.
      </Text>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  label: {
    ...textStyles.monoSmall,
    letterSpacing: 1.2,
    marginBottom: spacing.xs,
  },
  input: {
    ...textStyles.mono,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 50,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  busyText: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    flex: 1,
  },
  error: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.md,
  },
  hint: {
    ...textStyles.caption,
    marginTop: spacing.lg,
  },
  found: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  foundRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  foundText: { ...textStyles.bodySmall, color: colors.textPrimary },
  flex: { flex: 1 },
});
