/**
 * Settings screen — BYOK provider configuration.
 *
 * Users select an AI provider (OpenAI / Gemini), enter their API key,
 * and it's stored securely in the device keychain.
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
import { useRouter } from 'expo-router';
import { colors, fonts, spacing, radius, shadows } from '../src/theme';
import {
  PROVIDERS,
  saveApiKey,
  getApiKey,
  removeApiKey,
  maskKey,
  validateKeyFormat,
  getConfiguredProviders,
} from '../src/ai/provider';
import {
  loadActiveProvider,
  saveActiveProvider,
  peekActiveProvider,
} from '../src/ai/active_provider';
import { wireBrainChatProvider } from '../src/ai/brain_wiring';
import { getBootedNode, getBootDegradations } from '../src/hooks/useNodeBootstrap';
import type { ProviderType } from '../src/ai/provider';

/**
 * Mirror of the provider-blocker set in `_layout.tsx`. Kept local to
 * avoid a circular import; out-of-sync entries are caught by the
 * review process rather than runtime. Reviews #7, #8, #17 — the
 * canonical list lives in `_layout.tsx`, keep these in sync.
 */
const PROVIDER_BLOCKERS: ReadonlySet<string> = new Set([
  'publisher.stub',
  'transport.msgbox.missing',
  'identity.did_key',
  'execution.no_runner',
  'persistence.in_memory',
  'transport.sendd2d.noop',
]);

interface ProviderState {
  configured: boolean;
  keyPreview: string | null;
  loading: boolean;
}

