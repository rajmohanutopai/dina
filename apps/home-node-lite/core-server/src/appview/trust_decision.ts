/**
 * Task 6.23 — trust decision helpers.
 *
 * The AppView (`appview/src/scorer/algorithms/recommendation.ts`) is
 * the *authoritative* source for a subject's trust level — it has
 * global attestations, the social graph, flags, and the Verified+
 * Actioned signals that only the AppView can compute. But Brain
 * needs a *local* decision helper for three reasons:
 *
 *   1. **Pre-flight gating.** Before sending a `service.query` to a
 *      provider we just discovered, Brain takes the
 *      AppView-published trust score + confidence + ring + flag
 *      count and turns them into a single action: `proceed` /
 *      `caution` / `verify` / `avoid`. The AppView doesn't know the
 *      *context* the caller will use the provider in (read vs.
 *      transaction vs. autonomous action), so the final gate is
 *      here, not there.
 *   2. **Cache-locality.** The Brain caches trust scores (task
 *      6.21) so repeated queries don't re-hit AppView. The decision
 *      helper is what the cache feeds into.
 *   3. **Graceful degradation.** When AppView is unreachable, we
 *      still want a consistent verdict — typically `verify` (the
 *      safe default) rather than an exception the caller has to
 *      handle.
 *
 * This module is a **pure function**: given a `TrustInput` describing
 * what Brain knows about the subject + the intended context, return a
 * `TrustDecision` with the action, level, effective score, and
 * human-readable reasons.
 *
 * **Thresholds** match AppView's `computeRecommendation` so requester
 * + AppView verdicts don't flicker on the boundary:
 *
 *   Level:   high >= 0.80, moderate >= 0.50, low >= 0.30, else very-low
 *   Action:  proceed = score >= 0.70 AND confidence >= 0.40
 *            caution = score >= 0.40
 *            verify  = score >= 0.20
 *            avoid   = else
 *
 * **Context multipliers** (applied to raw score before level/action):
 *   read                 ×1.00  — baseline
 *   transaction          ×0.90  — money moving; raise the bar
 *   share-pii            ×0.85  — long-term privacy exposure
 *   autonomous-action    ×0.80  — agent acts without user in the loop
 *
 * **Unknown data** → action = `verify`, level = `unknown`. This
 * matches AppView's "No trust data available" branch.
 *
 * **Flag penalty**: each open flag multiplies the score by 0.6
 * (so two flags → ×0.36). Critical/serious/warning severities
 * compound the penalty (matching AppView's factor-3 logic but
 * simplified — the caller typically passes just `flagCount`).
 *
 * **Ring boosts** (matching AppView graph-context factor-4): direct
 * connection (ring=1) ×1.15, 2-hop (ring=2) ×1.05. Ring=3 is
 * no-op (strangers don't get a boost).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6f task 6.23.
 */

export type TrustLevel = 'high' | 'moderate' | 'low' | 'very-low' | 'unknown';
export type TrustAction = 'proceed' | 'caution' | 'verify' | 'avoid';

/**
 * One of the four action contexts the caller may evaluate trust in.
 * Each adjusts the score by a fixed multiplier before banding.
 */
export type TrustContext =
  | 'read'
  | 'transaction'
  | 'share-pii'
  | 'autonomous-action';

export interface TrustInput {
  /** Weighted trust score from AppView. `null` = no data. Valid range 0..1. */
  score: number | null;
  /** Confidence from AppView. `null` = no data. Valid range 0..1. */
  confidence: number | null;
  /** Count of open flags against the subject. Defaults to 0. */
  flagCount?: number;
  /**
   * Trust ring — 1=direct friend, 2=friend-of-friend, 3=stranger,
   * `null` when the graph context is unknown.
   */
  ring?: 1 | 2 | 3 | null;
  /** Context for the decision. Defaults to 'read'. */
  context?: TrustContext;
}

export interface TrustDecision {
  action: TrustAction;
  level: TrustLevel;
  /** Effective score AFTER flag penalty + ring boost + context multiplier (0..1). */
  score: number;
  /** Pass-through confidence (clamped to [0,1]). */
  confidence: number;
  /** Short human-readable reason strings, ordered most→least impactful. */
  reasons: string[];
}

