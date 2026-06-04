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
import { PassphraseField } from './PassphraseField';
import {
  unlock,
  useIsUnlocked,
  useUnlockState,
  getStepLabel,
  shouldForcePromptOnUnlock,
  clearForcePromptOnUnlock,
} from '../hooks/useUnlock';
import { loadWrappedSeed } from '../services/wrapped_seed_store';
import { loadAutoPassphrase, loadStartupMode } from '../services/startup_preferences';
import { loadBackgroundTimeoutPreference } from '../services/security_preferences';
import { setBackgroundTimeout } from '@dina/core';
import {
  clearOrphanKeychainState,
  installMarkerExists,
  wipeOrphanVaultFiles,
  writeInstallMarker,
} from '../services/install_marker';
import { colors, fonts, radius, spacing, textStyles } from '../theme';
import { OnboardingFlow } from './onboarding/onboarding_flow';

export type Mode = 'loading' | 'onboarding' | 'locked' | 'unlocking' | 'unlocked';

const DEV_PASSPHRASE = process.env.EXPO_PUBLIC_DINA_DEV_PASSPHRASE ?? '';

/**
 * Decide the gate's mode when the vault transitions unlocked → sealed.
 *
 * Only a genuine seal/wipe (prev === 'unlocked') is acted on — every
 * other prior mode (notably first-render 'loading') is owned by the
 * mount probe and passed through unchanged.
 *
 *   - seal / background auto-lock leaves the wrapped seed → 'locked'
 *     (re-prompt for the passphrase)
 *   - Sign out / Erase everything DELETED the wrapped seed →
 *     'onboarding' (there's no passphrase to ask for anymore)
 *
 * Pure so the wipe→onboarding contract is unit-testable without a full
 * gate render.
 */
export function modeAfterSeal(prev: Mode, hasWrappedSeed: boolean): Mode {
  if (prev !== 'unlocked') return prev;
  return hasWrappedSeed ? 'locked' : 'onboarding';
}

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

  // On mount, probe keychain for a wrapped seed:
  //   - existing wrapped seed → returning user → `locked`
  //   - no wrapped seed       → normal onboarding
  //
  // Infrastructure defaults are intentionally not a first-run gate.
  // A new user should not have to understand PDS/AppView before they
  // can create an identity; advanced endpoint overrides live under
  // Settings → Infrastructure.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // MT-27 orphan-install detection. iOS keychain entries persist
        // across app uninstalls; the documents-directory marker does
        // not. Marker missing + wrapped seed present means a prior
        // install left state in keychain — treat the whole keychain as
        // dead state, wipe it, and onboard fresh. Done BEFORE any
        // keychain reads so subsequent loads see the cleared state.
        //
        // Also wipe orphan SQLite files: a backup/restore flow (or any
        // path where the OS retained the data dir while the keychain
        // got wiped, or vice versa) leaves `.sqlite` files encrypted
        // with the OLD DEK; the fresh seed derives a NEW DEK and
        // op-sqlite throws "sqlite query error: file is not a database"
        // when it tries to decrypt them. Symptom: persistent chat-home
        // "dev-degraded mode / persistence.in_memory" banner across
        // restarts.
        if (!installMarkerExists()) {
          const stale = await loadWrappedSeed();
          if (stale !== null) {
            await clearOrphanKeychainState();
            wipeOrphanVaultFiles();
          }
          writeInstallMarker();
        }
        const [existing, bgTimeout] = await Promise.all([
          loadWrappedSeed(),
          loadBackgroundTimeoutPreference(),
        ]);
        if (cancelled) return;
        // MT-40-I3 — restore the user's chosen auto-lock timeout
        // before any AppState change can be observed. Without this
        // every cold launch reverts to the 5-minute default, so a
        // user who picked "1 minute" loses their setting on each
        // restart.
        if (bgTimeout !== null) {
          setBackgroundTimeout(bgTimeout);
        }
        if (existing !== null) {
          setMode('locked');
        } else {
          setMode('onboarding');
        }
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
    if (unlocked) {
      setMode('unlocked');
      return;
    }
    // unlocked → false transition. Only act on a real seal/wipe — i.e.
    // when we were previously 'unlocked'. First-render (mode 'loading')
    // is owned by the mount probe above, so leave it alone.
    //
    // Where we go depends on whether a vault still exists:
    //   - Manual seal / background auto-lock leaves the wrapped seed in
    //     place → 'locked' (re-prompt for the passphrase).
    //   - Sign out / Erase everything DELETES the wrapped seed →
    //     'onboarding'. Showing the "enter passphrase" form for a vault
    //     that no longer exists is a dead end (the passphrase isn't
    //     there anymore); the user should drop straight into a fresh
    //     onboarding flow.
    // So re-probe the seed rather than assuming 'locked'.
    let cancelled = false;
    void (async () => {
      const wrapped = await loadWrappedSeed();
      if (cancelled) return;
      setMode((prev) => modeAfterSeal(prev, wrapped !== null));
    })();
    return () => {
      cancelled = true;
    };
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

  // Auto-unlock for users who picked "Start automatically" during
  // onboarding. Reads the cached passphrase from keychain and runs the
  // unlock pipeline silently. If the cached passphrase is wrong (mode
  // got out of sync with the wrapped seed somehow), runUnlock falls
  // back to `locked` and the user gets the prompt — same as manual.
  useEffect(() => {
    if (mode !== 'locked') return;
    if (autoRanRef.current === mode) return;
    autoRanRef.current = mode;
    if (DEV_PASSPHRASE !== '') {
      setPassphrase(DEV_PASSPHRASE);
      const t = setTimeout(() => {
        void runUnlock(DEV_PASSPHRASE);
      }, 50);
      return () => clearTimeout(t);
    }
    // Sign-out short-circuit: when the user has just tapped Sign out,
    // suppress this re-entry's keychain auto-unlock so the chooser
    // sees a passphrase prompt instead. The flag is consumed (cleared)
    // here so the user's auto-unlock preference resumes after the next
    // successful manual unlock — Sign out is a one-shot event, not a
    // mode flip.
    if (shouldForcePromptOnUnlock()) {
      clearForcePromptOnUnlock();
      return;
    }
    let cancelled = false;
    (async () => {
      const startupMode = await loadStartupMode();
      if (cancelled || startupMode !== 'auto') return;
      const cached = await loadAutoPassphrase();
      if (cancelled || cached === null) return;
      setPassphrase(cached);
      void runUnlock(cached);
    })();
    return () => {
      cancelled = true;
    };
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

        <PassphraseField
          label="Passphrase"
          value={passphrase}
          onChangeText={setPassphrase}
          editable={!busy}
          placeholder="Passphrase"
          onSubmitEditing={() => void runUnlock(passphrase)}
          error={error !== '' ? error : undefined}
        />

        <Pressable
          testID="unlock-gate-unlock"
          accessibilityRole="button"
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

        {busy ? <Text style={styles.progress}>{getStepLabel(unlockState.step)}</Text> : null}
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
    ...textStyles.wordmark,
  },
  headline: {
    ...textStyles.display,
    marginTop: spacing.md,
  },
  sub: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  label: {
    ...textStyles.label,
    marginTop: spacing.xl,
    color: colors.textMuted,
  },
  input: {
    ...textStyles.bodyLarge,
    marginTop: spacing.sm,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.md,
  },
  error: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.md,
  },
  progress: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center',
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
  primaryText: textStyles.button,
  pressed: { opacity: 0.7 },
});
