/**
 * Starter Credits — client side (docs/CREDITS_DESIGN.md).
 *
 * Responsibilities:
 *   - getConfig fetch with COMPILED-IN clamping (model allowlist, value
 *     clamps, safe defaults) — a malformed/hostile config never
 *     propagates.
 *   - The anonymous claim flow: attestation → claimGrant → store the
 *     key. Non-blocking, in-session retry w/ backoff; TERMINAL refusals
 *     stop the loop permanently (persisted).
 *   - Key custody: device-only keychain slot (`dina.credits.key`),
 *     NEVER synchronized, NEVER exported (the backup/export allowlist
 *     does not include this service — see export tests), wiped on
 *     identity erase via `clearCreditsState`.
 *   - Balance: read straight from OpenRouter's key endpoint with the
 *     granted key (serverless), converted to "≈ N conversations".
 *   - Exhaustion + low-balance state for the two chat cards.
 *
 * The grant key is consumed by the provider layer through
 * `getGrantCredential()` — BYOK always wins over the grant (spec).
 */

import {
  CREDITS_CLAIM_GRANT_NSID,
  CREDITS_GET_CONFIG_NSID,
  TERMINAL_REFUSALS,
  parseClaimGrantRefusal,
  parseClaimGrantResponse,
} from '@dina/protocol';

import * as Keychain from '../services/keychain';

import type { CreditsAttestation } from '@dina/protocol';

/**
 * Choose the platform attestation to claim with. iOS → DeviceCheck.
 * Android → Play Integrity when a real device produces a token; when it
 * does not (emulator / no Play services / dev fake-attest), fall back to
 * the DeviceCheck seam so the dev override (which the dev grants server
 * expects as `devicecheck`) still drives an emulator claim. Returns null
 * only when no attestation can be produced at all → the claim parks as
 * 'unavailable' and BYOK stays the door.
 */
async function resolveAttestation(
  platform: 'ios' | 'android',
  deps: ClaimDeps,
): Promise<CreditsAttestation | null> {
  if (platform === 'android') {
    const piToken = deps.getPlayIntegrityToken ? await deps.getPlayIntegrityToken() : null;
    if (piToken !== null) return { kind: 'play_integrity', token: piToken };
  }
  const dcToken = await deps.getDeviceCheckToken();
  return dcToken === null ? null : { kind: 'devicecheck', token: dcToken };
}

const KEY_SERVICE = 'dina.credits.key';
const STATE_SERVICE = 'dina.credits.state';
const USERNAME = 'dina_credits';

/**
 * Compiled-in safety rails (spec "config hardening").
 *
 * V4 Flash 0731 replaced the V4 Pro pin on 2026-08-16: the 0423 Flash
 * was disqualified in June for dropping the HEALTH constraint under
 * 6-constraint load, and the 0731 re-post-train held every constraint
 * on the same brutal query, twice, at roughly a sixth of Pro's price
 * (docs/MODEL_COST_QUALITY_FINDINGS.md addendum). Pro stays in the
 * allowlist so an already-claimed grant with the old server pin keeps
 * working while the grants service migrates.
 */
export const CREDITS_MODEL_ALLOWLIST: readonly string[] = [
  'deepseek/deepseek-v4-flash-0731',
  'deepseek/deepseek-v4-pro',
];
export const CREDITS_DEFAULT_CONFIG = {
  enabled: true,
  grant_usd: 0.25,
  model_pin: 'deepseek/deepseek-v4-flash-0731',
  est_conversations: 120,
} as const;
/**
 * Measured average cost per conversation. June's Pro figure was
 * $0.0063; Flash 0731 measured ~3x cheaper on the same loop (brutal
 * run: ~$0.0017 including reasoning tokens). Kept conservative.
 */
const AVG_USD_PER_CONVERSATION = 0.002;
/** Low-balance card threshold, in estimated conversations. */
export const LOW_BALANCE_THRESHOLD = 5;

export interface CreditsClientConfig {
  enabled: boolean;
  grantUsd: number;
  modelPin: string;
  estConversations: number;
}

export type ClaimStatus = 'unclaimed' | 'claimed' | 'terminal_refused' | 'unavailable';

export interface CreditsState {
  status: ClaimStatus;
  /** Set once the low-balance card was dismissed — never re-show. */
  lowBalanceDismissed: boolean;
  /** Sticky exhaustion latch (cleared only by re-grant/top-up). */
  exhausted: boolean;
  modelPin: string;
}

const DEFAULT_STATE: CreditsState = {
  status: 'unclaimed',
  lowBalanceDismissed: false,
  exhausted: false,
  modelPin: CREDITS_DEFAULT_CONFIG.model_pin,
};

// ---------------------------------------------------------------- config

