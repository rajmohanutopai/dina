/**
 * SemVer parser + comparator — zero-dep subset of semver 2.0.0.
 *
 * Brain gates client compatibility by version: "reject devices
 * running dina-cli < 0.3.0", "warn if mobile < 0.2.0-beta.1". This
 * primitive parses and compares versions.
 *
 * **Supported**:
 *
 *   - Three-segment `MAJOR.MINOR.PATCH` with non-negative integers.
 *   - Optional pre-release suffix `-ALPHANUM.ALPHANUM...` — each
 *     identifier is numeric (compared as number) or alphanumeric
 *     (compared lexicographically). Missing pre-release ranks HIGHER
 *     than any present pre-release (`1.0.0` > `1.0.0-rc.1`).
 *   - Optional build metadata suffix `+ALPHANUM` — PARSED but
 *     IGNORED for comparison (per semver 2.0 spec).
 *
 * **Not supported** (deliberately — this is a compatibility gate,
 * not a full semver library):
 *
 *   - Range syntax (`^`, `~`, `>=`, etc.) — caller pairs
 *     `compareSemver` with their own range logic.
 *   - Leading `v` or other prefixes.
 *
 * **Pure** — no state, no IO.
 */

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Array of pre-release identifiers. Empty when absent. */
  pre: ReadonlyArray<string>;
  /** Build metadata — ignored for comparison. Raw string or null. */
  build: string | null;
  /** Original source — round-trip check. */
  raw: string;
}

export class SemverParseError extends Error {
  constructor(
    public readonly code: 'empty' | 'bad_format' | 'bad_number' | 'bad_identifier',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'SemverParseError';
  }
}

// Pre-release identifier: ALPHANUM (letters + digits + hyphen).
// Numeric identifiers can't have leading zeroes per spec.
const IDENT_PATTERN = /^(0|[1-9]\d*|[A-Za-z0-9-]+)$/;
const BUILD_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

/**
 * Parse a semver string. Throws `SemverParseError` on invalid input.
 */
export function parseSemver(raw: string): ParsedSemver {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SemverParseError('empty', 'version string required');
  }
  const trimmed = raw.trim();
  const core = trimmed;

  // Split build metadata first — `+foo` at the end.
  let build: string | null = null;
  let withoutBuild = core;
  const plusIdx = core.indexOf('+');
  if (plusIdx !== -1) {
    const buildPart = core.slice(plusIdx + 1);
    if (buildPart === '' || !BUILD_PATTERN.test(buildPart)) {
      throw new SemverParseError('bad_format', `invalid build metadata "${buildPart}"`);
    }
    build = buildPart;
    withoutBuild = core.slice(0, plusIdx);
  }

  // Pre-release splits on first `-` AFTER the core numbers.
  const coreEnd = firstPreDash(withoutBuild);
  const coreSegment = coreEnd === -1 ? withoutBuild : withoutBuild.slice(0, coreEnd);
  const preSegment = coreEnd === -1 ? '' : withoutBuild.slice(coreEnd + 1);

  // Parse MAJOR.MINOR.PATCH.
  const parts = coreSegment.split('.');
  if (parts.length !== 3) {
    throw new SemverParseError('bad_format', `expected MAJOR.MINOR.PATCH (got ${coreSegment})`);
  }
  const [maj, min, pat] = parts;
  const major = parseNonNegInt(maj!, 'MAJOR');
  const minor = parseNonNegInt(min!, 'MINOR');
  const patch = parseNonNegInt(pat!, 'PATCH');

  // Parse pre-release.
  const pre: string[] = [];
  if (coreEnd !== -1) {
    // A dash was present; pre-release segment must be non-empty.
    if (preSegment === '') {
      throw new SemverParseError('bad_identifier', 'pre-release segment must be non-empty');
    }
    for (const id of preSegment.split('.')) {
      if (id === '' || !IDENT_PATTERN.test(id)) {
        throw new SemverParseError('bad_identifier', `invalid pre-release identifier "${id}"`);
      }
      // All-digit identifiers must NOT have leading zeros (semver §9).
      if (/^\d+$/.test(id) && id.length > 1 && id.startsWith('0')) {
        throw new SemverParseError(
          'bad_identifier',
          `numeric pre-release identifier must not have leading zeros: "${id}"`,
        );
      }
      pre.push(id);
    }
  }

  return { major, minor, patch, pre, build, raw: trimmed };
}

/**
 * Compare two versions. Returns -1 / 0 / 1. Build metadata ignored.
 */
export function compareSemver(a: ParsedSemver | string, b: ParsedSemver | string): number {
  const pa = typeof a === 'string' ? parseSemver(a) : a;
  const pb = typeof b === 'string' ? parseSemver(b) : b;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // Pre-release: absence > presence.
  const aHas = pa.pre.length > 0;
  const bHas = pb.pre.length > 0;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  if (!aHas && !bHas) return 0;
  // Both have pre-release; compare identifier-wise.
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const aId = pa.pre[i];
    const bId = pb.pre[i];
    if (aId === undefined) return -1; // longer pre-release wins in tie
    if (bId === undefined) return 1;
    const aNum = /^\d+$/.test(aId);
    const bNum = /^\d+$/.test(bId);
    if (aNum && bNum) {
      const an = Number(aId);
      const bn = Number(bId);
      if (an !== bn) return an < bn ? -1 : 1;
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1; // numeric identifiers lower precedence
    if (aId !== bId) return aId < bId ? -1 : 1;
  }
  return 0;
}

/** Syntactic-validity check without exceptions. */
export function isValidSemver(raw: string): boolean {
  try {
    parseSemver(raw);
    return true;
  } catch {
    return false;
  }
}

/** Compatibility helpers — convenience wrappers. */
export function satisfiesAtLeast(version: string, min: string): boolean {
  return compareSemver(version, min) >= 0;
}

export function satisfiesLessThan(version: string, max: string): boolean {
  return compareSemver(version, max) < 0;
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Find the index of the first `-` that begins the pre-release
 * section — i.e. AFTER the core `X.Y.Z`. Returns -1 when none.
 */
function firstPreDash(text: string): number {
  // Walk until we've seen two dots.
  let dots = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '.') dots += 1;
    else if (ch === '-' && dots >= 2) return i;
  }
  return -1;
}

function parseNonNegInt(segment: string, label: string): number {
  if (segment === '' || !/^(0|[1-9]\d*)$/.test(segment)) {
    throw new SemverParseError('bad_number', `${label} must be non-negative integer without leading zeros (got ${segment})`);
  }
  return Number(segment);
}
