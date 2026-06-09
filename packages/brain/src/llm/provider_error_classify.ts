/**
 * Provider error classifier — turns a raw LLM-SDK error message into a
 * known-safe template string, or null if no pattern matched.
 *
 * **Why this exists (P1.2 residual):** an LLM SDK error can echo the
 * failing request body — which embeds the prompt + any vault content
 * the prompt referenced — directly into `err.message`. Truncating it is
 * not redaction. Earlier we sanitised the LOG path but the
 * user-visible `providerErrorMessage` on the agentic loop result still
 * carried `${ctor}: ${rawMessage}`, and the downstream "humaniser"
 * fell back to "AI provider error: ${cleaned raw}". Both leaked the
 * raw text past the catch boundary.
 *
 * This classifier sniffs the raw text against a small set of vendor
 * signals and either returns a fixed safe template (with an actionable
 * next step) or null. Callers that want a user-facing fallback should
 * wrap the null with their own static apology — never propagate the
 * raw text past this gate.
 *
 * The classification is ALSO exposed as a structured KIND
 * (`classifyProviderErrorKind`) so non-message consumers — the mobile
 * key-health pill, telemetry — can react to "credits ran out" without
 * string-matching the human template. Live incident 2026-06-10: Gemini's
 * prepaid exhaustion ("Your prepayment credits are depleted",
 * RESOURCE_EXHAUSTED) matched NO pattern here, so chat showed the generic
 * apology for hours while the cause was simply an empty balance.
 */

export type ProviderErrorKind =
  | 'credits_exhausted'
  | 'rate_limited'
  | 'invalid_key'
  | 'timeout'
  | 'network';

/**
 * Classify a raw provider error into a structured kind, or null when no
 * vendor signal matches. Order matters: the money family is checked
 * before generic 429/rate-limit so "out of credits" never degrades into
 * "wait a minute and retry" (waiting will not refill a balance).
 */
export function classifyProviderErrorKind(raw: string): ProviderErrorKind | null {
  const lower = raw.toLowerCase();

  // Credits / quota EXHAUSTION family — the account is out of money or
  // hard quota. Distinct from a transient rate limit: the action is
  // "top up / switch", not "wait". Covers Gemini prepaid
  // (RESOURCE_EXHAUSTED / "prepayment credits are depleted"), OpenAI
  // (insufficient_quota / "exceeded your current quota"), OpenRouter
  // (402 / "insufficient credits"), and generic billing wording.
  if (
    lower.includes('exceeded your current quota') ||
    lower.includes('insufficient_quota') ||
    lower.includes('resource_exhausted') ||
    lower.includes('prepayment credits') ||
    lower.includes('credits are depleted') ||
    lower.includes('out of credits') ||
    lower.includes('insufficient credits') ||
    lower.includes('quota exceeded') ||
    lower.includes('billing')
  ) {
    return 'credits_exhausted';
  }
  // @google/genai's retry wrapper DISCARDS the vendor body — what reaches us
  // is only the HTTP statusText: 429 → "Retryable HTTP Error: Too Many
  // Requests" (even when the real cause is depleted credits — verified live
  // 2026-06-10), 400/401/403 → "Non-retryable exception <statusText> sending
  // request". Classify on the wrapper shapes too; the rate-limited template
  // hedges toward credits because the wrapper makes the two indistinguishable
  // (the Settings key-health probe uses raw fetch with the full body and
  // resolves the ambiguity there).
  if (
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('too many requests')
  ) {
    return 'rate_limited';
  }

  // Invalid / revoked API key. 401/403 on every cloud provider. "Bad
  // Request" via the genai wrapper: our request shape is fixed and
  // contract-tested, so a 400 on the chat path is in practice an invalid
  // key (Gemini rejects bad keys with 400 INVALID_ARGUMENT, not 401).
  if (
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes('api key not valid') ||
    lower.includes(' 401') ||
    lower.includes(' 403') ||
    lower.includes('non-retryable exception unauthorized') ||
    lower.includes('non-retryable exception forbidden') ||
    lower.includes('non-retryable exception bad request')
  ) {
    return 'invalid_key';
  }

  // Timeout — either from our hard cap or the SDK's `AbortError`.
  if (
    lower.includes('aborterror') ||
    lower.includes('timed out') ||
    lower.includes('took too long')
  ) {
    return 'timeout';
  }

  // Network reachability.
  if (
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  ) {
    return 'network';
  }

  return null;
}

/** Fixed user-safe template per kind — never raw vendor text. */
const KIND_TEMPLATES: Record<ProviderErrorKind, string> = {
  credits_exhausted:
    "Your AI provider's credits are exhausted. Top up your account, or switch providers in Settings → Manage AI providers.",
  rate_limited:
    'The AI provider is refusing requests right now (rate limit — or your account may be out of credits). Wait a minute and try again; if it keeps happening, check your balance in Settings → Manage AI providers.',
  invalid_key: 'Your API key was rejected. Update it in Settings → Manage AI providers.',
  timeout:
    'That took too long to come back. The provider may be slow right now — try again, or switch providers in Settings → Manage AI providers.',
  network: "Couldn't reach the AI provider. Check your connection and try again.",
};

export function classifyProviderErrorMessage(raw: string): string | null {
  const kind = classifyProviderErrorKind(raw);
  return kind === null ? null : KIND_TEMPLATES[kind];
}

/**
 * The user-safe template for an ALREADY-classified kind. For consumers that
 * carry the structured kind (e.g. `failure.detail.providerErrorKind`) —
 * re-classifying an already-templated message is lossy (the template's own
 * wording need not match the raw-error patterns).
 */
export function providerErrorMessageForKind(kind: ProviderErrorKind): string {
  return KIND_TEMPLATES[kind];
}

/** Static fallback used by every "make this user-facing" wrapper. */
export const GENERIC_PROVIDER_FAILURE_MESSAGE =
  'I ran into a problem reaching the AI provider. Please try again in a moment.';
