/**
 * Deep-link builder — README §Core Principles: Deep Link Default.
 *
 * From README:
 *
 *   "Deep Link Default: Dina credits sources — not just extracts.
 *    Creators get traffic, users get truth."
 *
 * When Dina surfaces content in a briefing / nudge / ask answer, the
 * result includes the SOURCE URL with attribution. This builder
 * produces:
 *
 *   - `url`     — sanitised canonical URL the client opens.
 *   - `anchor`  — short linkable label ("dina.anthropic.com").
 *   - `display` — pre-formatted text ("Alice Jones, dina-times.com").
 *   - `payload` — machine-readable structure for UIs that render
 *                 their own chrome.
 *
 * **Sanitisation**:
 *
 *   - Strip known tracking params (`utm_*`, `fbclid`, `gclid`,
 *     `mc_eid`, etc.) — the point is clean attribution, not
 *     acquisition tracking.
 *   - Preserve fragment + other query params.
 *   - Normalise host to lowercase, strip `www.` prefix (the visible
 *     anchor reads nicer that way; the actual URL keeps the host
 *     the merchant published).
 *   - Reject non-http(s) + malformed URLs.
 *
 * **Attribution**:
 *
 *   - `author` — "Alice Jones"
 *   - `publisher` — "The New York Times" (falls back to the host).
 *   - `publishedAt` — unix seconds; rendered as ISO date in display text.
 *
 * **Pure builder** — no IO, no persistence, no HTTP fetches.
 */

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_EXACT = new Set([
  'fbclid',
  'gclid',
  'mc_eid',
  'mc_cid',
  'msclkid',
  'yclid',
  '_ga',
  '_gl',
  'dclid',
  'igshid',
]);

export interface DeepLinkInput {
  url: string;
  /** Display name of the author / creator. */
  author?: string;
  /** Display name of the publisher. Falls back to the URL's host. */
  publisher?: string;
  /** Unix seconds — rendered as ISO date in the display text. */
  publishedAtSec?: number;
  /** Optional excerpt. Length-capped to `maxExcerptChars`. */
  excerpt?: string;
  /** Optional caller-supplied ref — echoed back in the payload for click-through analytics. */
  ref?: string;
}

export interface DeepLinkOptions {
  /** Extra tracking params to strip. Merged with the built-in list. */
  extraTrackingParams?: ReadonlyArray<string>;
  /** Max excerpt length. Default 280 chars. */
  maxExcerptChars?: number;
  /** When true, keep `www.` in the anchor. Default false. */
  preserveWwwInAnchor?: boolean;
}

export interface DeepLinkPayload {
  url: string;
  host: string;
  anchor: string;
  author: string | null;
  publisher: string;
  publishedAtIso: string | null;
  publishedAtSec: number | null;
  excerpt: string | null;
  ref: string | null;
}

export interface DeepLinkOutcome {
  payload: DeepLinkPayload;
  display: string;
}

export const DEFAULT_MAX_EXCERPT_CHARS = 280;

export class DeepLinkError extends Error {
  constructor(
    public readonly code: 'invalid_url' | 'unsupported_scheme' | 'missing_url',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'DeepLinkError';
  }
}

/**
 * Build a source-credited deep link. Throws `DeepLinkError` on bad input.
 */
export function buildDeepLink(
  input: DeepLinkInput,
  opts: DeepLinkOptions = {},
): DeepLinkOutcome {
  if (!input || typeof input !== 'object') {
    throw new DeepLinkError('missing_url', 'input required');
  }
  if (typeof input.url !== 'string' || input.url.trim() === '') {
    throw new DeepLinkError('missing_url', 'url required');
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    throw new DeepLinkError('invalid_url', `url not parseable: ${input.url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DeepLinkError(
      'unsupported_scheme',
      `scheme must be http(s); got ${parsed.protocol.replace(':', '')}`,
    );
  }

  // Strip tracking params.
  const extraTracking = new Set(
    (opts.extraTrackingParams ?? []).map((p) => p.toLowerCase()),
  );
  stripTrackingParams(parsed, extraTracking);

  // Normalise host.
  const host = parsed.hostname.toLowerCase();
  parsed.hostname = host;
  const preserveWww = opts.preserveWwwInAnchor ?? false;
  const anchor = preserveWww || !host.startsWith('www.') ? host : host.slice(4);

  const url = parsed.toString();
  const author = input.author?.trim() || null;
  const publisher = input.publisher?.trim() || anchor;
  const publishedAtSec =
    input.publishedAtSec !== undefined && Number.isFinite(input.publishedAtSec)
      ? input.publishedAtSec
      : null;
  const publishedAtIso =
    publishedAtSec !== null
      ? new Date(publishedAtSec * 1000).toISOString()
      : null;

  const maxExcerpt = opts.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const excerpt = input.excerpt
    ? truncate(input.excerpt.trim(), maxExcerpt)
    : null;

  const ref = input.ref?.trim() || null;

  const payload: DeepLinkPayload = {
    url,
    host,
    anchor,
    author,
    publisher,
    publishedAtIso,
    publishedAtSec,
    excerpt,
    ref,
  };
  const display = renderDisplay(payload);

  return { payload, display };
}

/**
 * Render a `DeepLinkPayload` into a short human-readable attribution
 * string. Exposed so callers can re-render after mutations (e.g.
 * translating the excerpt).
 */
export function renderDisplay(payload: DeepLinkPayload): string {
  const parts: string[] = [];
  if (payload.author) parts.push(payload.author);
  parts.push(payload.publisher);
  if (payload.publishedAtIso) {
    parts.push(payload.publishedAtIso.slice(0, 10)); // just the date
  }
  return parts.join(', ');
}

// ── Internals ──────────────────────────────────────────────────────────

function stripTrackingParams(url: URL, extra: ReadonlySet<string>): void {
  const toDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAM_EXACT.has(lower) || extra.has(lower)) {
      toDelete.push(key);
      continue;
    }
    if (TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) url.searchParams.delete(key);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
