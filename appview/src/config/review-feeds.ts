/**
 * PER-MARKET REVIEW FEEDS (RESEARCHER_KERNEL_ARCHITECTURE §5.D, D4) — the
 * cold-start problem, answered without minting trust.
 *
 * A new market starts with an empty trust graph. Nobody has reviewed the
 * chairmaker down the road, so a ranked answer has nothing to rank, and the
 * Pull Economy's promise — rank by trust, not by ad spend — has nothing to
 * rank BY. The obvious fix is to import a corpus of reviews and let the
 * scorer treat them as reviews.
 *
 * WHICH WOULD BE THE DEAD INTERNET, BUILT ON PURPOSE. A peer attestation is
 * testimony: a person the owner can reach, whose record is signed into their
 * own repo, whose own trust can be checked and whose vouches can be walked.
 * An imported review is none of that. Writing one as if it were peer
 * testimony is exactly the attack the Dead Internet Filter exists to stop,
 * and a market bootstrapped that way would have a trust graph made of
 * somebody else's stars.
 *
 * SO THE RULE IS: AN IMPORTED REVIEW MOVES A RATING, NEVER A TRUST RING.
 *
 *   - It must NAME ITS SOURCE, in the record, with a deep link back — the
 *     Deep Link Default: Dina credits sources rather than extracting from
 *     them.
 *   - It is admitted only from a REGISTERED feed, and only from that feed's
 *     own publisher DID. Without both, any node could label its own review
 *     "imported from a review site" and have it displayed as one.
 *   - It carries a bounded, FIXED weight in a subject's rating —
 *     `IMPORTED_REVIEW_WEIGHT` — never the author's trust score, so a feed
 *     publisher cannot be vouched into speaking with a peer's authority.
 *   - It contributes NOTHING to any DID's PeerLens score, and it never
 *     counts toward a subject's CONFIDENCE. A hundred imported reviews and
 *     no peer review reads as what it is: a rating with nobody behind it
 *     yet.
 *
 * WHY THE REGISTRY SHIPS EMPTY. A feed belongs here once someone has read
 * its terms and decided Dina may show its reviews with attribution — "usage
 * terms the Pull Economy allows" is the whole difficulty of D4, and it is a
 * decision about a contract, not a line of code. An operator registers what
 * their terms permit at boot (`setReviewFeedRegistry`), the same way every
 * other host-owned table is composed. Until then every imported record is
 * refused, which is the correct behaviour for a node that has agreed to
 * nothing.
 */

/** One admitted feed: who publishes it, which market it serves, and on what terms. */
export interface ReviewFeed {
  /** The feed id a record names. Stable, lowercase, dotted. */
  readonly id: string
  /** The DID whose repo the feed's records must come from. */
  readonly publisherDid: string
  /** ISO-3166-1 alpha-2 market the feed serves. */
  readonly market: string
  /** The name a card credits. */
  readonly name: string
  /**
   * The terms under which this AppView may show the feed's reviews, in one
   * line an operator can defend — a licence name, or the agreement's id.
   * Held as evidence of the decision, never rendered as a legal claim.
   */
  readonly licence: string
  /** Where a reader goes to see the source itself. */
  readonly homepage: string
}

/**
 * Registered feeds, by id. Empty until an operator composes it: no feed's
 * terms have been read on this node's behalf, so no import is admitted.
 */
let feeds: ReadonlyMap<string, ReviewFeed> = new Map()

/**
 * Register the feeds this node admits, replacing any previous set. Called
 * from the ingester's composition root with whatever the operator's terms
 * permit; called with an empty list to admit none.
 */
export function setReviewFeedRegistry(registered: readonly ReviewFeed[]): void {
  const next = new Map<string, ReviewFeed>()
  for (const feed of registered) next.set(feed.id, feed)
  feeds = next
}

/** The feed with this id, or null when this node admits no such feed. */
export function reviewFeed(id: string): ReviewFeed | null {
  return feeds.get(id) ?? null
}

/** Every registered feed, for the admin surface and the tests. */
export function registeredReviewFeeds(): ReviewFeed[] {
  return [...feeds.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The source block a record carries when it is an import rather than testimony. */
export interface ReviewSource {
  readonly feed: string
  readonly market: string
  readonly url: string
  readonly observedAt: string
}

/** Why an imported record was refused. Metadata for the rejection log, never prose. */
export type ImportRefusal =
  /** No feed of that id is registered on this node. */
  | 'feed_not_registered'
  /** The record came from a repo that is not the feed's publisher. */
  | 'not_the_feed_publisher'
  /** The record claims a market the feed does not serve. */
  | 'market_not_served'
  /** The deep link back is missing or is not https. */
  | 'source_url_not_https'

/**
 * May this record be admitted as an import? Null means yes.
 *
 * BOTH halves of the check matter and for different reasons. The feed must be
 * registered, or a node admits a corpus nobody agreed to show. And the repo
 * must BE the feed's publisher, or any Dina could stamp "imported from a
 * review site" on its own opinion and have it rendered with that site's name
 * under it — a lie about provenance, told in Dina's own chrome.
 */
export function refuseImportedReview(args: {
  source: ReviewSource
  repoDid: string
}): ImportRefusal | null {
  const feed = reviewFeed(args.source.feed)
  if (feed === null) return 'feed_not_registered'
  if (feed.publisherDid !== args.repoDid) return 'not_the_feed_publisher'
  if (feed.market !== args.source.market) return 'market_not_served'
  if (!/^https:\/\//i.test(args.source.url)) return 'source_url_not_https'
  return null
}
