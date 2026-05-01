/**
 * Handle picker — Bluesky-style availability check + suggestion
 * generator. Used by the mobile + Lite + main-Dina onboarding flows
 * when registering a new identity.
 *
 * Replaces the silent always-suffixed scheme (`raju1a2b.<host>`) with
 * a clearer UX: try the bare prefix first (`raju.<host>`), fall back
 * to a curated set of available alternatives only when the user's
 * pick is actually taken.
 *
 * Availability is checked via `com.atproto.identity.resolveHandle` —
 * the standard AT Protocol lookup. The PDS authoritatively resolves a
 * handle to a DID iff someone has bound that handle via createAccount.
 * A 4xx with "Unable to resolve handle" / 404 means the handle is
 * unbound and free to claim.
 *
 * Network-failure handling: callers are told `unknown` rather than
 * being silently treated as available — the install flow should
 * surface this and let the user proceed at their own risk. (PDS
 * createAccount will still reject collisions when reachable.)
 *
 * Pure functions throughout — RNG and current year are injectable so
 * tests are deterministic. The fetch call is the only side effect and
 * it is also injectable.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type AvailabilityKind = 'available' | 'taken' | 'invalid' | 'unknown';

export interface AvailabilityResult {
  /** The full handle that was checked, e.g. `raju.pds.dinakernel.com`. */
  handle: string;
  kind: AvailabilityKind;
  /** DID the handle resolves to (only when `kind === 'taken'`). */
  did?: string;
  /** Human-readable reason for `invalid` / `unknown`. */
  reason?: string;
}

export interface PickerOptions {
  /**
   * Base URL of the PDS that hosts the handle namespace, e.g.
   * `https://pds.dinakernel.com`. Trailing slash optional.
   */
  pdsURL: string;
  /**
   * DNS suffix all candidate handles share, e.g. `pds.dinakernel.com`.
   * Must NOT include a leading dot.
   */
  pdsHost: string;
  /** Override the global fetch (test injection / RN polyfill). */
  fetch?: typeof globalThis.fetch;
  /** Override RNG for deterministic candidate ordering in tests. */
  random?: () => number;
  /** Pin the year used by the year-suffix candidate (default: current). */
  yearOverride?: number;
  /**
   * Per-request timeout in ms (default 5000). Treated as `unknown` on
   * timeout so callers can decide whether to surface "PDS unreachable"
   * vs proceed-and-hope.
   */
  timeoutMs?: number;
}

export interface PickHandleResult {
  /** Result of checking the user's preferred handle. */
  preferred: AvailabilityResult;
  /**
   * Available alternatives to suggest when `preferred.kind !== 'available'`.
   * Empty when preferred is available (caller should just use it). All
   * entries are pre-validated as `kind: 'available'`.
   */
  alternatives: AvailabilityResult[];
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * DNS hostname segment rule: lowercase alphanumeric + hyphens, no
 * leading or trailing hyphen, total length 1–63. AT Protocol handles
 * follow the same rule (each label of the dotted name).
 */
const DNS_SEGMENT_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Maximum characters in the user-supplied prefix. DNS allows 63 per
 * label, but we cap shorter so suffix decorations (`-fox`, `42`) still
 * fit comfortably.
 */
const MAX_PREFIX_CHARS = 30;

/**
 * Minimum prefix length. Single-letter handles look like spam / are
 * easily mistyped. Mirrors install.sh which falls back to `dina` if
 * the sanitized owner name is < 3 chars.
 */
const MIN_PREFIX_CHARS = 3;

/**
 * Curated word list for `<base>-<word>` candidates. Short, neutral,
 * easy to spell. Picked for evocativeness — small enough to fit on a
 * single screen if surfaced as suggestions.
 */
const SUFFIX_WORDS = [
  'sky',
  'oak',
  'fox',
  'sage',
  'kite',
  'nova',
  'lake',
  'peak',
  'mint',
  'jade',
  'tide',
  'fern',
] as const;

/**
 * Reserved prefixes — disallow registering these to keep the
 * namespace clean for future system use. Match is case-insensitive.
 */
const RESERVED_PREFIXES = new Set([
  'admin',
  'support',
  'official',
  'dina',
  'system',
  'root',
  'api',
  'help',
]);

const DEFAULT_TIMEOUT_MS = 5_000;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Sanitize a free-form display name into a valid handle prefix.
 * Lowercase, strips non-`[a-z0-9-]`, trims edge hyphens, clamps to
 * `MAX_PREFIX_CHARS`. Returns `''` if nothing usable remains — the
 * caller should treat empty as "ask user to pick one explicitly"
 * rather than silently substituting a fallback.
 */
export function sanitizeHandlePrefix(input: string): string {
  const stripped = input
    .toLowerCase()
    .normalize('NFKD') // strip accents (José → jose)
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PREFIX_CHARS)
    .replace(/^-+|-+$/g, ''); // re-trim if slice exposed an edge hyphen
  return stripped;
}

