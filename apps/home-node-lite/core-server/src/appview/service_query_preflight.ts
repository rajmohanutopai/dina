/**
 * Task 6.24 — service-query pre-flight orchestrator.
 *
 * Before Brain fires a `service.query` to a discovered provider,
 * it runs a pre-flight check: "is this provider trustworthy
 * enough in the current context to send them our payload?" The
 * pre-flight composes three primitives:
 *
 *   1. **`service.search`** (6.12) — finds candidate providers
 *      ranked by (capability match, distance, trust).
 *   2. **`trust.resolve`** (6.11) — fetches per-candidate trust
 *      aggregates (or uses the cache from 6.21).
 *   3. **`decideTrust`** (6.23) — maps the aggregated signal +
 *      calling context → `proceed | caution | verify | avoid`.
 *
 * This module is the orchestrator that runs all three in order
 * and returns a single verdict per candidate so the caller can
 * pick the best one (or bail when none pass).
 *
 * **Pattern**:
 *
 *   searchFn(query) → [candidates]
 *   for each candidate:
 *     trustFn(did) → {score, confidence, ring, flagCount}
 *     decideTrust(...) → {action, reason}
 *   return candidates + verdicts, sorted by ring-then-trust.
 *
 * **Never throws** — transport failures on any step surface as
 * structured outcome fields:
 *   - `search_failed` — can't discover candidates at all.
 *   - individual `trust_failed` per candidate (the preflight still
 *     returns the other candidates).
 *
 * **Context-aware**: the caller passes a `TrustContext` that
 * tightens decideTrust's thresholds based on what they plan to
 * do. "share-pii" is stricter than "read".
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6f task 6.24.
 */

import {
  type TrustAction,
  type TrustContext,
  type TrustDecision,
  type TrustInput,
  type TrustLevel,
  decideTrust,
} from './trust_decision';

/** A candidate surfaced by service.search that pre-flight will check. */
export interface PreflightCandidate {
  operatorDid: string;
  name: string;
  capability: string;
  schemaHash: string;
  distanceKm: number;
}

/** Subset of `trust.resolve` output that feeds decideTrust. */
export interface TrustSnapshot {
  score: number | null;
  confidence: number | null;
  ring?: 1 | 2 | 3 | null;
  flagCount?: number;
}

export type SearchFn = (query: {
  capability?: string;
  location?: { lat: number; lng: number; radiusKm?: number };
  limit?: number;
}) => Promise<
  | { ok: true; candidates: PreflightCandidate[] }
  | { ok: false; error: string }
>;

export type TrustFn = (
  did: string,
) => Promise<{ ok: true; snapshot: TrustSnapshot } | { ok: false; error: string }>;

export interface PreflightRequest {
  /** Capability required of the provider. */
  capability: string;
  /** Caller's trust context — gates the threshold. */
  context: TrustContext;
  /** Optional geo hint. */
  location?: { lat: number; lng: number; radiusKm?: number };
  /** Max candidates to check. Defaults to 5. */
  limit?: number;
  /** Minimum action to include in the output. Default 'caution' (skip 'verify' + 'avoid'). */
  minAction?: TrustAction;
}

export interface PreflightVerdict {
  candidate: PreflightCandidate;
  /** Trust snapshot from the resolver. Null on trust_failed. */
  trust: TrustSnapshot | null;
  /** Decide-trust verdict. Present when `trust` is present. */
  decision: TrustDecision | null;
  /** Failure reason when trust lookup or decision failed for this candidate. */
  error: string | null;
}

export type PreflightOutcome =
  | {
      ok: true;
      /** Verdicts ordered by urgency (proceed → caution → verify → avoid). */
      verdicts: PreflightVerdict[];
      /** True when at least one verdict has action='proceed'. */
      hasProceed: boolean;
    }
  | { ok: false; reason: 'search_failed'; error: string }
  | { ok: false; reason: 'invalid_input'; detail: string };

export interface PreflightOptions {
  searchFn: SearchFn;
  trustFn: TrustFn;
  /** Diagnostic hook. */
  onEvent?: (event: PreflightEvent) => void;
}

export type PreflightEvent =
  | { kind: 'search_failed'; error: string }
  | { kind: 'candidate_evaluated'; did: string; action: TrustAction | 'unknown' }
  | { kind: 'trust_failed'; did: string; error: string }
  | { kind: 'completed'; passed: number; rejected: number };

export const DEFAULT_PREFLIGHT_LIMIT = 5;
const CAPABILITY_RE = /^[a-z][a-z0-9_]{0,63}$/;

const ACTION_RANK: Readonly<Record<TrustAction, number>> = {
  proceed: 0,
  caution: 1,
  verify: 2,
  avoid: 3,
};
const UNKNOWN_LEVEL: TrustLevel = 'unknown';

/**
 * Create the pre-flight orchestrator. Returns a function
 * `(request) => Promise<PreflightOutcome>` the caller invokes
 * before sending a service.query.
 */
