/**
 * UnlockGate — renders children only after the vault is unlocked.
 *
 * Decides between three modes:
 *
 *   `loading`    — reading Keychain state
 *   `onboarding` — no wrapped seed yet → mount OnboardingFlow, which
 *                  drives the full welcome → passphrase → mnemonic →
 *                  provisioning sequence and ultimately calls unlock()
 *   `locked`     — wrapped seed exists → show the returning-user
 *                  passphrase form
 *   `unlocked`   — children render
 *
 * The gate subscribes to `useIsUnlocked()` so once any path (onboarding
 * or the unlock form) flips the global unlock state, this component
 * re-renders with `children` without any explicit hand-off.
 *
 * Dev autopilot (`EXPO_PUBLIC_DINA_DEV_PASSPHRASE`): when set, the
 * returning-user path auto-submits with that passphrase. Onboarding has
 * its own autopilot baked in. Production bundles without the env var
 * ignore both paths.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { unlock, useIsUnlocked } from '../hooks/useUnlock';
import { loadWrappedSeed } from '../services/wrapped_seed_store';
import { colors, fonts, radius, spacing } from '../theme';
import { OnboardingFlow } from './onboarding/onboarding_flow';

type Mode = 'loading' | 'onboarding' | 'locked' | 'unlocking' | 'unlocked';

const DEV_PASSPHRASE = process.env.EXPO_PUBLIC_DINA_DEV_PASSPHRASE ?? '';

export function UnlockGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const unlocked = useIsUnlocked();
  const [mode, setMode] = useState<Mode>('loading');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const autoRanRef = useRef<Mode | null>(null);

  // On mount, probe Keychain for a wrapped seed. Absent → onboarding.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await loadWrappedSeed();
        if (cancelled) return;
        setMode(existing === null ? 'onboarding' : 'locked');
      } catch (err) {
        if (cancelled) return;
        setMode('onboarding');
        setError(`Couldn't read vault state: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (unlocked) setMode('unlocked');
  }, [unlocked]);

  const runUnlock = useCallback(async (pp: string): Promise<void> => {
    setError('');
    if (pp === '') {
      setError('Enter your passphrase.');
      return;
    }
    setMode('unlocking');
    try {
      const wrapped = await loadWrappedSeed();
      if (wrapped === null) {
        setError('Vault record missing — starting fresh onboarding.');
        setMode('onboarding');
        return;
      }
      const result = await unlock(pp, wrapped);
      if (result.step === 'failed') {
        setError(result.error ?? 'Wrong passphrase.');
        setMode('locked');
      }
    } catch (err) {
      setError(`Couldn't unlock: ${err instanceof Error ? err.message : String(err)}`);
      setMode('locked');
    }
  }, []);

  // Dev autopilot for returning-user path.
  useEffect(() => {
    if (DEV_PASSPHRASE === '') return;
    if (mode !== 'locked') return;
    if (autoRanRef.current === mode) return;
    autoRanRef.current = mode;
    setPassphrase(DEV_PASSPHRASE);
    const t = setTimeout(() => {
      void runUnlock(DEV_PASSPHRASE);
    }, 50);
    return () => clearTimeout(t);
  }, [mode, runUnlock]);

  if (mode === 'unlocked') {
    return <>{children}</>;
  }

  if (mode === 'loading') {
    return (
      <View style={styles.root}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (mode === 'onboarding') {
    return <OnboardingFlow />;
  }

  // `locked` or `unlocking` — returning-user passphrase form.
  const busy = mode === 'unlocking';
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>DINA</Text>
        <Text style={styles.headline}>Welcome back</Text>
        <Text style={styles.sub}>
          Your vault is on this device. Enter the passphrase you set during onboarding.
        </Text>

        <Text style={styles.label}>Passphrase</Text>
        <TextInput
          value={passphrase}
          onChangeText={setPassphrase}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!busy}
          placeholder="Passphrase"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          onSubmitEditing={() => void runUnlock(passphrase)}
        />

        {error !== '' ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          onPress={() => void runUnlock(passphrase)}
          disabled={busy}
          style={({ pressed }) => [
            styles.primary,
            pressed && styles.pressed,
            busy && styles.disabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryText}>Unlock</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  content: {
    padding: spacing.lg,
    paddingTop: spacing.xxl * 2,
  },
  brand: {
    fontSize: 12,
    letterSpacing: 6,
    fontWeight: '700',
    color: colors.textMuted,
  },
  headline: {
    marginTop: spacing.md,
    fontFamily: Platform.OS === 'ios' ? fonts.serif : undefined,
    fontStyle: 'italic',
    fontSize: 36,
    lineHeight: 40,
    color: colors.textPrimary,
    letterSpacing: -0.4,
  },
  sub: {
    marginTop: spacing.sm,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
  },
  label: {
    marginTop: spacing.xl,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  input: {
    marginTop: spacing.sm,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  error: {
    marginTop: spacing.md,
    fontSize: 13,
    color: colors.error,
  },
  primary: {
    marginTop: spacing.xl,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.5 },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
});
