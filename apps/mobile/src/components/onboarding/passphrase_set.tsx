/**
 * PassphraseSet — the Create path's passphrase screen.
 *
 * Two inputs (passphrase + confirm) plus the startup-mode toggle
 * (install.sh's `server` vs `maximum` security modes). Rendered with
 * live validation + a strength bar so the user gets feedback before
 * hitting "Continue".
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { locateStep, type StartupMode, type Step } from '../../onboarding/state';
import { colors, radius, spacing, textStyles } from '../../theme';
import { PassphraseField } from '../PassphraseField';

import { OnboardingShell } from './shell';

const MIN_LENGTH = 8;

export interface PassphraseSetProps {
  initialPassphrase?: string;
  initialConfirm?: string;
  initialMode?: StartupMode;
  /**
   * Which flow this screen is part of — picks the right "N of M" label
   * in the shell. Defaults to `'create'` because PassphraseSet was first
   * built for the create wizard; the recover flow added later passes
   * `'recover'` so the progress reads "3 of 4" instead of "3 of 6".
   */
  flow?: 'create' | 'recover';
  onContinue: (passphrase: string, mode: StartupMode) => void;
  onBack: () => void;
}

export function PassphraseSet(props: PassphraseSetProps): React.ReactElement {
  const [pp, setPp] = useState<string>(props.initialPassphrase ?? '');
  const [confirm, setConfirm] = useState<string>(props.initialConfirm ?? '');
  const [mode, setMode] = useState<StartupMode>(props.initialMode ?? 'auto');

  const tooShort = pp.length > 0 && pp.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && pp !== confirm;
  const valid = pp.length >= MIN_LENGTH && pp === confirm;
  const strength = strengthOf(pp);

  const step: Step =
    props.flow === 'recover'
      ? { kind: 'recover_passphrase', draft: {} }
      : { kind: 'create_passphrase', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Set your passphrase"
      subtitle="This encrypts your vault on this device. Keep it safe. It's the only way into your data."
      primaryLabel="Continue"
      onPrimary={() => valid && props.onContinue(pp, mode)}
      primaryDisabled={!valid}
      onBack={props.onBack}
    >
      <PassphraseField
        label="Passphrase"
        value={pp}
        onChangeText={setPp}
        placeholder="At least 8 characters"
        error={tooShort ? 'At least 8 characters' : undefined}
        accessibilityLabel="Passphrase"
      />
      <StrengthBar score={strength} />

      <View style={styles.gap} />

      <PassphraseField
        label="Confirm"
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Type it again"
        error={mismatch ? 'Passphrases don\u2019t match' : undefined}
        accessibilityLabel="Confirm passphrase"
      />

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>STARTUP MODE</Text>
        <ModeCard
          selected={mode === 'auto'}
          onPress={() => setMode('auto')}
          title="Unlock automatically"
          body="Dina unlocks on launch. Convenient for daily use. Less secure if your phone is stolen."
        />
        <View style={styles.modeGap} />
        <ModeCard
          selected={mode === 'manual'}
          onPress={() => setMode('manual')}
          title="Ask me each time"
          body="Your vault stays sealed until you enter the passphrase. Safer, one extra tap."
        />
      </View>
    </OnboardingShell>
  );
}

const STRENGTH_LABELS = ['', 'Weak', 'Okay', 'Strong', 'Excellent'] as const;

function StrengthBar({ score }: { score: number }): React.ReactElement | null {
  if (score === 0) return null;
  const color = score >= 3 ? colors.success : score === 2 ? colors.warning : colors.error;
  return (
    <View accessibilityLabel={`Passphrase strength: ${STRENGTH_LABELS[score]}`}>
      <View style={styles.strengthRow}>
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={[styles.strengthPip, { backgroundColor: i < score ? color : colors.border }]}
          />
        ))}
      </View>
      <Text style={[styles.strengthLabel, { color }]}>{STRENGTH_LABELS[score]}</Text>
    </View>
  );
}

function strengthOf(pp: string): number {
  if (pp.length === 0) return 0;
  let score = 0;
  if (pp.length >= MIN_LENGTH) score++;
  if (pp.length >= 12) score++;
  if (/\d/.test(pp) && /[a-zA-Z]/.test(pp)) score++;
  if (/[^a-zA-Z0-9]/.test(pp)) score++;
  return score;
}

function ModeCard({
  selected,
  onPress,
  title,
  body,
}: {
  selected: boolean;
  onPress: () => void;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeCard,
        selected && styles.modeCardSelected,
        pressed && styles.pressed,
      ]}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}. ${body}`}
    >
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={styles.modeText}>
        <Text style={styles.modeTitle}>{title}</Text>
        <Text style={styles.modeBody}>{body}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  gap: { height: spacing.md },
  section: {
    marginTop: spacing.xl,
  },
  sectionLabel: {
    ...textStyles.eyebrow,
    letterSpacing: 1.5,
    marginBottom: spacing.sm,
  },
  strengthRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: spacing.sm,
  },
  strengthPip: {
    flex: 1,
    height: 6,
    borderRadius: 3,
  },
  strengthLabel: {
    ...textStyles.bodySmallStrong,
    marginTop: 4,
  },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    gap: spacing.md,
  },
  modeCardSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.bgTertiary,
  },
  modeGap: { height: spacing.sm },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.accent },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  modeText: { flex: 1 },
  modeTitle: textStyles.bodyStrong,
  modeBody: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
  },
  pressed: { opacity: 0.7 },
});
