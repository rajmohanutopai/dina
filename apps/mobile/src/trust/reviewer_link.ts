/**
 * Reviewer profile drill-down deep-link composer (TN-MOB-026).
 *
 * Plan §8.5:
 *
 *   > Tapping any reviewer row — on the subject card spotlight, the
 *   > subject-detail reviewer list, the cosig inbox sender line, the
 *   > network feed reviewer chip — drills into
 *   > `app/trust/reviewer/[did]` with that reviewer's profile.
 *
 * Today only the screen route exists (TN-MOB-015). Every surface that
 * shows a reviewer needs to compose the same `/trust/reviewer/<did>`
 * link — and crucially, when the reviewer is operating under a
 * pseudonymous namespace, the link must include the namespace so the
 * profile screen shows the per-namespace stats (per TN-DB-002 +
 * Plan §3.5). Without that, tapping a reviewer who only writes under
 * `namespace_3` would land on a profile screen showing the merged-
 * root stats — misleading for a pseudonymous-by-design surface.
 *
 * This module owns the **link composition + tap-eligibility**:
 *
 *   - `buildReviewerProfileDeepLink({did, namespace?})` — the URL
 *     composer with namespace anchor.
 *   - `parseReviewerProfileDeepLink(url)` — reverse for the receiver.
 *   - `isReviewerProfileTappable(reviewer)` — predicate the UI uses
 *     to decide whether to render a `<TouchableOpacity>` vs a plain
 *     `<View>`. Self-reviews don't drill (the user already knows
 *     who they are); rows with no DID (stub / placeholder) don't
 *     drill either.
 *
 * Pure function. Zero RN deps. Tests under plain Jest.
 *
 * Why a separate module rather than expanding `inbox_deep_link.ts`:
 * the cosig inbox link goes to a SUBJECT screen with an attestation
 * anchor; the reviewer link goes to a different ROUTE entirely
 * (`/trust/reviewer/<did>` vs `/trust/<subjectId>`). Same builder
 * pattern, different route family — keeping them as sibling modules
 * keeps the import graph honest about which surface a caller wants.
 */

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Minimum data the UI needs to decide whether a reviewer row is
 * tappable + where it should drill to. Modelled minimally: the
 * full `SubjectReview` type carries headline / score / etc. that
 * are irrelevant to the link decision.
 */
export interface ReviewerLinkInput {
  /** Reviewer DID — the path segment. `null` for placeholder rows. */
  readonly did: string | null;
  /**
   * Pseudonymous namespace fragment (without leading `#`), e.g.
   * `'namespace_2'`. When present, the drill-down lands on the
   * per-namespace profile slice; when absent, the root-identity
   * profile.
   */
  readonly namespace?: string | null;
  /**
   * Whether this row IS the viewer themselves. Self-rows don't
   * drill — tapping them would just route to the user's own
   * profile screen, which they got to a faster way.
   */
  readonly isSelf?: boolean;
}

