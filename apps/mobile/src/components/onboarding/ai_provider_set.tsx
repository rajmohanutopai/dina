/**
 * AiProviderSet — the MANDATORY "Connect your AI" onboarding step.
 *
 * The app is unusable without a working LLM key (every /ask + /remember
 * routes through it), so onboarding requires one before the vault unlocks.
 * This screen reuses the exact BYOK entry + LIVE key validation that
 * Settings → AI Providers uses (`validateKeyFormat` + `verifyKey`), so a
 * typo'd/expired key can't get through.
 *
 * If a provider is already configured — a returning user, or a dev/CI key
 * supplied via `EXPO_PUBLIC_DINA_DEV_<PROVIDER>_API_KEY` — the step is
 * already satisfied and just offers Continue (no re-entry).
 *
 * There is intentionally no skip: the step is mandatory.
 *
 * Source: onboarding requirement — a valid AI key is a precondition for the app.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { loadActiveProvider, saveActiveProvider } from '../../ai/active_provider';
import { getDeviceCheckToken, getPlayIntegrityToken } from '../../ai/attestation';
import { fetchCreditsConfig, runClaimFlow } from '../../ai/credits';
import {
  PROVIDERS,
  getConfiguredProviders,
  saveApiKey,
  validateKeyFormat,
  verifyKey,
  type ProviderType,
} from '../../ai/provider';
import { colors, radius, spacing, textStyles } from '../../theme';
import { ProviderPicker } from '../ProviderPicker';

import { OnboardingShell } from './shell';

import type { StepLocation } from '../../onboarding/state';

export interface AiProviderSetProps {
  location: StepLocation;
  onBack: () => void;
  /** Called once a working provider is connected (or already configured). */
  onContinue: () => void;
}

// Stable display order for the picker.
const PROVIDER_ORDER: ProviderType[] = ['gemini', 'openai', 'claude', 'openrouter'];

