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

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';

import {
  listCapabilities as listLocalCapabilities,
  computeSchemaHash,
  type CapabilityDef,
} from '@dina/brain';
import {
  validateServiceListing,
  effectiveDiscoverability,
  type CapabilityDefinition,
  type Discoverability,
  type ServiceListingStatus,
} from '@dina/protocol';

import { CapabilityPicker } from '../src/components/capability_picker';
import { getBootDegradations } from '../src/hooks/useNodeBootstrap';
import {
  listServiceListings,
  loadServiceConfig,
  loadServiceConfigWithRetry,
  saveServiceConfig,
  ServiceConfigNotConfiguredError,
  ServiceConfigValidationError,
} from '../src/hooks/useServiceConfigForm';
import {
  BUNDLED_CATALOG,
  defaultDiscoverabilityForCapabilities,
  findCapability,
  loadCatalog,
  type CatalogData,
  type CatalogFetch,
} from '../src/services/catalog_source';
import { slugifyRkey } from '../src/services/listing_rkey';
import { subscribeRuntimeWarnings, getRuntimeWarnings } from '../src/services/runtime_warnings';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

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

  // Explicit discovery visibility (spec §5.2). Supersedes the legacy
  // `isDiscoverable` boolean (which is derived on save: public → true).
  const [discoverability, setDiscoverability] = useState<Discoverability>('public');
  // Until the provider taps the "Who can find this?" selector (or we hydrate
  // a saved config), discoverability auto-tracks the safest catalog default
  // for the chosen capabilities (spec mobile #12/#13). Once touched, the
  // provider's explicit choice is respected and never auto-overridden.
  const [discoverabilityTouched, setDiscoverabilityTouched] = useState(false);
  const chooseDiscoverability = useCallback((value: Discoverability) => {
    setDiscoverabilityTouched(true);
    setDiscoverability(value);
  }, []);
  // Listing availability — the per-listing ON/OFF switch, distinct from node
  // role (requester/provider/both) and from discoverability (who can find it).
  // `active` = live (publish per discoverability + answer queries); `paused` =
  // keep the config but unpublish + stop answering. (`draft` exists in the
  // model but isn't a mobile toggle yet — a new listing starts `active`.)
  const [status, setStatus] = useState<ServiceListingStatus>('active');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Per-capability `category` is the concrete vertical chosen in the picker —
  // it travels onto the published listing (controls policy/consent/ranking).
  const [capabilities, setCapabilities] = useState<
    { key: string; policy: Policy; category?: string }[]
  >([]);
  // Official capability catalog (SERVICE_CAPABILITY_CATALOG_DESIGN.md). Starts as
  // the bundled fallback; the live AppView catalog is fetched on mount and wins
  // when available (spec §2). Drives the Category → Capability picker.
  const [catalog, setCatalog] = useState<CatalogData>(BUNDLED_CATALOG);
  // Add-Capability modal. The catalog picker drives Category → Capability; the
  // selected category is shared with the advanced custom (namespaced) entry.
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [pickerCategoryId, setPickerCategoryId] = useState<string | null>(null);
  const [customCapName, setCustomCapName] = useState('');
  // Local snapshot of the brain registry's known capabilities. Frozen
  // at mount — the registry is module-scope so it can't change at
  // runtime. Filtered to capabilities NOT already configured so the
  // picker doesn't show duplicates.
  const localKnownCapabilities = useMemo(() => listLocalCapabilities(), []);

  // Which listing this screen edits. `?rkey=<rkey>` edits that listing; no rkey
  // = CREATE a brand-new listing (its rkey is generated from the name on save).
  // Node role + the listing list live on `/my-listings` (the provider home).
  const params = useLocalSearchParams<{ rkey?: string }>();
  const editingRkey =
    typeof params.rkey === 'string' && params.rkey !== '' ? params.rkey : null;
  const isCreate = editingRkey === null;

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
    // The service-config Core client is wired during node boot
    // (`installChatGlobals`). This screen can mount inside the brief window
    // where that client is momentarily null — at first boot, or during a
    // re-boot (auto-lock → re-unlock, or a dev Fast-Refresh). `loadServiceConfigWithRetry`
    // keeps trying through that window so a transient null doesn't strand the
    // user on a sticky error; only a genuine, persistent null surfaces below.
    // CREATE mode: nothing to load — start with an empty form. The Core client
    // is needed only at save time (it's wired by then).
    if (isCreate) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await loadServiceConfigWithRetry({ rkey: editingRkey });
        if (cancelled) return;
        if (cfg !== null) hydrate(cfg);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ServiceConfigNotConfiguredError) {
          // Still null after the retry window — genuinely not ready.
          // Recoverable by reopening (which re-wires the client). Avoid
          // "wired"/"onboarding" jargon: onboarding is already done by the
          // time a user can reach this screen.
          setLoadError('Service settings couldn’t load yet — Dina may still be starting up. Reopen Dina and try again.');
        } else {
          setLoadError((err as Error).message ?? 'Failed to load service config');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function hydrate(cfg: ServiceConfig): void {
    // A saved config's discoverability is the provider's prior explicit
    // choice — pin `touched` so the auto-default effect doesn't clobber it.
    setDiscoverability(effectiveDiscoverability(cfg));
    setDiscoverabilityTouched(true);
    // Listing availability (default `active` for configs predating the field).
    setStatus(cfg.status ?? 'active');
    setName(cfg.name);
    setDescription(cfg.description ?? '');
    setCapabilities(
      Object.entries(cfg.capabilities).map(([key, cap]) => ({
        key,
        policy: (cap.responsePolicy ?? 'auto') as Policy,
        // Back-compat: an existing config may predate per-capability category.
        // Backfill the catalog's default for an official capability so a re-save
        // validates; leave undefined for custom/unknown (the user re-picks it).
        category: cap.category ?? findCapability(catalog, key)?.default_category_id,
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

  const addCapability = useCallback((key: string, category?: string) => {
    const trimmed = key.trim();
    if (trimmed === '') return;
    setCapabilities((list) => {
      if (list.some((c) => c.key === trimmed)) return list;
      return [
        ...list,
        { key: trimmed, policy: 'auto', ...(category !== undefined ? { category } : {}) },
      ];
    });
    setAddModalVisible(false);
    setPickerCategoryId(null);
    setCustomCapName('');
  }, []);

  const removeCapability = useCallback((key: string) => {
    setCapabilities((list) => list.filter((c) => c.key !== key));
  }, []);

  // Fetch the live AppView catalog once; fail-soft to the bundled fallback
  // (spec §2). The picker uses whichever is resolved.
  useEffect(() => {
    let cancelled = false;
    const url = process.env.EXPO_PUBLIC_DINA_APPVIEW_URL ?? '';
    void loadCatalog(url, globalThis.fetch as unknown as CatalogFetch).then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-default the discoverability to the safest catalog default for the
  // chosen capabilities (spec mobile #12/#13) — until the provider taps the
  // selector or we hydrate a saved config (`discoverabilityTouched`). A new
  // listing that adds e.g. a developer/ops capability seeds `known_only`
  // instead of silently defaulting to public search.
  useEffect(() => {
    if (discoverabilityTouched) return;
    setDiscoverability(
      defaultDiscoverabilityForCapabilities(
        capabilities.map((c) => c.key),
        catalog,
      ),
    );
  }, [discoverabilityTouched, capabilities, catalog]);

  const onSave = useCallback(async () => {
    if (name.trim() === '') {
      Alert.alert('Missing name', 'Give this node a display name before saving.');
      return;
    }
    // Review #19: don't allow saving a LIVE discoverable profile with no
    // capabilities — Core rejects it anyway, but catching it here produces a
    // clearer UI message than a wire error. Gated on `status === 'active'`: a
    // paused/draft listing isn't published, so an empty one is allowed (you can
    // pause an in-progress listing without first adding a capability).
    if (status === 'active' && discoverability === 'public' && capabilities.length === 0) {
      Alert.alert(
        'No capabilities',
        'A discoverable profile must advertise at least one capability. Add one first, or toggle "Make this node discoverable" off.',
      );
      return;
    }
    setSaving(true);
    try {
      // Edit mode: preserve the existing listing's caps/schemas. Create mode:
      // no existing config (a fresh listing under a new rkey).
      const existing = isCreate ? null : await loadServiceConfig(editingRkey);
      // Review #11: start from the EXISTING capability map so any
      // cap not surfaced by this screen (added via CLI, different
      // UI, or a newer version of this screen) survives the save.
      // Previously we rebuilt from the screen-local `capabilities`
      // array alone and every unseen capability got silently dropped.
      // Seed from the EXISTING config so policies + schemas configured
      // outside this screen (CLI, onboarding) survive the save, but keep
      // only capabilities still present in the screen list — rebuilt by
      // filtering (not mutated with `delete`) so a capability the user
      // removed here drops its policy AND its canonical schema.
      const liveKeys = new Set(capabilities.map((c) => c.key));
      const caps: ServiceConfig['capabilities'] = Object.fromEntries(
        Object.entries(existing?.capabilities ?? {}).filter(([k]) => liveKeys.has(k)),
      );
      const schemas: NonNullable<ServiceConfig['capabilitySchemas']> = Object.fromEntries(
        Object.entries(existing?.capabilitySchemas ?? {}).filter(([k]) => liveKeys.has(k)),
      );
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
          // The concrete category chosen in the picker travels onto the listing
          // (controls policy/consent/ranking). Preserve a prior category if the
          // screen list didn't carry one.
          ...(c.category !== undefined
            ? { category: c.category }
            : prior?.category !== undefined
              ? { category: prior.category }
              : {}),
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
        // Legacy boolean derived from the explicit value for back-compat.
        isDiscoverable: discoverability === 'public',
        // Explicit discovery visibility chosen in the "who can find this?"
        // selector (spec §5.2) — every listing carries it.
        discoverability,
        // Availability — `paused` keeps everything but unpublishes + stops
        // answering queries; `active` is live.
        status,
        name: name.trim(),
        description: description.trim() !== '' ? description.trim() : undefined,
        capabilities: caps,
        ...(Object.keys(schemas).length > 0 ? { capabilitySchemas: schemas } : {}),
      };
      // Fail-closed catalog validation (spec §8.1): a capability must be
      // official-or-namespaced (never an unknown flat name), carry an allowed
      // category, and write/booking actions must be review-gated. Block the
      // save + show the exact reasons rather than publishing a half-valid
      // public service.
      const verdict = validateServiceListing(next, { requireExplicitDiscoverability: true });
      if (!verdict.ok) {
        Alert.alert(
          'Fix before publishing',
          verdict.errors.map((e) => `• ${e.message}`).join('\n'),
        );
        return;
      }
      // Resolve the target rkey: edit → the listing's own rkey; create →
      // generate a unique slug from the name (avoiding existing rkeys + `self`).
      let targetRkey = editingRkey;
      if (targetRkey === null) {
        const all = await listServiceListings();
        targetRkey = slugifyRkey(next.name, all.map((l) => l.rkey));
      }
      await saveServiceConfig(next, targetRkey);
      Alert.alert('Saved', isCreate ? 'Listing created.' : 'Listing updated.', [
        { text: 'OK', onPress: () => router.replace('/my-listings') },
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
  }, [
    name,
    description,
    discoverability,
    status,
    capabilities,
    localKnownCapabilities,
    isCreate,
    editingRkey,
    router,
  ]);

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: isCreate ? 'New listing' : 'Edit listing' }} />
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
          <Text style={styles.sectionHeader}>SERVICE STATUS</Text>
          <View style={styles.card}>
            {(
              [
                {
                  value: 'active',
                  title: 'Active',
                  body: 'Live — published and answering queries (per the visibility below).',
                },
                {
                  value: 'paused',
                  title: 'Paused',
                  body: 'Off — kept saved, but not published and not answering queries. Flip back to Active anytime.',
                },
              ] as { value: ServiceListingStatus; title: string; body: string }[]
            ).map((opt) => (
              <Pressable
                key={opt.value}
                style={[styles.row, status === opt.value ? styles.rowSelected : null]}
                onPress={() => setStatus(opt.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: status === opt.value }}
                accessibilityLabel={`${opt.title}. ${opt.body}`}
              >
                <View style={{ flex: 1, paddingRight: spacing.sm }}>
                  <Text style={styles.rowTitle}>{opt.title}</Text>
                  <Text style={styles.rowSubtitle}>{opt.body}</Text>
                </View>
                {status === opt.value ? <Text style={styles.rowValue}>{'✓'}</Text> : null}
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>WHO CAN FIND THIS SERVICE?</Text>
          <View style={styles.card}>
            {(
              [
                { value: 'public', title: 'Public', body: 'Anyone can find this service in Dina search.' },
                {
                  value: 'unlisted',
                  title: 'Unlisted',
                  body: 'Only people with the service link, QR, invite, or pairing can find it.',
                },
                {
                  value: 'known_only',
                  title: 'Private / known only',
                  body: 'Not published to the network — only reachable through a direct connection you set up.',
                },
              ] as { value: Discoverability; title: string; body: string }[]
            ).map((opt) => (
              <Pressable
                key={opt.value}
                style={[styles.row, discoverability === opt.value ? styles.rowSelected : null]}
                onPress={() => chooseDiscoverability(opt.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: discoverability === opt.value }}
                accessibilityLabel={`${opt.title}. ${opt.body}`}
              >
                <View style={{ flex: 1, paddingRight: spacing.sm }}>
                  <Text style={styles.rowTitle}>{opt.title}</Text>
                  <Text style={styles.rowSubtitle}>{opt.body}</Text>
                </View>
                {discoverability === opt.value ? <Text style={styles.rowValue}>{'✓'}</Text> : null}
              </Pressable>
            ))}
            {discoverability === 'public' && discoveryBlocked ? (
              <View style={styles.discoveryCaveat}>
                <Text style={styles.discoveryCaveatTitle}>Not actually discoverable yet.</Text>
                <Text style={styles.discoveryCaveatBody}>
                  Missing: {activeBlockers.join(', ')}.{'\n'}Once onboarding wires PDS + MsgBox this
                  will reach AppView. Until then the profile is saved locally but won't appear in
                  search.
                </Text>
              </View>
            ) : null}
            <Text style={[styles.rowSubtitle, { paddingHorizontal: spacing.md, paddingTop: spacing.sm }]}>
              Discoverability is not authorization — the provider still controls who may actually use
              the service.
            </Text>
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
                Choose a category, then an official Dina capability. Advanced:
                define a custom namespaced capability if none fits.
              </Text>

              {/* Official catalog: Category → Capability (no typing ids). The
                  chosen category travels onto the listing. Already-added
                  capabilities are filtered so the picker doesn't show dupes. */}
              <CapabilityPicker
                catalog={{
                  ...catalog,
                  capabilities: catalog.capabilities.filter(
                    (def) => !capabilities.some((c) => c.key === def.id),
                  ),
                }}
                selectedCategoryId={pickerCategoryId}
                onSelectCategory={setPickerCategoryId}
                selectedCapabilityId={null}
                onSelectCapability={(cap: CapabilityDefinition, categoryId: string) =>
                  addCapability(cap.id, categoryId)
                }
              />

              {/* Advanced custom — needs a category too (spec §5.1), so it's
                  gated on a category having been picked above. */}
              {pickerCategoryId !== null ? (
                <>
                  <Text style={styles.modalSectionHeader}>OR DEFINE A CUSTOM CAPABILITY</Text>
                  <View style={styles.customCard}>
                    <Text style={styles.label}>Capability key</Text>
                    <TextInput
                      value={customCapName}
                      onChangeText={setCustomCapName}
                      placeholder="e.g. com.example.inventory_lookup"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.customCapInput}
                      accessibilityLabel="Custom capability key"
                    />
                    <Text style={styles.modalHelpText}>
                      Use a reverse-DNS capability name you control, e.g.
                      com.example.inventory_lookup. Custom capability keys are
                      developer preview: a public custom capability needs a
                      parameter/result schema before other Dinas can reliably call
                      it.
                    </Text>
                    <Pressable
                      onPress={() => addCapability(customCapName, pickerCategoryId)}
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
                </>
              ) : null}

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
  helpText: {
    ...textStyles.caption,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
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
