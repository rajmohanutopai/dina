/**
 * InfraSetupForm — first-run gate that captures the PDS + AppView
 * endpoints BEFORE the onboarding wizard starts.
 *
 * `provisionIdentity` (the PDS-first onboarding) needs to know which
 * PDS to call `createAccount` against. The previous flow read this
 * from `EXPO_PUBLIC_DINA_PDS_URL` and silently fell back to the
 * built-in default; that hid the URL from the operator and made it
 * impossible to point a non-dev build at a self-hosted PDS without
 * recompiling.
 *
 * Now: when the keychain has no `pdsUrl` preference (clean install OR
 * post-reset), we mount this form first. Defaults are pre-filled to
 * the demo infrastructure (`test-pds`, `test-appview`); the user can
 * override or accept and continue. On Continue we persist via
 * `infra_preferences` and the UnlockGate flips to `onboarding`.
 *
 * Fields are kept minimal:
 *   - PDS URL — backbone for createAccount + record publishing.
 *   - AppView URL — PeerLens + service discovery.
 *   - MsgBox URL — currently env-only (`EXPO_PUBLIC_DINA_MSGBOX_URL`)
 *     because it's rarely overridden and the keychain backing isn't
 *     wired yet. A future iteration can add it; for now an env
 *     escape-hatch is enough.
 *
 * Design intent: NOT a settings screen. This is a one-shot gate. The
 * full editable Service Sharing → Infrastructure section in
 * `app/service-settings.tsx` remains the post-onboarding edit
 * surface.
 */

import React, { useEffect, useRef, useState } from 'react';
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
import {
  savePdsUrl,
  saveAppViewURL,
} from '../../services/infra_preferences';
import { colors, fonts, radius, spacing, textStyles } from '../../theme';

const DEFAULT_PDS_URL = 'https://test-pds.dinakernel.com';
const DEFAULT_APPVIEW_URL = 'https://test-appview.dinakernel.com';

/**
 * Dev autopilot: when `EXPO_PUBLIC_DINA_DEV_PASSPHRASE` is set, the
 * onboarding wizard skips its own pre-flight (welcome / handle pick)
 * and jumps to provisioning. To keep the dev path frictionless we
 * mirror that here — auto-accept the defaults and advance to
 * onboarding without showing the form. Production bundles (no env
 * var) get the form. Same env-var pattern used by `unlock_gate.tsx`
 * and `onboarding_flow.tsx`.
 */
const DEV_PASSPHRASE = process.env.EXPO_PUBLIC_DINA_DEV_PASSPHRASE ?? '';

export function InfraSetupForm({
  onDone,
}: {
  /** Called after preferences are persisted. UnlockGate flips to
   *  `onboarding` mode. */
  onDone: () => void;
}): React.ReactElement {
  const [pdsUrl, setPdsUrl] = useState(DEFAULT_PDS_URL);
  const [appViewURL, setAppViewURL] = useState(DEFAULT_APPVIEW_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRanRef = useRef(false);

  // Dev autopilot — accept defaults, advance immediately. Runs once.
  useEffect(() => {
    if (DEV_PASSPHRASE === '' || autoRanRef.current) return;
    autoRanRef.current = true;
    void (async () => {
      try {
        await Promise.all([
          savePdsUrl(DEFAULT_PDS_URL),
          saveAppViewURL(DEFAULT_APPVIEW_URL),
        ]);
        onDone();
      } catch (err) {
        setError(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, [onDone]);

  const handleContinue = async (): Promise<void> => {
    setError(null);
    const trimmedPds = pdsUrl.trim();
    const trimmedAv = appViewURL.trim();
    if (!isHttpUrl(trimmedPds)) {
      setError('PDS URL must be http(s) — e.g. https://test-pds.dinakernel.com');
      return;
    }
    if (!isHttpUrl(trimmedAv)) {
      setError('AppView URL must be http(s) — e.g. https://test-appview.dinakernel.com');
      return;
    }
    setBusy(true);
    try {
      await Promise.all([savePdsUrl(trimmedPds), saveAppViewURL(trimmedAv)]);
      onDone();
    } catch (err) {
      setError(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>DINA</Text>
        <Text style={styles.headline}>Choose your infrastructure</Text>
        <Text style={styles.sub}>
          Dina uses AT Protocol and needs a PDS for identity and an AppView for
          PeerLens and Services. You can use your own, or use the defaults here.
        </Text>

        <Text style={styles.label}>PDS URL</Text>
        <TextInput
          value={pdsUrl}
          onChangeText={setPdsUrl}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!busy}
          placeholder={DEFAULT_PDS_URL}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          keyboardType="url"
        />
        <Text style={styles.helpText}>
          Where your did:plc account lives. The PDS mints the DID and stores published
          records.
        </Text>

        <Text style={styles.label}>PeerLens and Services URL</Text>
        <TextInput
          value={appViewURL}
          onChangeText={setAppViewURL}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!busy}
          placeholder={DEFAULT_APPVIEW_URL}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          keyboardType="url"
        />
        <Text style={styles.helpText}>
          Indexes PeerLens attestations and service profiles. PeerLens reviews and service
          discovery both hit this URL.
        </Text>

        {error !== null ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          onPress={() => void handleContinue()}
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
            <Text style={styles.primaryText}>Continue</Text>
          )}
        </Pressable>

        <Text style={styles.foot}>
          You can change these later in Settings → Service Sharing → Infrastructure.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function isHttpUrl(s: string): boolean {
  if (s.length === 0) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  content: {
    padding: spacing.lg,
    paddingTop: spacing.xxl * 2,
  },
  brand: {
    ...textStyles.eyebrow,
    letterSpacing: 6,
  },
  headline: {
    ...textStyles.displaySmall,
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
    ...textStyles.body,
    marginTop: spacing.sm,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.md,
  },
  helpText: {
    ...textStyles.caption,
    marginTop: spacing.xs,
  },
  error: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.md,
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
  foot: {
    ...textStyles.caption,
    marginTop: spacing.xl,
    textAlign: 'center',
  },
});
