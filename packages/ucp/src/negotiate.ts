/**
 * Version choice, entry filtering and capability intersection, done the way
 * the merchant will do them, so Dina can predict what a merchant will serve
 * and refuse an operation it cannot (UCP plan §3.6 steps 2-4).
 */

import { checkAuthorityBinding } from './authority';
import { DINA_CAPABILITIES, IDENTITY_LINKING_DECLARATION, SHOPPING_SERVICE } from './capabilities';
import { UCP_VERSION } from './version';

import type { CapabilityEntry, MerchantProfile, ServiceEntry } from './profile';

// ------------------------------------------------------------ version choice

export type VersionChoice =
  | { kind: 'current' }
  | { kind: 'leaf'; url: string }
  | { kind: 'none'; offered: string[] };

/**
 * overview :3508-3539: the newest version both sides speak. Dina speaks one
 * (S20), so: the merchant's current version if it is ours, else its
 * `supported_versions` leaf for ours, else none.
 */
export function chooseVersion(profile: MerchantProfile): VersionChoice {
  if (profile.version === UCP_VERSION) return { kind: 'current' };
  const leaf = profile.supportedVersions[UCP_VERSION];
  if (leaf !== undefined) return { kind: 'leaf', url: leaf };
  return { kind: 'none', offered: [profile.version, ...Object.keys(profile.supportedVersions)] };
}

/**
 * A fetched leaf is usable only if its `ucp.version` equals the version chosen
 * (:3524-3529) and it carries no `supported_versions` (leaf profiles MUST NOT,
 * :3531-3533).
 */
export function checkLeaf(leaf: MerchantProfile): { ok: true } | { ok: false; reason: string } {
  if (leaf.version !== UCP_VERSION) return { ok: false, reason: 'leaf_version_mismatch' };
  if (Object.keys(leaf.supportedVersions).length > 0)
    return { ok: false, reason: 'leaf_has_supported_versions' };
  return { ok: true };
}

// ------------------------------------------------------------ filtering

export interface DroppedEntry {
  name: string;
  reason: 'version_mismatch' | 'authority' | 'unsupported_transport' | 'no_endpoint';
}

export interface FilteredProfile {
  /** Usable `dev.ucp.shopping` endpoints by transport. */
  endpoints: { mcp?: string; rest?: string };
  capabilities: Record<string, CapabilityEntry[]>;
  dropped: DroppedEntry[];
}

/**
 * Drop entries Dina must not use: any `dev.ucp.*` entry whose `version`
 * differs from the profile's (:3711-3716); any entry whose `schema` URL fails
 * authority binding (:949-955); shopping service entries for a transport Dina
 * does not speak, or with no https endpoint.
 */
export function filterProfile(profile: MerchantProfile): FilteredProfile {
  const dropped: DroppedEntry[] = [];
  const endpoints: { mcp?: string; rest?: string } = {};
  for (const s of profile.services[SHOPPING_SERVICE] ?? []) {
    if (!serviceUsable(profile, s, dropped)) continue;
    const t = s.transport as 'mcp' | 'rest';
    if (endpoints[t] === undefined) endpoints[t] = (s.endpoint as string).replace(/\/$/, '');
  }
  const capabilities: Record<string, CapabilityEntry[]> = {};
  for (const [name, entries] of Object.entries(profile.capabilities)) {
    const kept: CapabilityEntry[] = [];
    for (const e of entries) {
      if (name.startsWith('dev.ucp.') && e.version !== profile.version) {
        dropped.push({ name, reason: 'version_mismatch' });
        continue;
      }
      if (!checkAuthorityBinding(name, e.schema).ok) {
        dropped.push({ name, reason: 'authority' });
        continue;
      }
      kept.push(e);
    }
    if (kept.length > 0) capabilities[name] = kept;
  }
  return { endpoints, capabilities, dropped };
}

function serviceUsable(
  profile: MerchantProfile,
  s: ServiceEntry,
  dropped: DroppedEntry[],
): boolean {
  if (s.version !== profile.version) {
    dropped.push({ name: SHOPPING_SERVICE, reason: 'version_mismatch' });
    return false;
  }
  if (s.transport !== 'mcp' && s.transport !== 'rest') {
    dropped.push({ name: SHOPPING_SERVICE, reason: 'unsupported_transport' });
    return false;
  }
  if (s.schema !== undefined && !checkAuthorityBinding(SHOPPING_SERVICE, s.schema).ok) {
    dropped.push({ name: SHOPPING_SERVICE, reason: 'authority' });
    return false;
  }
  if (s.endpoint === undefined || !s.endpoint.startsWith('https://')) {
    dropped.push({ name: SHOPPING_SERVICE, reason: 'no_endpoint' });
    return false;
  }
  return true;
}

// ------------------------------------------------------------ intersection

export interface NegotiatedCapability {
  name: string;
  version: string;
  /** The merchant's entry for that version (schema, config, extends). */
  entry: CapabilityEntry;
}

/**
 * The capability intersection (overview :1809-1833): names both sides
 * declare, at the highest version both list (exact string equality), then
 * extensions whose parent left the set are pruned until nothing changes. A
 * single-parent extension needs its parent; a multi-parent one needs at least
 * one.
 */
export function intersectCapabilities(
  merchant: Record<string, CapabilityEntry[]>,
  options: { identityLinking?: boolean } = {},
): Map<string, NegotiatedCapability> {
  const ours = new Map<string, { versions: string[]; extends?: string[] }>();
  for (const d of DINA_CAPABILITIES) {
    ours.set(d.name, {
      versions: [UCP_VERSION],
      ...(d.extends !== undefined ? { extends: [d.extends] } : {}),
    });
  }
  if (options.identityLinking === true)
    ours.set(IDENTITY_LINKING_DECLARATION.name, { versions: [UCP_VERSION] });

  const result = new Map<string, NegotiatedCapability>();
  for (const [name, entries] of Object.entries(merchant)) {
    const mine = ours.get(name);
    if (mine === undefined) continue;
    const shared = entries.filter((e) => mine.versions.includes(e.version));
    if (shared.length === 0) continue;
    const best = shared.reduce((a, b) => (b.version > a.version ? b : a));
    result.set(name, { name, version: best.version, entry: best });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, cap] of result) {
      const parents = cap.entry.extends;
      if (parents === undefined || parents.length === 0) continue;
      if (!parents.some((p) => result.has(p))) {
        result.delete(name);
        changed = true;
      }
    }
  }
  return result;
}
