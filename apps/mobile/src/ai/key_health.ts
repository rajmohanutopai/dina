/**
 * AI-provider key HEALTH probe — "does this key still actually generate?"
 *
 * `verifyKey` (provider.ts) probes the model-LIST endpoint, which is free —
 * and that is exactly why it cannot see the failure users actually hit: a
 * valid key whose project has run out of credits/quota lists models with a
 * 200 all day while every `generateContent` call 429s with
 * RESOURCE_EXHAUSTED ("Your prepayment credits are depleted"). Found live
 * 2026-06-10: chat went "problem reaching the AI provider" for hours while
 * the key still "verified".
 *
 * This module issues a MINIMAL GENERATION probe (1 max output token against
 * the provider's lite tier) and classifies the outcome so Settings can show
 * a status pill on the active key:
 *
 *   ok                 → generation works (the probe reply is discarded)
 *   credits_exhausted  → key valid, but quota/credits/billing are gone
 *   invalid_key        → provider rejected the key itself
 *   unreachable        → network/transient — NOT a verdict about the key
 *
 * Cost discipline: a healthy probe costs ~1 token. Results are cached
 * in-memory for CACHE_TTL_MS and only the ACTIVE provider is probed
 * automatically (screens re-probe on demand via `force`).
 */

import { getProviderTiers } from '@dina/brain/llm';

import type { ProviderType } from './provider';

export type KeyHealthStatus = 'ok' | 'credits_exhausted' | 'invalid_key' | 'unreachable';

export interface KeyHealth {
  readonly status: KeyHealthStatus;
  /** Provider's own error message (trimmed) for the detail alert. */
  readonly detail?: string;
  readonly checkedAt: number;
}

/** Re-probe a HEALTHY verdict at most every 5 minutes unless forced. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * ERROR verdicts go stale fast: after the user tops up / fixes the key they
 * expect the next Settings visit to clear the pill, not a 5-minute wait.
 * Re-probing an error state is also effectively free — while it persists the
 * provider refuses the request, and the one probe after recovery costs a
 * single token and clears the pill. 15s only guards rapid tab-flipping.
 */
export const ERROR_CACHE_TTL_MS = 15 * 1000;

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text: () => Promise<string> }>;

/**
 * Strip the `+thinking` pseudo-id plumbing (models_catalog stores e.g.
 * `gpt-5.5+thinking`) down to the real wire model id.
 */
function wireModelId(id: string): string {
  return id.split('+')[0];
}

/** Phrases that mean "the money/quota ran out" across providers. */
const EXHAUSTED_RE =
  /resource_exhausted|insufficient_quota|credits? (are )?depleted|out of credits|insufficient credits|billing|quota exceeded|exceeded your current quota/i;

/** Phrases that mean "the key itself is bad". */
const INVALID_RE =
  /api key not valid|api_key_invalid|invalid api key|incorrect api key|invalid x-api-key|authentication_error|no auth credentials/i;

function classify(status: number, body: string): KeyHealth {
  const detail = extractErrorMessage(body);
  if (status >= 200 && status < 300) return { status: 'ok', checkedAt: Date.now() };
  // Money first: providers signal exhaustion as 429 (OpenAI/Gemini), 402
  // (OpenRouter), and occasionally 400 with a billing message (Anthropic).
  if (status === 402 || EXHAUSTED_RE.test(body)) {
    return { status: 'credits_exhausted', detail, checkedAt: Date.now() };
  }
  if (status === 401 || status === 403 || INVALID_RE.test(body)) {
    return { status: 'invalid_key', detail, checkedAt: Date.now() };
  }
  // 429 without an exhaustion phrase = plain rate limit → transient.
  return { status: 'unreachable', detail, checkedAt: Date.now() };
}

/** Best-effort `error.message` out of a provider error body. */
function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const msg = parsed.error?.message;
    return typeof msg === 'string' && msg.trim() !== '' ? msg.trim().slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One minimal generation request per provider. 1 output token, no system
 * prompt — the cheapest call that exercises the BILLED path.
 */
export async function checkKeyHealth(
  provider: ProviderType,
  key: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  signal?: AbortSignal,
): Promise<KeyHealth> {
  const trimmed = key.trim();
  const model = wireModelId(getProviderTiers(provider).lite);
  try {
    if (provider === 'gemini') {
      const res = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': trimmed, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 1 },
          }),
          signal,
        },
      );
      return classify(res.status, await res.text());
    }
    if (provider === 'openai') {
      const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${trimmed}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: 1,
        }),
        signal,
      });
      return classify(res.status, await res.text());
    }
    if (provider === 'claude') {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': trimmed,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal,
      });
      return classify(res.status, await res.text());
    }
    // openrouter (OpenAI-compatible; 402 = out of credits)
    const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${trimmed}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal,
    });
    return classify(res.status, await res.text());
  } catch {
    // DNS/timeout/abort — say nothing scary about the key.
    return { status: 'unreachable', checkedAt: Date.now() };
  }
}

// ─── In-memory cache + tiny subscription (mirrors runtime_warnings shape) ────

const cache = new Map<ProviderType, KeyHealth>();
const inFlight = new Map<ProviderType, Promise<KeyHealth>>();
const listeners = new Set<() => void>();

export function getCachedKeyHealth(provider: ProviderType): KeyHealth | null {
  return cache.get(provider) ?? null;
}

export function subscribeKeyHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Probe (or reuse the cached verdict for) one provider's key. Coalesces
 * concurrent calls; `force` bypasses the TTL (the user tapped the pill).
 */
export async function refreshKeyHealth(
  provider: ProviderType,
  key: string,
  options: { force?: boolean; fetchImpl?: FetchLike } = {},
): Promise<KeyHealth> {
  const cached = cache.get(provider);
  const ttl = cached?.status === 'ok' ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS;
  if (options.force !== true && cached !== undefined && Date.now() - cached.checkedAt < ttl) {
    return cached;
  }
  const existing = inFlight.get(provider);
  if (existing !== undefined) return existing;
  const p = checkKeyHealth(provider, key, options.fetchImpl)
    .then((health) => {
      cache.set(provider, health);
      notify();
      return health;
    })
    .finally(() => inFlight.delete(provider));
  inFlight.set(provider, p);
  return p;
}

/** Test/lifecycle hook — drop all cached verdicts. */
export function clearKeyHealthCache(): void {
  cache.clear();
  notify();
}

/**
 * Record a key-health incident OBSERVED on a real call (not probed) — the
 * chat path feeds this when an /ask fails with a classified provider error,
 * so the Settings pill is already lit the moment chat hits the wall instead
 * of waiting for the next screen-visit probe. Same cache + subscribers as
 * the probe path; the short error TTL then lets the next Settings visit
 * re-verify (and clear it after the user fixes billing).
 */
export function reportKeyHealthIncident(
  provider: ProviderType,
  status: Extract<KeyHealthStatus, 'credits_exhausted' | 'invalid_key'>,
  detail?: string,
): void {
  cache.set(provider, {
    status,
    ...(detail !== undefined && detail.trim() !== ''
      ? { detail: detail.trim().slice(0, 300) }
      : {}),
    checkedAt: Date.now(),
  });
  notify();
}