export default function SettingsScreen() {
  const router = useRouter();
  const [providerStates, setProviderStates] = useState<Record<ProviderType, ProviderState>>({
    openai: { configured: false, keyPreview: null, loading: true },
    gemini: { configured: false, keyPreview: null, loading: true },
  });
  const [editingProvider, setEditingProvider] = useState<ProviderType | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<ProviderType | null>(peekActiveProvider());

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

    // Durable-first: if the user has previously selected a provider
    // AND its API key is still configured, honour it. If the key is
    // gone (manual keychain reset, provider removed elsewhere), fall
    // through to re-select the first configured one — review #10.
    // Without this fallback, Settings would happily wire a provider
    // that has no usable credential, and the next /ask call would
    // blow up at the cloud boundary.
    const configured = await getConfiguredProviders();
    const persisted = await loadActiveProvider();
    if (persisted !== null && configured.includes(persisted)) {
      if (active !== persisted) setActive(persisted);
      await wireBrainChatProvider(persisted);
      return;
    }
    // Either nothing persisted OR the persisted provider's key is gone.
    // Clear the stale selection and re-pick from what's actually
    // configured right now.
    if (persisted !== null && !configured.includes(persisted)) {
      await saveActiveProvider(null);
    }
    if (configured.length > 0) {
      setActive(configured[0]);
      await saveActiveProvider(configured[0]);
      // Mirror into the live chat path so the Brain orchestrator
      // actually uses the provider for `/ask` + chat reasoning
      // (issue #2).
      await wireBrainChatProvider(configured[0]);
    } else {
      // No configured providers at all — clear any stale wiring.
      setActive(null);
      await wireBrainChatProvider(null);
    }
  }, [active]);

  useEffect(() => {
    loadStates();
  }, [loadStates]);

  const handleSaveKey = async (provider: ProviderType) => {
    const error = validateKeyFormat(provider, keyInput);
    if (error) {
      Alert.alert('Invalid Key', error);
      return;
    }

    setSaving(true);
    try {
      await saveApiKey(provider, keyInput.trim());
      await saveActiveProvider(provider);
      await wireBrainChatProvider(provider);
      setActive(provider);
      setKeyInput('');
      setEditingProvider(null);
      await loadStates();
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveKey = (provider: ProviderType) => {
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

  const handleSelectActive = async (provider: ProviderType) => {
    await saveActiveProvider(provider);
    await wireBrainChatProvider(provider);
    setActive(provider);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* LLM Providers */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AI PROVIDER</Text>
        <Text style={styles.sectionDesc}>
          Bring your own API key. Your key stays on this device.
        </Text>

        {(Object.keys(PROVIDERS) as ProviderType[]).map((type) => {
          const info = PROVIDERS[type];
          const state = providerStates[type];
          const isActive = active === type;
          const isEditing = editingProvider === type;

          return (
            <View key={type} style={styles.providerCard}>
              <TouchableOpacity
                style={styles.providerHeader}
                onPress={() => {
                  if (state.configured) {
                    handleSelectActive(type);
                  } else {
                    setEditingProvider(isEditing ? null : type);
                    setKeyInput('');
                  }
                }}
                activeOpacity={0.7}
              >
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
              </TouchableOpacity>

              {/* Key input form */}
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
                      style={[styles.saveButton, saving && styles.saveButtonDisabled]}
                      onPress={() => handleSaveKey(type)}
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

              {/* Configured — show remove option */}
              {state.configured && (
                <View style={styles.configuredActions}>
                  {!isActive && (
                    <TouchableOpacity
                      style={styles.useButton}
                      onPress={() => handleSelectActive(type)}
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
              )}
            </View>
          );
        })}
      </View>

      {/* Service sharing — drill-down to the service-settings screen.
          Hidden entirely when the node isn't running as a provider or
          is blocked from being one (review #17). Without this, the
          link opens a screen that can save state the runtime will
          never honour. */}
      {(() => {
        const node = getBootedNode();
        const runningAsProvider =
          node !== null && (node.role === 'provider' || node.role === 'both');
        const blocked = getBootDegradations().some((d) => PROVIDER_BLOCKERS.has(d.code));
        if (!runningAsProvider || blocked) return null;
        return (
          <SettingsSection title="SERVICE SHARING">
            <TouchableOpacity
              style={styles.row}
              onPress={() => router.push('/service-settings')}
              accessibilityRole="button"
              accessibilityLabel="Open Service Sharing settings"
            >
              <Text style={styles.rowLabel}>Configure service profile</Text>
              <Text style={styles.rowValue}>{'\u203A'}</Text>
            </TouchableOpacity>
          </SettingsSection>
        );
      })()}

      {/* Agents — admin surface for `dina-admin device pair`. Always
          visible: even a requester-only node may want to authorize a
          dina-agent install to run delegation tasks. Port of main-
          dina's device admin CLI into the mobile app. Renamed away
          from "Paired Devices" because first-time users read that
          as "another phone running Dina"; see paired-devices.tsx
          for the full rationale. */}
      <SettingsSection title="AGENTS">
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/paired-devices')}
          accessibilityRole="button"
          accessibilityLabel="Open Agents"
        >
          <Text style={styles.rowLabel}>Agents</Text>
          <Text style={styles.rowValue}>{'\u203A'}</Text>
        </TouchableOpacity>
      </SettingsSection>

      {/* Admin — the dina-admin mirror. Drill-down into identity,
          security, diagnostics, and the danger-zone wipe action. Kept
          under its own section so returning users can find it without
          scrolling past BYOK + service-sharing. */}
      <SettingsSection title="ADMIN">
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/admin')}
          accessibilityRole="button"
          accessibilityLabel="Open Admin"
        >
          <Text style={styles.rowLabel}>Admin</Text>
          <Text style={styles.rowValue}>{'\u203A'}</Text>
        </TouchableOpacity>
      </SettingsSection>

      {/* Security */}
      <SettingsSection title="SECURITY">
        <SettingsRow label="Encryption" value="AES-256-GCM" />
        <SettingsRow label="Key derivation" value="SLIP-0010 + HKDF" />
        <SettingsRow label="Key storage" value="Device Keychain" />
      </SettingsSection>

      {/* Stats — the legacy in-memory memory counter was removed; the
          real vault/staging count lives in Core and surfaces via the
          Vault tab once the Core-side "list items" endpoint is wired.
          Showing a misleading zero in the meantime is worse than
          showing nothing (issue #16). */}
      <SettingsSection title="DATA">
        <SettingsRow label="Storage" value="On device only" />
      </SettingsSection>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Dina v0.1.0</Text>
        <Text style={styles.footerSubtext}>Your data never leaves this device</Text>
      </View>
    </ScrollView>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  sectionDesc: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    marginLeft: spacing.xs,
    lineHeight: 18,
  },
  sectionCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.sm,
  },

  // Provider cards
  providerCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
    overflow: 'hidden',
    ...shadows.sm,
  },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    justifyContent: 'space-between',
  },
  providerInfo: { flex: 1, marginRight: spacing.md },
  providerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  providerName: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
  },
  providerDesc: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  activeBadge: {
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  activeBadgeText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 9,
    color: colors.white,
    letterSpacing: 0.5,
  },
  keyPreview: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
  },
  addKey: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.accent,
  },

  // Key form
  keyForm: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  keyInput: {
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 10,
  },
  cancelButton: { paddingHorizontal: 16, paddingVertical: 10 },
  cancelText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.textMuted,
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    color: colors.white,
  },

  // Configured actions
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
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.accent,
  },
  removeButton: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  removeText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.error,
  },

  // Settings rows
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    color: colors.textPrimary,
  },
  rowValue: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textMuted,
  },

  footer: { alignItems: 'center', marginTop: spacing.xl, paddingVertical: spacing.lg },
  footerText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  footerSubtext: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
});