/**
 * Validate that a fully-qualified handle (`prefix.pdsHost`) parses as
 * a valid AT Protocol handle. Returns `{ok: true}` or
 * `{ok: false, reason}` with a user-presentable error.
 */
export function validateHandleFormat(
  handle: string,
  pdsHost: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof handle !== 'string' || handle.length === 0) {
    return { ok: false, reason: 'Handle is empty.' };
  }
  if (handle.length > 253) {
    return { ok: false, reason: 'Handle is too long.' };
  }
  const suffix = `.${pdsHost.toLowerCase()}`;
  if (!handle.toLowerCase().endsWith(suffix)) {
    return { ok: false, reason: `Handle must end with ${suffix}.` };
  }
  const prefix = handle.slice(0, handle.length - suffix.length);
  if (prefix.length < MIN_PREFIX_CHARS) {
    return { ok: false, reason: `Pick at least ${MIN_PREFIX_CHARS} characters.` };
  }
  if (!DNS_SEGMENT_RE.test(prefix)) {
    return {
      ok: false,
      reason: 'Use lowercase letters, digits and hyphens (no leading/trailing hyphen).',
    };
  }
  if (RESERVED_PREFIXES.has(prefix)) {
    return { ok: false, reason: `"${prefix}" is reserved — pick another.` };
  }
  return { ok: true };
}

/**
 * Check whether a single handle is bound on the PDS. Wraps
 * `com.atproto.identity.resolveHandle` and maps the response to one
 * of `available | taken | invalid | unknown`.
 */