export function AiProviderSet({ location, onBack, onContinue }: AiProviderSetProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  // A provider already has a usable key (keychain or dev env) → step satisfied.
  const [configured, setConfigured] = useState<ProviderType | null>(null);
  const [selected, setSelected] = useState<ProviderType | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starter Credits beat — shown ONLY when a grant is genuinely
  // claimable (config enabled AND attestation possible). Dormant on
  // sims/dev clients (attestation seam returns null) — never advertise
  // free conversations we can't mint (docs/CREDITS_DESIGN.md).
  const [creditsAvailable, setCreditsAvailable] = useState(false);
  // "Start free" claims the grant HERE, before leaving the step — otherwise a
  // later post-unlock claim failure (paused / rate-limited / already-claimed /
  // offline) leaves a user who was promised free AI with no usable provider and
  // no surface (review P2). On success we pin openrouter and continue; on
  // failure we keep them on this step to retry or BYOK.
  const [claimingCredits, setClaimingCredits] = useState(false);
  const [creditsError, setCreditsError] = useState<string | null>(null);

  const startFree = async (): Promise<void> => {
    setClaimingCredits(true);
    setCreditsError(null);
    try {
      // Single attempt (backoffMs [0]) keeps the tap snappy — retry is one more
      // tap. The post-unlock useCreditsClaim still runs, but on success here it
      // just short-circuits (already claimed).
      const status = await runClaimFlow(Platform.OS === 'android' ? 'android' : 'ios', {
        getDeviceCheckToken,
        getPlayIntegrityToken,
        backoffMs: [0],
      });
      if (status === 'claimed') {
        // Grant key is stored (a fresh grant OR one that survived a re-onboard
        // and was just re-adopted); pin openrouter so boot wires it as the live
        // provider (same precedence the providers screen uses; BYOK still wins).
        await saveActiveProvider('openrouter');
        onContinue();
        return;
      }
      if (status === 'terminal_refused') {
        // Once-per-device grant already spent AND no key survives locally —
        // retrying can never succeed, so don't invite it; point at BYOK.
        setCreditsError(
          'This device has already used its free credits. Pick a provider and add your own key below.',
        );
        return;
      }
      setCreditsError(
        'Free credits could not be activated right now. Tap Start free to try again, or pick a provider and add a key below.',
      );
    } catch {
      setCreditsError(
        'Free credits could not be activated right now. Tap Start free to try again, or add a key below.',
      );
    } finally {
      setClaimingCredits(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await getConfiguredProviders();
      if (cancelled) return;
      void (async () => {
        const platform = Platform.OS === 'android' ? 'android' : 'ios';
        // Android attests via Play Integrity; fall back to the DeviceCheck
        // seam so the dev fake-attest override still previews as available.
        const attest =
          platform === 'android'
            ? (await getPlayIntegrityToken()) ?? (await getDeviceCheckToken())
            : await getDeviceCheckToken();
        const cfg = await fetchCreditsConfig(platform);
        if (!cancelled) setCreditsAvailable(cfg.enabled && attest !== null);
      })();
      if (list.length > 0) {
        // Prefer the persisted active provider if it's in the configured set.
        const active = await loadActiveProvider();
        if (cancelled) return;
        setConfigured(active !== null && list.includes(active) ? active : list[0]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = keyInput.trim();

  const connectAndContinue = async (): Promise<void> => {
    if (selected === null) return;
    const fmt = validateKeyFormat(selected, trimmed);
    if (fmt !== null) {
      setError(fmt);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Live probe — a real API call. null = valid; string = why it failed.
      const probe = await verifyKey(selected, trimmed);
      if (probe !== null) {
        setError(probe);
        return;
      }
      await saveApiKey(selected, trimmed);
      await saveActiveProvider(selected);
      onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key.');
    } finally {
      setBusy(false);
    }
  };

  // Already configured → pin it active (so boot is deterministic) + continue.
  const continueWithConfigured = async (): Promise<void> => {
    if (configured === null) return;
    setBusy(true);
    try {
      await saveActiveProvider(configured);
      onContinue();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <OnboardingShell location={location} title="Connect your AI" onBack={onBack}>
        <View style={styles.center} testID="onboarding-ai-loading">
          <ActivityIndicator color={colors.accent} />
        </View>
      </OnboardingShell>
    );
  }

  // ── Already-configured state (returning user / dev key) ──────────────────
  if (configured !== null) {
    return (
      <OnboardingShell
        location={location}
        title="Connect your AI"
        subtitle="Dina runs on an AI model you bring. One is already connected on this device."
        primaryLabel="Continue"
        primaryBusy={busy}
        onPrimary={() => void continueWithConfigured()}
        onBack={onBack}
      >
        <View testID="onboarding-ai-connected" style={styles.connectedCard}>
          <Text style={styles.connectedTick}>✓</Text>
          <Text style={styles.connectedLabel}>{PROVIDERS[configured].label} connected</Text>
        </View>
        <Pressable
          testID="onboarding-ai-change"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            setConfigured(null);
            setSelected(null);
            setKeyInput('');
            setError(null);
          }}
          style={styles.changeRow}
        >
          <Text style={styles.changeText}>Use a different provider</Text>
        </Pressable>
      </OnboardingShell>
    );
  }

  // ── Pick a provider + paste a key (validated live) ───────────────────────
  return (
    <OnboardingShell
      location={location}
      title="Connect your AI"
      subtitle="Dina runs on an AI model you bring (your key stays on this device). Pick a provider and paste an API key."
      primaryLabel={busy ? 'Checking…' : 'Connect'}
      primaryBusy={busy}
      primaryDisabled={selected === null || trimmed === '' || busy}
      onPrimary={() => void connectAndContinue()}
      onBack={onBack}
    >
      {creditsAvailable ? (
        <View style={styles.creditsBeat} testID="onboarding-credits-beat">
          <Text style={styles.creditsTitle}>Your first conversations are free.</Text>
          <Text style={styles.creditsBody}>Just start talking to Dina.</Text>
          <Text style={styles.creditsSmall}>
            Starter conversations run directly through OpenRouter. Dina&apos;s servers never
            proxy or store them.
          </Text>
          <Pressable
            testID="onboarding-credits-start"
            accessibilityRole="button"
            onPress={() => void startFree()}
            disabled={claimingCredits}
            style={[styles.creditsButton, claimingCredits && styles.creditsButtonDisabled]}
          >
            {claimingCredits ? (
              <ActivityIndicator color={colors.bgPrimary} />
            ) : (
              <Text style={styles.creditsButtonText}>Start free</Text>
            )}
          </Pressable>
          {creditsError !== null ? (
            <Text testID="onboarding-credits-error" style={styles.creditsErrorText}>
              {creditsError}
            </Text>
          ) : null}
          <Text style={styles.creditsOr}>or bring your own key</Text>
        </View>
      ) : null}

      <ProviderPicker
        variant="compact"
        rows={PROVIDER_ORDER.map((type) => ({
          type,
          label: PROVIDERS[type].label,
          selected: selected === type,
          testID: `onboarding-ai-provider-${type}`,
          onPress: () => {
            setSelected(type);
            setError(null);
          },
          trailing: selected === type ? <Text style={styles.providerTick}>✓</Text> : undefined,
        }))}
      />

      {selected !== null ? (
        <TextInput
          testID="onboarding-ai-key-input"
          style={styles.keyInput}
          value={keyInput}
          onChangeText={(t) => {
            setKeyInput(t);
            setError(null);
          }}
          placeholder={`Paste your ${PROVIDERS[selected].label} API key`}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          secureTextEntry
        />
      ) : null}

      {error !== null ? (
        <Text testID="onboarding-ai-error" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  creditsBeat: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  creditsTitle: { ...textStyles.h3, color: colors.textPrimary },
  creditsBody: { ...textStyles.body, color: colors.textPrimary, marginTop: 6 },
  creditsSmall: { ...textStyles.caption, color: colors.textSecondary, marginTop: 8 },
  creditsButton: {
    backgroundColor: colors.textPrimary,
    borderRadius: 22,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  creditsButtonDisabled: { opacity: 0.6 },
  creditsButtonText: { ...textStyles.body, color: colors.bgPrimary, fontWeight: '600' },
  creditsErrorText: { ...textStyles.caption, color: colors.error, marginTop: 10, textAlign: 'center' },
  creditsOr: { ...textStyles.caption, color: colors.textSecondary, textAlign: 'center', marginTop: 12 },
  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  connectedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  connectedTick: { ...textStyles.bodyLargeStrong, color: colors.success },
  connectedLabel: { ...textStyles.bodyStrong, color: colors.textPrimary },
  changeRow: { paddingVertical: spacing.md, alignItems: 'center' },
  changeText: { ...textStyles.link, color: colors.textSecondary },
  providerTick: { ...textStyles.bodyLargeStrong, color: colors.accent },
  keyInput: {
    ...textStyles.body,
    marginTop: spacing.md,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    color: colors.textPrimary,
  },
  errorText: { ...textStyles.bodySmall, color: colors.error, marginTop: spacing.sm },
});
