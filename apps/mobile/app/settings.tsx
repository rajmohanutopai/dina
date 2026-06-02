/**
 * Settings screen — BYOK provider configuration.
 *
 * Users select an AI provider (OpenAI / Gemini / Claude / OpenRouter),
 * enter their API key, and it's stored securely in the device keychain.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadVerificationStatus } from '../src/services/verification_status';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';
import {
  PROVIDERS,
  getApiKey,
  maskKey,
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
import {
  getBackgroundTimeout,
  setBackgroundTimeout,
} from '@dina/core';
import { saveBackgroundTimeoutPreference } from '../src/services/security_preferences';

/**
 * Degradation codes that mean "this node cannot serve provider-role
 * traffic yet" — gate the Service Sharing row's "saved locally but not
 * discoverable" warning (spec 5.5). This is the sole definition now that
 * the bottom-bar Approvals tab (the other former consumer) is hidden
 * unconditionally and its provider-readiness gate was retired from
 * `_layout.tsx`. Reviews #7, #8, #17.
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
  const insets = useSafeAreaInsets();
  // Tab bar is 88pt on iOS (49 visual + ~34 safe area + 5 padding) as
  // defined in _layout.tsx. Settings is rendered on top of the tab
  // navigator so the ScrollView must add this height explicitly.
  const bottomPad = insets.bottom + 49 + spacing.md;
  const [providerStates, setProviderStates] = useState<Record<ProviderType, ProviderState>>({
    openai: { configured: false, keyPreview: null, loading: true },
    gemini: { configured: false, keyPreview: null, loading: true },
    claude: { configured: false, keyPreview: null, loading: true },
    openrouter: { configured: false, keyPreview: null, loading: true },
  });
  const [active, setActive] = useState<ProviderType | null>(peekActiveProvider());
  // Refreshed on focus so the row disappears as soon as the user
  // completes the deferred Confirm flow and navigates back.
  const [verificationPending, setVerificationPending] = useState(false);

  // Auto-lock background timeout (MT-40-I1). Lives in core's
  // `sleep_wake.ts` module-level state; the Settings row mirrors it
  // here for display + lets the user pick from the same preset list
  // the security hook publishes. Re-read on focus so external changes
  // (admin reset, future imperative APIs) refresh the label.
  const [autoLockSeconds, setAutoLockSeconds] = useState<number>(() => {
    try {
      return getBackgroundTimeout();
    } catch {
      return 300;
    }
  });
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void loadVerificationStatus().then((status) => {
        if (!cancelled) setVerificationPending(status === 'pending');
      });
      // Refresh the active provider + key states whenever Settings
      // comes back into focus — without this, a switch made in
      // `/ai-providers` (Use this provider / Add key / Remove key)
      // doesn't propagate to the compact card here. `loadStates` is
      // idempotent: it just re-reads the keychain + active-provider
      // pointer and updates local state if changed.
      void loadStates();
      return () => {
        cancelled = true;
      };
      // loadStates depends on `active`, which is the very thing we
      // want to discover on focus — re-running on every active change
      // would also reload on internal sets. Disable the lint rule
      // here intentionally.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

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

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
      {/* LLM Providers — quiet summary. The full add/remove/switch
          surface lives in /ai-providers; Settings only shows the
          active provider + its model picks so the top-level screen
          stays uncluttered. */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AI PROVIDER</Text>

        {active !== null && providerStates[active].configured ? (
          <View style={styles.providerCard}>
            <View style={styles.providerHeader}>
              <View style={styles.providerInfo}>
                <View style={styles.providerNameRow}>
                  <Text style={styles.providerName}>{PROVIDERS[active].label}</Text>
                  <View style={styles.activeBadge}>
                    <Text style={styles.activeBadgeText}>ACTIVE</Text>
                  </View>
                </View>
                <Text style={styles.providerDesc}>{PROVIDERS[active].description}</Text>
              </View>
              <Text style={styles.keyPreview}>{providerStates[active].keyPreview}</Text>
            </View>
            {/* The per-tier model picks render on the /ai-providers
                tile and would duplicate noise here — Settings stays
                a one-glance "who's the active brain right now" view
                with a single drill-down to the full surface. */}
            <TouchableOpacity
              style={styles.modelRow}
              onPress={() => router.push('/ai-providers')}
              accessibilityRole="button"
              accessibilityLabel="Manage AI providers"
              testID="settings-row-manage-providers"
            >
              <Text style={styles.modelRowLabel}>Manage AI providers</Text>
              <Text style={styles.modelRowChevron}>›</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.providerCard}
            onPress={() => router.push('/ai-providers')}
            accessibilityRole="button"
            accessibilityLabel="Add an AI provider"
          >
            <View style={styles.providerHeader}>
              <Text style={styles.providerName}>Add an AI provider</Text>
              <Text style={styles.modelRowChevron}>›</Text>
            </View>
          </TouchableOpacity>
        )}

      </View>


      {/* MORE — drill-downs that don't earn their own section.
          PeerLens preferences was a dedicated PEERLENS section with
          6 inline rows; collapsed to a single drill-down so it
          folds in here. `Become a service` lived in its own SERVICE
          SHARING section with one row; same reasoning, also folded
          here. Agents is the admin surface for `dina-admin device
          pair`; Admin is the on-device port of dina-admin. */}
      <SettingsSection title="MORE">
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/peerlens-preferences')}
          accessibilityRole="button"
          accessibilityLabel="Open PeerLens preferences"
          testID="settings-row-peerlens-preferences"
        >
          <Text style={styles.rowLabel}>PeerLens preferences</Text>
          <Text style={styles.rowValue}>{'›'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/infrastructure')}
          accessibilityRole="button"
          accessibilityLabel="Open Infrastructure settings"
          testID="settings-row-infrastructure"
        >
          <Text style={styles.rowLabel}>Infrastructure</Text>
          <Text style={styles.rowValue}>{'\u203A'}</Text>
        </TouchableOpacity>
        {/* Service sharing row → /my-listings (the provider home: node role +
            every listing). The label adapts to whether the node is already
            running as a provider; a non-provider node taps through to set its
            role + publish its first listing. */}
        {(() => {
          const node = getBootedNode();
          const runningAsProvider =
            node !== null && (node.role === 'provider' || node.role === 'both');
          const blocked = getBootDegradations().some((d) =>
            PROVIDER_BLOCKERS.has(d.code),
          );
          const blockedLabel = blocked ? ' (blocked)' : '';
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => router.push('/my-listings')}
              accessibilityRole="button"
              accessibilityLabel="Open My Services"
              testID="settings-row-service-sharing"
            >
              <Text style={styles.rowLabel}>
                {runningAsProvider ? 'Configure service profile' : 'Become a service provider'}
                {blockedLabel}
              </Text>
              <Text style={styles.rowValue}>{'›'}</Text>
            </TouchableOpacity>
          );
        })()}
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/paired-devices')}
          accessibilityRole="button"
          accessibilityLabel="Open Agents"
          testID="settings-row-agents"
        >
          <Text style={styles.rowLabel}>Agents</Text>
          <Text style={styles.rowValue}>{'\u203A'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/admin')}
          accessibilityRole="button"
          accessibilityLabel="Open Admin"
          testID="settings-row-admin"
        >
          <Text style={styles.rowLabel}>Admin</Text>
          <Text style={styles.rowValue}>{'\u203A'}</Text>
        </TouchableOpacity>
      </SettingsSection>

      {/* Security + storage. The old DATA section was a single row
          ("Storage: On device only") under its own header; folded
          here so the user sees one tidy block of "what protects
          your data". */}
      <SettingsSection title="SECURITY">
        {/* "Confirm recovery phrase" — only renders while the user
            has the in-onboarding "Quick check" deferred (status =
            'pending'). Pinned to the top of SECURITY so it's the
            first thing they see when they come here looking for it. */}
        {verificationPending ? (
          <TouchableOpacity
            style={styles.row}
            onPress={() => router.push('/confirm-recovery-phrase')}
            accessibilityRole="button"
            accessibilityLabel="Confirm recovery phrase"
            testID="settings-row-confirm-recovery-phrase"
          >
            <Text style={styles.rowLabel}>Confirm recovery phrase</Text>
            <Text style={styles.rowValuePending}>Pending {'›'}</Text>
          </TouchableOpacity>
        ) : null}
        {/* "View recovery phrase" is the only other ACTIONABLE row in
            this section; rest are read-only crypto labels. */}
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push('/recovery-phrase')}
          accessibilityRole="button"
          accessibilityLabel="View recovery phrase"
          testID="settings-row-recovery-phrase"
        >
          <Text style={styles.rowLabel}>View recovery phrase</Text>
          <Text style={styles.rowValue}>{'›'}</Text>
        </TouchableOpacity>
        {/* MT-40-I1: pick how long the app waits in the background
            before sealing the vault. The auto-lock listener
            (`useAutoLock`) reads `getBackgroundTimeout()` afresh on
            every transition, so a change here takes effect on the
            next foreground→background. Default is 5 minutes. */}
        <TouchableOpacity
          style={styles.row}
          onPress={() => {
            const presets: ReadonlyArray<{ s: number; label: string }> = [
              { s: 60, label: '1 minute' },
              { s: 300, label: '5 minutes' },
              { s: 600, label: '10 minutes' },
              { s: 1800, label: '30 minutes' },
              { s: 3600, label: '1 hour' },
            ];
            Alert.alert(
              'Auto-lock when backgrounded',
              'Seal the vault after this much time in the background. The app prompts for your passphrase the next time you bring it foreground.',
              [
                ...presets.map((p) => ({
                  text: p.label + (p.s === autoLockSeconds ? '  ✓' : ''),
                  onPress: () => {
                    try {
                      setBackgroundTimeout(p.s);
                      setAutoLockSeconds(p.s);
                      // MT-40-I3 — write through to durable storage so
                      // the choice survives a cold launch. Fire-and-
                      // forget; the in-memory `setBackgroundTimeout`
                      // call above already armed the new value for the
                      // current session.
                      void saveBackgroundTimeoutPreference(p.s).catch(
                        (err) => {
                          console.warn(
                            '[settings] saveBackgroundTimeoutPreference failed',
                            err,
                          );
                        },
                      );
                    } catch (err) {
                      Alert.alert(
                        'Could not change timeout',
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  },
                })),
                { text: 'Cancel', style: 'cancel' },
              ],
              { cancelable: true },
            );
          }}
          accessibilityRole="button"
          accessibilityLabel="Auto-lock timeout"
          testID="settings-row-autolock"
        >
          <Text style={styles.rowLabel}>Auto-lock when backgrounded</Text>
          <Text style={styles.rowValue}>{formatTimeoutLabel(autoLockSeconds)} {'›'}</Text>
        </TouchableOpacity>
        <SettingsRow label="Vault encryption" value="AES-256-CBC" />
        <SettingsRow label="Seed wrap" value="AES-256-GCM" />
        <SettingsRow label="Key derivation" value="SLIP-0010 + HKDF" />
        <SettingsRow label="Key storage" value="Device Keychain" />
        <SettingsRow label="Storage" value="On device only" />
      </SettingsSection>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Dina v0.1.0</Text>
        <Text style={styles.footerSubtext}>Vault contents are encrypted and stay on this device</Text>
      </View>
    </ScrollView>
  );
}

