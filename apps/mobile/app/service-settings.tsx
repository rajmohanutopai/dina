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

import { Ionicons } from '@expo/vector-icons';
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
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

import {
  listCapabilities as listLocalCapabilities,
  canonicalCapabilitySchemaHash,
  type CapabilityDef,
} from '@dina/brain';
import { listPersonas } from '@dina/core';
import {
  validateServiceListing,
  effectiveDiscoverability,
  effectiveSurface,
  effectiveDefaultOfferable,
  effectiveListingStatus,
  resolveCatalogCapability,
  type CapabilityDefinition,
  type Discoverability,
  type ServiceListingStatus,
  type ServiceSurface,
} from '@dina/protocol';

import { CapabilityPicker } from '../src/components/capability_picker';
import { getBootDegradations } from '../src/hooks/useNodeBootstrap';
import { buildContactServiceListingFields } from '../src/services/contact_service_listing';
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

// "Provider-specific" is surfaced in the visibility picker but DISABLED — it
// would be a public service carrying a custom capability (on the provider's own
// page, excluded from general search), which can't save without a params/result
// schema the app can't author yet (validateServiceListing §8.1). Shown so the
// concept is discoverable; tapping explains it's coming.
const PROVIDER_SPECIFIC_BODY =
  'Public services belonging to a specific provider, such as schools, clinics, or shops. They appear on that provider’s page, not in general Dina search.';
