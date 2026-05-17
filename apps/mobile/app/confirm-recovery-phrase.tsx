/**
 * Settings → "Confirm recovery phrase" — the deferred verification
 * flow for users who tapped "I'll do this later" during onboarding.
 *
 * Sequence:
 *   1. Passphrase gate (independent of unlock state — same rationale
 *      as recovery-phrase.tsx; we never want a borrowed-device
 *      session to expose the verification path).
 *   2. Derive the 24 words from the unwrapped seed and feed them to
 *      `MnemonicVerify`. The same component used in onboarding now
 *      runs against the user's actual phrase.
 *   3. On `onVerified` → call `markVerified()` (deletes the keychain
 *      `pending` marker) and pop back to Settings. The chat-home
 *      banner reads the same status and disappears on the next
 *      mount.
 *
 * No "I'll do this later" option in this flow — the user already
 * deferred once and explicitly came back to confirm. Re-offering
 * defer here would loop forever.
 */

import React, { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { entropyToMnemonic, unwrapSeed } from '@dina/core';
import { MnemonicVerify } from '../src/components/onboarding/mnemonic_verify';
import { loadWrappedSeed } from '../src/services/wrapped_seed_store';
import { markVerified } from '../src/services/verification_status';
import { colors, fonts, radius, spacing } from '../src/theme';

type Mode = 'gate' | 'unlocking' | 'verify';

export default function ConfirmRecoveryPhraseScreen(): React.ReactElement {
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  // Honour the ?from param so the chat-banner entry point (from='/') goes
  // back to Chat, and the Settings entry point (no from / from='/settings')
  // goes back to Settings.
  const backTarget: string =
    typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
      ? from
      : '/settings';
  const [mode, setMode] = useState<Mode>('gate');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [words, setWords] = useState<string[]>([]);

  const handleUnlock = useCallback(async (): Promise<void> => {
    setError('');
    if (passphrase === '') {
      setError('Type your passphrase first.');
      return;
    }
    setMode('unlocking');
    try {
      const wrapped = await loadWrappedSeed();
      if (wrapped === null) {
        setError("Couldn't find your wrapped seed. Try fully relaunching the app.");
        setMode('gate');
        return;
      }
      const seed = await unwrapSeed(passphrase, wrapped);
      const mnemonic = entropyToMnemonic(seed);
      setWords(mnemonic.split(' '));
      setPassphrase(''); // clear input — we no longer need it
      setMode('verify');
    } catch {
      setError('That passphrase didn’t unlock the seed. Try again.');
      setMode('gate');
    }
  }, [passphrase]);

  if (mode === 'verify') {
    return (
      <MnemonicVerify
        mnemonic={words}
        onBack={() => router.replace(backTarget as never)}
        compact
        onViewPhrase={() =>
          router.push({
            pathname: '/recovery-phrase',
            params: { from: '/confirm-recovery-phrase' },
          })
        }
        onVerified={() => {
          void markVerified();
          setWords([]);
          router.replace(backTarget as never);
        }}
      />
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Confirm recovery phrase</Text>
      <Text style={styles.subtitle}>
        Quick check to make sure your written copy is good. Enter your passphrase, then we'll ask
        for a few of the words.
      </Text>

      <Text style={styles.fieldLabel}>PASSPHRASE</Text>
      <TextInput
        value={passphrase}
        onChangeText={(v) => {
          setPassphrase(v);
          if (error !== '') setError('');
        }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        textContentType="password"
        editable={mode !== 'unlocking'}
        placeholder="Your passphrase"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        onSubmitEditing={() => void handleUnlock()}
        accessibilityLabel="Enter passphrase to confirm recovery phrase"
      />

      {error !== '' ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={() => void handleUnlock()}
        disabled={mode === 'unlocking'}
        accessibilityRole="button"
        accessibilityLabel="Continue to confirm phrase"
        accessibilityState={{ disabled: mode === 'unlocking' }}
        style={({ pressed }) => [
          styles.primaryButton,
          pressed && styles.primaryButtonPressed,
          mode === 'unlocking' && styles.primaryButtonDisabled,
        ]}
      >
        <Text style={styles.primaryButtonText}>
          {mode === 'unlocking' ? 'Unlocking…' : 'Continue'}
        </Text>
      </Pressable>

      {/* Mirror of the wallet-style "I forgot, take me back" link.
          Pops back to Settings; the chat-home banner stays visible
          since status is still pending. */}
      <Pressable
        onPress={() => router.replace(backTarget as never)}
        accessibilityRole="button"
        accessibilityLabel="Cancel and go back"
        style={styles.cancelButton}
      >
        <Text style={styles.cancelButtonText}>Not now</Text>
      </Pressable>

      <View style={styles.hint}>
        <Text style={styles.hintText}>
          We'll only check a few words — you don't have to type all 24. After this we'll stop
          showing the reminder banner.
        </Text>
      </View>
    </ScrollView>
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
  title: {
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    fontStyle: 'italic',
    fontSize: 24,
    color: colors.textPrimary,
    letterSpacing: -0.3,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  fieldLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 0.5,
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
    marginBottom: spacing.md,
  },
  error: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.error,
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
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.bgPrimary,
  },
  cancelButton: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textMuted,
  },
  hint: {
    marginTop: spacing.lg,
  },
  hintText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted,
  },
});
