/**
 * Inbound skill resolution, access mode and executor selection (design
 * §7.1, §7.2 step 7, §7.2a, §7.3). Pure reads over the live listings, the
 * client's grants and the runner bindings; the ingress route calls it, and
 * so does the card projection, so a skill the card leaves out can never be
 * reached by naming it.
 *
 *  1. The action registry first (§5.4): a custom, commerce, unknown or
 *     `payment` capability is refused before any listing is looked at.
 *  2. The listing (§7.2a), against Core's live registry, never a card, and
 *     only an `active` listing on `surface:'services'`:
 *       - `capability@rkey` names one listing: its discoverability sets the
 *         access mode;
 *       - a `grant_id` names its grant's listing: the grant must be this
 *         client's, live, and for this capability;
 *       - a bare capability resolves among PUBLIC listings only, and must
 *         resolve to exactly one.
 *  3. The access mode (total): public → in the client's scope (empty = all
 *     public); unlisted by exact reference → passes (the shipped D2D rule);
 *     known_only → only through a grant.
 *  4. The executor (§7.3), chosen deterministically and never the reasoning
 *     submitter: a sound plugin binding → the plugin lane; an `mcpServer`
 *     lane → only with a live runner binding, whose device DID becomes the
 *     operation's PEP; an instruction and no `mcpServer` → in-process Tier 1.
 *     A listing naming a reserved lane has no executor.
 */

import { ambiguousCanonicals, qualifySkill, type InvocationEnvelope } from '@dina/a2a';
import { effectiveDiscoverability, effectiveListingStatus, effectiveSurface } from '@dina/protocol';

import { getPluginInstallRepository } from '../plugins/registry';
import { namesReservedLane } from '../service/reserved_lanes';
import { configuredCapabilityKey, listServiceConfigs, getServiceConfig, pluginBindingProblem } from '../service/service_config';

import { classifyInboundCapability, type InboundActionClass, type InboundClassificationFailure } from './action_registry';
import { liveRunnerBinding } from './runner_bindings';

import type { PinnedSchemaPair } from './normalize';
import type { A2AStore } from './store';
import type { ServiceGrantRepository } from '../service/service_grant_repository';
import type { ServiceCapabilityConfig, ServiceConfig } from '@dina/protocol';

export const INBOUND_ACCESS_FAILURES = [
  'skill_unknown',
  'skill_ambiguous',
  'not_public_exposable',
  'not_in_scope',
  'grant_not_authorized',
  'no_executor',
] as const;
export type InboundAccessFailure = (typeof INBOUND_ACCESS_FAILURES)[number];

export type A2AExecutor =
  | { kind: 'plugin'; installId: string; manifestCid: string; capabilityId: string }
  | { kind: 'mcp_server'; lane: string; mcpTool: string; pepDid: string }
  | { kind: 'tier1' };

export type AccessMode = 'public' | 'unlisted' | 'known_only';

export interface ResolvedInboundSkill {
  rkey: string;
  config: ServiceConfig;
  /** The capability as the listing configured it. */
  configuredKey: string;
  cap: ServiceCapabilityConfig;
  canonical: string;
  actionClass: InboundActionClass;
  mode: AccessMode;
  grantId?: string;
  executor: A2AExecutor;
  /** The pinned schema pair, or null when the listing publishes none. */
  schemas: PinnedSchemaPair | null;
}

export type InboundResolution =
  | { ok: true; resolved: ResolvedInboundSkill }
  | { ok: false; reason: InboundClassificationFailure | InboundAccessFailure };

/**
 * The executor A2A work on this capability runs on, or null when it has
 * none A2A may use. The same function decides projection, invocation and
 * the claim-time re-check.
 *
 * `actionClass` is the catalog class the call is judged by (§5.4). A plugin
 * declares its own class for the code that actually runs; when the two
 * differ, the plugin is no executor for this name: a booking plugin bound
 * under a read name would otherwise run with no review and no permit, and
 * a payment one would slip past the payment rule.
 */
export function selectA2AExecutor(
  store: A2AStore,
  cap: ServiceCapabilityConfig,
  actionClass: InboundActionClass | null,
): A2AExecutor | null {
  if (namesReservedLane(cap)) return null;
  const installId = cap.pluginInstallId ?? '';
  const manifestCid = cap.pluginManifestCid ?? '';
  const capabilityId = cap.pluginCapabilityId ?? '';
  if (installId !== '' || manifestCid !== '' || capabilityId !== '') {
    // A capability with any part of a plugin binding runs on that install or
    // nowhere: a partial or unsound binding is no executor.
    if (installId === '' || manifestCid === '' || capabilityId === '') return null;
    if (pluginBindingProblem(cap) !== null) return null;
    const declared = getPluginInstallRepository()
      ?.getById(installId)
      ?.manifest.capabilities.find((c: { id: string }) => c.id === capabilityId) as { action_class?: unknown } | undefined;
    if (actionClass === null || declared?.action_class !== actionClass) return null;
    return { kind: 'plugin', installId, manifestCid, capabilityId };
  }
  const lane = typeof cap.mcpServer === 'string' ? cap.mcpServer : '';
  if (lane !== '') {
    const tool = typeof cap.mcpTool === 'string' ? cap.mcpTool : '';
    const binding = tool === '' ? null : liveRunnerBinding(store, lane);
    return binding === null ? null : { kind: 'mcp_server', lane, mcpTool: tool, pepDid: binding.device_did };
  }
  const instruction = typeof cap.instruction === 'string' ? cap.instruction.trim() : '';
  return instruction === '' ? null : { kind: 'tier1' };
}

