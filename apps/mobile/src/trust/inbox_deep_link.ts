/**
 * Inbox row → source-attestation deep-link composer (TN-MOB-041).
 *
 * Plan §10:
 *
 *   > An inbox tap should land on `app/trust/[subjectId]` AND surface
 *   > the source attestation that triggered the row — scrolled to,
 *   > highlighted, with the action sheet pinned over it.
 *
 * Today the cosig inbox row's `deepLink` is just `/trust/<subjectId>`
 * — the screen lands on the subject detail but has no signal as to
 * WHICH attestation triggered the inbox row. With many attestations
 * on a popular subject, the user has to hunt for the one Sancho
 * actually asked about. This module composes (and parses) the deep-
 * link with an `attestation` query parameter carrying the source
 * AT-URI so the screen can scroll-to / highlight the exact record.
 *
 * **Why query param, not path segment**: Expo Router's dynamic
 * `[subjectId].tsx` route segment already binds `subjectId`. Adding
 * a second segment would require a new route `[subjectId]/[rkey].tsx`
 * which (a) duplicates the screen, (b) creates a second URL surface
 * for the same screen, and (c) breaks the URL stability for
 * back-navigation + bookmarking. A query param `?attestation=` is
 * the additive, route-stable way.
 *
 * **Why the FULL AT-URI, not just the rkey**: rkeys are author-
 * scoped, not globally unique. Two different reviewers can have an
 * attestation with rkey `'3kxxxxx'` on the same subject. The full
 * AT-URI (`at://did:plc:abc/com.dina.trust.attestation/3kxxxxx`)
 * disambiguates. URL-encoded it's ~80 chars — well within URL length
 * budgets across iOS/Android.
 *
 * **Validation rules**:
 *   - `subjectId` must be a non-empty string (existing
 *     `cosig_inbox.buildDeepLink` invariant).
 *   - `attestationUri` (when supplied) must look like an AT-URI:
 *     `at://<did>/<collection>/<rkey>`. Malformed URIs are rejected
 *     loudly — silently coercing to "no attestation" would mean a
 *     deep-link with a typo lands on the screen with the action
 *     sheet missing, which reads as a bug to the user.
 *   - The query string is built deterministically: only the
 *     `attestation` key is added when non-null. Future params live
 *     in the same builder rather than being concatenated by callers.
 *
 * Pure function. No state, no I/O. Centralised so cosig_inbox,
 * notification_dispatch, and any future "open from inbox" surface
 * share the same URL shape.
 */

// ─── Public types ─────────────────────────────────────────────────────────

/** Parsed AT-URI components. */
export interface ParsedAtUri {
  /** Author DID — e.g. `'did:plc:abc'`. */
  readonly did: string;
  /** Collection NSID — e.g. `'com.dina.trust.attestation'`. */
  readonly collection: string;
  /** Record key — e.g. `'3kxxxxxxxxxxxxxxxxxxxxxxx'`. */
  readonly rkey: string;
}

/** Input to `buildAttestationDeepLink`. */
export interface AttestationDeepLinkInput {
  /** Subject id — drives the path segment. Must be non-empty. */
  readonly subjectId: string;
  /**
   * Source attestation AT-URI — drives the `?attestation=` query
   * param. Optional: when omitted (or null), the deep-link is the
   * plain `/trust/<subjectId>` form (no anchor). The screen falls
   * back to its default first-attestation behaviour.
   */
  readonly attestationUri?: string | null;
}