// ── Public thresholds — exported so tests + admin UI can import them
//    and we don't have magic numbers duplicated across callsites. ────

export const LEVEL_HIGH = 0.8;
export const LEVEL_MODERATE = 0.5;
export const LEVEL_LOW = 0.3;

export const ACTION_PROCEED_SCORE = 0.7;
export const ACTION_PROCEED_CONFIDENCE = 0.4;
export const ACTION_CAUTION_SCORE = 0.4;
export const ACTION_VERIFY_SCORE = 0.2;

export const CONTEXT_MULTIPLIERS: Readonly<Record<TrustContext, number>> = {
  read: 1.0,
  transaction: 0.9,
  'share-pii': 0.85,
  'autonomous-action': 0.8,
};

export const FLAG_PENALTY_PER_FLAG = 0.6;
export const RING_BOOST_DIRECT = 1.15;
export const RING_BOOST_TWO_HOP = 1.05;

/**
 * Map a trust input to a single action + rationale. Pure + deterministic.
 *
 * Never throws — unknown inputs collapse to `action: 'verify'`, which
 * is the safe default. The caller (service-query pre-flight, contact
 * suggestion, review surfacer) then decides whether to proceed,
 * prompt the user, or abort.
 */
export function decideTrust(input: TrustInput): TrustDecision {
  const context = input.context ?? 'read';
  const reasons: string[] = [];

  // 1. Unknown data → immediate 'verify'. We explicitly don't guess.
  if (input.score === null && input.confidence === null) {
    return {
      action: 'verify',
      level: 'unknown',
      score: 0,
      confidence: 0,
      reasons: ['no trust data available for this subject'],
    };
  }

  let score = clamp01(input.score ?? 0);
  const confidence = clamp01(input.confidence ?? 0);

  // 2. Flag penalty — each open flag compounds 0.6×. Easy for the
  //    caller to explain: "1 flag drops ~40%, 2 flags drops ~64%".
  const flagCount = Math.max(0, input.flagCount ?? 0);
  if (flagCount > 0) {
    score *= FLAG_PENALTY_PER_FLAG ** flagCount;
    reasons.push(
      flagCount === 1
        ? '1 open flag on subject'
        : `${flagCount} open flags on subject`,
    );
  }

  // 3. Ring boost — only direct + 2-hop get a lift. Strangers (ring=3)
  //    + unknown (null) have no social-graph signal to boost with.
  if (input.ring === 1) {
    score = Math.min(1, score * RING_BOOST_DIRECT);
    reasons.push('direct trust connection');
  } else if (input.ring === 2) {
    score = Math.min(1, score * RING_BOOST_TWO_HOP);
    reasons.push('2-hop trust connection');
  }

  // 4. Context multiplier — tighten on high-stakes operations.
  const multiplier = CONTEXT_MULTIPLIERS[context];
  if (multiplier !== 1.0) {
    score *= multiplier;
    reasons.push(`context=${context} adjustment`);
  }

  score = clamp01(score);

  const level = bandLevel(score);
  const action = bandAction(score, confidence);

  // Prepend the most important summary reason so `reasons[0]` is
  // always the primary driver of the decision.
  reasons.unshift(`score=${score.toFixed(2)} confidence=${confidence.toFixed(2)}`);

  return { action, level, score, confidence, reasons };
}

/**
 * Lowest-level action the caller must take given the score+confidence.
 * Exposed for tests + admin UI so callers can see the action boundary
 * directly without going through `decideTrust` and its side-computation.
 */
export function bandAction(score: number, confidence: number): TrustAction {
  if (score >= ACTION_PROCEED_SCORE && confidence >= ACTION_PROCEED_CONFIDENCE) {
    return 'proceed';
  }
  if (score >= ACTION_CAUTION_SCORE) return 'caution';
  if (score >= ACTION_VERIFY_SCORE) return 'verify';
  return 'avoid';
}

/**
 * Label the score bucket. Exposed for admin UI "at-a-glance" rendering
 * without having to map integers back to human words.
 */
export function bandLevel(score: number): TrustLevel {
  if (score >= LEVEL_HIGH) return 'high';
  if (score >= LEVEL_MODERATE) return 'moderate';
  if (score >= LEVEL_LOW) return 'low';
  return 'very-low';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