/** An active `surface:'services'` listing, or null. */
function liveServicesListing(rkey: string): ServiceConfig | null {
  const config = getServiceConfig(rkey);
  if (config === null) return null;
  if (effectiveListingStatus(config) !== 'active' || effectiveSurface(config) !== 'services') return null;
  return config;
}

/** The pinned schema pair a listing publishes for one configured capability, or null. */
export function pinnedSchemasOf(config: ServiceConfig, configuredKey: string): PinnedSchemaPair | null {
  const s = config.capabilitySchemas?.[configuredKey];
  if (s === undefined || typeof s.params !== 'object' || s.params === null) return null;
  return {
    params: s.params,
    result: s.result,
    ...(s.description === undefined ? {} : { description: s.description }),
    ...(s.schemaHash === '' ? {} : { storedHash: s.schemaHash }),
  };
}

/** Resolve one invocation for one authenticated principal. */
/** How a listing is reached: its effective discoverability, as one access mode. */
function accessModeOf(listing: ServiceConfig): AccessMode {
  const discoverability = effectiveDiscoverability(listing);
  return discoverability === 'public' ? 'public' : discoverability === 'unlisted' ? 'unlisted' : 'known_only';
}

export function resolveInboundSkill(args: {
  store: A2AStore;
  grants: ServiceGrantRepository | null;
  principal: string;
  /** The client's public-skill scope; empty means every public skill. */
  scope: readonly string[];
  envelope: InvocationEnvelope;
  nowMs: number;
}): InboundResolution {
  const { envelope } = args;
  const classified = classifyInboundCapability(envelope.skill.capability);
  if (!classified.ok) return { ok: false, reason: classified.reason };
  const { canonical, actionClass, publicExposureAllowed } = classified;

  let rkey: string;
  let config: ServiceConfig;
  let configuredKey: string;
  let mode: AccessMode;
  let grantId: string | undefined;

  if (envelope.skill.rkey !== undefined) {
    const listing = liveServicesListing(envelope.skill.rkey);
    const key = listing === null ? null : configuredCapabilityKey(listing, envelope.skill.capability);
    if (listing === null || key === null) return { ok: false, reason: 'skill_unknown' };
    rkey = envelope.skill.rkey;
    config = listing;
    configuredKey = key;
    mode = accessModeOf(listing);
  } else if (envelope.grantId !== undefined) {
    const grant = args.grants?.getById(envelope.grantId) ?? null;
    if (grant === null || grant.granteeDid !== args.principal) return { ok: false, reason: 'grant_not_authorized' };
    const listing = liveServicesListing(grant.serviceRkey);
    const key = listing === null ? null : configuredCapabilityKey(listing, envelope.skill.capability);
    if (listing === null || key === null) return { ok: false, reason: 'skill_unknown' };
    rkey = grant.serviceRkey;
    config = listing;
    configuredKey = key;
    // The listing decides, as for a named rkey: a grant on a public listing
    // adds nothing (the public rules and the scope decide, as the card shows).
    mode = accessModeOf(listing);
  } else {
    const matches = listServiceConfigs().flatMap(({ rkey: r }) => {
      const listing = liveServicesListing(r);
      if (listing === null || effectiveDiscoverability(listing) !== 'public') return [];
      const key = configuredCapabilityKey(listing, envelope.skill.capability);
      return key === null ? [] : [{ rkey: r, listing, key }];
    });
    const [only, second] = matches;
    if (only === undefined) return { ok: false, reason: 'skill_unknown' };
    if (second !== undefined) return { ok: false, reason: 'skill_ambiguous' };
    rkey = only.rkey;
    config = only.listing;
    configuredKey = only.key;
    mode = 'public';
  }

  // One rule with the card (§7.3): a capability this listing configures under
  // two names (itself and an alias) is ambiguous for every call to it, by any
  // name; the card leaves it off for the same reason.
  const configured = Object.keys(config.capabilities).map((key) => {
    const c = classifyInboundCapability(key);
    return { canonical: c.ok ? c.canonical : null };
  });
  if (ambiguousCanonicals(configured).has(canonical)) return { ok: false, reason: 'skill_ambiguous' };

  // The access mode, total over the three.
  if (mode === 'public') {
    // The rule the listing validator and the card apply (taxonomy §3): a
    // sensitive or subject-scoped capability is never public, whatever a
    // listing row says.
    if (!publicExposureAllowed) return { ok: false, reason: 'not_public_exposable' };
    if (args.scope.length > 0 && !args.scope.includes(qualifySkill(canonical, rkey)) && !args.scope.includes(canonical)) {
      return { ok: false, reason: 'not_in_scope' };
    }
  } else if (mode === 'known_only' || envelope.grantId !== undefined) {
    // A grant is the only door to a known_only skill; a grant presented for
    // any other listing must still be this client's and live.
    const authorized =
      envelope.grantId !== undefined &&
      args.grants !== null &&
      args.grants.isAuthorized({
        granteeDid: args.principal,
        serviceRkey: rkey,
        capability: configuredKey,
        grantId: envelope.grantId,
        nowSec: Math.floor(args.nowMs / 1000),
      });
    if (!authorized) return { ok: false, reason: 'grant_not_authorized' };
    grantId = envelope.grantId;
  }

  const cap = config.capabilities[configuredKey];
  const executor = cap === undefined ? null : selectA2AExecutor(args.store, cap, actionClass);
  if (cap === undefined || executor === null) return { ok: false, reason: 'no_executor' };
  return {
    ok: true,
    resolved: {
      rkey,
      config,
      configuredKey,
      cap,
      canonical,
      actionClass,
      mode,
      ...(grantId === undefined ? {} : { grantId }),
      executor,
      schemas: pinnedSchemasOf(config, configuredKey),
    },
  };
}
