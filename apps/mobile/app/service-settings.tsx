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

import React, { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
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
  Modal,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';
import {
  loadServiceConfig,
  saveServiceConfig,
  ServiceConfigNotConfiguredError,
  ServiceConfigValidationError,
} from '../src/hooks/useServiceConfigForm';
import { getBootDegradations, getBootedNode } from '../src/hooks/useNodeBootstrap';
import { subscribeRuntimeWarnings, getRuntimeWarnings } from '../src/services/runtime_warnings';
import { saveRolePreference } from '../src/services/role_preference';
import {
  loadInfraPreferences,
  savePdsUrl,
  savePdsHandle,
  savePdsPassword,
  savePdsEmail,
  saveAppViewURL,
  saveServicesAppViewURL,
} from '../src/services/infra_preferences';
import type { NodeRole } from '../src/services/bootstrap';
import type { ServiceConfig } from '@dina/core';
// Local capability registry — every capability the brain knows how to
// validate (paramsSchema, resultSchema, hash, default TTL). Surfacing
// these in the Add-Capability picker means a user adding `eta_query`
// from the UI gets the canonical schema attached automatically; no
// hand-typing a JSON Schema. Capabilities NOT in this registry can
// still be added via the free-text path, but they won't ship a
// `capabilitySchemas` entry — provider-side request validation will
// be skipped for them. The list mirrors what AppView accepts across
// the network; new capabilities are added to
// `packages/brain/src/service/capabilities/registry.ts` first.
import {
  listCapabilities as listLocalCapabilities,
  computeSchemaHash,
  type CapabilityDef,
} from '@dina/brain';

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
  // Add-Capability modal. When open, the user picks a known capability
  // from the local registry (canonical schemas attached automatically)
  // OR types a custom key (schemas skipped — provider-side validation
  // will be lenient until they're registered in the brain registry).
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [customCapName, setCustomCapName] = useState('');
  // Local snapshot of the brain registry's known capabilities. Frozen
  // at mount — the registry is module-scope so it can't change at
  // runtime. Filtered to capabilities NOT already configured so the
  // picker doesn't show duplicates.
  const localKnownCapabilities = useMemo(() => listLocalCapabilities(), []);
  const bootedNode = getBootedNode();
  const [role, setRole] = useState<NodeRole>(
    bootedNode !== null ? (bootedNode.role as NodeRole) : 'requester',
  );

  // Infra URLs (PDS / AppView). Loaded from preferences once per mount;
  // saved field-by-field on blur via the corresponding setters below.
  const [pdsUrl, setPdsUrlState] = useState('');
  const [pdsHandle, setPdsHandleState] = useState('');
  const [pdsPassword, setPdsPasswordState] = useState('');
  const [pdsEmail, setPdsEmailState] = useState('');
  const [appViewURLState, setAppViewURLState] = useState('');
  const [servicesAppViewURLState, setServicesAppViewURLState] = useState('');

  useEffect(() => {
    (async () => {
      const infra = await loadInfraPreferences();
      setPdsUrlState(infra.pdsUrl ?? '');
      setPdsHandleState(infra.pdsHandle ?? '');
      setPdsPasswordState(infra.pdsPassword ?? '');
      setPdsEmailState(infra.pdsEmail ?? '');
      setAppViewURLState(infra.appViewURL ?? '');
      setServicesAppViewURLState(infra.servicesAppViewURL ?? '');
    })();
  }, []);

  const onChangeRole = useCallback(async (next: NodeRole) => {
    setRole(next);
    try {
      await saveRolePreference(next);
      Alert.alert(
        'Role updated',
        `Saved as ${next}. Force-quit and reopen Dina to apply (boot wires ServicePublisher + ServiceHandler from this preference).`,
      );
    } catch (err) {
      Alert.alert('Error', (err as Error).message ?? 'Failed to save role');
    }
  }, []);

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
          setLoadError("Service config isn't wired yet. Complete onboarding first.");
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

  const addCapability = useCallback((key: string) => {
    const trimmed = key.trim();
    if (trimmed === '') return;
    setCapabilities((list) => {
      if (list.some((c) => c.key === trimmed)) return list;
      return [...list, { key: trimmed, policy: 'auto' }];
    });
    setAddModalVisible(false);
    setCustomCapName('');
  }, []);

  const removeCapability = useCallback((key: string) => {
    setCapabilities((list) => list.filter((c) => c.key !== key));
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
      // Start from the EXISTING capabilitySchemas map so any schemas
      // configured outside this screen (CLI, onboarding) survive the
      // save. Newly-added known capabilities (picked from the brain's
      // local registry) get their canonical schemas attached here.
      const schemas: NonNullable<ServiceConfig['capabilitySchemas']> = {
        ...(existing?.capabilitySchemas ?? {}),
      };
      // Drop schemas for capabilities the user removed via this screen.
      const liveKeys = new Set(capabilities.map((c) => c.key));
      for (const k of Object.keys(caps)) {
        if (!liveKeys.has(k)) delete caps[k];
        if (!liveKeys.has(k) && k in schemas) delete schemas[k];
      }
      // Overlay the policy + schema for each capability still in the
      // screen list. For caps NOT in `existing` (newly added via Add
      // Capability), look up the brain registry to attach the
      // canonical paramsSchema/resultSchema/schemaHash. Caps not in
      // the registry (free-text custom) are written without schemas;
      // provider-side params validation will be skipped for them.
      for (const c of capabilities) {
        const prior = existing?.capabilities[c.key] ?? caps[c.key];
        const def: CapabilityDef | undefined =
          prior === undefined
            ? localKnownCapabilities.find((cap) => cap.name === c.key)
            : undefined;
        // schema_hash precedence:
        //   1) any hash on the existing entry (preserved across saves)
        //   2) recomputed from the registry's paramsSchema (matches
        //      what ServicePublisher would compute on publish)
        const schemaHash =
          prior?.schemaHash ??
          (def !== undefined ? computeSchemaHash(def.paramsSchema) : undefined);
        caps[c.key] = {
          mcpServer: prior?.mcpServer ?? 'transit',
          mcpTool: prior?.mcpTool ?? c.key,
          responsePolicy: c.policy,
          ...(schemaHash !== undefined ? { schemaHash } : {}),
        };
        // Attach capabilitySchemas only when we have a registry def
        // AND it's not already in the existing schemas map. Mirrors
        // the published profile shape AppView consumers expect.
        if (def !== undefined && !(c.key in schemas)) {
          schemas[c.key] = {
            params: def.paramsSchema,
            result: def.resultSchema,
            schemaHash: schemaHash ?? computeSchemaHash(def.paramsSchema),
            description: def.description,
            defaultTtlSeconds: def.defaultTtlSeconds,
          };
        }
      }
      const next: ServiceConfig = {
        isDiscoverable,
        name: name.trim(),
        description: description.trim() !== '' ? description.trim() : undefined,
        capabilities: caps,
        ...(Object.keys(schemas).length > 0 ? { capabilitySchemas: schemas } : {}),
      };
      await saveServiceConfig(next);
      Alert.alert('Saved', 'Service config updated.', [
        { text: 'OK', onPress: () => router.replace('/settings') },
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
  }, [name, description, isDiscoverable, capabilities, localKnownCapabilities, router]);

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
        {/* ROLE — let a fresh requester-only node self-promote to
            provider. The boot path reads this on next launch and wires
            ServicePublisher + ServiceHandler accordingly. Without this
            toggle, role stays 'requester' forever (no other UI path). */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>ROLE</Text>
          <View style={styles.card}>
            {(['requester', 'provider', 'both'] as NodeRole[]).map((opt) => (
              <Pressable
                key={opt}
                style={[styles.row, role === opt ? styles.rowSelected : null]}
                onPress={() => onChangeRole(opt)}
                accessibilityRole="button"
                accessibilityLabel={`Set role to ${opt}`}
              >
                <Text style={styles.rowTitle}>{labelForRole(opt)}</Text>
                {role === opt ? <Text style={styles.rowValue}>{'✓'}</Text> : null}
              </Pressable>
            ))}
          </View>
        </View>

        {/* INFRA — user-editable PDS + AppView endpoints. Persisted via
            infra_preferences (Keychain) so a fresh boot reads the user's
            choice over env defaults. PDS handle + password become the
            account this node publishes its service-profile under. The
            "Save" button below commits all five fields atomically; we
            don't auto-save on blur because adb-driven keyboard input
            doesn't always emit a reliable blur event. */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>INFRASTRUCTURE</Text>
          <View style={styles.card}>
            <Text style={styles.label}>PeerLens AppView URL</Text>
            <TextInput
              value={appViewURLState}
              onChangeText={setAppViewURLState}
              placeholder="https://test-appview.dinakernel.com"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <View style={styles.inputDivider} />
            <Text style={styles.label}>Service Discovery AppView URL</Text>
            <TextInput
              value={servicesAppViewURLState}
              onChangeText={setServicesAppViewURLState}
              placeholder="Leave blank to use PeerLens AppView"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <View style={styles.inputDivider} />
            <Text style={styles.label}>PDS URL</Text>
            <TextInput
              value={pdsUrl}
              onChangeText={setPdsUrlState}
              placeholder="https://test-pds.dinakernel.com"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <View style={styles.inputDivider} />
            <Text style={styles.label}>PDS handle</Text>
            <TextInput
              value={pdsHandle}
              onChangeText={setPdsHandleState}
              placeholder="yourhandle.test-pds.dinakernel.com"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <View style={styles.inputDivider} />
            <Text style={styles.label}>PDS password</Text>
            <TextInput
              value={pdsPassword}
              onChangeText={setPdsPasswordState}
              placeholder="account password"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={styles.input}
            />
            <View style={styles.inputDivider} />
            <Text style={styles.label}>PDS email (optional)</Text>
            <TextInput
              value={pdsEmail}
              onChangeText={setPdsEmailState}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              style={styles.input}
            />
          </View>
          <Pressable
            style={styles.infraSaveButton}
            onPress={async () => {
              await Promise.all([
                saveAppViewURL(appViewURLState),
                saveServicesAppViewURL(servicesAppViewURLState),
                savePdsUrl(pdsUrl),
                savePdsHandle(pdsHandle),
                savePdsPassword(pdsPassword),
                savePdsEmail(pdsEmail),
              ]);
              Alert.alert(
                'Infrastructure saved',
                'Force-quit and reopen Dina to apply (boot wires AppView client + PDS publisher from these values).',
              );
            }}
            accessibilityRole="button"
            accessibilityLabel="Save infrastructure URLs"
          >
            <Text style={styles.infraSaveButtonText}>Save infrastructure</Text>
          </Pressable>
        </View>

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
                  wires PDS + MsgBox. Until then the profile is saved locally but will not reach
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
                No capabilities configured yet. Tap “Add capability” to advertise one.
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
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.capabilityName}>{cap.key}</Text>
                  </View>
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
                  <Pressable
                    onPress={() => removeCapability(cap.key)}
                    style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${cap.key} capability`}
                    hitSlop={8}
                  >
                    <Text style={styles.removeButtonText}>×</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>
          <Pressable
            onPress={() => setAddModalVisible(true)}
            style={({ pressed }) => [styles.addCapButton, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Add a capability to this service profile"
          >
            <Text style={styles.addCapButtonText}>+ Add capability</Text>
          </Pressable>
        </View>

        <Modal
          visible={addModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setAddModalVisible(false)}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setAddModalVisible(false)}
            // accessible={false} so the backdrop doesn't consume the
            // entire modal as one accessibility element — VoiceOver
            // can then reach the inputs and buttons inside the sheet.
            // The Cancel button below provides the keyboard/AX dismiss
            // path; the backdrop's tap-to-dismiss is a touch-only
            // affordance.
            accessible={false}
            importantForAccessibility="no-hide-descendants"
          >
            {/* Inner Pressable swallows backdrop taps so the sheet
                itself isn't dismissed when the user taps inside. */}
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={styles.modalSheet}
              accessible={false}
              accessibilityViewIsModal
            >
              <Text
                style={styles.modalTitle}
                accessibilityRole="header"
              >
                Add capability
              </Text>
              <Text style={styles.modalSubtitle}>
                Pick a known one or type your own. Known capabilities ship with JSON
                Schemas + schema_hash so requesters can detect version skew.
              </Text>

              {/* KNOWN — render only when at least one preset is unused. */}
              {localKnownCapabilities.some(
                (def) => !capabilities.some((c) => c.key === def.name),
              ) ? (
                <>
                  <Text style={styles.modalSectionHeader}>FROM CATALOGUE</Text>
                  <View style={styles.card}>
                    {localKnownCapabilities
                      .filter((def) => !capabilities.some((c) => c.key === def.name))
                      .map((def, idx, arr) => (
                        <Pressable
                          key={def.name}
                          onPress={() => addCapability(def.name)}
                          style={({ pressed }) => [
                            styles.knownCapRow,
                            idx === arr.length - 1 && styles.capabilityRowLast,
                            pressed && styles.pressed,
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={`Add ${def.name}. ${def.description}`}
                        >
                          <Text style={styles.capabilityName}>{def.name}</Text>
                          <Text style={styles.knownCapDescription} numberOfLines={2}>
                            {def.description}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                </>
              ) : null}

              <Text style={styles.modalSectionHeader}>
                {localKnownCapabilities.some(
                  (def) => !capabilities.some((c) => c.key === def.name),
                )
                  ? 'OR TYPE YOUR OWN'
                  : 'TYPE YOUR OWN'}
              </Text>
              <View style={styles.customCard}>
                <Text style={styles.label}>Capability key</Text>
                <TextInput
                  value={customCapName}
                  onChangeText={setCustomCapName}
                  placeholder="e.g. weather_forecast"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.customCapInput}
                  accessibilityLabel="Custom capability key"
                />
                <Text style={styles.modalHelpText}>
                  Custom capabilities ship without JSON Schemas. Requesters that
                  pre-validate params will reject the call. Register the key in
                  `packages/brain/src/service/capabilities/registry.ts` to ship schemas.
                </Text>
                <Pressable
                  onPress={() => addCapability(customCapName)}
                  disabled={customCapName.trim() === ''}
                  style={({ pressed }) => [
                    styles.modalAddButton,
                    pressed && styles.pressed,
                    customCapName.trim() === '' && styles.disabled,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Add custom capability"
                >
                  <Text style={styles.modalAddButtonText}>Add custom</Text>
                </Pressable>
              </View>

              <Pressable
                onPress={() => setAddModalVisible(false)}
                style={({ pressed }) => [styles.modalCancelButton, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.modalCancelButtonText}>Cancel</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

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

function labelForRole(r: NodeRole): string {
  if (r === 'requester') return 'Requester only. Ask others, never serve.';
  if (r === 'provider') return 'Provider. Accept inbound service queries.';
  return 'Both: provider plus requester.';
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
    ...textStyles.eyebrow,
    letterSpacing: 1.2,
    marginBottom: spacing.xs,
    marginLeft: spacing.xs,
  },
  sectionSubtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  rowSelected: {
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    borderBottomWidth: 0,
  },
  rowValue: {
    ...textStyles.bodyLargeStrong,
    color: colors.accent,
  },
  rowTitle: {
    ...textStyles.bodyStrong,
    marginBottom: 2,
  },
  rowSubtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
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
    ...textStyles.eyebrow,
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
  },
  input: {
    ...textStyles.body,
    paddingVertical: 4,
    minHeight: 28,
  },
  multiline: {
    minHeight: 48,
    textAlignVertical: 'top',
  },
  inputDivider: {
    height: 1,
    backgroundColor: colors.borderLight,
    marginVertical: spacing.sm,
  },
  helpText: {
    ...textStyles.caption,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  infraSaveButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  infraSaveButtonText: {
    ...textStyles.bodyStrong,
    color: colors.white,
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
  capabilityName: textStyles.mono,
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
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  policyActiveText: {
    ...textStyles.bodySmallStrong,
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
    ...textStyles.button,
    letterSpacing: 0.3,
  },
  emptyText: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
  },
  errorBanner: {
    backgroundColor: colors.errorBgSoft,
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  errorText: {
    ...textStyles.bodySmall,
    color: colors.error,
  },
  discoveryCaveat: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  discoveryCaveatTitle: {
    ...textStyles.bodySmallStrong,
    color: colors.error,
    marginBottom: 4,
  },
  discoveryCaveatBody: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  // Add-capability affordance below the capabilities card. Plain text
  // button rather than a filled CTA so it doesn't compete visually
  // with the "Save changes" footer button.
  addCapButton: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  addCapButtonText: {
    ...textStyles.buttonSmall,
    color: colors.accent,
  },
  removeButton: {
    marginLeft: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgTertiary,
  },
  removeButtonText: {
    ...textStyles.h3,
    color: colors.textSecondary,
  },
  // Add-capability modal sheet. Backdrop dims the screen; sheet sits
  // centered with a small max-height so the keyboard for the custom
  // input doesn't shove it off-screen.
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalSheet: {
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    maxHeight: '85%',
  },
  modalTitle: {
    ...textStyles.h3,
    marginBottom: spacing.xs,
  },
  modalSubtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  modalSectionHeader: {
    ...textStyles.eyebrow,
    letterSpacing: 1.2,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    marginLeft: spacing.xs,
  },
  // CUSTOM-section card. Dashed accent border + tinted background
  // sets it visually apart from the white "FROM CATALOGUE" card so
  // the alternative path is unmistakable, not a continuation of the
  // selection list.
  customCard: {
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.accent,
    padding: spacing.md,
  },
  // Input inside the dashed CUSTOM card. The page's shared `input`
  // style has no visible border (it relies on the parent form card's
  // dividers for shape) — here that left the field looking like
  // static example text. Solid white background + hairline border
  // reads unambiguously as "type here".
  customCapInput: {
    ...textStyles.body,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  knownCapRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  knownCapDescription: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  modalHelpText: {
    ...textStyles.tiny,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  modalAddButton: {
    marginTop: spacing.xs,
    paddingVertical: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  modalAddButtonText: textStyles.buttonSmall,
  modalCancelButton: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  modalCancelButtonText: {
    ...textStyles.link,
    color: colors.textSecondary,
  },
});
