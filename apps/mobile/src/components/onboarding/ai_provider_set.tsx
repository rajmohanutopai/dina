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
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  PROVIDERS,
  getConfiguredProviders,
  saveApiKey,
  validateKeyFormat,
  verifyKey,
  type ProviderType,
} from '../../ai/provider';
import { loadActiveProvider, saveActiveProvider } from '../../ai/active_provider';
import type { StepLocation } from '../../onboarding/state';
import { colors, radius, spacing, textStyles } from '../../theme';

import { OnboardingShell } from './shell';

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await getConfiguredProviders();
      if (cancelled) return;
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
      subtitle="Dina runs on an AI model you bring (your key stays on this device). Pick a provider and paste an API key. The app needs it to think."
      primaryLabel={busy ? 'Checking…' : 'Connect'}
      primaryBusy={busy}
      primaryDisabled={selected === null || trimmed === '' || busy}
      onPrimary={() => void connectAndContinue()}
      onBack={onBack}
    >
      <View style={styles.providerList}>
        {PROVIDER_ORDER.map((type) => {
          const isSel = selected === type;
          return (
            <Pressable
              key={type}
              testID={`onboarding-ai-provider-${type}`}
              accessibilityRole="button"
              accessibilityState={{ selected: isSel }}
              onPress={() => {
                setSelected(type);
                setError(null);
              }}
              style={[styles.providerRow, isSel && styles.providerRowSelected]}
            >
              <Text style={[styles.providerLabel, isSel && styles.providerLabelSelected]}>
                {PROVIDERS[type].label}
              </Text>
              {isSel ? <Text style={styles.providerTick}>✓</Text> : null}
            </Pressable>
          );
        })}
      </View>

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
  providerList: { gap: spacing.sm },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  providerRowSelected: { borderColor: colors.accent },
  providerLabel: { ...textStyles.bodyStrong, color: colors.textPrimary },
  providerLabelSelected: { color: colors.accent },
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
