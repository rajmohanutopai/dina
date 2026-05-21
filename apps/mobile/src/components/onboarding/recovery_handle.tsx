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
 */

import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  resolveAndVerifyDidPlc,
  type ResolveDidResult,
} from '../../hooks/useOnboarding';
import { locateStep, type Step } from '../../onboarding/state';
import { colors, radius, spacing, textStyles } from '../../theme';

import { OnboardingShell } from './shell';

export interface RecoveryHandleProps {
  mnemonic: string[];
  initialHandle?: string;
  onContinue: (handle: string, did: string) => void;
  onBack: () => void;
}

export function RecoveryHandle(props: RecoveryHandleProps): React.ReactElement {
  const [handle, setHandle] = useState(props.initialHandle ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result: ResolveDidResult = await resolveAndVerifyDidPlc(handle, props.mnemonic);
      if (result.kind === 'ok') {
        props.onContinue(handle.trim().toLowerCase(), result.did);
        return;
      }
      setError(result.message);
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

      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={styles.busyText}>
            Resolving with the PDS and verifying your recovery key…
          </Text>
        </View>
      ) : null}

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.hint}>
        Dina checks that the recovery phrase you entered is registered as a rotation key on
        the handle's PLC document, so a wrong phrase or a wrong handle will fail loudly
        instead of silently restoring into the wrong account.
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
});
