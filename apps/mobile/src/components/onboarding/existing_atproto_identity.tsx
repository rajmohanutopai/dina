import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { locateStep, type Step } from '../../onboarding/state';
import { loginWithBluesky } from '../../services/oauth_login';
import { colors, radius, spacing, textStyles } from '../../theme';

import { OnboardingShell } from './shell';

/** A linked external identity. `verified` ⇒ proven via OAuth. */
export interface ExternalLink {
  did: string;
  handle: string | null;
  pdsUrl: string;
}

export interface ExistingAtprotoIdentityProps {
  initialIdentifier?: string;
  /** `verifiedLink` is set when the user proved control via OAuth. */
  onContinue: (identifier: string, verifiedLink?: ExternalLink) => void;
  onBack: () => void;
}

export function ExistingAtprotoIdentity(props: ExistingAtprotoIdentityProps): React.ReactElement {
  const [identifier, setIdentifier] = useState(props.initialIdentifier ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = identifier.trim().length > 0;
  const step: Step = { kind: 'external_identity', draft: {} };

  const onLogin = (): void => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    loginWithBluesky(identifier.trim())
      .then((result) => {
        props.onContinue(identifier.trim(), {
          did: result.did,
          handle: result.handle,
          pdsUrl: result.pdsUrl,
        });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Link your Bluesky identity"
      subtitle="Connect a Bluesky or AT Protocol account you already have. Dina keeps its own keys — we just link your handle so people can recognise and trust you."
      primaryLabel={busy ? 'Opening Bluesky…' : 'Login with Bluesky'}
      onPrimary={onLogin}
      primaryDisabled={!valid || busy}
      onBack={props.onBack}
    >
      <Text style={styles.label}>HANDLE OR DID</Text>
      <TextInput
        value={identifier}
        onChangeText={setIdentifier}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType="email-address"
        placeholder="alice.bsky.social or did:plc:..."
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        testID="existing-atproto-identifier-input"
      />

      {busy ? (
        <View style={styles.busyRow} testID="existing-atproto-oauth-busy">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.busyText}>Approve in Bluesky, then you’ll come back here…</Text>
        </View>
      ) : null}

      {error !== null ? (
        <Text style={styles.error} testID="existing-atproto-oauth-error">
          {error}
        </Text>
      ) : null}

      <View style={styles.note} testID="existing-atproto-link-explainer">
        <Text style={styles.noteText}>
          You’ll sign in on Bluesky to prove the account is yours. Dina never sees your password,
          creates its own separate identity, and only stores a reference to this account — for
          recognition, trust, and attribution. We never post as you or change your account.
        </Text>
      </View>

      <TouchableOpacity
        onPress={() => {
          if (valid && !busy) props.onContinue(identifier.trim());
        }}
        disabled={!valid || busy}
        testID="existing-atproto-link-without-signin"
        accessibilityRole="button"
      >
        <Text style={[styles.secondary, (!valid || busy) && styles.secondaryDisabled]}>
          Link without signing in (unverified)
        </Text>
      </TouchableOpacity>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  label: {
    ...textStyles.label,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  input: {
    ...textStyles.bodyLarge,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.md,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  busyText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    flexShrink: 1,
  },
  error: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.lg,
  },
  note: {
    marginTop: spacing.lg,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    backgroundColor: colors.bgTertiary,
    padding: spacing.md,
  },
  noteText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  secondary: {
    ...textStyles.bodySmall,
    color: colors.accent,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
  secondaryDisabled: {
    color: colors.textMuted,
  },
});
