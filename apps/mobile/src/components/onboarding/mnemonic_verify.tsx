/**
 * MnemonicVerify — confirm the user wrote the phrase down.
 *
 * Picks 3 random word positions from the mnemonic (via
 * `createVerificationChallenge` from useOnboarding) and asks the user
 * to type each word. On mismatch we reset the inputs + explain; on
 * success we advance.
 */

import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { OnboardingShell } from './shell';
import { locateStep, type Step } from '../../onboarding/state';
import { createVerificationChallenge, verifyMnemonicAnswers } from '../../hooks/useOnboarding';
import { colors, fonts, radius, spacing } from '../../theme';

export interface MnemonicVerifyProps {
  mnemonic: string[];
  onVerified: () => void;
  onBack: () => void;
}

export function MnemonicVerify(props: MnemonicVerifyProps): React.ReactElement {
  // The challenge is memoized on `mnemonic` — re-rolling every render
  // would keep resetting which word positions the user has to type.
  // We intentionally regenerate on mount; on retry we keep the same
  // challenge so the user isn't chasing a moving target.
  const challenge = useMemo(() => createVerificationChallenge(props.mnemonic), [props.mnemonic]);
  const [answers, setAnswers] = useState<string[]>(() => challenge.indices.map(() => ''));
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<(TextInput | null)[]>([]);

  const allFilled = answers.every((a) => a.trim().length > 0);

  const submit = (): void => {
    const result = verifyMnemonicAnswers(challenge, answers);
    if (result.valid) {
      props.onVerified();
      return;
    }
    setError('One of those words doesn\u2019t match. Double-check your paper copy and try again.');
    setAnswers(challenge.indices.map(() => ''));
    inputs.current[0]?.focus();
  };

  const setAnswerAt = (i: number, value: string): void => {
    const next = [...answers];
    next[i] = value;
    setAnswers(next);
    if (error !== null) setError(null);
  };

  const step: Step = { kind: 'create_mnemonic_verify', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Confirm your phrase"
      subtitle="Fill in the missing words from your paper copy. We'll check all three before continuing."
      primaryLabel="Verify"
      onPrimary={submit}
      primaryDisabled={!allFilled}
      onBack={props.onBack}
    >
      {challenge.indices.map((pos, i) => (
        <View key={pos} style={styles.row}>
          <Text style={styles.rowLabel}>Word #{pos + 1}</Text>
          <TextInput
            ref={(r) => {
              inputs.current[i] = r;
            }}
            value={answers[i]}
            onChangeText={(v) => setAnswerAt(i, v)}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder="\u2026"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            returnKeyType={i === challenge.indices.length - 1 ? 'done' : 'next'}
            onSubmitEditing={() => {
              if (i < challenge.indices.length - 1) {
                inputs.current[i + 1]?.focus();
              } else if (allFilled) {
                submit();
              }
            }}
          />
        </View>
      ))}

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  row: {
    marginBottom: spacing.md,
  },
  rowLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 6,
  },
  input: {
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    fontFamily: fonts.mono,
  },
  error: {
    marginTop: spacing.md,
    fontSize: 13,
    lineHeight: 18,
    color: colors.error,
  },
});
