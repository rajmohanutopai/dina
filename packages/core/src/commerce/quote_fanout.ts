/**
 * Bounded quote fan-out (§12.3, §20.17) — how many suppliers one buyer
 * request is allowed to reach.
 *
 * THE AMPLIFICATION PROBLEM. A buyer asks "who can supply 500 oak chairs".
 * The obvious implementation queries every supplier the index returns, which
 * turns ONE local action into N outbound D2D messages to N independent nodes.
 * At that point the buyer's Dina is a traffic amplifier: a request costing one
 * tap produces load proportional to how many suppliers exist, and a peer who
 * repeats it in a loop has a distributed flood with someone else's name on the
 * envelopes.
 *
 * §20.17 is why the cap is a HARD ceiling rather than a default. A configurable
 * limit protects the suppliers of whoever configured it thoughtfully; a
 * ceiling protects everyone else too, including from a bug in this node.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not ranking. Choosing WHICH suppliers
 * to ask is a different question from choosing which OFFER to accept, and the
 * inputs are different: at fan-out time there are no prices, no lead times and
 * no quotes — only what an index said before anyone was contacted. Mixing the
 * two would let index metadata leak into a commercial comparison that §13.3
 * requires to rest on signed offers.
 */

/** A supplier the index offered, before anyone has been contacted. */
export interface FanoutCandidate {
  supplierDid: string;
  /** The listing this candidate came from. One supplier may have several. */
  serviceRkey: string;
  /**
   * PeerLens trust at discovery time, 0..10000. Absent means no history —
   * which orders a candidate LAST but never excludes it, because a supplier
   * nobody has rated yet is how every supplier starts.
   */
  trustBp?: number;
  /** Freshness of the catalog evidence behind this candidate, epoch ms. */
  catalogSeenAtMs?: number;
}

export type FanoutExclusion =
  /** Another listing from the same supplier was already selected. */
  | 'duplicate_supplier'
  /** Beyond the per-request cap. */
  | 'over_cap'
  /** The buyer's own DID: a node does not quote itself. */
  | 'self';

export interface ExcludedCandidate {
  candidate: FanoutCandidate;
  reason: FanoutExclusion;
}

export interface FanoutPlan {
  /** Suppliers to query, in the order they should be asked. */
  selected: FanoutCandidate[];
  /** Everyone else, with the reason. Never silently dropped. */
  excluded: ExcludedCandidate[];
  /** The ceiling that applied, so a caller can explain the shortlist. */
  capApplied: number;
}

/**
 * The ceiling. Not configurable UPWARD by anything.
 *
 * Chosen so a buyer gets a genuine comparison — a handful of quotes is enough
 * to see a spread — while the load one request can put on the network stays
 * flat as the index grows. The number matters less than the fact that it does
 * not grow with the candidate list.
 */
export const MAX_QUOTE_FANOUT = 8;

export interface FanoutPolicy {
  /** The buyer's own DID, so it never quotes itself. */
  buyerDid: string;
  /**
   * A tighter cap than the ceiling, when the owner wants fewer queries. Values
   * above `MAX_QUOTE_FANOUT` are CLAMPED rather than refused: a caller asking
   * for more should get the ceiling, not an error that tempts a workaround.
   */
  maxSuppliers?: number;
}

/**
 * Order candidates by how likely they are to give a useful quote, then take
 * the first N.
 *
 * DETERMINISTIC, so two runs over the same candidates ask the same suppliers.
 * The final tiebreak is the supplier DID rather than input order — an index
 * that returned rows in a different order must not change who gets asked, or
 * the buyer's fan-out becomes a function of someone else's pagination.
 *
 * Trust orders but never excludes. A supplier with no history sorts last and
 * still gets asked if there is room, because "nobody has rated them yet" is
 * where every supplier begins and a cold-start exclusion would make the trust
 * system self-fulfilling.
 */
export function planQuoteFanout(
  candidates: readonly FanoutCandidate[],
  policy: FanoutPolicy,
): FanoutPlan {
  // The upper clamp is the ceiling and is load-bearing. The lower clamp is
  // NOT: a negative cap already selects nothing, because `length >= cap` is
  // true from the start. What it protects is the REPORTED number — a caller
  // explaining a short shortlist to its owner should not be handed
  // `capApplied: -1`. A mutation proved the behavioural half redundant, so the
  // reason it stays is written down rather than assumed.
  const capApplied = Math.max(
    0,
    Math.min(policy.maxSuppliers ?? MAX_QUOTE_FANOUT, MAX_QUOTE_FANOUT),
  );

  const ordered = [...candidates].sort((a, b) => {
    // Higher trust first; absent trust sorts last without being removed.
    const at = a.trustBp ?? -1;
    const bt = b.trustBp ?? -1;
    if (at !== bt) return bt - at;
    // Then fresher catalog evidence: a supplier whose catalog was seen
    // recently is more likely to still offer what the index says.
    const af = a.catalogSeenAtMs ?? -1;
    const bf = b.catalogSeenAtMs ?? -1;
    if (af !== bf) return bf - af;
    // Then the DID, so index order cannot change who is asked.
    if (a.supplierDid !== b.supplierDid) return a.supplierDid.localeCompare(b.supplierDid);
    return a.serviceRkey.localeCompare(b.serviceRkey);
  });

  const selected: FanoutCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  const seenSuppliers = new Set<string>();

  for (const candidate of ordered) {
    if (candidate.supplierDid === policy.buyerDid) {
      excluded.push({ candidate, reason: 'self' });
      continue;
    }
    if (seenSuppliers.has(candidate.supplierDid)) {
      // ONE query per supplier, not one per listing. A supplier with six
      // listings would otherwise consume six of the eight slots and crowd out
      // five other suppliers — turning a cap meant to protect the network into
      // a cap that narrows the buyer's comparison.
      excluded.push({ candidate, reason: 'duplicate_supplier' });
      continue;
    }
    if (selected.length >= capApplied) {
      excluded.push({ candidate, reason: 'over_cap' });
      continue;
    }
    seenSuppliers.add(candidate.supplierDid);
    selected.push(candidate);
  }

  return { selected, excluded, capApplied };
}
