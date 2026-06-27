/**
 * Settings → Security → "Change passphrase".
 *
 * Re-wraps the master seed under a new passphrase. The passphrase only
 * wraps the seed (Argon2id → AES-256-GCM); the seed and every persona
 * DEK derived from it are unchanged, so all existing vault data keeps
 * decrypting — this is a key re-wrap, not a re-encryption.
 *
 * Three fields: current, new, confirm. The current passphrase is proven
 * by the unwrap step inside `changeVaultPassphrase` (a wrong one fails
 * the GCM tag and nothing is written). On success the new wrapped seed
 * is persisted and, for "Unlock automatically" users, the cached
 * passphrase is refreshed so silent boot keeps working.
 *
 * The recovery phrase is unaffected: it encodes the seed, not the
 * passphrase, so the same 24 words still restore the identity after a
 * passphrase change.
 */

import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { PassphraseField } from '../src/components/PassphraseField';
import { getPassphraseStrength } from '../src/hooks/useSecurity';
import { changeVaultPassphrase } from '../src/services/change_passphrase';
import { colors, radius, spacing, textStyles } from '../src/theme';

type Mode = 'idle' | 'saving' | 'done';

const STRENGTH_LABEL: Record<ReturnType<typeof getPassphraseStrength>, string> = {
  weak: 'Weak',
  fair: 'Fair',
  strong: 'Strong',
  very_strong: 'Very strong',
};

const STRENGTH_COLOR: Record<ReturnType<typeof getPassphraseStrength>, string> = {
  weak: colors.error,
  fair: colors.warning,
  strong: colors.accent,
  very_strong: colors.success,
};

export default function ChangePassphraseScreen(): React.ReactElement {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const strength = useMemo(() => (next === '' ? null : getPassphraseStrength(next)), [next]);

  const clearError = (): void => {
    if (error !== '') setError('');
  };

  const handleSave = async (): Promise<void> => {
    setError('');
    if (current === '') {
      setError('Enter your current passphrase.');
      return;
    }
    if (next !== confirm) {
      setError("The new passphrase and confirmation don't match.");
      return;
    }
    setMode('saving');
    const result = await changeVaultPassphrase(current, next);
    if (result.ok) {
      // Wipe the inputs out of state — no need to keep secrets around
      // once the re-wrap is durable.
      setCurrent('');
      setNext('');
      setConfirm('');
      setMode('done');
      return;
    }
    setError(result.error);
    setMode('idle');
  };

  if (mode === 'done') {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="change-passphrase-screen"
      >
        <View style={styles.successBanner}>
          <Text style={styles.successText}>
            Passphrase changed. Your vault is now sealed with the new passphrase. Your recovery
            phrase is unchanged.
          </Text>
        </View>
        <Pressable
          testID="change-passphrase-done"
          onPress={() => router.replace('/settings' as never)}
          accessibilityRole="button"
          accessibilityLabel="Done, return to settings"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
        >
          <Text style={styles.primaryButtonText}>Done</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const busy = mode === 'saving';

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={styles.container}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="change-passphrase-screen"
      >
        {/* Native Stack header already reads "Change passphrase". */}
        <Text style={styles.subtitle}>
          This re-seals your vault under a new passphrase. Your data and your 24-word recovery
          phrase stay the same. If you forget the new passphrase, only the recovery phrase can get
          you back in.
        </Text>

        <PassphraseField
          testID="change-pass-current"
          label="CURRENT PASSPHRASE"
          value={current}
          onChangeText={(v) => {
            setCurrent(v);
            clearError();
          }}
          editable={!busy}
          placeholder="Your current passphrase"
          accessibilityLabel="Current passphrase"
          style={styles.field}
        />

        <PassphraseField
          testID="change-pass-new"
          label="NEW PASSPHRASE"
          value={next}
          onChangeText={(v) => {
            setNext(v);
            clearError();
          }}
          editable={!busy}
          placeholder="At least 8 characters"
          accessibilityLabel="New passphrase"
          style={styles.field}
        />
        {strength !== null ? (
          <Text style={[styles.strength, { color: STRENGTH_COLOR[strength] }]} testID="change-pass-strength">
            Strength: {STRENGTH_LABEL[strength]}
          </Text>
        ) : null}

        <PassphraseField
          testID="change-pass-confirm"
          label="CONFIRM NEW PASSPHRASE"
          value={confirm}
          onChangeText={(v) => {
            setConfirm(v);
            clearError();
          }}
          editable={!busy}
          placeholder="Type the new passphrase again"
          accessibilityLabel="Confirm new passphrase"
          onSubmitEditing={() => void handleSave()}
          error={error !== '' ? error : undefined}
          style={styles.field}
        />

        <Pressable
          testID="change-passphrase-submit"
          onPress={() => void handleSave()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Change passphrase"
          accessibilityState={{ disabled: busy }}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && styles.primaryButtonPressed,
            busy && styles.primaryButtonDisabled,
          ]}
        >
          <Text style={styles.primaryButtonText}>{busy ? 'Changing…' : 'Change passphrase'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  subtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  field: {
    marginBottom: spacing.md,
  },
  strength: {
    ...textStyles.caption,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  primaryButton: {
    marginTop: spacing.md,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonPressed: {
    opacity: 0.85,
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    ...textStyles.bodyStrong,
    color: colors.bgPrimary,
  },
  successBanner: {
    backgroundColor: colors.successBgSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.success,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.lg,
  },
  successText: {
    ...textStyles.bodySmall,
    color: colors.textPrimary,
  },
});
