/**
 * Bottom-sheet picker for primary + lite model selection on a BYOK
 * provider. Mirrors `dina-admin model set` on the desktop but with
 * eager validation: every selection triggers an immediate
 * `generateText` probe so a mistyped or unavailable model id surfaces
 * before the user taps Save. Custom text input is debounced so
 * partial typing doesn't fire half a dozen API calls.
 *
 * Tiers:
 *   primary — chat + /ask reasoning (the model 99% of turns hit).
 *   lite    — classification, intent, guard scan (cheap small model).
 *
 * Heavy isn't surfaced — mobile only exercises it as a `primary`
 * fallback today; adding a third tier here just clutters the UI.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { generateText } from 'ai';

import { PROVIDERS, createModel } from '../ai/provider';
import { getModelDisplayName, getModelOptions } from '../ai/models_catalog';
import {
  peekModelOverride,
  setModelOverride,
  clearModelOverride,
} from '../ai/model_overrides';
import { swapAgenticActiveProvider } from '../ai/agentic_swap';
import { getProviderTiers } from '@dina/brain/llm';
import { colors, radius, shadows, spacing, textStyles } from '../theme';

import type { LLMTier, ProviderType } from '../ai/provider';

interface ModelPickerSheetProps {
  visible: boolean;
  provider: ProviderType;
  onClose: () => void;
}

type TryStatus =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

interface TierState {
  selected: string;
  usingCustom: boolean;
  customText: string;
  status: TryStatus;
}

const TIERS: LLMTier[] = ['primary', 'lite'];

const TIER_DESCRIPTION: Record<LLMTier, string> = {
  primary: 'chat + /ask reasoning',
  lite: 'classification + lightweight calls',
  heavy: 'multi-step / heavy reasoning',
};

const CUSTOM_DEBOUNCE_MS = 700;

function initialTierState(provider: ProviderType, tier: LLMTier): TierState {
  const def = getProviderTiers(provider)[tier];
  const override = peekModelOverride(provider, tier);
  const value = override ?? def;
  const catalogue = getModelOptions(provider);
  // If the active value isn't in the catalogue (e.g. OpenRouter's
  // `auto` meta-model, or a user-typed custom), open the picker in
  // custom mode with the value pre-filled — otherwise the radio
  // selection looks empty and the user has no visual cue that any
  // model is actually being used.
  const inCatalogue = catalogue.includes(value);
  return {
    selected: inCatalogue ? value : '',
    usingCustom: !inCatalogue,
    customText: inCatalogue ? '' : value,
    status: { kind: 'idle' },
  };
}

export function ModelPickerSheet({
  visible,
  provider,
  onClose,
}: ModelPickerSheetProps): React.JSX.Element {
  const catalogue = useMemo(() => getModelOptions(provider), [provider]);
  const tierDefaults = useMemo(() => getProviderTiers(provider), [provider]);

  const [tiers, setTiers] = useState<Record<LLMTier, TierState>>({
    primary: initialTierState(provider, 'primary'),
    lite: initialTierState(provider, 'lite'),
    heavy: initialTierState(provider, 'heavy'),
  });
  const [saving, setSaving] = useState(false);

  // Used by the debounced custom-text probe + by Sheet close to cancel
  // in-flight work. One token per tier.
  const probeTokenRef = useRef<Record<LLMTier, number>>({
    primary: 0,
    lite: 0,
    heavy: 0,
  });
  const customTimerRef = useRef<Record<LLMTier, NodeJS.Timeout | null>>({
    primary: null,
    lite: null,
    heavy: null,
  });

  function effectiveModel(tier: LLMTier): string {
    const t = tiers[tier];
    return t.usingCustom ? t.customText.trim() : t.selected;
  }

  // Reset state when the sheet opens for a fresh provider.
  useEffect(() => {
    if (!visible) return;
    setTiers({
      primary: initialTierState(provider, 'primary'),
      lite: initialTierState(provider, 'lite'),
      heavy: initialTierState(provider, 'heavy'),
    });
    // Kick off an eager probe for each tier's initial selection so
    // the user sees "looks good" / error before they touch anything.
    for (const tier of TIERS) {
      const init = initialTierState(provider, tier);
      const model = init.usingCustom ? init.customText.trim() : init.selected;
      if (model.length > 0) {
        void probe(tier, model);
      }
    }
    return () => {
      // Cancel any pending debounce on close.
      for (const tier of TIERS) {
        const timer = customTimerRef.current[tier];
        if (timer !== null) clearTimeout(timer);
        customTimerRef.current[tier] = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, provider]);

  /**
   * Probe a model for a tier. Aborts via a token if a newer probe
   * for the same tier starts before this one resolves (avoids a
   * stale response overwriting a fresh status).
   */
  async function probe(tier: LLMTier, model: string): Promise<void> {
    const myToken = probeTokenRef.current[tier] + 1;
    probeTokenRef.current[tier] = myToken;

    setTiers((prev) => ({
      ...prev,
      [tier]: { ...prev[tier], status: { kind: 'probing' } },
    }));

    try {
      const lm = await createModel(provider, { modelId: model });
      if (lm === null) {
        if (probeTokenRef.current[tier] !== myToken) return;
        setTiers((prev) => ({
          ...prev,
          [tier]: {
            ...prev[tier],
            status: {
              kind: 'error',
              message: 'No API key for this provider.',
            },
          },
        }));
        return;
      }
      const { text } = await generateText({
        model: lm,
        prompt: 'Reply with just the word OK.',
      });
      if (probeTokenRef.current[tier] !== myToken) return;
      if (text.trim().length === 0) {
        setTiers((prev) => ({
          ...prev,
          [tier]: {
            ...prev[tier],
            status: { kind: 'error', message: 'Model returned empty reply.' },
          },
        }));
        return;
      }
      setTiers((prev) => ({
        ...prev,
        [tier]: { ...prev[tier], status: { kind: 'ok' } },
      }));
    } catch (err) {
      if (probeTokenRef.current[tier] !== myToken) return;
      const msg = err instanceof Error ? err.message : String(err);
      setTiers((prev) => ({
        ...prev,
        [tier]: { ...prev[tier], status: { kind: 'error', message: msg } },
      }));
    }
  }

  function pickRadio(tier: LLMTier, modelId: string): void {
    setTiers((prev) => ({
      ...prev,
      [tier]: {
        ...prev[tier],
        usingCustom: false,
        selected: modelId,
        status: { kind: 'probing' },
      },
    }));
    void probe(tier, modelId);
  }

  function pickCustom(tier: LLMTier): void {
    setTiers((prev) => ({
      ...prev,
      [tier]: {
        ...prev[tier],
        usingCustom: true,
        // Don't probe yet — wait for the text. If the user already
        // typed something earlier in this session, kick a probe.
        status:
          prev[tier].customText.trim().length > 0
            ? { kind: 'probing' }
            : { kind: 'idle' },
      },
    }));
    const existing = tiers[tier].customText.trim();
    if (existing.length > 0) {
      void probe(tier, existing);
    }
  }

  function changeCustomText(tier: LLMTier, value: string): void {
    setTiers((prev) => ({
      ...prev,
      [tier]: { ...prev[tier], customText: value, status: { kind: 'idle' } },
    }));
    const timer = customTimerRef.current[tier];
    if (timer !== null) clearTimeout(timer);
    customTimerRef.current[tier] = setTimeout(() => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      void probe(tier, trimmed);
    }, CUSTOM_DEBOUNCE_MS);
  }

  const allValid =
    tiers.primary.status.kind === 'ok' &&
    tiers.lite.status.kind === 'ok';
  const anyProbing =
    tiers.primary.status.kind === 'probing' ||
    tiers.lite.status.kind === 'probing';
  const canSave = allValid && !saving && !anyProbing;

  async function save(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    try {
      for (const tier of TIERS) {
        const model = effectiveModel(tier);
        if (model.length === 0) continue;
        if (model === tierDefaults[tier]) {
          await clearModelOverride(provider, tier);
        } else {
          await setModelOverride(provider, tier, model);
        }
      }
      await swapAgenticActiveProvider(provider);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTiers((prev) => ({
        ...prev,
        primary: { ...prev.primary, status: { kind: 'error', message: msg } },
      }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        testID="model-picker-backdrop"
        accessibilityRole="button"
        accessibilityLabel="Dismiss model picker"
      />
      <View style={styles.sheet}>
        <Text style={styles.title}>
          Models · {PROVIDERS[provider].label}
        </Text>
        <Text style={styles.subtitle}>
          The models Dina uses on this provider. Each selection is
          tested live; an invalid model surfaces here.
        </Text>

        <ScrollView
          style={styles.options}
          contentContainerStyle={styles.optionsContent}
          keyboardShouldPersistTaps="handled"
        >
          {TIERS.map((tier) => {
            const state = tiers[tier];
            return (
              <View key={tier} style={styles.tierBlock}>
                <View style={styles.tierHeader}>
                  <Text style={styles.tierLabel}>
                    {tier.toUpperCase()}
                  </Text>
                  <Text style={styles.tierDescription}>
                    {TIER_DESCRIPTION[tier]}
                  </Text>
                </View>

                {catalogue.map((modelId) => {
                  const isPicked = !state.usingCustom && state.selected === modelId;
                  const isDefault = modelId === tierDefaults[tier];
                  return (
                    <TouchableOpacity
                      key={`${tier}:${modelId}`}
                      testID={`model-picker-option-${tier}-${modelId}`}
                      style={styles.row}
                      onPress={() => pickRadio(tier, modelId)}
                      accessibilityRole="radio"
                      accessibilityLabel={`${tier} ${modelId}`}
                      accessibilityState={{ selected: isPicked }}
                    >
                      <View
                        style={[styles.radio, isPicked && styles.radioPicked]}
                      />
                      <View style={styles.rowText}>
                        <Text style={styles.rowLabel}>
                          {getModelDisplayName(provider, modelId)}
                        </Text>
                        {isDefault ? (
                          <Text style={styles.rowDefault}>default</Text>
                        ) : null}
                      </View>
                      {isPicked ? (
                        <StatusIndicator status={state.status} />
                      ) : null}
                    </TouchableOpacity>
                  );
                })}

                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>custom</Text>
                  <View style={styles.dividerLine} />
                </View>

                <TouchableOpacity
                  testID={`model-picker-custom-${tier}`}
                  style={styles.row}
                  onPress={() => pickCustom(tier)}
                  accessibilityRole="radio"
                  accessibilityLabel={`${tier} custom`}
                  accessibilityState={{ selected: state.usingCustom }}
                >
                  <View
                    style={[
                      styles.radio,
                      state.usingCustom && styles.radioPicked,
                    ]}
                  />
                  <Text style={styles.rowLabel}>type a model id</Text>
                  {state.usingCustom ? (
                    <StatusIndicator status={state.status} />
                  ) : null}
                </TouchableOpacity>
                {state.usingCustom ? (
                  <TextInput
                    testID={`model-picker-custom-input-${tier}`}
                    style={styles.customInput}
                    value={state.customText}
                    onChangeText={(v) => changeCustomText(tier, v)}
                    placeholder={`e.g. ${tierDefaults[tier]}`}
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                ) : null}

                {state.status.kind === 'error' ? (
                  <Text style={styles.statusErrorText}>
                    {state.status.message}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </ScrollView>

        <View style={styles.actions}>
          <TouchableOpacity
            testID="model-picker-cancel"
            accessibilityRole="button"
            style={[styles.button, styles.cancelButton]}
            onPress={onClose}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="model-picker-save"
            accessibilityRole="button"
            style={[
              styles.button,
              styles.saveButton,
              !canSave && styles.saveDisabled,
            ]}
            onPress={save}
            disabled={!canSave}
            accessibilityLabel="Save model selection"
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={styles.saveText}>Save</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function StatusIndicator({
  status,
}: {
  status: TryStatus;
}): React.JSX.Element | null {
  if (status.kind === 'probing') {
    return <ActivityIndicator size="small" color={colors.textMuted} />;
  }
  if (status.kind === 'ok') {
    return <Text style={styles.statusOk}>✓</Text>;
  }
  if (status.kind === 'error') {
    return <Text style={styles.statusError}>✗</Text>;
  }
  return null;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl + spacing.md,
    maxHeight: '90%',
    ...shadows.lg,
  },
  title: {
    ...textStyles.h3,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  options: {
    maxHeight: 560,
  },
  optionsContent: {
    paddingBottom: spacing.md,
  },
  tierBlock: {
    marginBottom: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  tierHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  tierLabel: {
    ...textStyles.bodySmallStrong,
    color: colors.textPrimary,
  },
  tierDescription: {
    ...textStyles.caption,
    color: colors.textMuted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
  },
  radioPicked: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  rowText: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  rowLabel: {
    ...textStyles.body,
  },
  rowDefault: {
    ...textStyles.caption,
    color: colors.textMuted,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.xs,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.borderLight,
  },
  dividerText: {
    ...textStyles.caption,
    color: colors.textMuted,
  },
  customInput: {
    ...textStyles.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    color: colors.textPrimary,
  },
  statusOk: {
    ...textStyles.bodyStrong,
    color: colors.success,
  },
  statusError: {
    ...textStyles.bodyStrong,
    color: colors.error,
  },
  statusErrorText: {
    ...textStyles.caption,
    color: colors.error,
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: 'transparent',
  },
  cancelText: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  saveButton: {
    backgroundColor: colors.textPrimary,
  },
  saveDisabled: {
    opacity: 0.4,
  },
  saveText: {
    ...textStyles.bodyStrong,
    color: colors.white,
  },
});
