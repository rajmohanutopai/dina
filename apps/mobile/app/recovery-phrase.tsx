/**
 * Settings → "View recovery phrase".
 *
 * Re-displays the user's 24-word BIP-39 mnemonic on demand. The words
 * themselves are never persisted — we hold only the wrapped seed
 * (entropy) in keychain, and round-trip back to the mnemonic via
 * `entropyToMnemonic` after the user re-authenticates.
 *
 * Why a separate re-auth gate (instead of trusting the unlock state):
 * the unlock state can be carried by the auto-unlock startup mode (a
 * cached passphrase in keychain — convenience), but exposing the
 * mnemonic is the highest-stakes reveal in the app. Anyone who
 * shoulder-surfs the passphrase on a borrowed device can extract the
 * full identity here, even if they later wipe the device. Forcing
 * passphrase re-entry every time raises the bar to "actively typing
 * the phrase right now" instead of "happens to have a recently-active
 * session." Same pattern every wallet uses for phrase reveal.
 *
 * Hardening:
 *   - Wipes state on `AppState.change → background/inactive` so app
 *     switcher previews don't leak the words.
 *   - Wipes after a 60s idle timer so a user who walks away mid-view
 *     doesn't leave the words on screen.
 *   - Never logs the words — even on error paths.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { entropyToMnemonic, unwrapSeed } from '@dina/core';
import { loadWrappedSeed } from '../src/services/wrapped_seed_store';
import { colors, fonts, radius, spacing } from '../src/theme';

type Mode = 'gate' | 'unlocking' | 'revealed';

/**
 * After this many ms with the words visible we drop back to the gate.
 * Long enough that a user can comfortably read + transcribe the 24
 * words; short enough that walking away from the device doesn't leave
 * them on screen indefinitely.
 */
const IDLE_HIDE_MS = 60_000;

export default function RecoveryPhraseScreen(): React.ReactElement {
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  // Honour ?from so confirm-recovery-phrase → view phrase → back returns
  // to the verify step, and Settings → view phrase → back returns to Settings.
  const backTarget: string =
    typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
      ? from
      : '/settings';
  const [mode, setMode] = useState<Mode>('gate');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [words, setWords] = useState<string[]>([]);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drop the revealed words back to the gate. Centralised so every
  // hide path (idle timeout, background, manual "Done") clears the
  // same state — keeps the words from sticking around in any of the
  // hooks' captured closures.
  const wipeRevealed = useCallback((): void => {
    setWords([]);
    setPassphrase('');
    setError('');
    setMode('gate');
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  // Auto-hide on background. iOS app-switcher captures a screenshot of
  // the foreground view when the user swipes up; if we leave the words
  // on screen, that screenshot persists in the recents thumbnail until
  // the next foreground render. Wiping on `inactive` (the transition
  // state iOS hits BEFORE `background`) ensures the recents image is
  // already empty by the time the OS captures it.
  useEffect(() => {
    if (mode !== 'revealed') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        wipeRevealed();
      }
    });
    return () => {
      sub.remove();
    };
  }, [mode, wipeRevealed]);

  // Idle hide. Resets on every render-while-revealed; the user
  // touching the screen (interaction triggers re-render via state)
  // would extend it, but for a static reveal screen the timer just
  // counts down from the last reveal.
  useEffect(() => {
    if (mode !== 'revealed') return;
    idleTimerRef.current = setTimeout(wipeRevealed, IDLE_HIDE_MS);
    return () => {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [mode, wipeRevealed]);

  const handleReveal = useCallback(async (): Promise<void> => {
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
      setPassphrase(''); // wipe input — no need to keep it after reveal
      setMode('revealed');
    } catch {
      // Any error here — wrong passphrase, KDF mismatch, AES tag
      // failure — gets a single generic surface so we don't leak
      // which step failed. Same pattern as unlock_gate's wrong-
      // passphrase path.
      setError('That passphrase didn’t unlock the seed. Try again.');
      setMode('gate');
    }
  }, [passphrase]);

  if (mode === 'revealed') {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Your recovery phrase</Text>
        <View style={styles.warningBanner}>
          <Text style={styles.warningText}>
            Keep these somewhere very safe. Anyone with these words can access your Dina identity.
            We'll auto-hide them in 60 seconds.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.grid}>
            {words.map((word, i) => (
              <View key={i} style={styles.cell}>
                <Text style={styles.cellIndex}>{String(i + 1).padStart(2, '0')}</Text>
                <Text
                  style={styles.cellWord}
                  selectable={false}
                  // selectable={false} so a long-press doesn't surface
                  // the iOS share/copy menu — copying these to the
                  // clipboard is exactly what we're trying to prevent.
                >
                  {word}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <Pressable
          onPress={() => {
            wipeRevealed();
            router.replace(backTarget as never);
          }}
          accessibilityRole="button"
          accessibilityLabel="Hide recovery phrase and go back"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
        >
          <Text style={styles.primaryButtonText}>Done</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>View recovery phrase</Text>
      <Text style={styles.subtitle}>
        Use this before upgrading or switching phones — enter your passphrase to see your 24 words
        and write them down somewhere safe. As long as you have this app and your passphrase, you
        can always retrieve them here.
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
        onSubmitEditing={() => void handleReveal()}
        accessibilityLabel="Enter passphrase to view recovery phrase"
      />

      {error !== '' ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={() => void handleReveal()}
        disabled={mode === 'unlocking'}
        accessibilityRole="button"
        accessibilityLabel="Reveal recovery phrase"
        accessibilityState={{ disabled: mode === 'unlocking' }}
        style={({ pressed }) => [
          styles.primaryButton,
          pressed && styles.primaryButtonPressed,
          mode === 'unlocking' && styles.primaryButtonDisabled,
        ]}
      >
        <Text style={styles.primaryButtonText}>
          {mode === 'unlocking' ? 'Unlocking…' : 'Reveal phrase'}
        </Text>
      </Pressable>
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
    marginBottom: spacing.lg,
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
});
