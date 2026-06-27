/**
 * OwnerName — first step of the Create path.
 *
 * Collects a short display name. The next step (`HandlePicker`) uses
 * this to seed the public handle prefix and lets the user check + edit
 * it interactively against the PDS. We just show a sanitized preview
 * here so the user has a sense of what comes next; the picker is
 * authoritative.
 */

import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { pdsHostForEndpoints } from '@dina/home-node';

import { mobileHostedEndpoints } from '../../services/hosted_endpoints';
import { OnboardingShell } from './shell';
import { locateStep, type Step } from '../../onboarding/state';
import { colors, radius, spacing, textStyles } from '../../theme';

export interface OwnerNameProps {
  initialName?: string;
  onContinue: (name: string) => void;
  onBack: () => void;
}

export function OwnerName(props: OwnerNameProps): React.ReactElement {
  const [name, setName] = useState<string>(props.initialName ?? '');
  const trimmed = name.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 40;

  const handlePreview = useMemo(() => buildPreview(trimmed), [trimmed]);

  const step: Step = { kind: 'create_name', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="What should we call you?"
      subtitle="Just a display name. We'll use it as the basis of your Dina handle on the public directory."
      primaryLabel="Continue"
      onPrimary={() => valid && props.onContinue(trimmed)}
      primaryDisabled={!valid}
      onBack={props.onBack}
    >
      <Text style={styles.label}>Display name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        autoCorrect={false}
        placeholder="e.g. John"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        testID="owner-name-input"
        maxLength={40}
        returnKeyType="done"
        onSubmitEditing={() => valid && props.onContinue(trimmed)}
      />

      {handlePreview !== null ? (
        <View style={styles.preview}>
          <Text style={styles.previewLabel}>SUGGESTED HANDLE</Text>
          <Text style={styles.previewValue}>{handlePreview}</Text>
          <Text style={styles.previewHint}>
            You&rsquo;ll be able to edit this in the next step.
          </Text>
        </View>
      ) : null}
    </OnboardingShell>
  );
}

function buildPreview(name: string): string | null {
  if (name.length < 2) return null;
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  if (sanitized.length < 2) return null;
  const pdsHost = pdsHostForEndpoints(mobileHostedEndpoints());
  return `${sanitized}.${pdsHost}`;
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
  preview: {
    marginTop: spacing.xl,
    padding: spacing.md,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
  },
  previewLabel: {
    ...textStyles.eyebrow,
    letterSpacing: 1.5,
  },
  previewValue: {
    ...textStyles.mono,
    marginTop: 6,
  },
  previewHint: {
    ...textStyles.caption,
    marginTop: spacing.sm,
  },
});
