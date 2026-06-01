import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { locateStep, type Step } from '../../onboarding/state';
import { colors, radius, spacing, textStyles } from '../../theme';
import { PassphraseField } from '../PassphraseField';

import { OnboardingShell } from './shell';

export interface ExistingAtprotoIdentityProps {
  initialIdentifier?: string;
  initialAppPassword?: string;
  initialPlcToken?: string;
  onContinue: (identifier: string, appPassword: string, plcToken: string) => void;
  onBack: () => void;
}

export function ExistingAtprotoIdentity(
  props: ExistingAtprotoIdentityProps,
): React.ReactElement {
  const [identifier, setIdentifier] = useState(props.initialIdentifier ?? '');
  const [appPassword, setAppPassword] = useState(props.initialAppPassword ?? '');
  const [plcToken, setPlcToken] = useState(props.initialPlcToken ?? '');
  const valid = identifier.trim().length > 0 && appPassword.length > 0;
  const step: Step = { kind: 'external_identity', draft: {} };

  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Use existing identity"
      subtitle="Connect a Bluesky or AT Protocol account you already own. Dina will use that account's PDS for public PeerLens and services records."
      primaryLabel="Continue"
      onPrimary={() => {
        if (!valid) return;
        props.onContinue(identifier.trim(), appPassword, plcToken.trim());
      }}
      primaryDisabled={!valid}
      onBack={props.onBack}
    >
      <Text style={styles.label}>HANDLE OR DID</Text>
      <TextInput
        value={identifier}
        onChangeText={setIdentifier}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType="email-address"
        placeholder="alice.bsky.social or did:plc:..."
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        testID="existing-atproto-identifier-input"
      />

      <PassphraseField
        label="PDS APP PASSWORD"
        value={appPassword}
        onChangeText={setAppPassword}
        placeholder="App password"
        accessibilityLabel="PDS app password"
        style={styles.secretField}
      />

      <PassphraseField
        label="PLC TOKEN (OPTIONAL)"
        value={plcToken}
        onChangeText={setPlcToken}
        placeholder="Only if your PDS asks for one"
        accessibilityLabel="PLC operation token"
        style={styles.secretField}
      />

      <View style={styles.note}>
        <Text style={styles.noteText}>
          Dina must add its signing key and MsgBox endpoint to this did:plc. If your PDS
          requires a PLC token, enter it here before continuing.
        </Text>
      </View>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  label: {
    ...textStyles.label,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  input: {
    ...textStyles.bodyLarge,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.md,
  },
  secretField: {
    marginTop: spacing.lg,
  },
  note: {
    marginTop: spacing.lg,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    backgroundColor: colors.bgTertiary,
    padding: spacing.md,
  },
  noteText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
});