export function createServiceQueryPreflight(
  opts: PreflightOptions,
): (req: PreflightRequest) => Promise<PreflightOutcome> {
  if (typeof opts?.searchFn !== 'function') {
    throw new TypeError('createServiceQueryPreflight: searchFn is required');
  }
  if (typeof opts.trustFn !== 'function') {
    throw new TypeError('createServiceQueryPreflight: trustFn is required');
  }
  const searchFn = opts.searchFn;
  const trustFn = opts.trustFn;
  const onEvent = opts.onEvent;

  return async function preflight(req: PreflightRequest): Promise<PreflightOutcome> {
    const validation = validateRequest(req);
    if (validation !== null) {
      return { ok: false, reason: 'invalid_input', detail: validation };
    }
    const limit = req.limit ?? DEFAULT_PREFLIGHT_LIMIT;
    const minAction = req.minAction ?? 'caution';

    // 1. Search.
    const searchInput: Parameters<SearchFn>[0] = {
      capability: req.capability,
      limit,
    };
    if (req.location !== undefined) searchInput.location = req.location;
    const searchResult = await searchFn(searchInput);
    if (!searchResult.ok) {
      onEvent?.({ kind: 'search_failed', error: searchResult.error });
      return { ok: false, reason: 'search_failed', error: searchResult.error };
    }
    const candidates = searchResult.candidates.slice(0, limit);

    // 2. Trust lookup per candidate — run in parallel.
    const verdicts: PreflightVerdict[] = await Promise.all(
      candidates.map(async (candidate): Promise<PreflightVerdict> => {
        const trustResult = await trustFn(candidate.operatorDid);
        if (!trustResult.ok) {
          onEvent?.({
            kind: 'trust_failed',
            did: candidate.operatorDid,
            error: trustResult.error,
          });
          return {
            candidate,
            trust: null,
            decision: null,
            error: trustResult.error,
          };
        }
        const trustInput: TrustInput = {
          score: trustResult.snapshot.score,
          confidence: trustResult.snapshot.confidence,
          context: req.context,
        };
        if (trustResult.snapshot.flagCount !== undefined) {
          trustInput.flagCount = trustResult.snapshot.flagCount;
        }
        if (trustResult.snapshot.ring !== undefined) {
          trustInput.ring = trustResult.snapshot.ring;
        }
        const decision = decideTrust(trustInput);
        onEvent?.({
          kind: 'candidate_evaluated',
          did: candidate.operatorDid,
          action: decision.level === UNKNOWN_LEVEL ? 'unknown' : decision.action,
        });
        return {
          candidate,
          trust: trustResult.snapshot,
          decision,
          error: null,
        };
      }),
    );

    // 3. Filter by minAction + sort by urgency.
    const minRank = ACTION_RANK[minAction];
    const filtered = verdicts.filter((v) =>
      v.decision !== null && ACTION_RANK[v.decision.action] <= minRank,
    );
    // Also include trust_failed so callers can see + manually decide.
    // BUT putting them AFTER successful verdicts keeps the proceed list clean.
    const failed = verdicts.filter((v) => v.decision === null);
    const sorted = [...filtered].sort(comparatorByActionThenRing);
    const ordered = [...sorted, ...failed];

    const hasProceed = sorted.some((v) => v.decision?.action === 'proceed');
    onEvent?.({
      kind: 'completed',
      passed: sorted.length,
      rejected: verdicts.length - sorted.length,
    });
    return { ok: true, verdicts: ordered, hasProceed };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateRequest(req: PreflightRequest): string | null {
  if (!req || typeof req !== 'object') return 'request is required';
  if (typeof req.capability !== 'string' || !CAPABILITY_RE.test(req.capability)) {
    return 'capability must match [a-z][a-z0-9_]*';
  }
  if (
    req.context !== 'read' &&
    req.context !== 'transaction' &&
    req.context !== 'share-pii' &&
    req.context !== 'autonomous-action'
  ) {
    return 'context must be read | transaction | share-pii | autonomous-action';
  }
  if (req.limit !== undefined) {
    if (
      typeof req.limit !== 'number' ||
      !Number.isInteger(req.limit) ||
      req.limit < 1 ||
      req.limit > 20
    ) {
      return 'limit must be integer in [1, 20]';
    }
  }
  if (req.minAction !== undefined) {
    if (!(req.minAction in ACTION_RANK)) {
      return 'minAction must be proceed | caution | verify | avoid';
    }
  }
  return null;
}

function comparatorByActionThenRing(
  a: PreflightVerdict,
  b: PreflightVerdict,
): number {
  const actionDiff =
    ACTION_RANK[a.decision!.action] - ACTION_RANK[b.decision!.action];
  if (actionDiff !== 0) return actionDiff;
  // Same action — higher score first, then closer distance.
  const scoreDiff = (b.decision!.score ?? 0) - (a.decision!.score ?? 0);
  if (scoreDiff !== 0) return scoreDiff;
  return a.candidate.distanceKm - b.candidate.distanceKm;
}