function grantsBaseUrl(): string {
  // Read EXPO_PUBLIC_* via the STATIC `process.env.X` form — Expo's bundler
  // only inlines that exact member expression. An aliased read (the old
  // `env.X` through a default param) is left untouched by the transform and
  // resolves to `undefined` in a release bundle, which silently pinned BOTH
  // the dev override AND the prod URL to the test default (the app would hit
  // test-grants.dinakernel.com in production). Caught by the credits Maestro
  // e2e, 2026-06-13. Tests mock fetch, so the resolved URL is irrelevant to
  // them; this is the convention used everywhere else (endpoint mode, appview).
  const override = process.env.EXPO_PUBLIC_DINA_GRANTS_URL;
  if (override !== undefined && override !== '') return override;
  return process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE === 'release'
    ? 'https://grants.dinakernel.com'
    : 'https://test-grants.dinakernel.com';
}

/**
 * Clamp a raw config object into safe bounds. Exported for tests.
 * Anything out of bounds degrades to the compiled default, field-wise.
 */
export function clampCreditsConfig(raw: unknown): CreditsClientConfig {
  const d = CREDITS_DEFAULT_CONFIG;
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const enabled = typeof r.enabled === 'boolean' ? r.enabled : false;
  const grantUsd =
    typeof r.grant_usd === 'number' && Number.isFinite(r.grant_usd) && r.grant_usd > 0 && r.grant_usd <= 5
      ? r.grant_usd
      : d.grant_usd;
  const modelPin =
    typeof r.model_pin === 'string' && CREDITS_MODEL_ALLOWLIST.includes(r.model_pin)
      ? r.model_pin
      : d.model_pin;
  const estConversations =
    typeof r.est_conversations === 'number' &&
    Number.isFinite(r.est_conversations) &&
    r.est_conversations >= 0 &&
    r.est_conversations <= 10_000
      ? Math.floor(r.est_conversations)
      : d.est_conversations;
  return { enabled, grantUsd, modelPin, estConversations };
}

/** Fetch + clamp the remote config; compiled defaults on ANY failure. */
export async function fetchCreditsConfig(
  platform: 'ios' | 'android',
  fetchImpl: typeof fetch = fetch,
): Promise<CreditsClientConfig> {
  try {
    const res = await fetchImpl(
      `${grantsBaseUrl()}/xrpc/${CREDITS_GET_CONFIG_NSID}?platform=${platform}`,
    );
    if (res.status !== 200) return { ...clampCreditsConfig(null), enabled: false };
    return clampCreditsConfig(await res.json());
  } catch {
    // Unreachable service: defaults, but NOT enabled — never advertise
    // free conversations we can't currently mint.
    return { ...clampCreditsConfig(null), enabled: false };
  }
}

// ----------------------------------------------------------------- state

let cachedState: CreditsState | null = null;
let cachedKey: string | null | undefined; // undefined = not loaded

export async function loadCreditsState(): Promise<CreditsState> {
  if (cachedState !== null) return cachedState;
  const row = await Keychain.getGenericPassword({ service: STATE_SERVICE });
  if (row !== false) {
    try {
      cachedState = { ...DEFAULT_STATE, ...(JSON.parse(row.password) as Partial<CreditsState>) };
    } catch {
      cachedState = { ...DEFAULT_STATE };
    }
  } else {
    cachedState = { ...DEFAULT_STATE };
  }
  return cachedState;
}

