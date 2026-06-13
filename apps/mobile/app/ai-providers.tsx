/**
 * AI providers sub-page (Settings → Manage providers).
 *
 * Settings only shows the active provider's compact summary so the
 * top-level screen stays quiet; this page owns the full BYOK
 * surface — Add / Remove key, switch active, and per-provider model
 * picker. Each tile shows current state (configured, active, key
 * preview) so the user has a single place to see every BYOK at once.
 *
 * Tile order mirrors Settings: ACTIVE provider floats to the top,
 * the rest sort alphabetically. Stable across renders so the user's
 * mental index of the page doesn't shuffle when they switch active.
 */

import { useFocusEffect } from 'expo-router';
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getProviderTiers } from '@dina/brain/llm';

import {
  loadActiveProvider,
  saveActiveProvider,
  peekActiveProvider,
} from '../src/ai/active_provider';
import { swapAgenticActiveProvider } from '../src/ai/agentic_swap';
import { wireBrainChatProvider } from '../src/ai/brain_wiring';
import { loadModelOverrides, peekModelOverride } from '../src/ai/model_overrides';
import { getModelDisplayName } from '../src/ai/models_catalog';
import {
  PROVIDERS,
  saveApiKey,
  getApiKey,
  removeApiKey,
  maskKey,
  validateKeyFormat,
  verifyKey,
  getConfiguredProviders,
} from '../src/ai/provider';
import { CreditsTile } from '../src/components/CreditsTile';
import { KeyHealthPill } from '../src/components/key_health_pill';
import { ModelPickerSheet } from '../src/components/ModelPickerSheet';
import { ProviderPicker } from '../src/components/ProviderPicker';
import { colors, spacing, radius, textStyles } from '../src/theme';

import type { ProviderType } from '../src/ai/provider';

interface ProviderState {
  configured: boolean;
  keyPreview: string | null;
  loading: boolean;
}

