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
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing, radius, shadows, textStyles } from '../src/theme';
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
import {
  loadActiveProvider,
  saveActiveProvider,
  peekActiveProvider,
} from '../src/ai/active_provider';
import { wireBrainChatProvider } from '../src/ai/brain_wiring';
import { swapAgenticActiveProvider } from '../src/ai/agentic_swap';
import { ModelPickerSheet } from '../src/components/ModelPickerSheet';
import {
  loadModelOverrides,
  peekModelOverride,
} from '../src/ai/model_overrides';
import { getModelDisplayName } from '../src/ai/models_catalog';
import { getProviderTiers } from '@dina/brain/llm';

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

  const [providerStates, setProviderStates] = useState<
    Record<ProviderType, ProviderState>
  >({
    openai: { configured: false, keyPreview: null, loading: true },
    gemini: { configured: false, keyPreview: null, loading: true },
    claude: { configured: false, keyPreview: null, loading: true },
    openrouter: { configured: false, keyPreview: null, loading: true },
  });
  const [editingProvider, setEditingProvider] = useState<ProviderType | null>(
    null,
  );
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<ProviderType | null>(
    peekActiveProvider(),
  );
  const [modelSheetProvider, setModelSheetProvider] =
    useState<ProviderType | null>(null);
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

  const handleSelectActive = async (
    provider: ProviderType,
  ): Promise<void> => {
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
        <Text style={styles.sectionDesc}>
          Bring your own API key. Your key stays on this device.
        </Text>

        {/*
          Order: the ACTIVE provider floats to the top; the rest sort
          alphabetically by label so a user looking for a specific
          one always finds it in a stable position.
        */}
        {(() => {
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

          // The header is tappable ONLY for unconfigured providers
          // (to open the Add-key form). For configured providers it's
          // a static row — selection happens via the explicit "Use
          // this provider" button below. Without this guard, brushing
          // the provider name triggered a silent active-swap, which
          // surprised users who expected to inspect the tile.
          const headerOnPress = state.configured
            ? undefined
            : () => {
                setEditingProvider(isEditing ? null : type);
                setKeyInput('');
              };
          const HeaderTag = state.configured ? View : TouchableOpacity;
          const headerProps = state.configured
            ? { style: styles.providerHeader }
            : {
                style: styles.providerHeader,
                onPress: headerOnPress,
                activeOpacity: 0.7 as const,
              };

          return (
            <View key={type} style={styles.providerCard}>
              <HeaderTag {...headerProps}>
                <View style={styles.providerInfo}>
                  <View style={styles.providerNameRow}>
                    <Text style={styles.providerName}>{info.label}</Text>
                    {isActive && (
                      <View style={styles.activeBadge}>
                        <Text style={styles.activeBadgeText}>ACTIVE</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.providerDesc}>{info.description}</Text>
                </View>
                {state.loading ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : state.configured ? (
                  <Text style={styles.keyPreview}>{state.keyPreview}</Text>
                ) : (
                  <Text style={styles.addKey}>Add key</Text>
                )}
              </HeaderTag>

              {isEditing && !state.configured && (
                <View style={styles.keyForm}>
                  <TextInput
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
                      style={styles.cancelButton}
                      onPress={() => {
                        setEditingProvider(null);
                        setKeyInput('');
                      }}
                    >
                      <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.saveButton,
                        saving && styles.saveButtonDisabled,
                      ]}
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
              )}

              {state.configured && (
                <>
                  <TouchableOpacity
                    style={styles.modelRow}
                    onPress={() => setModelSheetProvider(type)}
                    accessibilityRole="button"
                    accessibilityLabel={`Configure models for ${info.label}`}
                  >
                    <Text style={styles.modelRowLabel}>Models</Text>
                    <View style={styles.modelRowRight}>
                      <Text style={styles.modelRowValue}>
                        {/* Use catalog display names so pseudo-ids
                            like `gpt-5.5+thinking` render as
                            "gpt-5.5 (thinking)" — the picker stores
                            the pseudo-id but the user shouldn't see
                            the `+thinking` plumbing. */}
                        {modelVersion >= 0
                          ? `${getModelDisplayName(
                              type,
                              peekModelOverride(type, 'primary') ??
                                getProviderTiers(type).primary,
                            )}\n${getModelDisplayName(
                              type,
                              peekModelOverride(type, 'lite') ??
                                getProviderTiers(type).lite,
                            )}`
                          : ''}
                      </Text>
                      <Text style={styles.modelRowChevron}>›</Text>
                    </View>
                  </TouchableOpacity>
                  <View style={styles.configuredActions}>
                    {!isActive && (
                      <TouchableOpacity
                        style={styles.useButton}
                        onPress={() => void handleSelectActive(type)}
                      >
                        <Text style={styles.useText}>Use this provider</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => handleRemoveKey(type)}
                    >
                      <Text style={styles.removeText}>Remove key</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          );
        })}
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
  providerCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    ...shadows.sm,
  },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  providerInfo: { flex: 1, marginRight: spacing.md },
  providerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  providerName: textStyles.bodyLargeStrong,
  providerDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
  },
  activeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  activeBadgeText: {
    ...textStyles.caption,
    color: colors.white,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  addKey: { ...textStyles.bodySmallStrong, color: colors.accent },
  keyPreview: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontFamily: 'Menlo',
  },
  keyForm: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  keyInput: {
    ...textStyles.body,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: 'Menlo',
    fontSize: 13,
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