async function saveState(patch: Partial<CreditsState>): Promise<CreditsState> {
  const next = { ...(await loadCreditsState()), ...patch };
  cachedState = next;
  await Keychain.setGenericPassword(USERNAME, JSON.stringify(next), {
    service: STATE_SERVICE,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
  return next;
}

/** The granted key, or null. Device-only; never exported. */
export async function getGrantKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  const row = await Keychain.getGenericPassword({ service: KEY_SERVICE });
  cachedKey = row === false ? null : row.password;
  return cachedKey;
}

/** Credential view for the provider layer. */
export async function getGrantCredential(): Promise<{ key: string; modelPin: string } | null> {
  const key = await getGrantKey();
  if (key === null) return null;
  const state = await loadCreditsState();
  return { key, modelPin: state.modelPin };
}

/** Wipe everything (identity erase). */
export async function clearCreditsState(): Promise<void> {
  cachedState = null;
  cachedKey = undefined;
  await Keychain.resetGenericPassword({ service: KEY_SERVICE });
  await Keychain.resetGenericPassword({ service: STATE_SERVICE });
}

/** Test hook — reset in-memory caches only. */
export function __resetCreditsCachesForTest(): void {
  cachedState = null;
  cachedKey = undefined;
}

// ----------------------------------------------------------------- claim

export interface ClaimDeps {
  /**
   * iOS DeviceCheck seam (also the dev fake-attest override, any
   * platform) — null on sim/dev without the override.
   */
  getDeviceCheckToken: () => Promise<string | null>;
  /**
   * Android Play Integrity seam — a real integrity token on a genuine
   * device, null on an emulator / no-Play-services / dev override. When
   * it yields null on Android, the flow falls back to the DeviceCheck
   * seam so the dev fake-attest path still drives an emulator claim.
   */
  getPlayIntegrityToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Backoff schedule in ms (in-session retries on transient failures). */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Fired once when a key lands — activate the provider mid-session. */
  onClaimed?: () => Promise<void> | void;
}

let claimInFlight: Promise<ClaimStatus> | null = null;

/**
 * Run the claim flow to completion (claimed / terminal / gave-up).
 * Never throws; concurrent calls coalesce onto one in-flight run (a
 * duplicate trigger can otherwise interleave state writes — review P3).
 * Designed to be fire-and-forgotten AFTER onboarding — the spec's
 * "enhancement, never a gate". `onClaimed` fires exactly once when a
 * key lands, so the caller can activate the provider mid-session.
 */
export async function runClaimFlow(
  platform: 'ios' | 'android',
  deps: ClaimDeps,
): Promise<ClaimStatus> {
  if (claimInFlight !== null) return claimInFlight;
  claimInFlight = runClaimFlowInner(platform, deps).finally(() => {
    claimInFlight = null;
  });
  return claimInFlight;
}

async function runClaimFlowInner(
  platform: 'ios' | 'android',
  deps: ClaimDeps,
): Promise<ClaimStatus> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const backoff = deps.backoffMs ?? [0, 5_000, 30_000];
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const state = await loadCreditsState();
  if (state.status === 'claimed' || state.status === 'terminal_refused') return state.status;

  const config = await fetchCreditsConfig(platform, fetchImpl);
  if (!config.enabled) return state.status; // stays unclaimed; retried next boot

  const attestation = await resolveAttestation(platform, deps);
  if (attestation === null) {
    await saveState({ status: 'unavailable' });
    return 'unavailable';
  }

  for (const delayMs of backoff) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      const res = await fetchImpl(`${grantsBaseUrl()}/xrpc/${CREDITS_CLAIM_GRANT_NSID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          attestation,
        }),
      });
      if (res.status === 200) {
        // The shared wire contract is the ONLY success parser — the
        // hand-rolled variant diverged from it (review P1: dead parsers).
        const grant = parseClaimGrantResponse(await res.json().catch(() => null));
        if (grant === null) continue; // malformed → transient
        const modelPin = CREDITS_MODEL_ALLOWLIST.includes(grant.model_pin)
          ? grant.model_pin
          : CREDITS_DEFAULT_CONFIG.model_pin;
        await Keychain.setGenericPassword(USERNAME, grant.key, {
          service: KEY_SERVICE,
          accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
        cachedKey = grant.key;
        await saveState({ status: 'claimed', modelPin, exhausted: false });
        try {
          await deps.onClaimed?.();
        } catch {
          /* activation is best-effort; boot picks the grant up next launch */
        }
        return 'claimed';
      }
      const refusal = parseClaimGrantRefusal(await res.json().catch(() => null));
      if (refusal !== null && TERMINAL_REFUSALS.includes(refusal.error)) {
        // `already_claimed` means the server already minted THIS device's
        // one-time grant. The granted key lives in the Keychain, which
        // survives an app reinstall / re-onboard even though our local STATUS
        // does not — so a returning user can hit this 409 with a perfectly
        // usable key still on the device. Adopt it instead of dead-ending;
        // only fall through to the terminal "already used" state when the key
        // is genuinely gone.
        if (refusal.error === 'already_claimed' && (await getGrantKey()) !== null) {
          await saveState({ status: 'claimed' });
          return 'claimed';
        }
        await saveState({ status: 'terminal_refused' });
        return 'terminal_refused';
      }
      // Transient (rate_limited / grants_paused / attestation_unavailable
      // / unparseable) → next attempt, then next launch.
    } catch {
      // network error → next attempt
    }
  }
  return (await loadCreditsState()).status; // gave up this session; retry next boot
}

// --------------------------------------------------------------- balance

export interface CreditsBalance {
  remainingUsd: number;
  estConversationsLeft: number;
  exhausted: boolean;
}

/**
 * Read the live balance from OpenRouter with the granted key and update
 * the sticky exhaustion latch. Null when no grant / endpoint trouble.
 */
export async function refreshBalance(fetchImpl: typeof fetch = fetch): Promise<CreditsBalance | null> {
  const key = await getGrantKey();
  if (key === null) return null;
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { data?: { limit?: unknown; usage?: unknown; limit_remaining?: unknown } };
    const remRaw = body.data?.limit_remaining;
    const remainingUsd =
      typeof remRaw === 'number' && Number.isFinite(remRaw) ? Math.max(0, remRaw) : null;
    if (remainingUsd === null) return null;
    const estConversationsLeft = Math.floor(remainingUsd / AVG_USD_PER_CONVERSATION);
    const exhausted = remainingUsd <= AVG_USD_PER_CONVERSATION / 4; // < a quarter-conversation
    if (exhausted) await saveState({ exhausted: true });
    return { remainingUsd, estConversationsLeft, exhausted };
  } catch {
    return null;
  }
}

export async function dismissLowBalanceCard(): Promise<void> {
  await saveState({ lowBalanceDismissed: true });
}
