/**
 * PassphraseSet — the Create path's passphrase screen.
 *
 * Two inputs (passphrase + confirm) plus the startup-mode toggle
 * (install.sh's `server` vs `maximum` security modes). Rendered with
 * live validation + a strength bar so the user gets feedback before
 * hitting "Continue".
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { OnboardingShell } from './shell';
import { locateStep, type StartupMode, type Step } from '../../onboarding/state';
import { colors, radius, spacing } from '../../theme';

const MIN_LENGTH = 8;

export interface PassphraseSetProps {
  initialPassphrase?: string;
  initialConfirm?: string;
  initialMode?: StartupMode;
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

  const step: Step = { kind: 'create_passphrase', draft: {} };
  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Set your passphrase"
      subtitle="This encrypts your vault on this device. Keep it safe — it's the only way into your data."
      primaryLabel="Continue"
      onPrimary={() => valid && props.onContinue(pp, mode)}
      primaryDisabled={!valid}
      onBack={props.onBack}
    >
      <Field
        label="Passphrase"
        value={pp}
        onChangeText={setPp}
        placeholder="At least 8 characters"
        helperError={tooShort ? 'At least 8 characters' : undefined}
      />
      <StrengthBar score={strength} />

      <View style={styles.gap} />

      <Field
        label="Confirm"
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Type it again"
        helperError={mismatch ? 'Passphrases don\u2019t match' : undefined}
      />

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>STARTUP MODE</Text>
        <ModeCard
          selected={mode === 'auto'}
          onPress={() => setMode('auto')}
          title="Start automatically"
          body="Dina unlocks on launch. Convenient for daily use; less resilient if your phone is stolen."
        />
        <View style={styles.modeGap} />
        <ModeCard
          selected={mode === 'manual'}
          onPress={() => setMode('manual')}
          title="Ask for my passphrase each time"
          body="Your vault stays sealed until you enter the passphrase. Safer, one extra tap."
        />
      </View>
    </OnboardingShell>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  helperError?: string;
}): React.ReactElement {
  return (
    <View>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textMuted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={[styles.input, props.helperError !== undefined && styles.inputError]}
      />
      {props.helperError !== undefined ? (
        <Text style={styles.fieldError}>{props.helperError}</Text>
      ) : null}
    </View>
  );
}

function StrengthBar({ score }: { score: number }): React.ReactElement {
  const color = score >= 3 ? colors.success : score === 2 ? colors.warning : colors.error;
  return (
    <View style={styles.strengthRow}>
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={[styles.strengthPip, { backgroundColor: i < score ? color : colors.border }]}
        />
      ))}
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
      accessibilityLabel={title}
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
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  fieldLabel: {
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
    fontSize: 16,
  },
  inputError: {
    borderColor: colors.error,
  },
  fieldError: {
    marginTop: 6,
    fontSize: 12,
    color: colors.error,
  },
  strengthRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: spacing.sm,
  },
  strengthPip: {
    flex: 1,
    height: 3,
    borderRadius: 2,
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
  modeTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  modeBody: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  pressed: { opacity: 0.7 },
});
