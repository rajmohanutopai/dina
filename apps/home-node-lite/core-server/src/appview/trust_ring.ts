/**
 * Task 6.22 — trust ring resolution.
 *
 * Brain's decision helper (task 6.23) takes a `ring` value that says
 * how close the subject is to the user in the social graph:
 *
 *   **Ring 1**: direct contact. The user has explicitly added this
 *     DID to their contacts (or the subject has attested-to the user
 *     with reciprocal signal). Strongest trust signal.
 *   **Ring 2**: friend-of-friend. A Ring-1 contact has vouched for /
 *     attested to the subject. Mild trust boost.
 *   **Ring 3**: stranger. No path through the trust graph — the
 *     subject is only known via public AppView data.
 *
 * **Why a separate module?**  The resolver composes three inputs:
 *
 *   1. The user's own contact list (Ring 1 membership).
 *   2. Each Ring-1 contact's trust edges (Ring 2 membership) — this
 *      is what AppView's graph context provides (`shortestPath: 1 |
 *      2 | 3+`).
 *   3. A short-circuit: the subject DID === the user's own DID
 *      (Ring 1 trivially; you're always your own best friend).
 *
 * The resolver itself is **pure** — it takes the graph + the query
 * DID and returns a ring. Fetching the graph (Core adapter + AppView
 * xRPC) is a separate concern wired by the caller.
 *
 * **Semantics** (pinned by tests):
 *   - `resolveRing({userDid, subjectDid, contacts, twoHopContacts})`:
 *     - `subjectDid === userDid` → ring 1 (self)
 *     - `subjectDid ∈ contacts` → ring 1
 *     - `subjectDid ∈ twoHopContacts` → ring 2
 *     - else → ring 3
 *   - `null` is the answer when the user's own DID is unknown (not
 *     yet provisioned) — the resolver can't evaluate membership.
 *   - Duplicate entries in `contacts` / `twoHopContacts` are fine —
 *     `Set` semantics apply.
 *   - DID comparison is exact string match (case-sensitive). AT
 *     Protocol DIDs are canonical-form ASCII, so no normalisation
 *     needed.
 *
 * **Index construction**: for services that resolve many subjects
 * against the same graph (batch trust-check of a search result list),
 * build a `TrustRingIndex` once + reuse it. Map-backed O(1) lookup
 * vs. a scan of arrays.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6f task 6.22.
 */

/** AT Protocol DID — e.g. `did:plc:abc123`. */
export type Did = string;

/** The three-ring trust model from ARCHITECTURE.md §Trust Rings. */
export type TrustRing = 1 | 2 | 3;

export interface ResolveRingInput {
  /**
   * The user's own DID. When `null`, the user isn't yet provisioned
   * — the resolver returns `null` instead of guessing a ring.
   */
  userDid: Did | null;
  /** The subject we want to classify. */
  subjectDid: Did;
  /** DIDs the user has added as direct contacts. */
  contacts: Iterable<Did>;
  /**
   * DIDs that a Ring-1 contact has in THEIR direct contacts /
   * attestations. The resolver doesn't care how the caller computed
   * this set — AppView graph-context, local cache, or a Set union.
   */
  twoHopContacts: Iterable<Did>;
}

/**
 * Classify a single subject. Pure — same input → same output forever.
 *
 * Returns `null` only when `userDid` is unknown (user not yet
 * provisioned). In every other case returns 1 | 2 | 3.
 */
export function resolveRing(input: ResolveRingInput): TrustRing | null {
  if (typeof input.userDid !== 'string' || input.userDid === '') {
    return null;
  }
  if (typeof input.subjectDid !== 'string' || input.subjectDid === '') {
    // Reject empty subject — we can't classify nothing.
    return 3;
  }

  if (input.subjectDid === input.userDid) return 1;

  // Walk `contacts` first — an O(n) scan is fine for single-shot
  // resolution of typical contact lists (tens to hundreds). Callers
  // with large graphs should use `TrustRingIndex` instead.
  for (const c of input.contacts) {
    if (c === input.subjectDid) return 1;
  }
  for (const c of input.twoHopContacts) {
    if (c === input.subjectDid) return 2;
  }
  return 3;
}

/**
 * O(1)-per-lookup ring classifier for batch use. Build once, reuse
 * across many subjects — Set-backed membership test.
 *
 * Example: service-search returns 20 candidates + we want the ring
 * for each to feed `decideTrust`. Building 20 fresh Sets would be
 * wasteful; the index amortises the cost.
 */
export class TrustRingIndex {
  private readonly userDid: Did | null;
  private readonly contacts: ReadonlySet<Did>;
  private readonly twoHop: ReadonlySet<Did>;

  constructor(opts: {
    userDid: Did | null;
    contacts: Iterable<Did>;
    twoHopContacts: Iterable<Did>;
  }) {
    this.userDid =
      typeof opts.userDid === 'string' && opts.userDid !== ''
        ? opts.userDid
        : null;
    // Freeze via ReadonlySet<Did>; Set itself is already structurally
    // read-through from the outside since we never expose it.
    this.contacts = new Set(opts.contacts);
    this.twoHop = new Set(opts.twoHopContacts);
  }

  /** Ring of a single subject — same contract as `resolveRing()`. */
  ring(subjectDid: Did): TrustRing | null {
    if (this.userDid === null) return null;
    if (typeof subjectDid !== 'string' || subjectDid === '') return 3;
    if (subjectDid === this.userDid) return 1;
    if (this.contacts.has(subjectDid)) return 1;
    if (this.twoHop.has(subjectDid)) return 2;
    return 3;
  }

  /**
   * Batch classification. Preserves input order so callers can zip
   * with a parallel list (e.g. search result DIDs).
   *
   * Returns `null` for every subject when `userDid` is unknown — the
   * caller gets a stable shape regardless of provisioning state.
   */
  rings(subjectDids: Iterable<Did>): Array<TrustRing | null> {
    return Array.from(subjectDids, (d) => this.ring(d));
  }

  /** Count of direct contacts — for admin UI "you know N people". */
  contactCount(): number {
    return this.contacts.size;
  }

  /** Count of 2-hop contacts — for admin UI "reach: M people". */
  twoHopCount(): number {
    return this.twoHop.size;
  }
}
