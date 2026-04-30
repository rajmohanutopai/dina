/**
 * Friend-boost helper (TN-SCORE-003 / Plan §7 line 885).
 *
 * Plan §7's search ranker formula:
 *
 *     final_score = base_score
 *                 × friend_boost
 *                 × (1 + reviewer_in_network ? bonus : 0)
 *                 × ...
 *
 * where:
 *
 *     friend_boost = FRIEND_BOOST  if any 1-hop reviewer of the
 *                                   subject overlaps the viewer's
 *                                   1-hop graph
 *                  = 1.0           otherwise
 *
 * `FRIEND_BOOST` defaults to **1.5** (Plan §13.6 — operator-tunable
 * via `trust_v1_params`; surfaced through `readTrustV1Params` from
 * TN-SCORE-009).
 *
 * **Audit verdict on existing scorer** (per Plan §13 line 601):
 * the per-viewer 1-hop / 2-hop / 3+ network-position weights from the
 * original draft are deliberately **NOT** in `trust-score.ts`. Reviewer
 * trust score is viewer-independent and cacheable; the per-viewer
 * friend-boost is a query-time multiplier applied on top by the search
 * ranker. The only network-position weight specified in Plan §7 is the
 * 1-hop FRIEND_BOOST below — there are no 2-hop or 3+ multipliers in
 * the V1 ranker. Hence "no drift to fix" in `trust-score.ts`; the work
 * for TN-SCORE-003 is shipping this primitive so TN-API-001 (search
 * filters + ranker wiring) can compose it.
 *
 * **Pure function**: given the viewer's 1-hop set and the subject's
 * reviewer set, returns the boost. No I/O, no async. Set-overlap is
 * O(min(|viewer|, |reviewers|)) using a hash lookup.
 *
 * **Boost is a flag, not a per-overlap multiplier**. Two friends
 * having reviewed the subject yields the same boost as one friend.
 * That matches the plan ("`= 1.5` if **any** 1-hop reviewer..."): the
 * boost rewards "do I know somebody who's seen this?" — not "how
 * many friends?". Stacking would let a heavily-networked viewer push
 * crowd-favoured subjects above their actual ranking, defeating the
 * sort-by-relevance contract.
 *
 * **Symmetric-empty-set semantics**: if either the viewer set OR the
 * reviewer set is empty, returns 1.0 (no overlap is possible). A new
 * viewer with no contacts gets the un-boosted baseline; a brand-new
 * subject with no reviewers can't have any friends in its reviewer
 * set. Both edges are correct AND match what the search ranker should
 * see (anything else would falsely surface unreviewed-by-anyone
 * subjects above legitimately friend-reviewed alternatives).
 *
 * **The viewer set is the 1-hop trust graph**, NOT the viewer's own
 * DID. The viewer's own attestations are excluded from rankings
 * upstream (they wouldn't be in the reviewer set of "subjects the
 * viewer reviews against"). Callers MUST exclude `viewerDid` from
 * `viewerOneHopDids` before calling this — see the JSDoc on the
 * params interface.
 */

export interface FriendBoostInput {
  /**
   * The viewer's 1-hop trust graph — DIDs the viewer has directly
   * attested to / vouched for. Caller responsibility:
   *   - Exclude the viewer's own DID (it's the root, not a 1-hop
   *     contact, and would falsely match the viewer's own
   *     attestations).
   *   - Pass an `Iterable` (Array, Set, or generator) — the helper
   *     materialises a Set internally for O(1) lookup.
   */
  readonly viewerOneHopDids: Iterable<string>
  /**
   * DIDs of reviewers who have attested to the subject. Same
   * iterable contract as `viewerOneHopDids` — caller already de-
   * duplicated upstream (a reviewer who attested twice still counts
   * once).
   */
  readonly subjectReviewerDids: Iterable<string>
  /**
   * The boost multiplier from `trust_v1_params.FRIEND_BOOST`
   * (operator-tunable, default 1.5). Caller resolves via
   * `readTrustV1Params(db).FRIEND_BOOST` so the snapshot is reused
   * across many subjects in a single ranker pass.
   *
   * **Validation**: caller is responsible for ensuring this is a
   * positive finite number. The helper does NOT clamp or sanitise —
   * a zero or negative FRIEND_BOOST would silently zero out boosted
   * results, which a unit test on the params reader (TN-SCORE-009)
   * already guards against.
   */
  readonly friendBoost: number
}

/**
 * Returns `friendBoost` when any DID in `viewerOneHopDids` overlaps
 * `subjectReviewerDids`; returns `1.0` otherwise.
 *
 * Iteration order: short-circuits on the first overlap. The viewer's
 * 1-hop graph is materialised first (typically smaller than a hot
 * subject's reviewer set in V1 — well-connected viewers have ~tens
 * of contacts; popular subjects have ~hundreds of reviewers). For
 * small viewer + large reviewer set this gives the cheapest scan.
 */
export function friendBoostFor(input: FriendBoostInput): number {
  const oneHop = new Set(input.viewerOneHopDids)
  if (oneHop.size === 0) return 1.0

  for (const reviewer of input.subjectReviewerDids) {
    if (oneHop.has(reviewer)) {
      return input.friendBoost
    }
  }
  return 1.0
}
