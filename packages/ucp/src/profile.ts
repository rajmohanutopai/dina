/**
 * UCP profiles (overview/index.md:1248-1530; profile.json, ucp.json,
 * service.json, capability.json):
 *  - a merchant's `/.well-known/ucp` parsed into what Dina needs, tolerating
 *    unknown members (the `ucp` container is open, :1574-1580);
 *  - Dina's own buyer profile, built as exact canonical bytes so its hash can be
 *    signed into the publication envelope (UCP plan §3.5).
 */

import { canonicalize, isPlainObject, type JsonObject } from '@dina/a2a';

import {
  DINA_CAPABILITIES,
  DINA_SERVICES,
  IDENTITY_LINKING_DECLARATION,
  SHOPPING_SERVICE,
  SPEC_OVERVIEW,
  type CapabilityDeclaration,
} from './capabilities';
import { UCP_VERSION, VERSION_PATTERN } from './version';

import type { Es256Jwk } from './jwk';

/** reverse_domain_name.json (v2026-08-25). */
export const REVERSE_DOMAIN_NAME =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+$/;

export interface ServiceEntry {
  version: string;
  transport: string;
  endpoint?: string;
  schema?: string;
}

export interface CapabilityEntry {
  version: string;
  schema: string;
  spec?: string;
  /** Parent capability names this extension extends (one or more). */
  extends?: string[];
  config?: Record<string, unknown>;
}

export interface MerchantProfile {
  version: string;
  /** `supported_versions`: version → leaf profile URL. */
  supportedVersions: Record<string, string>;
  services: Record<string, ServiceEntry[]>;
  capabilities: Record<string, CapabilityEntry[]>;
  /** Top-level `keys[]`, raw; read with `usableEs256Keys`. */
  keys: unknown[];
}

export type ProfileParse = { ok: true; profile: MerchantProfile } | { ok: false; reason: string };

/**
 * Parse a merchant profile. Malformed required parts refuse the profile
 * (`profile_malformed`); a malformed single entry inside a registry is dropped,
 * as an entry Dina cannot read is an entry it cannot use.
 */
export function parseMerchantProfile(value: unknown): ProfileParse {
  if (!isPlainObject(value) || !isPlainObject(value.ucp))
    return { ok: false, reason: 'no_ucp_object' };
  const ucp = value.ucp;
  if (typeof ucp.version !== 'string' || !VERSION_PATTERN.test(ucp.version))
    return { ok: false, reason: 'bad_version' };
  if (!isPlainObject(ucp.services)) return { ok: false, reason: 'no_services' };
  if (!isPlainObject(ucp.payment_handlers)) return { ok: false, reason: 'no_payment_handlers' };
  if (ucp.capabilities !== undefined && !isPlainObject(ucp.capabilities))
    return { ok: false, reason: 'bad_capabilities' };

  const supportedVersions: Record<string, string> = {};
  if (ucp.supported_versions !== undefined) {
    if (!isPlainObject(ucp.supported_versions))
      return { ok: false, reason: 'bad_supported_versions' };
    for (const [version, url] of Object.entries(ucp.supported_versions)) {
      if (VERSION_PATTERN.test(version) && typeof url === 'string')
        supportedVersions[version] = url;
    }
  }

  const services: Record<string, ServiceEntry[]> = {};
  for (const [name, entries] of Object.entries(ucp.services)) {
    if (!REVERSE_DOMAIN_NAME.test(name) || !Array.isArray(entries)) continue;
    const parsed: ServiceEntry[] = [];
    for (const e of entries) {
      if (!isPlainObject(e) || typeof e.version !== 'string' || typeof e.transport !== 'string')
        continue;
      const entry: ServiceEntry = { version: e.version, transport: e.transport };
      if (typeof e.endpoint === 'string') entry.endpoint = e.endpoint;
      if (typeof e.schema === 'string') entry.schema = e.schema;
      parsed.push(entry);
    }
    services[name] = parsed;
  }

  const capabilities: Record<string, CapabilityEntry[]> = {};
  for (const [name, entries] of Object.entries(ucp.capabilities ?? {})) {
    if (!REVERSE_DOMAIN_NAME.test(name) || !Array.isArray(entries)) continue;
    const parsed: CapabilityEntry[] = [];
    for (const e of entries) {
      // capability.json business entry: version and schema required.
      if (!isPlainObject(e) || typeof e.version !== 'string' || typeof e.schema !== 'string')
        continue;
      const entry: CapabilityEntry = { version: e.version, schema: e.schema };
      if (typeof e.spec === 'string') entry.spec = e.spec;
      if (typeof e.extends === 'string') entry.extends = [e.extends];
      else if (Array.isArray(e.extends) && e.extends.every((x) => typeof x === 'string'))
        entry.extends = e.extends as string[];
      else if (e.extends !== undefined) continue;
      if (isPlainObject(e.config)) entry.config = e.config;
      parsed.push(entry);
    }
    capabilities[name] = parsed;
  }

  const keys = Array.isArray(value.keys) ? value.keys : [];
  return {
    ok: true,
    profile: { version: ucp.version, supportedVersions, services, capabilities, keys },
  };
}

// ------------------------------------------------------------ Dina's profile

export interface BuyerProfileInput {
  /** The UCP signing key's public JWK(s), active first (UCP plan §3.1). */
  keys: readonly Es256Jwk[];
  /** `config.webhook_url` of the order capability: a public server's own, or the drop-box (S8, S9). */
  webhookUrl: string;
  /** Declare identity linking (from U4). */
  identityLinking?: boolean;
}

/** Dina's buyer profile as a JSON value (§3.5). */
export function buildBuyerProfile(input: BuyerProfileInput): JsonObject {
  const declarations: CapabilityDeclaration[] = [...DINA_CAPABILITIES];
  if (input.identityLinking === true) declarations.push(IDENTITY_LINKING_DECLARATION);
  const capabilities: JsonObject = {};
  for (const d of declarations) {
    const entry: JsonObject = { version: UCP_VERSION, spec: d.spec, schema: d.schema };
    if (d.extends !== undefined) entry.extends = d.extends;
    if (d.name === 'dev.ucp.shopping.order') entry.config = { webhook_url: input.webhookUrl };
    capabilities[d.name] = [entry];
  }
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [SHOPPING_SERVICE]: DINA_SERVICES.map((s) => ({
          version: UCP_VERSION,
          spec: SPEC_OVERVIEW,
          transport: s.transport,
          schema: s.schema,
        })),
      },
      capabilities,
      payment_handlers: {},
    },
    keys: input.keys.map((k) => ({ ...k })),
  };
}

/** The exact bytes of Dina's profile document (RFC 8785 canonical JSON), as hashed and served. */
export function buyerProfileBytes(input: BuyerProfileInput): string {
  return canonicalize(buildBuyerProfile(input));
}
