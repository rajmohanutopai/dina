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
 */

export function classifyProviderErrorMessage(raw: string): string | null {
  const lower = raw.toLowerCase();

  // Quota / rate-limit family — both surface as 429s but the body
  // text distinguishes them and the action differs (top-up vs wait).
  if (lower.includes('exceeded your current quota') || lower.includes('insufficient_quota')) {
    return 'Your AI provider is out of quota. Open Settings → Manage AI providers and switch to a different one (or top up your account).';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'AI provider rate-limited. Wait a minute and try again, or switch providers in Settings → Manage AI providers.';
  }

  // Invalid / revoked API key. 401/403 on every cloud provider.
  if (
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes(' 401') ||
    lower.includes(' 403')
  ) {
    return 'Your API key was rejected. Update it in Settings → Manage AI providers.';
  }

  // Timeout — either from our hard cap or the SDK's `AbortError`.
  if (
    lower.includes('aborterror') ||
    lower.includes('timed out') ||
    lower.includes('took too long')
  ) {
    return 'That took too long to come back. The provider may be slow right now — try again, or switch providers in Settings → Manage AI providers.';
  }

  // Network reachability.
  if (
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  ) {
    return "Couldn't reach the AI provider. Check your connection and try again.";
  }

  return null;
}

/** Static fallback used by every "make this user-facing" wrapper. */
export const GENERIC_PROVIDER_FAILURE_MESSAGE =
  'I ran into a problem reaching the AI provider. Please try again in a moment.';