/**
 * Pretty-print the auto-lock timeout for the Settings row's right-side
 * value. The presets are 60s/300s/600s/1800s/3600s; non-preset values
 * (set via direct API call) fall through to a generic "Ns" rendering
 * so the row never goes blank.
 */
function formatTimeoutLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds === 60) return '1 minute';
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} minutes`;
  }
  return `${seconds}s`;
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
  },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    ...textStyles.eyebrow,
    letterSpacing: 1.5,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  sectionDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    marginLeft: spacing.xs,
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
  providerName: textStyles.bodyLargeStrong,
  providerDesc: {
    ...textStyles.bodySmall,
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
    ...textStyles.eyebrow,
    color: colors.white,
    letterSpacing: 0.5,
  },
  keyPreview: textStyles.monoSmall,
  addKey: {
    ...textStyles.link,
    color: colors.accent,
  },

  // Key form
  keyForm: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  keyInput: {
    ...textStyles.mono,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
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
    ...textStyles.link,
    color: colors.textMuted,
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveText: textStyles.buttonSmall,

  // Model picker row (sits above configuredActions on configured providers)
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
    ...textStyles.bodySmallStrong,
    color: colors.accent,
  },
  removeButton: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  removeText: {
    ...textStyles.bodySmallStrong,
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
  rowLabel: textStyles.body,
  rowValue: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
  },
  rowValuePending: {
    ...textStyles.bodySmallStrong,
    color: colors.warning,
  },

  footer: { alignItems: 'center', marginTop: spacing.xl, paddingVertical: spacing.lg },
  footerText: {
    ...textStyles.bodySmallStrong,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  footerSubtext: {
    ...textStyles.caption,
    marginTop: spacing.xs,
  },
});