/** Result of `parseAttestationDeepLink`. */
export interface ParsedAttestationDeepLink {
  readonly subjectId: string;
  readonly attestationUri: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * AT-URI shape: `at://<did>/<collection>/<rkey>`. The DID family
 * (`did:plc:`, `did:web:`) is not constrained here — the AT-protocol
 * spec admits both. Validation defers to the callers (record-
 * validator) for the DID format itself; this regex only verifies the
 * URI's structural shape.
 */
const AT_URI_REGEX =
  /^at:\/\/([^/\s]+)\/([a-zA-Z0-9.-]+(?:\.[a-zA-Z0-9.-]+)+)\/([^/\s]+)$/;

const TRUST_BASE_PATH = '/trust/';
const ATTESTATION_QUERY_KEY = 'attestation';

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Parse an AT-URI into its three components, or return `null` if the
 * string isn't a structurally-valid AT-URI. Pure / total.
 */
export function parseAtUri(uri: unknown): ParsedAtUri | null {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  const match = AT_URI_REGEX.exec(uri);
  if (!match) return null;
  // Regex groups: 1=did, 2=collection, 3=rkey. Indices are 1-based.
  // The match always has exactly 4 entries (full + 3 groups) — the
  // non-null assertions reflect that contract, not a guess.
  return {
    did: match[1]!,
    collection: match[2]!,
    rkey: match[3]!,
  };
}

/**
 * Build the deep-link URL for "open this subject's screen, optionally
 * scrolled to/highlighted on this attestation".
 *
 * Throws on a non-string / empty `subjectId` (same contract as
 * `cosig_inbox.buildDeepLink`).
 *
 * Throws on a non-string / malformed `attestationUri` rather than
 * silently dropping it. Reasoning in the module preamble: a
 * malformed deep-link silently lacking the `?attestation=` anchor
 * reads as an app bug to the user; better to surface the bug at
 * compose-time so the screen can render an error row rather than a
 * sneakily-wrong subject screen.
 */
export function buildAttestationDeepLink(input: AttestationDeepLinkInput): string {
  if (typeof input.subjectId !== 'string' || input.subjectId.length === 0) {
    throw new Error('buildAttestationDeepLink: subjectId must be a non-empty string');
  }

  const path = TRUST_BASE_PATH + encodeURIComponent(input.subjectId);

  const att = input.attestationUri;
  if (att === null || att === undefined) return path;

  if (typeof att !== 'string' || att.length === 0) {
    throw new Error(
      'buildAttestationDeepLink: attestationUri must be a non-empty string when provided',
    );
  }
  if (!AT_URI_REGEX.test(att)) {
    throw new Error(
      `buildAttestationDeepLink: attestationUri is not a valid AT-URI: "${att}"`,
    );
  }

  return `${path}?${ATTESTATION_QUERY_KEY}=${encodeURIComponent(att)}`;
}

/**
 * Reverse of `buildAttestationDeepLink`: parse a deep-link URL back
 * into its components for the receiver screen.
 *
 * Returns `null` for non-`/trust/...` URLs and other non-deep-link
 * strings — the caller distinguishes "not our deep link" from "a
 * deep link with a missing attestation anchor" via the `attestationUri`
 * field (null when the anchor is absent or fails AT-URI validation).
 *
 * Defensive against a hostile / malformed `attestation` query value:
 * an `attestation=banana` produces `{ subjectId, attestationUri: null }`
 * rather than landing the screen with a nonsense anchor. That's the
 * one spot we DO swallow malformedness — incoming deep links from
 * the OS notification stack may have been mangled by URL handlers
 * upstream, and crashing the screen on a bad anchor is worse than
 * gracefully degrading to "show the subject without scroll".
 */
export function parseAttestationDeepLink(url: unknown): ParsedAttestationDeepLink | null {
  if (typeof url !== 'string' || url.length === 0) return null;

  // Only handle the path shape we own — `/trust/<subjectId>[?...]`.
  if (!url.startsWith(TRUST_BASE_PATH)) return null;

  // Split off the query string. URL parsing via the global URL ctor
  // would require a base, which feels heavyweight for an internal
  // route. A manual split is sufficient + deterministic.
  const queryIdx = url.indexOf('?');
  const pathPart = queryIdx >= 0 ? url.slice(0, queryIdx) : url;
  const queryPart = queryIdx >= 0 ? url.slice(queryIdx + 1) : '';

  const subjectIdEncoded = pathPart.slice(TRUST_BASE_PATH.length);
  if (subjectIdEncoded.length === 0) return null;

  let subjectId: string;
  try {
    subjectId = decodeURIComponent(subjectIdEncoded);
  } catch {
    // Malformed percent-encoding — not a valid deep-link.
    return null;
  }
  if (subjectId.length === 0) return null;

  let attestationUri: string | null = null;
  if (queryPart.length > 0) {
    // Walk the params manually rather than using URLSearchParams —
    // the latter is supported in RN but adds a polyfill dependency
    // we don't need for one query key.
    for (const pair of queryPart.split('&')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx < 0) continue;
      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);
      if (key !== ATTESTATION_QUERY_KEY) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        // Malformed anchor — degrade gracefully (see preamble).
        continue;
      }
      // Only accept structurally-valid AT-URIs as the anchor.
      if (AT_URI_REGEX.test(decoded)) {
        attestationUri = decoded;
      }
      // Stop at the first `attestation` param — duplicates are
      // ill-defined and the first wins.
      break;
    }
  }

  return { subjectId, attestationUri };
}
