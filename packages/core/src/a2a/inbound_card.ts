/**
 * Lane 2's public Agent Card (design §7.1, §7.6; plan §3.13, §3.22).
 *
 * Core classifies every listing capability with the functions invocation
 * uses — the action registry (§5.4), the pinned-schema audit and hash, and
 * §7.3's executor selection — and `@dina/a2a`'s projection applies the
 * inclusion rules. So a skill on the card is one a call can reach, and a
 * skill a call cannot reach is never on the card.
 *
 * The card is signed (JWS, ES256) with the card key of plan D4, derived from
 * the master seed at `m/9999'/5'/{generation}'`. Its `kid` is the key's
 * RFC 7638 thumbprint and its `jku` the gateway's JWK Set, which this module
 * also builds; publishing the key in the DID document waits for Lane 3 (M5).
 *
 * Only Core decides what the card says: the public URL comes from Core's own
 * configuration, never from the gateway that asks for the card, so a
 * compromised gateway cannot get Dina's signature on a card that sends
 * clients elsewhere.
 *
 * The extended card (M3, A2A §3.1.11) is the same projection for one
 * authenticated client: the public skills in its scope, and those its live
 * grants open (§7.1), each grant re-checked when the card is built, so a
 * revoked grant's skill is gone from the next card. It is signed with the
 * same key. A client that can reach no skill has no card to receive.
 */

import { p256 } from '@noble/curves/nist.js';

import {
  A2A_LIMITS,
  A2A_NAME_MAX_CODE_POINTS,
  MAX_TEXT_CODE_POINTS,
  a2aDisplayText,
  base64urlEncode,
  canonicalize,
  dinaCardFrame,
  ingressRouteOf,
  jsonRpcResult,
  projectAgentCard,
  cardSigningForms,
  signAgentCard,
  type AgentCard,
  type CardAudience,
  type JsonObject,
  type JsonValue,
  type ProjectionCapability,
  type ProjectionListing,
} from '@dina/a2a';
import {
  effectiveDiscoverability,
  effectiveListingStatus,
  effectiveSurface,
  getCatalogCapability,
} from '@dina/protocol';

import { validateAgainstSchema } from '../plugins/schema_validate';
import { capabilitySchemaHash } from '../service/capability_schema_hash';
import { listServiceConfigs, type ServiceConfig } from '../service/service_config';

import { classifyInboundCapability } from './action_registry';
import { jwkThumbprint } from './card_keys';
import { sha256HexOfText } from './digest';
import { pinnedSchemasOf, selectA2AExecutor } from './inbound_resolve';
import {
  admitIngress,
  rpcError,
  slowDown,
  type GatewayAnswer,
  type GatewayEnvelope,
  type InboundRuntime,
} from './ingress_common';
import { schemaPairEnforceable } from './normalize';

import type { A2AStore } from './store';
import type { ServiceGrantRepository } from '../service/service_grant_repository';

/** The JWK Set path the card's `jku` names, on the gateway's public origin. */
export const A2A_JWKS_PATH = '/.well-known/jwks.json';

const DEFAULT_CARD_DESCRIPTION = 'Services this Dina node offers to other agents.';
const DEFAULT_CARD_NAME = 'A Dina node';

/** The card key: an ES256 key pair from `m/9999'/5'/{generation}'`. */
export interface A2ACardKey {
  privateKey: Uint8Array;
  generation: number;
}

/** What a host serving Lane 2 configures: the card key and the gateway's public origin. */
export interface A2ACardConfig {
  key: A2ACardKey;
  /** `https://host[:port]` (plain http only on loopback), no path, query or credentials. */
  publicOrigin: string;
}

let cardConfig: A2ACardConfig | null = null;

/**
 * Hosts that serve Lane 2 install the card config at boot; null removes it.
 * Throws on an origin that is not a bare https origin, so a misconfigured
 * host fails at boot, not on the first card request.
 */
export function installA2ACardConfig(config: A2ACardConfig | null): void {
  if (config === null) {
    cardConfig = null;
    return;
  }
  const origin = parseA2APublicOrigin(config.publicOrigin);
  if (origin === null) throw new Error('A2A public origin must be a bare https origin');
  cardConfig = { key: { privateKey: config.key.privateKey.slice(), generation: config.key.generation }, publicOrigin: origin };
}

export function getA2ACardConfig(): A2ACardConfig | null {
  return cardConfig;
}

/** The public JWK of a card key, with its RFC 7638 thumbprint as `kid`. */
/** The card key's public point, compressed (33 bytes): the form the DID document's `#a2a_card` Multikey takes. */
export function cardPublicKey(key: A2ACardKey): Uint8Array {
  return p256.getPublicKey(key.privateKey, true);
}

