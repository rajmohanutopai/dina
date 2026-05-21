/**
 * RecoveryEntry — Recover-path step one: user types all 24 words back.
 *
 * Layout is a 4×6 grid of inputs numbered 1..24. We validate the
 * mnemonic as the user types the last word (via
 * `validateRecoveryMnemonic` from useOnboarding) and show a live DID
 * preview so the user can sanity-check they're about to restore the
 * right identity BEFORE we commit the passphrase + PLC step.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { previewRecoveryDID, validateRecoveryMnemonic } from '../../hooks/useOnboarding';
import { locateStep, type Step } from '../../onboarding/state';
import { colors, radius, spacing, textStyles } from '../../theme';

import { OnboardingShell } from './shell';

export interface RecoveryEntryProps {
  initialWords?: string[];
  onContinue: (words: string[], did: string) => void;
  onBack: () => void;
}

export function RecoveryEntry(props: RecoveryEntryProps): React.ReactElement {
  const [words, setWords] = useState<string[]>(() =>
    props.initialWords && props.initialWords.length === 24
      ? props.initialWords
      : new Array(24).fill(''),
  );
  const inputs = useRef<(TextInput | null)[]>([]);

  const { valid, error } = useMemo(() => validateRecoveryMnemonic(words), [words]);
  const did = useMemo(() => (valid ? previewRecoveryDID(words) : null), [valid, words]);

  const updateWord = (i: number, value: string): void => {
    const next = [...words];
    next[i] = value.trim();
    setWords(next);
  };

  const onPasteAll = (pasted: string): void => {
    const chunks = pasted
      .split(/\s+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 0);
    if (chunks.length === 24) {
      setWords(chunks);
    }
  };

  const step: Step = { kind: 'recover_mnemonic', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Enter your recovery phrase"
      subtitle="Type the 24 words from your paper copy in order. To paste the whole phrase at once, long-press the first field and pick Paste. Dina will fan the words out across all 24 boxes."
      primaryLabel="Continue"
      onPrimary={() =>
        valid &&
        did !== null &&
        props.onContinue(
          words.map((w) => w.toLowerCase()),
          did,
        )
      }
      primaryDisabled={!valid || did === null}
      onBack={props.onBack}
    >
      <View style={styles.grid}>
        {words.map((w, i) => (
          <View key={i} style={styles.cell}>
            <Text style={styles.index}>{String(i + 1).padStart(2, '0')}</Text>
            <TextInput
              ref={(r) => {
                inputs.current[i] = r;
              }}
              value={w}
              onChangeText={(value) => {
                // Detect paste of the whole phrase when the user drops
                // a 24-token string into any field.
                if (value.split(/\s+/).length >= 12) {
                  onPasteAll(value);
                  return;
                }
                updateWord(i, value);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.input}
              returnKeyType={i === 23 ? 'done' : 'next'}
              blurOnSubmit={i === 23}
              onSubmitEditing={() => {
                if (i < 23) inputs.current[i + 1]?.focus();
              }}
              testID={`mnemonic-word-${i + 1}`}
            />
          </View>
        ))}
      </View>

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}

      {did !== null ? (
        <Pressable
          onPress={() => {
            /* show details — future */
          }}
          style={styles.didPreview}
        >
          <Text style={styles.didLabel}>THIS WILL RESTORE</Text>
          <Text style={styles.didValue} numberOfLines={2}>
            {did}
          </Text>
        </Pressable>
      ) : null}
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  cell: {
    width: '50%',
    paddingHorizontal: 4,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  index: {
    ...textStyles.monoSmall,
    width: 22,
    textAlign: 'right',
  },
  input: {
    ...textStyles.mono,
    flex: 1,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.sm,
  },
  error: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.md,
  },
  didPreview: {
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
  },
  didLabel: {
    ...textStyles.eyebrow,
    letterSpacing: 1.5,
  },
  didValue: {
    ...textStyles.monoSmall,
    marginTop: 4,
  },
});
