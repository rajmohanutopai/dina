/**
 * Discovering a merchant (UCP plan §3.6 steps 1–5), the part every reader
 * shares: Core before it talks to a merchant, and AppView's merchant index
 * (§3.15). How profiles are fetched (a cache, conditional requests, the
 * vetted socket) is the caller's `read`; what is done with them is here:
 *
 *  - the merchant's identity is its origin, `https://host[:port]` only;
 *  - the version both speak, through the merchant's leaf profile when its
 *    current version is not Dina's, the leaf checked against the spec;
 *  - entries filtered and capabilities intersected the way the merchant
 *    will (identity linking among them);
 *  - MCP chosen over REST when both are offered (D9, S18).
 *
 * The answer names what was dropped and why, for the owner's merchant
 * status and the index's record of each merchant.
 */

import { hostNameProblem } from './authority';
import { readJsonBytes } from './json_bytes';
import {
  checkLeaf,
  chooseVersion,
  filterProfile,
  intersectCapabilities,
  type DroppedEntry,
  type NegotiatedCapability,
} from './negotiate';
import { parseMerchantProfile, type MerchantProfile } from './profile';

export type MerchantTransport = 'mcp' | 'rest';

export interface DiscoveredMerchant {
  origin: string;
  /** The profile Dina negotiated against (the leaf, when one was used). */
  profileUrl: string;
  profile: MerchantProfile;
  /**
   * The merchant's own `/.well-known/ucp`: its identity, and the signing keys
   * it lists (a version leaf need not list them). The same as `profile` when no
   * leaf was used.
   */
  rootProfile: MerchantProfile;
  transport: MerchantTransport;
  /** The endpoint for that transport. */
  endpoint: string;
  /** Capability name → the version and entry both sides will use. */
  negotiated: Map<string, NegotiatedCapability>;
  /** Entries Dina will not use, with the reason. */
  dropped: DroppedEntry[];
  /** A profile was served from a cache past its freshness, while a revalidation runs. */
  stale: boolean;
}

export type DiscoveryFailure =
  | 'bad_origin'
  | 'unreachable'
  | 'not_found'
  | 'too_large'
  | 'profile_malformed'
  | 'no_shared_version'
  | 'leaf_unusable'
  | 'no_endpoint';

export type Discovery =
  | { ok: true; merchant: DiscoveredMerchant }
  | { ok: false; reason: DiscoveryFailure; detail?: string };

/** One profile document read, by whatever means the caller fetches. */
export type ProfileRead =
  | { ok: true; profile: MerchantProfile; stale: boolean }
  | { ok: false; reason: DiscoveryFailure; detail?: string };

/** `https://host[:port]` and nothing more, lower-cased; null for anything else. */
export function merchantOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '')
    return null;
  // A shop lives at a public DNS name: never an address or a bare local name, and one
  // spelling only (no trailing dot).
  if (hostNameProblem(url.hostname) !== null || url.hostname.endsWith('.')) return null;
  return url.origin;
}

/** A merchant's profile URL: its origin's `/.well-known/ucp`. */
export function merchantProfileUrl(origin: string): string {
  return `${origin}/.well-known/ucp`;
}

/** A profile document's bytes read as one: UTF-8 strict JSON, then the profile's own rules. */
export function readProfileDocument(
  bytes: Uint8Array,
):
  | { ok: true; profile: MerchantProfile }
  | { ok: false; reason: 'profile_malformed'; detail: string } {
  const json = readJsonBytes(bytes);
  if (!json.ok) return { ok: false, reason: 'profile_malformed', detail: json.reason };
  const parsed = parseMerchantProfile(json.value);
  if (!parsed.ok) return { ok: false, reason: 'profile_malformed', detail: parsed.reason };
  return { ok: true, profile: parsed.profile };
}

/** Discover the merchant at `input` (an origin), its profiles fetched by `read`. */
export async function discoverMerchant(
  input: string,
  read: (url: string) => Promise<ProfileRead>,
): Promise<Discovery> {
  const origin = merchantOrigin(input);
  if (origin === null) return { ok: false, reason: 'bad_origin' };
  const profileUrl = merchantProfileUrl(origin);
  const top = await read(profileUrl);
  if (!top.ok) return top;

  let profile = top.profile;
  let used = profileUrl;
  let stale = top.stale;
  const choice = chooseVersion(profile);
  if (choice.kind === 'none')
    return { ok: false, reason: 'no_shared_version', detail: choice.offered.join(',') };
  if (choice.kind === 'leaf') {
    // The leaf is read like the profile, by the same `read`.
    const leaf = await read(choice.url);
    if (!leaf.ok) return { ok: false, reason: 'leaf_unusable', detail: leaf.reason };
    const check = checkLeaf(leaf.profile);
    if (!check.ok) return { ok: false, reason: 'leaf_unusable', detail: check.reason };
    profile = leaf.profile;
    used = choice.url;
    stale = stale || leaf.stale;
  }

  const filtered = filterProfile(profile);
  // Identity linking (U4) is negotiated too: a merchant's config for it says what linking gates.
  const negotiated = intersectCapabilities(filtered.capabilities, { identityLinking: true });
  const transport: MerchantTransport | null =
    filtered.endpoints.mcp !== undefined
      ? 'mcp'
      : filtered.endpoints.rest !== undefined
        ? 'rest'
        : null;
  if (transport === null) return { ok: false, reason: 'no_endpoint' };
  return {
    ok: true,
    merchant: {
      origin,
      profileUrl: used,
      profile,
      rootProfile: top.profile,
      transport,
      endpoint: filtered.endpoints[transport] as string,
      negotiated,
      dropped: filtered.dropped,
      stale,
    },
  };
}