export function cardPublicJwk(key: A2ACardKey): JsonObject {
  const point = p256.getPublicKey(key.privateKey, false);
  const x = point.slice(1, 33);
  const y = point.slice(33);
  const kid = jwkThumbprint({ kty: 'EC', crv: 'P-256', x, y });
  return { kty: 'EC', crv: 'P-256', x: base64urlEncode(x), y: base64urlEncode(y), kid, use: 'sig', alg: 'ES256' };
}

export type InboundCardResult =
  | { ok: true; card: AgentCard; jwks: { keys: JsonObject[] } }
  | { ok: false; reason: 'no_projectable_skills' | 'public_origin_invalid' | 'card_too_large' };

/**
 * Why invocation refuses a skill on the card's own grounds, so no card shows
 * it: its id is longer than a card allows (`skillIdFits`), or it would take
 * more of a card than one skill may (`skillShareFits`).
 */
export const INBOUND_CARD_FAILURES = ['skill_id_too_long', 'skill_too_large'] as const;
export type InboundCardFailure = (typeof INBOUND_CARD_FAILURES)[number];

/** One listing capability, classified exactly as invocation would classify it. */
export function projectionCapability(store: A2AStore, config: ServiceConfig, configuredKey: string): ProjectionCapability {
  const cap = config.capabilities[configuredKey];
  const cls = classifyInboundCapability(configuredKey);
  const canonical = cls.ok ? cls.canonical : null;
  const def = canonical === null ? null : getCatalogCapability(canonical);
  const schemas = pinnedSchemasOf(config, configuredKey);
  let schemaHash: string | undefined;
  if (schemas !== null) {
    try {
      // The hash invocation recomputes and always accepts.
      schemaHash = capabilitySchemaHash(schemas);
    } catch {
      schemaHash = undefined; // not hashable: invocation refuses it as schema_unenforceable
    }
  }
  return {
    capability: configuredKey,
    canonical,
    actionClass: cls.ok ? cls.actionClass : null,
    publicExposureAllowed: cls.ok && cls.publicExposureAllowed,
    ...(schemas === null || schemaHash === undefined ? {} : { paramsSchema: schemas.params as JsonObject, schemaHash }),
    schemasEnforceable: schemas !== null && schemaPairEnforceable(schemas),
    executor: cap === undefined ? null : (selectA2AExecutor(store, cap, cls.ok ? cls.actionClass : null)?.kind ?? null),
    displayName: def?.display_name ?? configuredKey,
    description: schemas?.description ?? def?.short_description ?? '',
    tags: def === null ? [] : [...def.category_ids],
  };
}

/** Every listing, classified (the projection applies the inclusion rules). */
export function inboundProjectionListings(store: A2AStore): ProjectionListing[] {
  return listServiceConfigs().map(({ rkey, config }) => ({
    rkey,
    status: effectiveListingStatus(config),
    discoverability: effectiveDiscoverability(config),
    surface: effectiveSurface(config),
    capabilities: Object.keys(config.capabilities)
      .sort()
      .map((key) => projectionCapability(store, config, key)),
  }));
}

/**
 * The card's name and description: the default `self` listing's when it is
 * live and public on the services surface, else the first such listing's.
 * An extended card may also take them from a listing the client's own
 * grants open (`alsoRkeys`), never from one it cannot see.
 */
function cardIdentity(alsoRkeys: ReadonlySet<string> = new Set()): { name: string; description: string } | null {
  const live = listServiceConfigs().filter(
    ({ rkey, config }) =>
      effectiveListingStatus(config) === 'active' &&
      (effectiveDiscoverability(config) === 'public' || alsoRkeys.has(rkey)) &&
      effectiveSurface(config) === 'services',
  );
  // A public listing names the card before a granted one does.
  const pub = live.filter(({ config }) => effectiveDiscoverability(config) === 'public');
  const chosen = pub.find((l) => l.rkey === 'self') ?? pub[0] ?? live.find((l) => l.rkey === 'self') ?? live[0];
  if (chosen === undefined) return null;
  // Bounded as the words of a remote are: the listing validator bounds neither
  // field, and one long description must not push the whole card past its cap.
  const name = a2aDisplayText(chosen.config.name, A2A_NAME_MAX_CODE_POINTS);
  const description = a2aDisplayText(chosen.config.description ?? '', MAX_TEXT_CODE_POINTS);
  return {
    name: name === '' ? DEFAULT_CARD_NAME : name,
    description: description === '' ? DEFAULT_CARD_DESCRIPTION : description,
  };
}

/**
 * The bare https origin `raw` names (plain http only on loopback, for
 * tests), or null: no credentials, path, query or fragment. Hosts check
 * their configuration with it before boot.
 */
