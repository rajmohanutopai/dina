/**
 * Service Settings — configure this node's public service profile.
 *
 * Controls:
 *   - isDiscoverable toggle (whether the profile is published to AppView)
 *   - Display name + description
 *   - Per-capability response policy picker (auto / review)
 *
 * The screen is hidden from the tab bar (see _layout.tsx) and reached
 * via a drill-down row on the main Settings screen. Saving triggers
 * server-side validation + ServicePublisher.sync (re-publish or unpublish
 * depending on isDiscoverable).
 */

import React, { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Switch,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { colors, fonts, spacing, radius, shadows } from '../src/theme';
import {
  loadServiceConfig,
  saveServiceConfig,
  ServiceConfigNotConfiguredError,
  ServiceConfigValidationError,
} from '../src/hooks/useServiceConfigForm';
import { getBootDegradations } from '../src/hooks/useNodeBootstrap';
import { subscribeRuntimeWarnings, getRuntimeWarnings } from '../src/services/runtime_warnings';
import type { ServiceConfig } from '@dina/core/src/service/service_config';

/**
 * Degradation codes that mean "this screen overpromises."
 *
 * When ANY of these is active the screen shows a caveat instead of
 * claiming the toggle makes the node discoverable on AppView —
 * because without those dependencies wired, toggling on doesn't make
 * the node reachable in practice (findings #9, #11, #8).
 *
 *   publisher.stub             — PDS publisher not wired; no profile
 *                                is pushed to AppView
 *   transport.msgbox.missing   — no relay transport; no inbound path
 *   identity.did_key           — dev-only DID; not publishable
 *   execution.no_runner        — no runner to execute inbound queries,
 *                                so even a published profile can't
 *                                answer anything
 *   persistence.in_memory      — workflow state is volatile; inbound
 *                                queries and approvals don't survive
 *                                a restart
 *   transport.sendd2d.noop     — D2D sender is a no-op: service.response
 *                                envelopes go to /dev/null (review #8)
 *
 * Review #7: `discovery.no_appview` was removed from this set — it's
 * a requester-side issue (our lookups return empty), not a provider
 * one. A provider can still publish + serve without local AppView
 * search.
 */
const DISCOVERY_BLOCKERS: ReadonlySet<string> = new Set([
  'publisher.stub',
  'transport.msgbox.missing',
  'identity.did_key',
  'execution.no_runner',
  'persistence.in_memory',
  'transport.sendd2d.noop',
]);

type Policy = 'auto' | 'review';

export default function ServiceSettingsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isDiscoverable, setIsDiscoverable] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<Array<{ key: string; policy: Policy }>>([]);

  // Pull the boot-time degradations so the "make discoverable" toggle
  // can tell the truth: without a PDS publisher + MsgBox transport the
  // node is not actually reachable even when the switch is ON.
  // Issue #9.
  //
  // Review #9: also subscribe to the runtime warnings channel so a
  // later `publisher.sync_failed` (post-boot PDS outage, config-change
  // retry failure) surfaces here — not just in the top banner. Static
  // boot degradations + dynamic runtime warnings BOTH contribute to
  // "is this node actually discoverable right now?"
  const runtimeWarnings = useSyncExternalStore(
    subscribeRuntimeWarnings,
    getRuntimeWarnings,
    getRuntimeWarnings,
  );
  const bootBlockers = getBootDegradations()
    .filter((d) => DISCOVERY_BLOCKERS.has(d.code))
    .map((d) => d.code);
  const runtimeBlockers = runtimeWarnings
    .filter((w) => w.code === 'publisher.sync_failed')
    .map((w) => w.code);
  const activeBlockers = [...bootBlockers, ...runtimeBlockers];
  const discoveryBlocked = activeBlockers.length > 0;

  useEffect(() => {
    (async () => {
      try {
        const cfg = await loadServiceConfig();
        if (cfg !== null) hydrate(cfg);
      } catch (err) {
        if (err instanceof ServiceConfigNotConfiguredError) {
          setLoadError("Service config isn't wired yet — complete onboarding first.");
        } else {
          setLoadError((err as Error).message ?? 'Failed to load service config');
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function hydrate(cfg: ServiceConfig): void {
    setIsDiscoverable(cfg.isDiscoverable);
    setName(cfg.name);
    setDescription(cfg.description ?? '');
    setCapabilities(
      Object.entries(cfg.capabilities).map(([key, cap]) => ({
        key,
        policy: (cap.responsePolicy ?? 'auto') as Policy,
      })),
    );
  }

  const toggleCapabilityPolicy = useCallback((key: string) => {
    setCapabilities((list) =>
      list.map((c) =>
        c.key === key ? { ...c, policy: c.policy === 'auto' ? 'review' : 'auto' } : c,
      ),
    );
  }, []);

  const onSave = useCallback(async () => {
    if (name.trim() === '') {
      Alert.alert('Missing name', 'Give this node a display name before saving.');
      return;
    }
    // Review #19: don't allow saving a discoverable profile with no
    // capabilities — Core rejects it anyway, but catching it here
    // produces a clearer UI message than a wire error.
    if (isDiscoverable && capabilities.length === 0) {
      Alert.alert(
        'No capabilities',
        'A discoverable profile must advertise at least one capability. Add one first, or toggle "Make this node discoverable" off.',
      );
      return;
    }
    setSaving(true);
    try {
      const existing = await loadServiceConfig();
      // Review #11: start from the EXISTING capability map so any
      // cap not surfaced by this screen (added via CLI, different
      // UI, or a newer version of this screen) survives the save.
      // Previously we rebuilt from the screen-local `capabilities`
      // array alone and every unseen capability got silently dropped.
      const caps: ServiceConfig['capabilities'] =
        existing !== null ? { ...existing.capabilities } : {};
      // Overlay the policy changes from this screen on top. Unknown
      // caps added via this screen (future-ish) keep the same defaults
      // as before — mcpServer='transit' / mcpTool=<cap key>.
      for (const c of capabilities) {
        const prior = existing?.capabilities[c.key] ?? caps[c.key];
        caps[c.key] = {
          mcpServer: prior?.mcpServer ?? 'transit',
          mcpTool: prior?.mcpTool ?? c.key,
          responsePolicy: c.policy,
          ...(prior?.schemaHash !== undefined ? { schemaHash: prior.schemaHash } : {}),
        };
      }
      const next: ServiceConfig = {
        isDiscoverable,
        name: name.trim(),
        description: description.trim() !== '' ? description.trim() : undefined,
        capabilities: caps,
      };
      await saveServiceConfig(next);
      Alert.alert('Saved', 'Service config updated.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (err) {
      if (err instanceof ServiceConfigValidationError) {
        Alert.alert('Validation error', err.message);
      } else {
        Alert.alert('Error', (err as Error).message ?? 'Failed to save');
      }
    } finally {
      setSaving(false);
    }
  }, [name, description, isDiscoverable, capabilities, router]);

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Service Sharing' }} />
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Service Sharing' }} />
      {loadError !== null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>PUBLIC</Text>
          <View style={styles.card}>
            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text style={styles.rowTitle}>Make this node discoverable</Text>
                <Text style={styles.rowSubtitle}>
                  When on, your service profile is published to AppView so others on the network can
                  query you.
                </Text>
              </View>
              <Switch
                value={isDiscoverable}
                onValueChange={setIsDiscoverable}
                trackColor={{ false: colors.bgTertiary, true: colors.accent }}
                thumbColor={colors.white}
              />
            </View>
            {discoveryBlocked ? (
              <View style={styles.discoveryCaveat}>
                <Text style={styles.discoveryCaveatTitle}>Not actually discoverable yet.</Text>
                <Text style={styles.discoveryCaveatBody}>
                  Missing: {activeBlockers.join(', ')}.{'\n'}Flip this switch on once onboarding
                  wires PDS + MsgBox — until then the profile is saved locally but will not reach
                  AppView.
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>IDENTITY</Text>
          <View style={styles.card}>
            <View style={styles.inputRow}>
              <Text style={styles.label}>Display name</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="e.g. Bus 42"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                autoCapitalize="words"
              />
            </View>
            <View style={[styles.inputRow, styles.inputRowLast]}>
              <Text style={styles.label}>Description (optional)</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="e.g. SF Muni Bus 42 ETAs"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.multiline]}
                multiline
                numberOfLines={2}
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>CAPABILITIES</Text>
          <Text style={styles.sectionSubtitle}>
            Choose whether each capability runs automatically or waits for your approval.
          </Text>
          <View style={styles.card}>
            {capabilities.length === 0 ? (
              <Text style={styles.emptyText}>
                No capabilities configured yet. Add them via onboarding or CLI first.
              </Text>
            ) : (
              capabilities.map((cap, idx) => (
                <View
                  key={cap.key}
                  style={[
                    styles.capabilityRow,
                    idx === capabilities.length - 1 && styles.capabilityRowLast,
                  ]}
                >
                  <Text style={styles.capabilityName}>{cap.key}</Text>
                  <Pressable
                    onPress={() => toggleCapabilityPolicy(cap.key)}
                    style={({ pressed }) => [styles.policyToggle, pressed && styles.pressed]}
                  >
                    <View style={[styles.policyHalf, cap.policy === 'auto' && styles.policyActive]}>
                      <Text
                        style={[
                          styles.policyText,
                          cap.policy === 'auto' && styles.policyActiveText,
                        ]}
                      >
                        Auto
                      </Text>
                    </View>
                    <View
                      style={[styles.policyHalf, cap.policy === 'review' && styles.policyActive]}
                    >
                      <Text
                        style={[
                          styles.policyText,
                          cap.policy === 'review' && styles.policyActiveText,
                        ]}
                      >
                        Review
                      </Text>
                    </View>
                  </Pressable>
                </View>
              ))
            )}
          </View>
        </View>

        <Pressable
          onPress={onSave}
          disabled={saving}
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.pressed,
            saving && styles.disabled,
          ]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <Text style={styles.saveButtonText}>Save changes</Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  centered: { justifyContent: 'center', alignItems: 'center' },
  scrollContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionHeader: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    marginLeft: spacing.xs,
  },
  sectionSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
    lineHeight: 18,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  switchLabel: { flex: 1, marginRight: spacing.sm },
  rowTitle: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    color: colors.textPrimary,
    marginBottom: 2,
  },
  rowSubtitle: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  inputRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
  },
  inputRowLast: {
    borderBottomWidth: 0,
    paddingBottom: 0,
    marginBottom: 0,
  },
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  input: {
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: 4,
    minHeight: 28,
  },
  multiline: {
    minHeight: 48,
    textAlignVertical: 'top',
  },
  capabilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  capabilityRowLast: {
    borderBottomWidth: 0,
  },
  capabilityName: {
    fontFamily: fonts.monoMedium,
    fontSize: 15,
    color: colors.textPrimary,
  },
  policyToggle: {
    flexDirection: 'row',
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
    overflow: 'hidden',
  },
  policyHalf: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    minWidth: 68,
  },
  policyActive: {
    backgroundColor: colors.accent,
  },
  policyText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  policyActiveText: {
    fontFamily: fonts.sansSemibold,
    color: colors.white,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  saveButton: {
    marginTop: spacing.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    ...shadows.sm,
  },
  saveButtonText: {
    fontFamily: fonts.sansSemibold,
    color: colors.white,
    fontSize: 16,
    letterSpacing: 0.3,
  },
  emptyText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
  errorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  errorText: {
    fontFamily: fonts.sansMedium,
    color: colors.error,
    fontSize: 13,
    lineHeight: 18,
  },
  discoveryCaveat: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  discoveryCaveatTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.error,
    marginBottom: 4,
  },
  discoveryCaveatBody: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
});
