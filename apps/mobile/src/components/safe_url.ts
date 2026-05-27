/**
 * Validate an untrusted, peer-supplied URL before handing it to
 * `Linking.openURL`.
 *
 * Service-response bodies (e.g. an ETA card's `map_url`) are opaque,
 * attacker-controlled data owned by the remote provider's Dina. Opening an
 * arbitrary URI on a native client is dangerous: a hostile provider could
 * return a `tel:`/`sms:` (premium-rate dialer), a `javascript:` URI, an
 * `https://` phishing page, or a deep link into another app's vulnerable
 * intent handler. Only allow real `https://` links — the sole scheme a
 * legitimate maps producer emits. `new URL` is runtime-safe under Hermes/Expo
 * (already used across the app).
 */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}
