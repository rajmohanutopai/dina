/**
 * Starter Credits wire contract — `com.dinakernel.credits.*`.
 *
 * Shared by the grants service (server side) and the mobile client.
 * Design: docs/CREDITS_DESIGN.md. Two endpoints:
 *
 *   GET  /xrpc/com.dinakernel.credits.getConfig?platform=ios|android
 *   POST /xrpc/com.dinakernel.credits.claimGrant
 *
 * Privacy invariant (spec "anonymous claim"): the claim request carries
 * NO DID and no signed identity headers — the platform attestation is
 * the scarce resource and the replay protection. Adding any
 * identity-bearing field to `ClaimGrantRequest` is a spec violation,
 * not an enhancement.
 *
 * This is a NEW OPTIONAL surface — not part of the L1–L4 conformance
 * levels; no frozen-vector changes, no protocol major bump
 * (conformance.md §14 untouched by design).
 *
 * Wire compatibility:
 *   - snake_case field names.
 *   - Numbers are plain JSON numbers (USD as decimal, e.g. 0.25).
 *   - Unknown fields are ignored on parse (forward compatibility).
 *
 * Zero runtime deps (enforced by dep_hygiene.test.ts).
 */

/** Platforms a grant can target. */
export type CreditsPlatform = 'ios' | 'android';

/** Typed refusal codes for claimGrant (HTTP 4xx/5xx body `error`). */
export type ClaimRefusalCode =
  | 'already_claimed'
  | 'attestation_failed'
  | 'attestation_unavailable'
  | 'grants_paused'
  | 'platform_disabled'
  | 'rate_limited';

const REFUSAL_CODES: readonly ClaimRefusalCode[] = [
  'already_claimed',
  'attestation_failed',
  'attestation_unavailable',
  'grants_paused',
  'platform_disabled',
  'rate_limited',
];

/**
 * Platform attestation — discriminated union, extensible.
 *
 * v1 ships `devicecheck` (iOS). `app_attest` is the documented
 * stronger target; `play_integrity` arrives when the Android path is
 * verified and enabled. The service rejects kinds it doesn't support
 * with `attestation_failed` (never a crash).
 */
export type CreditsAttestation =
  | { kind: 'devicecheck'; token: string }
  | { kind: 'app_attest'; key_id: string; assertion: string; client_data: string }
  | { kind: 'play_integrity'; token: string };

/** GET getConfig response — everything the client renders is here. */
export interface CreditsConfig {
  /** Grants currently offered for the REQUESTING platform. */
  enabled: boolean;
  /** Cap for new grants, USD (informational — the key enforces it). */
  grant_usd: number;
  /** Model id every tier is pinned to while on credits. */
  model_pin: string;
  /** Server's "≈ N conversations" estimate for the grant. */
  est_conversations: number;
}

/** POST claimGrant request body. NO identity fields — see module docs. */
export interface ClaimGrantRequest {
  platform: CreditsPlatform;
  attestation: CreditsAttestation;
}

/** POST claimGrant success response. */
export interface ClaimGrantResponse {
  /** The spend-capped OpenRouter runtime key. Treat as a secret. */
  key: string;
  limit_usd: number;
  model_pin: string;
}

/** POST claimGrant refusal body. */
export interface ClaimGrantRefusal {
  error: ClaimRefusalCode;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPlatform(v: unknown): v is CreditsPlatform {
  return v === 'ios' || v === 'android';
}

/**
 * Parse + validate a getConfig response. Returns null on any shape
 * violation — the CLIENT then falls back to compiled-in defaults (spec
 * "config hardening": a malformed config must never propagate).
 */
export function parseCreditsConfig(raw: unknown): CreditsConfig | null {
  if (!isRecord(raw)) return null;
  const { enabled, grant_usd, model_pin, est_conversations } = raw;
  if (typeof enabled !== 'boolean') return null;
  if (typeof grant_usd !== 'number' || !Number.isFinite(grant_usd) || grant_usd < 0) return null;
  if (typeof model_pin !== 'string' || model_pin === '') return null;
  if (
    typeof est_conversations !== 'number' ||
    !Number.isFinite(est_conversations) ||
    est_conversations < 0
  ) {
    return null;
  }
  return {
    enabled,
    grant_usd,
    model_pin,
    est_conversations: Math.floor(est_conversations),
  };
}

/**
 * Parse + validate a claimGrant request (SERVICE side). Returns null on
 * shape violation → the service responds 400, never throws. Extra
 * fields are ignored; identity-shaped fields are NOT read even if sent.
 */
export function parseClaimGrantRequest(raw: unknown): ClaimGrantRequest | null {
  if (!isRecord(raw)) return null;
  if (!isPlatform(raw.platform)) return null;
  const att = raw.attestation;
  if (!isRecord(att)) return null;
  switch (att.kind) {
    case 'devicecheck':
    case 'play_integrity': {
      if (typeof att.token !== 'string' || att.token === '') return null;
      return {
        platform: raw.platform,
        attestation: { kind: att.kind, token: att.token },
      };
    }
    case 'app_attest': {
      if (typeof att.key_id !== 'string' || att.key_id === '') return null;
      if (typeof att.assertion !== 'string' || att.assertion === '') return null;
      if (typeof att.client_data !== 'string' || att.client_data === '') return null;
      return {
        platform: raw.platform,
        attestation: {
          kind: 'app_attest',
          key_id: att.key_id,
          assertion: att.assertion,
          client_data: att.client_data,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Parse a claimGrant SUCCESS response (CLIENT side). Returns null on
 * shape violation — the client treats it as a transient failure and
 * retries later; it must never store a malformed key record.
 */
export function parseClaimGrantResponse(raw: unknown): ClaimGrantResponse | null {
  if (!isRecord(raw)) return null;
  const { key, limit_usd, model_pin } = raw;
  if (typeof key !== 'string' || key === '') return null;
  if (typeof limit_usd !== 'number' || !Number.isFinite(limit_usd) || limit_usd <= 0) return null;
  if (typeof model_pin !== 'string' || model_pin === '') return null;
  return { key, limit_usd, model_pin };
}

/**
 * Parse a claimGrant refusal body (CLIENT side). Unknown/missing codes
 * normalize to null — the client treats unparseable refusals as
 * transient (retry w/ backoff), but parsed TERMINAL codes
 * (`already_claimed`, `attestation_failed`, `platform_disabled`) stop
 * the retry loop, while transient ones (`grants_paused`,
 * `rate_limited`, `attestation_unavailable` — a transient Apple/Google
 * outage, NOT a forged device) are retried next launch.
 */
export function parseClaimGrantRefusal(raw: unknown): ClaimGrantRefusal | null {
  if (!isRecord(raw)) return null;
  const e = raw.error;
  if (typeof e !== 'string') return null;
  return (REFUSAL_CODES as readonly string[]).includes(e)
    ? { error: e as ClaimRefusalCode }
    : null;
}

/** Refusal codes that must STOP the client's claim-retry loop. */
export const TERMINAL_REFUSALS: readonly ClaimRefusalCode[] = [
  'already_claimed',
  'attestation_failed',
  'platform_disabled',
];

/** xRPC method ids (single source for URLs on both sides). */
export const CREDITS_GET_CONFIG_NSID = 'com.dinakernel.credits.getConfig';
export const CREDITS_CLAIM_GRANT_NSID = 'com.dinakernel.credits.claimGrant';