const PROVIDER_SPECIFIC_COMING_SOON =
  'Provider-specific services (published on a business, school, or clinic’s own page rather than in general Dina search) are coming in a later update. For now, choose Public, Unlisted, or Private / Approved Only.';

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
  // Toggle a listing between a Services-tab provider service and a Talk
  // relationship service. A `talk` listing is `known_only` by construction
  // (validator §5.3), so turning it ON pins discoverability to `known_only`;
  // turning it OFF also clears `defaultOfferable` (which only applies to talk).
  const chooseSurface = useCallback((next: ServiceSurface) => {
    setSurface(next);
    if (next === 'talk') {
      setDiscoverability('known_only');
      setDiscoverabilityTouched(true);
    } else {
      setDefaultOfferable(false);
    }
  }, []);
  // Listing availability — the per-listing ON/OFF switch, distinct from node
  // role (requester/provider/both) and from discoverability (who can find it).
  // `active` = live (publish per discoverability + answer queries); `paused` =
  // keep the config but unpublish + stop answering. (`draft` exists in the
  // model but isn't a mobile toggle yet — a new listing starts `active`.)
  const [status, setStatus] = useState<ServiceListingStatus>('active');
  // Contact Services (CONTACT_SERVICES_ARCHITECTURE.md §5.3). `surface` decides
  // WHERE this listing lives: `services` = the Services tab (a provider service,
  // the default); `talk` = a relationship service surfaced inside a Talk thread
  // with a contact. A `talk` listing is `known_only` BY CONSTRUCTION (the
  // validator enforces `talk_must_be_known_only`), so flipping it to Talk also
  // pins discoverability to `known_only`. `defaultOfferable` (only meaningful on
  // a talk listing) opts it into the closeness-default flow: a close contact's
  // grant-request auto-grants, a friend's surfaces an ask-to-enable prompt.
  const [surface, setSurface] = useState<ServiceSurface>('services');
  const [defaultOfferable, setDefaultOfferable] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Per-capability `category` is the concrete vertical chosen in the picker —
  // it travels onto the published listing (controls policy/consent/ranking).
  //
  // `lane` is the capability's execution plane (docs/SERVICE_PROVIDER_TIERS.md):
  //   - 'dina'  → Tier 1 prompt-provider: the provider writes an `instruction`
  //               ("how should Dina answer?") and THEIR OWN Dina answers from
  //               it + their vault notes. No infrastructure. The DEFAULT.
  //   - 'agent' → a paired dina-agent daemon executes (mcpServer binding).
  // `instruction` is kept across lane toggles so switching back doesn't lose
  // the provider's text; only the saved mcpServer presence decides the lane.
  const [capabilities, setCapabilities] = useState<
    {
      key: string;
      policy: Policy;
      category?: string;
      lane: 'dina' | 'agent';
      instruction: string;
      /**
       * The saved agent binding, carried through the screen state so a
       * dina → save → agent round-trip RESTORES the real runner/tool
       * instead of fabricating the 'openclaw'/<key> default (which
       * silently dead-ends a multi-runner provider's listing).
       */
      mcpServer?: string;
      mcpTool?: string;
    }[]
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
  // Tier 1 vault pin (docs/SERVICE_PROVIDER_TIERS.md): which SINGLE vault this
  // listing's "My Dina answers" executions may read from AND write to. The
  // selection is ALWAYS one concrete vault — there is no "all memory" fan-out
  // (the runtime reads/writes exactly this one persona, ∩ its safe-tier
  // filter). Defaults to `general` (the main vault); pinnable choices exclude
  // sensitive/locked tiers (the runtime intersects with the tier scope anyway,
  // so a sensitive pin would yield no access).
  const [vaultPersona, setVaultPersona] = useState<string>('general');
  const pinnablePersonas = useMemo(
    () =>
      listPersonas()
        .filter((per) => per.tier !== 'sensitive' && per.tier !== 'locked')
        .map((per) => per.name),
    [],
  );

  // Resolve a configured capability key to its friendly catalog name for
  // display. A provider picks "Order status" from the catalog but the listing
  // stores the id `order_status`; showing the raw id back is a regression in
  // recognisability. Custom (reverse-DNS) keys aren't in the catalog, so the
  // resolver returns the key unchanged and the row renders it as-is.
  const capabilityDisplayName = useMemo(() => {
    const byId = new Map(catalog.capabilities.map((def) => [def.id, def.display_name]));
    return (key: string): string => byId.get(key) ?? key;
  }, [catalog]);

  // Which listing this screen edits. `?rkey=<rkey>` edits that listing; no rkey
  // = CREATE a brand-new listing (its rkey is generated from the name on save).
  // Node role + the listing list live on `/my-listings` (the provider home).
  const params = useLocalSearchParams<{ rkey?: string }>();
  const editingRkey = typeof params.rkey === 'string' && params.rkey !== '' ? params.rkey : null;
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
          setLoadError(
            'Service settings couldn’t load yet. Dina may still be starting up. Reopen Dina and try again.',
          );
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
    // Contact Services: surface + default-offerable (absent ⇒ services / false).
    setSurface(effectiveSurface(cfg));
    setDefaultOfferable(effectiveDefaultOfferable(cfg));
    setName(cfg.name);
    setDescription(cfg.description ?? '');
    // Old configs (or ones authored before the single-vault rule) may carry an
    // empty/absent pin that used to mean "all shared memory". That fan-out is
    // gone — map it to the `general` default so the picker shows one concrete
    // selection and the save re-persists it explicitly.
    setVaultPersona(
      typeof cfg.vaultPersona === 'string' && cfg.vaultPersona !== ''
        ? cfg.vaultPersona
        : 'general',
    );
    setCapabilities(
      Object.entries(cfg.capabilities).map(([key, cap]) => {
        // Back-compat: an existing config may predate per-capability category.
        // Backfill the catalog's default for an official capability so a
        // re-save validates; leave undefined for custom/unknown (the user
        // re-picks it). The key is resolved THROUGH THE ALIAS MAP first — an
        // alias-keyed config (e.g. `booking_status` for appointment_status,
        // possible from CLI/Core-authored configs) classifies as OFFICIAL in
        // the validator, so skipping the backfill for it would dead-end the
        // save on `missing_category` with no in-screen remedy.
        const canonical = resolveCatalogCapability(key);
        return {
          key,
          policy: (cap.responsePolicy ?? 'auto') as Policy,
          category:
            cap.category ??
            (canonical !== null
              ? findCapability(catalog, canonical)?.default_category_id
              : undefined),
          // Saved mcpServer presence IS the lane (Tier 1 caps omit it).
          lane: (typeof cap.mcpServer === 'string' && cap.mcpServer !== ''
            ? 'agent'
            : 'dina') as 'dina' | 'agent',
          instruction: cap.instruction ?? '',
          // Keep the real binding in screen state so lane round-trips
          // don't fabricate a default one (see the state docstring).
          ...(typeof cap.mcpServer === 'string' && cap.mcpServer !== ''
            ? { mcpServer: cap.mcpServer }
            : {}),
          ...(typeof cap.mcpTool === 'string' && cap.mcpTool !== ''
            ? { mcpTool: cap.mcpTool }
            : {}),
        };
      }),
    );
  }

  const toggleCapabilityPolicy = useCallback((key: string) => {
    setCapabilities((list) =>
      list.map((c) =>
        c.key === key ? { ...c, policy: c.policy === 'auto' ? 'review' : 'auto' } : c,
      ),
    );
  }, []);

  const toggleCapabilityLane = useCallback((key: string) => {
    setCapabilities((list) =>
      list.map((c) => (c.key === key ? { ...c, lane: c.lane === 'dina' ? 'agent' : 'dina' } : c)),
    );
  }, []);

  const setCapabilityInstruction = useCallback((key: string, text: string) => {
    setCapabilities((list) => list.map((c) => (c.key === key ? { ...c, instruction: text } : c)));
  }, []);

  const addCapability = useCallback(
    (key: string, category?: string) => {
      const trimmed = key.trim();
      if (trimmed === '') return;
      // Seed the response policy from the catalog's approval hint —
      // a booking/write capability (e.g. appointment_book,
      // `always_approval`) starts as `review` so the save doesn't
      // dead-end on the validator's `write_needs_approval`.
      const canonical = resolveCatalogCapability(trimmed);
      const catalogEntry = canonical !== null ? findCapability(catalog, canonical) : undefined;
      const hint = catalogEntry?.approval_policy_hint;
      const seededPolicy: Policy = hint === 'always_approval' ? 'review' : 'auto';
      setCapabilities((list) => {
        if (list.some((c) => c.key === trimmed)) return list;
        return [
          ...list,
          {
            key: trimmed,
            policy: seededPolicy,
            // Tier 1 is the no-infrastructure default: a new capability is
            // answered by the provider's own Dina until they explicitly
            // connect an agent for it (docs/SERVICE_PROVIDER_TIERS.md).
            lane: 'dina' as const,
            // Seed the catalog's default instruction so the capability works as
            // expected out of the box (the provider can edit it). Custom / un-
            // cataloged capabilities fall back to empty.
            instruction: catalogEntry?.default_instruction ?? '',
            ...(category !== undefined ? { category } : {}),
          },
        ];
      });
      setAddModalVisible(false);
      setPickerCategoryId(null);
      setCustomCapName('');
    },
    [catalog],
  );

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
      Alert.alert('Missing name', 'Give this service a display name before saving.');
      return;
    }
    // Review #19: don't allow saving a LIVE discoverable profile with no
    // capabilities — Core rejects it anyway, but catching it here produces a
    // clearer UI message than a wire error. Gated on `status === 'active'`: a
    // paused/draft listing isn't published, so an empty one is allowed (you can
    // pause an in-progress listing without first adding a capability).
    // Mirrors the validator's `no_capabilities` rule, which gates on
    // isListingPublishable = active && !known_only — so it fires for
    // UNLISTED too, and the remedies offered must actually pass.
    if (status === 'active' && discoverability !== 'known_only' && capabilities.length === 0) {
      Alert.alert(
        'No capabilities',
        'A live listing must advertise at least one capability. Add one first, set its visibility to Private / Approved Only, or pause the listing.',
      );
      return;
    }
    // Tier 1 lane needs the provider's words — an active capability with
    // neither an agent binding nor an instruction can only time out on the
    // requester. Mirrors the validator's `missing_execution_plane` with a
    // friendlier in-screen message (Core rejects it anyway).
    if (status === 'active') {
      const missing = capabilities.find((c) => c.lane === 'dina' && c.instruction.trim() === '');
      if (missing !== undefined) {
        Alert.alert(
          'Tell Dina how to answer',
          `"${capabilityDisplayName(missing.key)}" is answered by your Dina, but you haven't written instructions yet. Add a sentence or two (e.g. "Use my appointment notes to answer availability. If someone wants to book, ask me first."), or switch it to a connected agent.`,
        );
        return;
      }
    }
    // Review #3: a default-offerable TALK listing is the one a close contact
    // AUTO-grants. Two default-offerable talk listings offering the SAME
    // capability make that pick ambiguous (Core breaks the tie deterministically
    // by preferring default-offerable then rkey, but the rkey order is arbitrary
    // to the user). For V1 we enforce uniqueness at save time: a capability may be
    // auto-offered by only ONE active relationship service. Fail-OPEN if the
    // listing read throws (the runtime tiebreak still keeps it deterministic).
    if (surface === 'talk' && defaultOfferable && status === 'active') {
      try {
        const myKeys = new Set(capabilities.map((c) => c.key));
        const clashListing = (await listServiceListings())
          .filter((l) => l.rkey !== editingRkey)
          .find(
            (l) =>
              effectiveSurface(l.config) === 'talk' &&
              effectiveDefaultOfferable(l.config) &&
              effectiveListingStatus(l.config) === 'active' &&
              Object.keys(l.config.capabilities ?? {}).some((k) => myKeys.has(k)),
          );
        if (clashListing !== undefined) {
          const clashCap = Object.keys(clashListing.config.capabilities ?? {}).find((k) =>
            myKeys.has(k),
          );
          Alert.alert(
            'Already auto-offered elsewhere',
            `"${clashListing.config.name ?? clashListing.rkey}" already auto-offers ${
              clashCap !== undefined ? capabilityDisplayName(clashCap) : 'this capability'
            } to close contacts. A capability can be auto-offered by only one relationship service — turn off "Offer to close contacts by default" on one of them first.`,
          );
          return;
        }
      } catch {
        /* fail-open: couldn't list — let the deterministic runtime tiebreak handle it */
      }
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
      // Shallow-CLONE each preserved schema entry: `existing` is Core's
      // live in-memory config object (in-process transport returns it by
      // reference), and the canonical-hash heal below writes
      // `schemaEntry.schemaHash`. Mutating the live entry would change
      // kernel state even when the save is later aborted by validation.
      const schemas: NonNullable<ServiceConfig['capabilitySchemas']> = Object.fromEntries(
        Object.entries(existing?.capabilitySchemas ?? {})
          .filter(([k]) => liveKeys.has(k))
          .map(([k, v]) => [k, { ...v }]),
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
        // Attach capabilitySchemas for a NEWLY added registry capability
        // (existing schema entries were preserved above). The hash is
        // filled below from the entry itself.
        if (def !== undefined && !(c.key in schemas)) {
          schemas[c.key] = {
            params: def.paramsSchema,
            result: def.resultSchema,
            schemaHash: '',
            description: def.description,
            defaultTtlSeconds: def.defaultTtlSeconds,
          };
        }
        // schema_hash is ALWAYS derived from the schema entry actually
        // being saved — the publisher's canonical {params, result,
        // description} recipe (`canonicalCapabilitySchemaHash`). Never a
        // cached prior value and never params-only: a stale/params-only
        // local hash diverges from the published record's hash, and the
        // provider then rejects every hash-carrying query with
        // `schema_version_mismatch` (found live in the Tier 1 salon
        // demo). Recomputing on every save also HEALS configs written
        // with the old params-only recipe. Caps with no schema entry
        // (free-text custom) keep any prior hash (nothing to derive from).
        const schemaEntry = schemas[c.key];
        const schemaHash =
          schemaEntry !== undefined
            ? canonicalCapabilitySchemaHash(schemaEntry)
            : prior?.schemaHash;
        if (schemaEntry !== undefined && schemaHash !== undefined) {
          schemaEntry.schemaHash = schemaHash;
        }
        // Execution plane by lane (docs/SERVICE_PROVIDER_TIERS.md):
        //   'dina'  → Tier 1: instruction only, NO mcpServer/mcpTool —
        //             the absence of the binding routes tasks to the
        //             reserved in-process 'dina.local' runner.
        //   'agent' → agent binding. Default runner is the conventional
        //             paired dina-agent name ('openclaw' — see cli
        //             agent_daemon default); the transit demo overrides
        //             this explicitly. Any prior instruction text is
        //             preserved (inert on this lane) so toggling back
        //             to "My Dina" doesn't lose the provider's words.
        const trimmedInstruction = c.instruction.trim();
        // As-of discipline: bump the timestamp ONLY when the text
        // actually changed — re-saving an untouched listing must not
        // make stale guidance look fresh. Unchanged text PRESERVES the
        // prior value INCLUDING undefined (a CLI-authored instruction
        // with no timestamp stays "age unknown" — honest — rather than
        // getting laundered to "moments ago" by an incidental save).
        const instructionUpdatedAt =
          trimmedInstruction === ''
            ? undefined
            : trimmedInstruction === (prior?.instruction ?? '').trim()
              ? prior?.instructionUpdatedAt
              : Date.now();
        caps[c.key] = {
          ...(c.lane === 'agent'
            ? {
                // Screen-state binding first (survives dina→agent
                // round-trips within AND across saves), then the stored
                // prior, then the conventional paired-daemon default.
                mcpServer: c.mcpServer ?? prior?.mcpServer ?? 'openclaw',
                mcpTool: c.mcpTool ?? prior?.mcpTool ?? c.key,
              }
            : {}),
          ...(trimmedInstruction !== ''
            ? {
                instruction: trimmedInstruction,
                ...(instructionUpdatedAt !== undefined ? { instructionUpdatedAt } : {}),
              }
            : {}),
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
      }
      // Contact Services (§5.3): resolve the surface/discoverability/default-
      // offerable trio through the single pure (tested) decision. It pins a
      // Talk listing to `known_only` and drops `defaultOfferable` for a Services
      // listing, so this screen can only ever PRODUCE a config that passes the
      // validator's `talk_must_be_known_only` rule. The legacy `isDiscoverable`
      // boolean derives from the RESOLVED discoverability (not the raw state).
      const contactFields = buildContactServiceListingFields(
        surface,
        discoverability,
        defaultOfferable,
      );
      const next: ServiceConfig = {
        // Seed from the EXISTING config so fields this screen does not
        // manage (serviceArea, accessPolicyHint/rateLimitHint/pricingHint/
        // freshnessHint, anything a CLI added) survive the save — the
        // screen previously rebuilt the object from its own fields alone
        // and silently dropped a listing's service area on every edit.
        ...(existing ?? {}),
        // Legacy boolean derived from the RESOLVED value for back-compat.
        isDiscoverable: contactFields.discoverability === 'public',
        ...contactFields,
        // Availability — `paused` keeps everything but unpublishes + stops
        // answering queries; `active` is live.
        status,
        name: name.trim(),
        description: description.trim() !== '' ? description.trim() : undefined,
        capabilities: caps,
        ...(Object.keys(schemas).length > 0
          ? { capabilitySchemas: schemas }
          : { capabilitySchemas: undefined }),
        // Always persist a concrete single vault — the picker no longer offers
        // an "all memory" option. Fall back to `general` (the runtime's own
        // default) if the state is somehow empty, so the listing always pins
        // exactly one vault for both reads and writes.
        vaultPersona: vaultPersona !== '' ? vaultPersona : 'general',
      };
      // Fail-closed catalog validation (spec §8.1): a capability must be
      // official-or-namespaced (never an unknown flat name), carry an allowed
      // category, and write/booking actions must be review-gated. Block the
      // save + show the exact reasons rather than publishing a half-valid
      // public service.
      const verdict = validateServiceListing(next, { requireExplicitDiscoverability: true });
      if (!verdict.ok) {
        // Public custom (namespaced) capabilities need a schema we don't yet
        // have UI to author. Rather than a dead-end "needs schema" message,
        // offer the supported V1 path: publish it Known-only (custom caps are
        // allowed there without a schema — validator §8.1 only requires it for
        // `public`). One tap switches visibility so the next Save passes.
        const customSchemaBlocked =
          discoverability === 'public' &&
          verdict.errors.some((e) => e.code === 'public_custom_needs_schema');
        if (customSchemaBlocked) {
          Alert.alert(
            'Public custom capabilities not supported yet',
            'Custom (namespaced) capabilities can only be published Public with a ' +
              'params/result schema, which this build can’t author yet. Publish it ' +
              'Known-only instead, or use a standard capability.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Make Known-only',
                onPress: () => {
                  setDiscoverability('known_only');
                  setDiscoverabilityTouched(true);
                },
              },
            ],
          );
          return;
        }
        // A sensitive official capability on a PUBLIC listing (taxonomy §3 /
        // guardrail #7 — e.g. school homework, appointment status). The
        // validator fail-closes; here we explain it and offer the one-tap
        // fixes instead of a dead-end error list.
        const sensitivePublicBlocked =
          discoverability === 'public' &&
          verdict.errors.some((e) => e.code === 'public_sensitive_capability');
        if (sensitivePublicBlocked) {
          Alert.alert(
            'Too sensitive for a Public listing',
            'This listing includes a capability that reads sensitive or personal data ' +
              '(for example appointment or homework status). It can be offered Unlisted ' +
              '(link or QR) or Private / Approved Only, but not in public Dina search.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Make Unlisted',
                onPress: () => {
                  setDiscoverability('unlisted');
                  setDiscoverabilityTouched(true);
                },
              },
              {
                text: 'Make Private',
                onPress: () => {
                  setDiscoverability('known_only');
                  setDiscoverabilityTouched(true);
                },
              },
            ],
          );
          return;
        }
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
        targetRkey = slugifyRkey(
          next.name,
          all.map((l) => l.rkey),
        );
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
    // The selected single vault (Tier-1 "answers from this vault"). MUST be in
    // the deps — without it the memoized callback keeps a stale closure over the
    // initial value, so selecting a different vault then saving would silently
    // persist the old one.
    vaultPersona,
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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: isCreate ? 'New listing' : 'Edit listing' }} />
      {loadError !== null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      ) : null}
      <ScrollView
        style={styles.scrollFlex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>SERVICE STATUS</Text>
          <View style={styles.card}>
            {(
              [
                {
                  value: 'active',
                  title: 'Active',
                  body: 'Live. Published and answering queries (per the visibility below).',
                },
                {
                  value: 'paused',
                  title: 'Paused',
                  body: 'Off. Kept saved, but not published and not answering queries. Flip back to Active anytime.',
                },
              ] as { value: ServiceListingStatus; title: string; body: string }[]
            ).map((opt) => (
              <Pressable
                key={opt.value}
                style={[styles.row, status === opt.value ? styles.rowSelected : null]}
                onPress={() => setStatus(opt.value)}
                testID={`service-settings-status-${opt.value}`}
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
          <Text style={styles.sectionHeader}>SERVICE TYPE</Text>
          <View style={styles.card}>
            {(
              [
                {
                  value: 'services' as ServiceSurface,
                  title: 'Provider service',
                  body: 'Lives in the Services tab. Customers find and use it like a business listing.',
                },
                {
                  value: 'talk' as ServiceSurface,
                  title: 'Relationship service (Talk)',
                  body: 'Surfaced inside a Talk thread with a contact — e.g. "find a time with me". Private to people you approve.',
                },
              ]
            ).map((opt) => {
              const selected = surface === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[styles.row, selected ? styles.rowSelected : null]}
                  onPress={() => chooseSurface(opt.value)}
                  testID={`service-settings-surface-${opt.value}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${opt.title}. ${opt.body}`}
                >
                  <View style={{ flex: 1, paddingRight: spacing.sm }}>
                    <Text style={styles.rowTitle}>{opt.title}</Text>
                    <Text style={styles.rowSubtitle}>{opt.body}</Text>
                  </View>
                  {selected ? <Text style={styles.rowValue}>{'✓'}</Text> : null}
                </Pressable>
              );
            })}
            {surface === 'talk' ? (
              <Pressable
                style={[styles.row, defaultOfferable ? styles.rowSelected : null]}
                onPress={() => setDefaultOfferable((v) => !v)}
                testID="service-settings-default-offerable"
                accessibilityRole="switch"
                accessibilityState={{ checked: defaultOfferable }}
                accessibilityLabel="Offer to close contacts by default"
              >
                <View style={{ flex: 1, paddingRight: spacing.sm }}>
                  <Text style={styles.rowTitle}>Offer to close contacts by default</Text>
                  <Text style={styles.rowSubtitle}>
                    Close contacts (family) are auto-granted; friends get a one-time "Allow?" prompt.
                    Everyone else is silently not offered. You can still approve anyone by hand.
                  </Text>
                </View>
                <Text style={styles.rowValue}>{defaultOfferable ? '✓' : '—'}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>WHO CAN FIND THIS SERVICE?</Text>
          {surface === 'talk' ? (
            <Text style={styles.sectionSubtitle}>
              A relationship service is always Private / Approved Only — only contacts you grant can
              reach it. (Locked for Talk services.)
            </Text>
          ) : null}
          <View style={styles.card}>
            {(
              [
                {
                  value: 'public',
                  title: 'Public',
                  body: 'Visible in Dina search. Anyone can find and access this service.',
                },
                {
                  // Not a real `discoverability` value — surfaced so providers
                  // know the concept exists, but disabled: it would be public +
                  // a custom capability, which can't save without a schema the
                  // app can't author yet (validateServiceListing §8.1).
                  value: 'provider_specific',
                  title: 'Provider-specific',
                  body: PROVIDER_SPECIFIC_BODY,
                  disabled: true,
                },
                {
                  value: 'unlisted',
                  title: 'Unlisted',
                  body: 'Hidden from Dina search. Anyone with the link or QR can access it.',
                },
                {
                  value: 'known_only',
                  title: 'Private / Approved Only',
                  body: 'Not listed and not link-shareable. Only people you explicitly approve can access it.',
                },
              ] as {
                value: Discoverability | 'provider_specific';
                title: string;
                body: string;
                disabled?: boolean;
              }[]
            ).map((opt) => {
              const selected = opt.disabled !== true && discoverability === opt.value;
              // A Talk service is locked to `known_only` (validator §5.3): every
              // OTHER visibility row is disabled while Talk is selected, so the
              // provider can't author an invalid talk+public/unlisted listing.
              const lockedForTalk = surface === 'talk' && opt.value !== 'known_only';
              const rowDisabled = opt.disabled === true || lockedForTalk;
              return (
                <Pressable
                  key={opt.value}
                  style={[
                    styles.row,
                    selected ? styles.rowSelected : null,
                    rowDisabled ? styles.rowDisabled : null,
                  ]}
                  onPress={() =>
                    opt.disabled === true
                      ? Alert.alert('Coming soon', PROVIDER_SPECIFIC_COMING_SOON)
                      : lockedForTalk
                        ? undefined
                        : chooseDiscoverability(opt.value as Discoverability)
                  }
                  disabled={lockedForTalk}
                  testID={`service-settings-discoverability-${opt.value}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: rowDisabled }}
                  accessibilityLabel={`${opt.title}. ${opt.body}${
                    opt.disabled === true ? '. Coming soon.' : ''
                  }${lockedForTalk ? '. Locked for relationship services.' : ''}`}
                >
                  <View style={{ flex: 1, paddingRight: spacing.sm }}>
                    <Text style={styles.rowTitle}>{opt.title}</Text>
                    <Text style={styles.rowSubtitle}>{opt.body}</Text>
                  </View>
                  {opt.disabled === true ? (
                    <Text style={styles.comingSoonPill}>Coming soon</Text>
                  ) : selected ? (
                    <Text style={styles.rowValue}>{'✓'}</Text>
                  ) : null}
                </Pressable>
              );
            })}
            {discoverability === 'public' && discoveryBlocked ? (
              <View style={styles.discoveryCaveat}>
                <Text style={styles.discoveryCaveatTitle}>Not actually discoverable yet.</Text>
                <Text style={styles.discoveryCaveatBody}>
                  This listing is saved on your device, but Dina isn't ready to publish it to the
                  network yet. Once setup finishes it will appear in search. Until then it stays
                  local and won't show up for anyone else.
                </Text>
              </View>
            ) : null}
            <Text
              style={[
                styles.rowSubtitle,
                { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
              ]}
            >
              Discoverability is not authorization. The provider still controls who may actually use
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
                testID="service-settings-name-input"
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
                testID="service-settings-description-input"
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>ANSWERS FROM</Text>
          <Text style={styles.sectionSubtitle}>
            Pick the one vault your Dina answers this service from. It reads and writes only this
            vault, never any other. Private (sensitive or locked) vaults are never available to
            services.
          </Text>
          <View style={styles.card}>
            <View style={styles.personaPinRow}>
              {pinnablePersonas.map((per) => (
                <Pressable
                  key={per}
                  onPress={() => setVaultPersona(per)}
                  style={({ pressed }) => [
                    styles.personaChip,
                    vaultPersona === per && styles.personaChipActive,
                    pressed && styles.pressed,
                  ]}
                  testID={`service-settings-vault-persona-${per}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Answers may use only the ${per} memory`}
                >
                  <Text
                    style={[
                      styles.personaChipText,
                      vaultPersona === per && styles.personaChipTextActive,
                    ]}
                  >
                    {per}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>CAPABILITIES</Text>
          <Text style={styles.sectionSubtitle}>
            For each capability: who answers it (your Dina, from your instructions and notes — or
            a connected agent), and whether answers go out automatically or wait for your
            approval.
          </Text>
          <View style={styles.card}>
            {capabilities.length === 0 ? (
              <Text style={styles.emptyText}>
                No capabilities configured yet. Tap “Add capability” to advertise one.
              </Text>
            ) : (
              capabilities.map((cap, idx) => {
                const friendly = capabilityDisplayName(cap.key);
                const isCatalog = friendly !== cap.key;
                return (
                  <View
                    key={cap.key}
                    style={[
                      styles.capabilityBlock,
                      idx === capabilities.length - 1 && styles.capabilityRowLast,
                    ]}
                  >
                    <View style={styles.capabilityHeaderRow}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        {/* Catalog caps: friendly name + the raw key as a muted
                          sub-line. Custom keys: just the key (mono). */}
                        <Text style={isCatalog ? styles.capabilityLabel : styles.capabilityName}>
                          {friendly}
                        </Text>
                        {isCatalog ? (
                          <Text style={styles.capabilityKeySub} numberOfLines={1}>
                            {cap.key}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => toggleCapabilityPolicy(cap.key)}
                        style={({ pressed }) => [styles.policyToggle, pressed && styles.pressed]}
                        testID={`service-settings-policy-${cap.key}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${friendly} response policy: ${cap.policy}. Tap to toggle.`}
                      >
                        <View
                          style={[styles.policyHalf, cap.policy === 'auto' && styles.policyActive]}
                        >
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
                        testID={`service-settings-remove-capability-${cap.key}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${friendly} capability`}
                        hitSlop={8}
                      >
                        <Ionicons name="close" size={16} color={colors.textSecondary} />
                      </Pressable>
                    </View>

                    {/* Execution plane (docs/SERVICE_PROVIDER_TIERS.md):
                        "My Dina" = Tier 1 prompt-provider (instruction +
                        the provider's own notes); "Agent" = a paired
                        dina-agent daemon executes. */}
                    <View style={styles.laneRow}>
                      <Text style={styles.laneLabel}>Answered by</Text>
                      <Pressable
                        onPress={() => toggleCapabilityLane(cap.key)}
                        style={({ pressed }) => [styles.policyToggle, pressed && styles.pressed]}
                        testID={`service-settings-lane-${cap.key}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${friendly} answered by: ${cap.lane === 'dina' ? 'my Dina' : 'a connected agent'}. Tap to toggle.`}
                      >
                        <View style={[styles.policyHalf, cap.lane === 'dina' && styles.policyActive]}>
                          <Text
                            style={[styles.policyText, cap.lane === 'dina' && styles.policyActiveText]}
                          >
                            My Dina
                          </Text>
                        </View>
                        <View style={[styles.policyHalf, cap.lane === 'agent' && styles.policyActive]}>
                          <Text
                            style={[styles.policyText, cap.lane === 'agent' && styles.policyActiveText]}
                          >
                            Agent
                          </Text>
                        </View>
                      </Pressable>
                    </View>

                    {cap.lane === 'dina' ? (
                      <TextInput
                        style={styles.instructionInput}
                        value={cap.instruction}
                        onChangeText={(t) => setCapabilityInstruction(cap.key, t)}
                        placeholder={'How should Dina answer? e.g. "Use my appointment notes to answer availability. If someone wants to book, ask me first."'}
                        placeholderTextColor={colors.textSecondary}
                        multiline
                        testID={`service-settings-instruction-${cap.key}`}
                        accessibilityLabel={`Instructions for how Dina answers ${friendly}`}
                      />
                    ) : (
                      <Text style={styles.laneHint}>
                        A connected agent executes this capability. Manage agents under
                        Settings → Agents.
                      </Text>
                    )}
                  </View>
                );
              })
            )}
          </View>
          <Pressable
            onPress={() => setAddModalVisible(true)}
            style={({ pressed }) => [styles.addCapButton, pressed && styles.pressed]}
            testID="service-settings-add-capability"
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
            testID="service-settings-add-modal-backdrop"
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
              <Text style={styles.modalTitle} accessibilityRole="header">
                Add capability
              </Text>
              <Text style={styles.modalSubtitle}>
                {discoverability === 'public'
                  ? 'Choose a category, then an official Dina capability.'
                  : 'Choose a category, then an official Dina capability, or define a custom one.'}
              </Text>

              {/* Single scroll context for the whole sheet body. The sheet is
                  capped at 85% height; the title above and Cancel below stay
                  pinned while the category list + capabilities + the note below
                  scroll between them. Without this the tall content (11
                  categories + capabilities) overflowed the sheet box and
                  spilled over the tab bar. */}
              <ScrollView
                style={styles.modalScroll}
                contentContainerStyle={styles.modalScrollContent}
                keyboardShouldPersistTaps="handled"
              >
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
                {/* Custom (namespaced) capability — allowed only when this
                    listing is NOT public. A public custom cap needs a
                    params/result schema the app can't author yet
                    (validateServiceListing §8.1), so for Public the picker is
                    catalog-only (and Provider-specific, the public+custom case,
                    is the disabled "coming soon" visibility tier). For Unlisted
                    / Private a custom cap saves fine with no schema. Needs a
                    category too (spec §5.1), so it's gated on one being picked. */}
                {discoverability !== 'public' && pickerCategoryId !== null ? (
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
                        testID="service-settings-custom-capability-input"
                        accessibilityLabel="Custom capability key"
                      />
                      <Text style={styles.modalHelpText}>
                        Use a logical FQDN (preferably something you own), e.g.
                        com.example.inventory_lookup.
                      </Text>
                      <Pressable
                        onPress={() => addCapability(customCapName, pickerCategoryId)}
                        disabled={customCapName.trim() === ''}
                        style={({ pressed }) => [
                          styles.modalAddButton,
                          pressed && styles.pressed,
                          customCapName.trim() === '' && styles.disabled,
                        ]}
                        testID="service-settings-add-custom-capability"
                        accessibilityRole="button"
                        accessibilityLabel="Add custom capability"
                      >
                        <Text style={styles.modalAddButtonText}>Add custom</Text>
                      </Pressable>
                    </View>
                  </>
                ) : null}
              </ScrollView>

              <Pressable
                onPress={() => setAddModalVisible(false)}
                style={({ pressed }) => [styles.modalCancelButton, pressed && styles.pressed]}
                testID="service-settings-add-modal-cancel"
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.modalCancelButtonText}>Cancel</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      </ScrollView>

      {/* Pinned footer — keeps the primary "Save changes" action always
          reachable above the keyboard + tab bar, regardless of how long
          the form scrolls. (Was the last child of the ScrollView, which
          parked it below the fold on long listings.) */}
      <View style={styles.footer}>
        <Pressable
          onPress={onSave}
          disabled={saving}
          testID="service-settings-save"
          accessibilityRole="button"
          accessibilityLabel="Save changes"
          accessibilityState={{ disabled: saving, busy: saving }}
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
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  centered: { justifyContent: 'center', alignItems: 'center' },
  scrollFlex: { flex: 1 },
  scrollContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
  },
  footer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgPrimary,
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
  // Disabled "Provider-specific" tier — greyed but still readable so the
  // concept registers; tap shows a "coming soon" popup.
  rowDisabled: {
    opacity: 0.5,
  },
  comingSoonPill: {
    ...textStyles.tiny,
    color: colors.textMuted,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: 'hidden',
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
  // Per-capability block: header row + execution-plane selector +
  // instruction editor (Tier 1) stacked under one bottom border.
  capabilityBlock: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  capabilityHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  laneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  laneLabel: {
    ...textStyles.caption,
  },
  laneHint: {
    ...textStyles.caption,
    marginTop: spacing.xs,
  },
  personaPinRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  personaChip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  personaChipActive: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary,
  },
  personaChipText: {
    ...textStyles.caption,
  },
  personaChipTextActive: {
    color: colors.bgPrimary,
  },
  instructionInput: {
    ...textStyles.body,
    marginTop: spacing.xs,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    minHeight: 64,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 8,
  },
  capabilityRowLast: {
    borderBottomWidth: 0,
  },
  capabilityName: textStyles.mono,
  // Friendly catalog name (primary) + the raw key beneath it (muted/mono).
  capabilityLabel: textStyles.body,
  capabilityKeySub: {
    ...textStyles.mono,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted,
    marginTop: 1,
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
  // The scrollable middle of the sheet. `flexShrink` lets it give up height
  // to the pinned title/cancel so the sheet stays within `maxHeight` and the
  // body scrolls instead of overflowing the box.
  modalScroll: {
    flexShrink: 1,
  },
  modalScrollContent: {
    paddingBottom: spacing.xs,
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
  // CUSTOM-section card. Dashed accent border + tinted background sets it
  // apart from the white catalog card so the alternative path is unmistakable.
  customCard: {
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.accent,
    padding: spacing.md,
  },
  // Input inside the dashed CUSTOM card — solid background + hairline border so
  // it reads unambiguously as "type here" (the shared `input` style is borderless).
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