export default function AIProvidersScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  // Tab bar is 88pt on iOS as defined in _layout.tsx. This screen
  // renders on top of the tab navigator so the ScrollView needs the
  // extra padding to keep the last tile clear.
  const bottomPad = insets.bottom + 49 + spacing.md;

  const [providerStates, setProviderStates] = useState<Record<ProviderType, ProviderState>>({
    openai: { configured: false, keyPreview: null, loading: true },
    gemini: { configured: false, keyPreview: null, loading: true },
    claude: { configured: false, keyPreview: null, loading: true },
    openrouter: { configured: false, keyPreview: null, loading: true },
  });
  const [editingProvider, setEditingProvider] = useState<ProviderType | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<ProviderType | null>(peekActiveProvider());
  const [modelSheetProvider, setModelSheetProvider] = useState<ProviderType | null>(null);
  // Bumped after the model picker closes so the inline preview reads
  // the new override without a navigation/focus event.
  const [modelVersion, setModelVersion] = useState(0);

  // Hydrate overrides for the inline preview text. Boot already does
  // this on a fresh app launch, but the user might land here before
  // the agentic boot has finished or might land directly via deep
  // link, so we re-run on every screen mount. `loadModelOverrides` is
  // idempotent.
  useEffect(() => {
    void loadModelOverrides().then(() => setModelVersion((v) => v + 1));
  }, []);

  const loadStates = useCallback(async () => {
    const states: Record<string, ProviderState> = {};
    for (const type of Object.keys(PROVIDERS) as ProviderType[]) {
      const key = await getApiKey(type);
      states[type] = {
        configured: !!key,
        keyPreview: key ? maskKey(key) : null,
        loading: false,
      };
    }
    setProviderStates(states as Record<ProviderType, ProviderState>);

    // Durable-first: honour the persisted active provider when its
    // key still exists; otherwise fall through to the first-configured
    // one. Same logic Settings used to run on focus.
    const configured = await getConfiguredProviders();
    const persisted = await loadActiveProvider();
    if (persisted !== null && configured.includes(persisted)) {
      if (active !== persisted) setActive(persisted);
      await wireBrainChatProvider(persisted);
      return;
    }
    if (persisted !== null && !configured.includes(persisted)) {
      await saveActiveProvider(null);
    }
    if (configured.length > 0) {
      setActive(configured[0]);
      await saveActiveProvider(configured[0]);
      await wireBrainChatProvider(configured[0]);
    } else {
      setActive(null);
      await wireBrainChatProvider(null);
    }
  }, [active]);

  useFocusEffect(
    useCallback(() => {
      void loadStates();
    }, [loadStates]),
  );

  const handleSaveKey = async (provider: ProviderType): Promise<void> => {
    const formatError = validateKeyFormat(provider, keyInput);
    if (formatError) {
      Alert.alert('Invalid Key', formatError);
      return;
    }
    setSaving(true);
    try {
      const probeError = await verifyKey(provider, keyInput.trim());
      if (probeError !== null) {
        Alert.alert("Key didn't work", probeError);
        return;
      }
      await saveApiKey(provider, keyInput.trim());
      await saveActiveProvider(provider);
      await wireBrainChatProvider(provider);
      await swapAgenticActiveProvider(provider);
      setActive(provider);
      setKeyInput('');
      setEditingProvider(null);
      await loadStates();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save key';
      Alert.alert('Error', msg);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveKey = (provider: ProviderType): void => {
    Alert.alert(
      'Remove API Key',
      `Remove your ${PROVIDERS[provider].label} key? You can add it again later.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await removeApiKey(provider);
            if (active === provider) {
              await saveActiveProvider(null);
              await wireBrainChatProvider(null);
              setActive(null);
            }
            await loadStates();
          },
        },
      ],
    );
  };

  const handleSelectActive = async (provider: ProviderType): Promise<void> => {
    await saveActiveProvider(provider);
    await wireBrainChatProvider(provider);
    await swapAgenticActiveProvider(provider);
    setActive(provider);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
    >
      <View style={styles.section}>
        {/* Starter Credits tile — present only while the grant is the
            live OpenRouter source (BYOK wins; tile yields then). */}
        <CreditsTile />

        <Text style={styles.sectionDesc}>
          Bring your own API key. Your key stays on this device.
        </Text>

        {/*
          Order: the ACTIVE provider floats to the top; the rest sort
          alphabetically by label so a user looking for a specific
          one always finds it in a stable position.
        */}
        <ProviderPicker
          variant="card"
          rows={(() => {
            const all = Object.keys(PROVIDERS) as ProviderType[];
            return [...all].sort((a, b) => {
              if (a === active) return -1;
              if (b === active) return 1;
              return PROVIDERS[a].label.localeCompare(PROVIDERS[b].label);
            });
          })().map((type) => {
            const info = PROVIDERS[type];
            const state = providerStates[type];
            const isActive = active === type;
            const isEditing = editingProvider === type;

            return {
              type,
              label: info.label,
              // ACTIVE only when this provider has its OWN configured key. When a
              // grant is the source, active==='openrouter' but it's unconfigured —
              // the "Dina Starter Credits" tile is the sole ACTIVE indicator then,
              // so the openrouter row must not also claim ACTIVE (avoids the
              // confusing double-ACTIVE).
              badge: isActive && state.configured ? 'ACTIVE' : undefined,
              subtitle: (
                <>
                  <Text style={styles.providerDesc}>{info.description}</Text>
                  {/* Probe only the ACTIVE configured key (cost discipline —
                      a probe burns ~1 token when healthy). Problem-only pill:
                      credits exhausted / key not working. */}
                  {isActive && state.configured ? <KeyHealthPill provider={type} /> : null}
                </>
              ),
              trailing: state.loading ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : state.configured ? (
                <Text style={styles.keyPreview}>{state.keyPreview}</Text>
              ) : (
                <Text style={styles.addKey}>Add key</Text>
              ),
              // Header tappable ONLY for unconfigured providers (opens the
              // Add-key form). Configured rows are static; active-swap is the
              // explicit "Use this provider" button below — without this
              // guard, brushing the name triggered a silent active-swap.
              onPress: state.configured
                ? undefined
                : () => {
                    setEditingProvider(isEditing ? null : type);
                    setKeyInput('');
                  },
              testID: state.configured ? undefined : `ai-providers-add-key-${type}`,
              expanded: (
                <>
                  {isEditing && !state.configured ? (
                    <View style={styles.keyForm}>
                      <TextInput
                        testID={`ai-providers-key-input-${type}`}
                        style={styles.keyInput}
                        value={keyInput}
                        onChangeText={setKeyInput}
                        placeholder={`Paste your ${info.label} API key`}
                        placeholderTextColor={colors.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                      />
                      <View style={styles.keyActions}>
                        <TouchableOpacity
                          testID={`ai-providers-cancel-${type}`}
                          accessibilityRole="button"
                          style={styles.cancelButton}
                          onPress={() => {
                            setEditingProvider(null);
                            setKeyInput('');
                          }}
                        >
                          <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          testID={`ai-providers-save-${type}`}
                          accessibilityRole="button"
                          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
                          onPress={() => void handleSaveKey(type)}
                          disabled={saving || !keyInput.trim()}
                        >
                          {saving ? (
                            <ActivityIndicator size="small" color={colors.white} />
                          ) : (
                            <Text style={styles.saveText}>Save</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : null}

                  {state.configured ? (
                    <>
                      <TouchableOpacity
                        testID={`ai-providers-models-${type}`}
                        style={styles.modelRow}
                        onPress={() => setModelSheetProvider(type)}
                        accessibilityRole="button"
                        accessibilityLabel={`Configure models for ${info.label}`}
                      >
                        <Text style={styles.modelRowLabel}>Models</Text>
                        <View style={styles.modelRowRight}>
                          <Text style={styles.modelRowValue}>
                            {/* Catalog display names so pseudo-ids like
                                `gpt-5.5+thinking` render as "gpt-5.5
                                (thinking)" — the picker stores the pseudo-id
                                but the user shouldn't see the plumbing. */}
                            {modelVersion >= 0
                              ? `${getModelDisplayName(
                                  type,
                                  peekModelOverride(type, 'primary') ?? getProviderTiers(type).primary,
                                )}\n${getModelDisplayName(
                                  type,
                                  peekModelOverride(type, 'lite') ?? getProviderTiers(type).lite,
                                )}`
                              : ''}
                          </Text>
                          <Text style={styles.modelRowChevron}>›</Text>
                        </View>
                      </TouchableOpacity>
                      <View style={styles.configuredActions}>
                        {!isActive ? (
                          <TouchableOpacity
                            testID={`ai-providers-use-${type}`}
                            accessibilityRole="button"
                            style={styles.useButton}
                            onPress={() => void handleSelectActive(type)}
                          >
                            <Text style={styles.useText}>Use this provider</Text>
                          </TouchableOpacity>
                        ) : null}
                        <TouchableOpacity
                          testID={`ai-providers-remove-${type}`}
                          accessibilityRole="button"
                          style={styles.removeButton}
                          onPress={() => handleRemoveKey(type)}
                        >
                          <Text style={styles.removeText}>Remove key</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : null}
                </>
              ),
            };
          })}
        />
      </View>

      {modelSheetProvider !== null && (
        <ModelPickerSheet
          visible={modelSheetProvider !== null}
          provider={modelSheetProvider}
          onClose={() => {
            setModelSheetProvider(null);
            setModelVersion((v) => v + 1);
          }}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md },
  section: { marginBottom: spacing.lg },
  sectionDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  providerDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  addKey: { ...textStyles.bodySmallStrong, color: colors.accent },
  keyPreview: {
    ...textStyles.mono,
    color: colors.textMuted,
  },
  keyForm: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  keyInput: {
    ...textStyles.mono,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  keyActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm,
    gap: 8,
  },
  cancelButton: { paddingHorizontal: 20, paddingVertical: 10 },
  cancelText: { ...textStyles.bodySmall, color: colors.textSecondary },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveText: textStyles.buttonSmall,

  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modelRowLabel: {
    ...textStyles.bodySmallStrong,
    color: colors.textPrimary,
  },
  modelRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  modelRowValue: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    textAlign: 'right',
    flexShrink: 1,
  },
  modelRowChevron: {
    ...textStyles.body,
    color: colors.textMuted,
  },

  configuredActions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  useButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  useText: {
    ...textStyles.bodySmallStrong,
    color: colors.accent,
  },
  removeButton: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  removeText: {
    ...textStyles.bodySmallStrong,
    color: colors.error,
  },
});
