/**
 * MnemonicReveal — show the generated 24-word phrase.
 *
 * Emphasises the "write this down on paper" instruction visually: the
 * phrase sits inside a framed card with a warning color band above and
 * below. The only primary action is "I've written it down" — the user
 * has to physically acknowledge before proceeding to verification.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { OnboardingShell } from './shell';
import { locateStep, type Step } from '../../onboarding/state';
import { colors, fonts, radius, spacing } from '../../theme';

export interface MnemonicRevealProps {
  mnemonic: string[];
  onContinue: () => void;
  onBack: () => void;
}

export function MnemonicReveal(props: MnemonicRevealProps): React.ReactElement {
  const step: Step = { kind: 'create_mnemonic_reveal', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Your recovery phrase"
      subtitle="These 24 words are the only way to restore your Dina on a new device. Write them down on paper and keep them somewhere safe."
      primaryLabel="I've written it down"
      onPrimary={props.onContinue}
      onBack={props.onBack}
    >
      <View style={styles.warningBanner}>
        <Text style={styles.warningText}>
          Don't screenshot. Don't save to a cloud note. Anyone with these words can restore your
          vault.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.grid}>
          {props.mnemonic.map((word, i) => (
            <View key={i} style={styles.cell}>
              <Text style={styles.cellIndex}>{String(i + 1).padStart(2, '0')}</Text>
              <Text style={styles.cellWord}>{word}</Text>
            </View>
          ))}
        </View>
      </View>

      <Text style={styles.footer}>
        We'll ask you to confirm three of these words next — that's how we verify you actually wrote
        them down.
      </Text>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  warningBanner: {
    backgroundColor: '#FFF4DB',
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.lg,
  },
  warningText: {
    fontSize: 13,
    lineHeight: 19,
    color: '#8A5A00',
  },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  cell: {
    width: '50%',
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  cellIndex: {
    width: 20,
    textAlign: 'right',
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: fonts.mono,
  },
  cellWord: {
    fontSize: 14,
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    letterSpacing: 0.2,
  },
  footer: {
    marginTop: spacing.lg,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