export async function checkHandleAvailability(
  handle: string,
  opts: PickerOptions,
): Promise<AvailabilityResult> {
  const formatCheck = validateHandleFormat(handle, opts.pdsHost);
  if (!formatCheck.ok) {
    return { handle, kind: 'invalid', reason: formatCheck.reason };
  }

  const f = opts.fetch ?? globalThis.fetch;
  const base = opts.pdsURL.replace(/\/$/, '');
  const url = `${base}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await f(url, { signal: controller.signal });
    if (res.status === 200) {
      // Handle is bound. Body should be `{"did": "did:plc:..."}`.
      // If it isn't, treat as taken-by-something we can't identify
      // rather than risk falsely advertising the handle as free.
      const body = (await res.json().catch(() => ({}))) as { did?: unknown };
      const did = typeof body.did === 'string' ? body.did : undefined;
      return { handle, kind: 'taken', did };
    }
    // 400 with "Unable to resolve handle" is the canonical AT Proto
    // "no such handle" response. 404 is what some PDS impls return.
    // Both mean: free to claim. Anything else is unknown territory.
    if (res.status === 400 || res.status === 404) {
      return { handle, kind: 'available' };
    }
    return {
      handle,
      kind: 'unknown',
      reason: `PDS responded with HTTP ${res.status}`,
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? 'PDS unreachable (timeout)'
        : err instanceof Error
          ? err.message
          : String(err);
    return { handle, kind: 'unknown', reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a stable, ordered list of candidate prefixes derived from
 * `base`. Mixes short numeric, year, prepend-word, and suffix-word
 * styles. Deterministic when `random` and `year` are injected — used
 * by the test suite. The first-3-available filter happens at the
 * caller (`pickHandle`); this function just emits raw candidates.
 *
 * The candidates are intentionally cheap to enumerate (no I/O). 12 is
 * more than the 3 we surface so the picker has room to reject taken
 * ones without re-generating.
 */
export function generateCandidates(
  base: string,
  opts?: { random?: () => number; year?: number },
): string[] {
  const random = opts?.random ?? Math.random;
  const year = opts?.year ?? new Date().getUTCFullYear();
  const yearShort = String(year).slice(-2);

  const out: string[] = [];
  const pushUnique = (c: string): void => {
    if (c === base) return;
    if (out.includes(c)) return;
    out.push(c);
  };

  // Numeric suffixes — small two-digit ints for memorability.
  pushUnique(`${base}${pickInt(random, 2, 99)}`);
  pushUnique(`${base}${pickInt(random, 2, 99)}`);
  pushUnique(`${base}${yearShort}`);

  // Prepend modifiers.
  pushUnique(`the${base}`);
  pushUnique(`real${base}`);

  // Word-suffix variants. Pull a deterministic-shuffled view of
  // SUFFIX_WORDS so two consecutive calls don't produce identical
  // lists (when random isn't injected).
  const shuffled = shuffle([...SUFFIX_WORDS], random);
  for (const w of shuffled.slice(0, 4)) {
    pushUnique(`${base}-${w}`);
  }

  // Hyphenated digit ("raju-7") for users who don't like trailing
  // numerals smashed onto the name.
  pushUnique(`${base}-${pickInt(random, 2, 9)}`);

  return out;
}

/**
 * End-to-end picker. Checks the user's preferred handle; if not
 * available, generates and pre-validates up to `count` alternatives.
 *
 * Network behaviour:
 *   - Preferred check times out → preferred reports `unknown`,
 *     alternatives still generated and checked (best-effort).
 *   - Suggestion checks: each runs in parallel with its own timeout.
 *     Only those returning `available` make the cut.
 *   - If fewer than `count` come back available, the result has fewer
 *     entries — caller can re-run or ask for a different base.
 */
export async function pickHandle(
  preferred: string,
  opts: PickerOptions,
  count = 3,
): Promise<PickHandleResult> {
  const preferredResult = await checkHandleAvailability(preferred, opts);

  // Short-circuit: preferred is good, no need to suggest alternatives.
  if (preferredResult.kind === 'available') {
    return { preferred: preferredResult, alternatives: [] };
  }

  // Pull the prefix off the preferred handle if shape allows; if the
  // user typed nonsense, fall back to the literal sanitized input.
  const suffix = `.${opts.pdsHost.toLowerCase()}`;
  const lowered = preferred.toLowerCase();
  const basePrefix = lowered.endsWith(suffix)
    ? lowered.slice(0, lowered.length - suffix.length)
    : sanitizeHandlePrefix(preferred);

  if (basePrefix.length < MIN_PREFIX_CHARS) {
    // Can't generate alternatives from an unusable base.
    return { preferred: preferredResult, alternatives: [] };
  }

  const candidatePrefixes = generateCandidates(basePrefix, {
    random: opts.random,
    year: opts.yearOverride,
  });
  const candidateHandles = candidatePrefixes.map((p) => `${p}.${opts.pdsHost}`);
  const checks = await Promise.all(
    candidateHandles.map((h) => checkHandleAvailability(h, opts)),
  );

  const alternatives = checks
    .filter((r) => r.kind === 'available')
    .slice(0, count);

  return { preferred: preferredResult, alternatives };
}

// ─── Internals ────────────────────────────────────────────────────────────

function pickInt(random: () => number, min: number, max: number): number {
  const span = max - min + 1;
  return min + Math.floor(random() * span);
}

/**
 * Fisher–Yates shuffle. Deterministic when `random` is injected.
 */
function shuffle<T>(arr: T[], random: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
