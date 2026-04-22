/**
 * OwnerName — first step of the Create path.
 *
 * Collects a short display name that becomes the base of the PDS handle
 * (install.sh step 8b: `${sanitized}${randhex}.${pds_host}`). Sanitization
 * happens server-side in `deriveHandle`; here we just show a live
 * preview of what the handle is likely to look like so the user isn't
 * surprised by the truncation + hex suffix.
 */

import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { OnboardingShell } from './shell';
import { locateStep, type Step } from '../../onboarding/state';
import { resolveMsgBoxURL } from '../../services/msgbox_wiring';
import { colors, fonts, radius, spacing } from '../../theme';

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
      subtitle="Just a display name — we use it as the base of your Dina handle on the community directory."
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
        placeholder="e.g. Raj"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        maxLength={40}
        returnKeyType="done"
        onSubmitEditing={() => valid && props.onContinue(trimmed)}
      />

      {handlePreview !== null ? (
        <View style={styles.preview}>
          <Text style={styles.previewLabel}>YOUR HANDLE WILL LOOK LIKE</Text>
          <Text style={styles.previewValue}>{handlePreview}</Text>
          <Text style={styles.previewHint}>
            A 4-character suffix is added so the handle is unique.
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
  const pdsHost = resolveMsgBoxURL().includes('test-mailbox')
    ? 'test-pds.dinakernel.com'
    : 'pds.dinakernel.com';
  return `${sanitized}\u2026.${pdsHost}`;
}

const styles = StyleSheet.create({
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  input: {
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: 17,
  },
  preview: {
    marginTop: spacing.xl,
    padding: spacing.md,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
  },
  previewLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  previewValue: {
    marginTop: 6,
    fontSize: 14,
    fontFamily: fonts.mono,
    color: colors.textPrimary,
  },
  previewHint: {
    marginTop: spacing.sm,
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
  },
});