/** Result of `parseReviewerProfileDeepLink`. */
export interface ParsedReviewerProfileDeepLink {
  readonly did: string;
  readonly namespace: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────

const REVIEWER_BASE_PATH = '/trust/reviewer/';
const NAMESPACE_QUERY_KEY = 'namespace';

/**
 * DID shape — mirrors `record-validator.ts`'s `didString`:
 * `z.string().min(8).max(2048).regex(/^did:[a-z]+:/)`. Any DID method
 * is admissible (not just plc/web) — the AT-protocol spec admits
 * `did:key:`, `did:ion:`, etc., and AppView would happily accept
 * attestations from those reviewers. A tighter mobile regex would
 * silently render valid reviewers as non-tappable. Pinned by test.
 *
 * The `\S+` body matches the validator's "non-empty after the second
 * colon" implicit requirement (the validator only checks the prefix
 * + length; `did:key:` alone is rejected by min length).
 */
const DID_REGEX = /^did:[a-z]+:\S+$/;
const DID_MIN_LENGTH = 8; // mirrors validator's `.min(8)`
const DID_MAX_LENGTH = 2048;

/**
 * Pseudonymous namespace fragment — `record-validator.ts`'s
 * `namespaceFragment` is `z.string().min(1).max(255)` with NO regex.
 * The protocol does NOT constrain the character set; URL safety is
 * handled by `encodeURIComponent` on emit + `decodeURIComponent` on
 * parse. The only invariant we enforce is the length cap.
 */
const NAMESPACE_MIN_LENGTH = 1;
const NAMESPACE_MAX_LENGTH = 255;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Whether a reviewer row should render as a tappable surface.
 *
 *   - Self-rows: false. Tapping would land on the user's own profile
 *     they got to a faster way.
 *   - DID-less rows (placeholder / skeleton / data anomaly): false.
 *     No DID = no destination.
 *   - Otherwise: true.
 *
 * Exposed as a predicate (rather than baked into `buildReviewerProfileDeepLink`'s
 * throw path) so the UI can branch on tappability without try/catch.
 */
export function isReviewerProfileTappable(input: ReviewerLinkInput): boolean {
  if (input.isSelf === true) return false;
  if (typeof input.did !== 'string') return false;
  if (input.did.length < DID_MIN_LENGTH || input.did.length > DID_MAX_LENGTH) return false;
  if (!DID_REGEX.test(input.did)) return false;
  return true;
}

/**
 * Build the drill-down deep-link for a reviewer profile.
 *
 * Throws on a non-tappable input — callers should guard with
 * `isReviewerProfileTappable` first. Throws (rather than returning
 * null) because the call surface is "I already decided this is
 * tappable; give me the URL" — a silent null here would surface as
 * a non-functional tap.
 *
 * Validates the namespace if present (length cap + regex). A
 * malformed namespace param is the wrong kind of "missing data" to
 * silently strip — the screen would land on the root profile when
 * the user explicitly tapped a namespaced row.
 */
export function buildReviewerProfileDeepLink(input: ReviewerLinkInput): string {
  if (input.isSelf === true) {
    throw new Error('buildReviewerProfileDeepLink: self-reviews do not drill (use isReviewerProfileTappable to guard)');
  }
  if (typeof input.did !== 'string' || input.did.length === 0) {
    throw new Error('buildReviewerProfileDeepLink: did must be a non-empty string');
  }
  if (input.did.length < DID_MIN_LENGTH || input.did.length > DID_MAX_LENGTH) {
    throw new Error(
      `buildReviewerProfileDeepLink: did length must be in [${DID_MIN_LENGTH}, ${DID_MAX_LENGTH}] (got ${input.did.length})`,
    );
  }
  if (!DID_REGEX.test(input.did)) {
    throw new Error(`buildReviewerProfileDeepLink: did is not a valid DID: "${input.did}"`);
  }

  const path = REVIEWER_BASE_PATH + encodeURIComponent(input.did);

  const ns = input.namespace;
  if (ns === null || ns === undefined) return path;

  if (typeof ns !== 'string' || ns.length < NAMESPACE_MIN_LENGTH) {
    throw new Error(
      `buildReviewerProfileDeepLink: namespace must be at least ${NAMESPACE_MIN_LENGTH} char when provided`,
    );
  }
  if (ns.length > NAMESPACE_MAX_LENGTH) {
    throw new Error(
      `buildReviewerProfileDeepLink: namespace exceeds max length ${NAMESPACE_MAX_LENGTH} (got ${ns.length})`,
    );
  }

  return `${path}?${NAMESPACE_QUERY_KEY}=${encodeURIComponent(ns)}`;
}

/**
 * Reverse of `buildReviewerProfileDeepLink`. Returns null for non-
 * `/trust/reviewer/...` paths or malformed input. Like the inbox
 * deep-link parser, this gracefully degrades on malformed `?namespace=`
 * values (yields `namespace: null` — the screen renders the root
 * profile rather than crashing).
 */
export function parseReviewerProfileDeepLink(url: unknown): ParsedReviewerProfileDeepLink | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  if (!url.startsWith(REVIEWER_BASE_PATH)) return null;

  const queryIdx = url.indexOf('?');
  const pathPart = queryIdx >= 0 ? url.slice(0, queryIdx) : url;
  const queryPart = queryIdx >= 0 ? url.slice(queryIdx + 1) : '';

  const didEncoded = pathPart.slice(REVIEWER_BASE_PATH.length);
  if (didEncoded.length === 0) return null;

  let did: string;
  try {
    did = decodeURIComponent(didEncoded);
  } catch {
    return null;
  }
  if (
    did.length < DID_MIN_LENGTH ||
    did.length > DID_MAX_LENGTH ||
    !DID_REGEX.test(did)
  ) {
    return null;
  }

  let namespace: string | null = null;
  if (queryPart.length > 0) {
    for (const pair of queryPart.split('&')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx < 0) continue;
      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);
      if (key !== NAMESPACE_QUERY_KEY) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        continue;
      }
      if (decoded.length >= NAMESPACE_MIN_LENGTH && decoded.length <= NAMESPACE_MAX_LENGTH) {
        namespace = decoded;
      }
      break; // first wins (same RFC-3986 stance as inbox_deep_link.ts)
    }
  }

  return { did, namespace };
}
