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

import { locateStep, type Step } from '../../onboarding/state';
import { colors, radius, spacing, textStyles } from '../../theme';

import { OnboardingShell } from './shell';

export interface MnemonicRevealProps {
  mnemonic: string[];
  step?: Step;
  onContinue: () => void;
  onBack: () => void;
}

export function MnemonicReveal(props: MnemonicRevealProps): React.ReactElement {
  const step: Step = props.step ?? { kind: 'create_mnemonic_reveal', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Your recovery phrase"
      subtitle="To restore your Dina identity (your handle, keys, and network presence), you will need these 24 words. Please keep them safe. Anyone with these words can access your Dina identity."
      primaryLabel="I've written it down"
      onPrimary={props.onContinue}
      onBack={props.onBack}
    >
      <View style={styles.warningBanner}>
        <Text style={styles.warningText}>
          Note: your chats and memories backup is separate from this.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.grid}>
          {props.mnemonic.map((word, i) => (
            <View key={i} style={styles.cell} accessibilityLabel={`Word ${i + 1}: ${word}`}>
              <Text
                style={styles.cellIndex}
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                {String(i + 1).padStart(2, '0')}
              </Text>
              <Text
                style={styles.cellWord}
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                {word}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <Text style={styles.footer}>
        Next we'll ask you to fill in a few of these words. Quick check to make sure you've got them
        right. You can re-view the full phrase any time from Settings.
      </Text>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  warningBanner: {
    backgroundColor: colors.warningBgSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.lg,
  },
  warningText: {
    ...textStyles.bodySmall,
    color: colors.warningTextDeep,
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
    ...textStyles.monoSmall,
    width: 20,
    textAlign: 'right',
  },
  cellWord: {
    ...textStyles.mono,
    letterSpacing: 0.2,
  },
  footer: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
});
