/**
 * MnemonicVerify — confirm the user wrote the phrase down.
 *
 * Picks 3 random word positions from the mnemonic (via
 * `createVerificationChallenge` from useOnboarding) and asks the user
 * to type each word. On mismatch we reset the inputs + explain; on
 * success we advance.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { OnboardingShell } from './shell';
import { locateStep, type Step } from '../../onboarding/state';
import { createVerificationChallenge, verifyMnemonicAnswers } from '../../hooks/useOnboarding';
import { colors, radius, spacing, textStyles } from '../../theme';

export interface MnemonicVerifyProps {
  mnemonic: string[];
  step?: Step;
  onVerified: () => void;
  onBack: () => void;
  /**
   * Optional "I'll do this later" affordance. When provided, renders
   * as a secondary link below the primary "Confirm" button. The
   * caller is responsible for marking verification as pending and
   * advancing the user past this step — this component only fires
   * the callback. Omit to make verification mandatory (e.g. inline
   * confirm-from-settings flow where there's no rest-of-onboarding
   * to advance to).
   */
  onSkip?: () => void;
  /**
   * Suppress the OnboardingShell's "5 OF 6 · CONFIRM PHRASE" pill
   * and back arrow. Used when this component is reused outside the
   * onboarding flow (the deferred Confirm-from-Settings route) where
   * the native nav header already supplies a back button and the
   * step-counter is misleading. Defaults to false (full onboarding
   * chrome).
   */
  compact?: boolean;
  /**
   * When provided (onboarding only), renders a "View my recovery phrase
   * again" link so the user can go back and copy the words they may have
   * missed. Omit in the Settings confirm flow — user already has the phrase.
   */
  onViewPhrase?: () => void;
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
    // Only clear the wrong answers; keep the ones the user got right
    // so they don't have to re-type everything for a single mismatch.
    // The verifier returns per-position correctness; for now we treat
    // the whole submission as "at least one wrong" and clear only the
    // entries that don't match the expected word at that position.
    const next = challenge.indices.map((pos, i) => {
      const expected = props.mnemonic[pos];
      return answers[i].trim().toLowerCase() === expected.toLowerCase() ? answers[i] : '';
    });
    const firstWrong = next.findIndex((a) => a === '');
    setError(
      'One of those words doesn\u2019t match what we generated. Take another look at your paper copy.',
    );
    setAnswers(next);
    if (firstWrong >= 0) inputs.current[firstWrong]?.focus();
  };

  const setAnswerAt = (i: number, value: string): void => {
    const next = [...answers];
    next[i] = value;
    setAnswers(next);
    if (error !== null) setError(null);
  };

  const step: Step = props.step ?? { kind: 'create_mnemonic_verify', draft: {} };
  const compact = props.compact === true;
  return (
    <OnboardingShell
      // Hide the "5 OF 6" step pill outside the onboarding flow —
      // the native header on the confirm-from-settings route already
      // supplies its own title, and the step counter would be lying.
      location={compact ? null : locateStep(step)}
      // The route header on the confirm-from-settings page already
      // renders a back button; suppress the shell's own back arrow
      // to avoid the duplicate-back-arrow visual.
      canGoBack={!compact}
      title="Quick check"
      subtitle={
        // JSX attribute strings render `\u2014` literally \u2014 wrap in a
        // template literal (or use the raw character). Same applies
        // to any escaped Unicode in attributes.
        "Just a few words from what you wrote down \u2014 to make sure your copy is good. You can always re-view the full phrase later in Settings."
      }
      primaryLabel="Confirm"
      onPrimary={submit}
      primaryDisabled={!allFilled}
      secondaryLabel={props.onSkip !== undefined ? "I'll do this later" : undefined}
      onSecondary={props.onSkip}
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
            placeholder="…"
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

      {props.onViewPhrase !== undefined ? (
        <Pressable
          onPress={props.onViewPhrase}
          accessibilityRole="link"
          accessibilityLabel="View my recovery phrase again"
          style={styles.viewPhraseLink}
        >
          <Text style={styles.viewPhraseLinkText}>View my recovery phrase again</Text>
        </Pressable>
      ) : null}
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  row: {
    marginBottom: spacing.md,
  },
  rowLabel: {
    ...textStyles.label,
    color: colors.textMuted,
    marginBottom: 6,
  },
  input: {
    ...textStyles.mono,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.md,
  },
  error: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.md,
  },
  viewPhraseLink: {
    marginTop: spacing.lg,
    alignItems: 'center',
  },
  viewPhraseLinkText: {
    ...textStyles.link,
    color: colors.accent,
    textDecorationLine: 'underline',
  },
});
