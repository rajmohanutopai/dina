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
import { unlock, useIsUnlocked, useUnlockState, getStepLabel } from '../hooks/useUnlock';
import { loadWrappedSeed } from '../services/wrapped_seed_store';
import { loadInfraPreferences } from '../services/infra_preferences';
import { colors, fonts, radius, spacing } from '../theme';
import { OnboardingFlow } from './onboarding/onboarding_flow';
import { InfraSetupForm } from './onboarding/infra_setup';

type Mode =
  | 'loading'
  /**
   * First-run state: no wrapped seed AND no persisted PDS URL. We
   * want the operator to confirm or override the infrastructure
   * endpoints (PDS + AppView) BEFORE we attempt PDS createAccount in
   * the onboarding wizard.
   */
  | 'infra-setup'
  | 'onboarding'
  | 'locked'
  | 'unlocking'
  | 'unlocked';

const DEV_PASSPHRASE = process.env.EXPO_PUBLIC_DINA_DEV_PASSPHRASE ?? '';

/** Total budget for the full unlock pipeline. Argon2id KDF + SQLCipher
 *  open + per-persona DB open + hydration tops out at ~5–8s on iOS
 *  simulator cold-cache. 30s gives slow devices plenty of headroom while
 *  still cutting off a genuinely-hung step (op-sqlite file lock, keychain
 *  stall, etc.) before the spinner spins indefinitely. */
const UNLOCK_TIMEOUT_MS = 30_000;

export function UnlockGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const unlocked = useIsUnlocked();
  const unlockState = useUnlockState();
  const [mode, setMode] = useState<Mode>('loading');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const autoRanRef = useRef<Mode | null>(null);

  // On mount, probe keychain for a wrapped seed AND infra prefs:
  //   - existing wrapped seed → returning user → `locked`
  //   - no wrapped seed + no PDS URL pref → first run → `infra-setup`
  //   - no wrapped seed + PDS URL set    → restart of partial onboard → `onboarding`
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [existing, infra] = await Promise.all([
          loadWrappedSeed(),
          loadInfraPreferences(),
        ]);
        if (cancelled) return;
        if (existing !== null) {
          setMode('locked');
        } else if (infra.pdsUrl === null) {
          setMode('infra-setup');
        } else {
          setMode('onboarding');
        }
      } catch (err) {
        if (cancelled) return;
        setMode('infra-setup');
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
      // Race the unlock pipeline against a hard timeout. Without this,
      // any awaited step that hangs (op-sqlite file lock, keychain
      // stall, native-module bug) leaves the spinner running forever
      // with no way back. The Symbol sentinel disambiguates a real
      // resolved UnlockState from the timeout fire.
      const TIMEOUT_SENTINEL = Symbol('unlock_timeout');
      const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        setTimeout(() => resolve(TIMEOUT_SENTINEL), UNLOCK_TIMEOUT_MS);
      });
      const outcome = await Promise.race([unlock(pp, wrapped), timeoutPromise]);
      if (outcome === TIMEOUT_SENTINEL) {
        setError(
          'Unlock is taking longer than expected. Try again, or restart the app if it keeps hanging.',
        );
        setMode('locked');
        return;
      }
      if (outcome.step === 'failed') {
        setError(outcome.error ?? 'Wrong passphrase.');
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

  if (mode === 'infra-setup') {
    return <InfraSetupForm onDone={() => setMode('onboarding')} />;
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

        {busy ? (
          <Text style={styles.progress}>{getStepLabel(unlockState.step)}</Text>
        ) : null}
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
  progress: {
    marginTop: spacing.md,
    textAlign: 'center',
    fontSize: 13,
    color: colors.textSecondary,
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