export function parseA2APublicOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
    return null;
  }
  if (url.username !== '' || url.password !== '' || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url.origin;
}

/**
 * The card's version: `1.0.0+` and the first 16 hex of the digest of
 * everything else on it, so any change to what it says changes it.
 */
function cardVersion(card: AgentCard): string {
  const { version: _version, signatures: _signatures, ...rest } = card;
  return `1.0.0+${sha256HexOfText(canonicalize(rest as unknown as JsonObject)).slice(0, 16)}`;
}

/** Project, then sign, the public card (or, with an audience, one client's extended card); with it, the JWK Set its `jku` names. */
export async function buildInboundCard(
  store: A2AStore,
  args: { nodeDid: string; config: A2ACardConfig; audience?: CardAudience },
): Promise<InboundCardResult> {
  const { key } = args.config;
  const origin = parseA2APublicOrigin(args.config.publicOrigin);
  if (origin === null) return { ok: false, reason: 'public_origin_invalid' };
  const identity = cardIdentity(new Set(args.audience?.grants.map((g) => g.rkey) ?? []));
  if (identity === null) return { ok: false, reason: 'no_projectable_skills' };
  const projected = projectAgentCard({
    nodeDid: args.nodeDid,
    name: identity.name,
    description: identity.description,
    version: '',
    ...dinaCardFrame(origin),
    listings: inboundProjectionListings(store),
    ...(args.audience === undefined ? {} : { audience: args.audience }),
    // An example is checked by the validator invocation uses: one it would refuse never goes on the card.
    acceptsExample: (params, schema) => validateAgainstSchema(params, schema).ok,
  });
  if (!projected.ok) return { ok: false, reason: projected.reason };
  const jwk = cardPublicJwk(key);
  const card: AgentCard = { ...projected.card, version: cardVersion(projected.card) };
  // One signature per form that differs (§6.6): every bearer card has a
  // scope-less requirement, which the reference SDK's form drops, so its
  // verifier needs a signature of its own.
  const unsigned = card as unknown as Record<string, unknown>;
  const signatures = await Promise.all(
    cardSigningForms(unsigned).map((form) =>
      signAgentCard(
        unsigned,
        { alg: 'ES256', kid: jwk.kid as string, jku: `${origin}${A2A_JWKS_PATH}` },
        (input) => p256.sign(input, key.privateKey),
        form,
      ),
    ),
  );
  const signed: AgentCard = { ...card, signatures };
  // A card larger than any A2A client or the directory accepts (design §6.6,
  // §8.3) is no card: the owner sees why, rather than a card nobody can read.
  if (new TextEncoder().encode(canonicalize(signed as unknown as JsonValue)).length > A2A_LIMITS.maxCardBytes) {
    return { ok: false, reason: 'card_too_large' };
  }
  return { ok: true, card: signed, jwks: { keys: [jwk] } };
}

/** A client's live grants, as the extended card's audience reads them: checked now, at build time. */
export function liveGrantsOf(
  grants: ServiceGrantRepository | null,
  principal: string,
  nowMs: number,
): CardAudience['grants'] {
  if (grants === null) return [];
  const nowSec = Math.floor(nowMs / 1000);
  return grants
    .listByGrantee(principal)
    .filter((g) =>
      grants.isAuthorized({
        granteeDid: principal,
        serviceRkey: g.serviceRkey,
        capability: g.capability,
        grantId: g.grantId,
        nowSec,
      }),
    )
    .map((g) => ({ grantId: g.grantId, rkey: g.serviceRkey, capability: g.capability }));
}

/** `GetExtendedAgentCard` (A2A §3.1.11, design §7.1): the authenticated client's own card. */
export async function ingressGetExtendedAgentCard(
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
  card: { nodeDid: string; config: A2ACardConfig } | null,
): Promise<GatewayAnswer> {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf('GetExtendedAgentCard'), params: {} });
  if (!admitted.ok) return admitted.answer;
  const now = rt.a2a.nowMs();
  if (!rt.budgets.chargeRead(admitted.principal, now)) return slowDown();
  if (card === null) return rpcError(admitted.id, 'extendedAgentCardNotConfigured');
  const built = await buildInboundCard(rt.a2a.store, {
    ...card,
    audience: { scope: admitted.scope, grants: liveGrantsOf(rt.grants, admitted.principal, now) },
  });
  if (!built.ok) {
    return rpcError(admitted.id, 'extendedAgentCardNotConfigured', built.reason === 'no_projectable_skills' ? 'no_skills_for_client' : built.reason);
  }
  return { status: 200, body: jsonRpcResult(admitted.id, built.card as unknown as JsonValue) };
}
