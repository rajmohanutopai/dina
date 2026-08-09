import type { Money } from '@dina/commerce-protocol';

/**
 * Who may commit this business to this order (§7.2, §7.3 — WS-8.4).
 *
 * TWO RULES, AND THE SECOND IS THE ONE THAT WILL BE VIOLATED BY ACCIDENT.
 *
 * §7.2: "Caller-supplied body fields do not establish any of those
 * identities." Every identity in the acting-for chain must arrive from
 * something that AUTHENTICATED it — a signed request, a paired device, an
 * install record. This module cannot check that on its own, so it does the
 * next best thing: it takes the chain as a value that a caller must ASSEMBLE
 * from authenticated sources, and refuses a chain with a gap in it. A function
 * that accepted an order and dug the principal out of its body would make the
 * violation invisible.
 *
 * §7.3: "the wire and persistence contracts must not encode 'one phone equals
 * the organization'." The pilot may ship with a single owner approver — that
 * is a CONFIGURATION with one grant in it, not a shortcut in the code. So
 * there is no `isOwner` branch that skips evaluation: the owner is a grant
 * like any other, and a node configured with exactly one of them behaves the
 * way §7.3 wants while the contract stays able to express the rest.
 *
 * IT DECIDES; IT DOES NOT SIGN. The answer is permit / needs-another-person /
 * refuse. Binding that answer to a payload is §15.2's job, and a module that
 * did both would let an authority change quietly relax a binding check.
 */

/** The identities §7.2 requires an order proposal to resolve and pin. */
export interface ActingForChain {
  /** The authenticated staff or device principal. Never from a body field. */
  principalDid: string;
  /** The Buyer (or Supplier) plugin instance acting. */
  installId: string;
  /** The business being committed. */
  actingForBusinessDid: string;
  /** The authority domain, or the policy revision when policy decided. */
  authorityDomain: string | null;
  policyRevision: string | null;
  supplierDid: string;
  serviceRkey: string;
  quoteDigest: string;
  orderDigest: string;
}

export type ChainGap =
  | 'principal_missing'
  | 'install_missing'
  | 'business_missing'
  | 'authority_missing'
  | 'counterparty_missing'
  | 'payload_missing';

/**
 * Is this chain complete enough to decide on?
 *
 * A gap is a REFUSAL, not a default. Every one of these fields is something a
 * caller had to learn from an authenticated source, so an empty one means the
 * caller did not learn it — and the safe reading of "I do not know who is
 * acting" is never "proceed as the owner".
 */
export function chainGaps(chain: ActingForChain): ChainGap[] {
  const gaps: ChainGap[] = [];
  if (chain.principalDid === '') gaps.push('principal_missing');
  if (chain.installId === '') gaps.push('install_missing');
  if (chain.actingForBusinessDid === '') gaps.push('business_missing');
  // ONE of the two, never neither: an act is authorized either by a domain a
  // person holds or by a policy revision that decided without one. Neither
  // means nothing authorized it.
  if (
    (chain.authorityDomain === null || chain.authorityDomain === '') &&
    (chain.policyRevision === null || chain.policyRevision === '')
  ) {
    gaps.push('authority_missing');
  }
  if (chain.supplierDid === '' || chain.serviceRkey === '') gaps.push('counterparty_missing');
  if (chain.quoteDigest === '' || chain.orderDigest === '') gaps.push('payload_missing');
  return gaps;
}

/** The authority shapes §7.3 requires the contract to be able to express. */
export type StaffGrant =
  | { kind: 'owner'; principalDid: string }
  | {
      kind: 'buyer';
      principalDid: string;
      /** Minor units, as a canonical integer STRING. Compared with BigInt. */
      spendCeilingMinorUnits: string;
      currency: string;
    }
  | { kind: 'category_buyer'; principalDid: string; categoryIds: string[] }
  | { kind: 'location'; principalDid: string; regionValues: string[] }
  | { kind: 'supplier_sales'; principalDid: string }
  | {
      /** §7.3 — delegated authority that stops working on its own. */
      kind: 'delegated';
      principalDid: string;
      /** The grant it stands in for while it lasts. */
      delegates: Exclude<StaffGrant, { kind: 'delegated' }>;
      notAfterMs: number;
    };

/** What the order needs authority FOR. */
export interface AuthorityRequest {
  total: Money;
  categoryIds: string[];
  /** `scheme:value` of the delivery region, when the order names one. */
  regionValue: string | null;
  side: 'buy' | 'sell';
}

/** How many distinct people this business requires for an order like this. */
export interface QuorumPolicy {
  /** Orders at or above this need a second person. Null disables the rule. */
  secondPersonAtOrAboveMinorUnits: string | null;
  currency: string;
}

export type AuthorityVerdict =
  | { permitted: true; /** Grants that carried it, for the audit record. */ via: StaffGrant[] }
  | {
      permitted: false;
      /** A second (or third) distinct principal would permit it. */
      needsAnotherPrincipal: boolean;
      reason: string;
    };

function minorUnits(value: string): bigint {
  // Throwing would turn a malformed amount into a crash on the approval path.
  // A value this cannot read is treated as UNBOUNDED, which fails toward
  // refusing rather than toward permitting: an unreadable ceiling authorizes
  // nothing, and an unreadable total exceeds every ceiling.
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

/** Is this grant usable at this instant? */
function live(grant: StaffGrant, nowMs: number): boolean {
  return grant.kind !== 'delegated' || grant.notAfterMs > nowMs;
}

/** The grant a delegation stands in for, or the grant itself. */
function effective(grant: StaffGrant): Exclude<StaffGrant, { kind: 'delegated' }> {
  return grant.kind === 'delegated' ? grant.delegates : grant;
}

/**
 * Does one grant cover this request?
 *
 * The owner grant covers everything, and that is a GRANT rather than a bypass —
 * §7.3's "one phone equals the organization" is about the contract, and a
 * contract that can express five other shapes has not encoded it.
 */
function covers(grant: StaffGrant, request: AuthorityRequest, nowMs: number): boolean {
  if (!live(grant, nowMs)) return false;
  const g = effective(grant);
  switch (g.kind) {
    case 'owner':
      return true;
    case 'buyer': {
      if (request.side !== 'buy') return false;
      // A ceiling in another currency does not convert. Converting would make
      // an authority decision depend on a rate nobody approved.
      if (g.currency !== request.total.currency) return false;
      const ceiling = minorUnits(g.spendCeilingMinorUnits);
      const total = minorUnits(request.total.minor_units);
      if (ceiling < 0n || total < 0n) return false;
      return total <= ceiling;
    }
    case 'category_buyer':
      if (request.side !== 'buy') return false;
      // EVERY category must be covered, not any: an order spanning an
      // authorized and an unauthorized category is not half-authorized.
      return (
        request.categoryIds.length > 0 &&
        request.categoryIds.every((id) => g.categoryIds.includes(id))
      );
    case 'location':
      return request.regionValue !== null && g.regionValues.includes(request.regionValue);
    case 'supplier_sales':
      return request.side === 'sell';
  }
}

/**
 * Decide whether these principals may commit this order.
 *
 * `approvals` is the set of principals who have approved so far — one on an
 * ordinary order, two when a quorum rule applies. Passing the SET rather than
 * a count is what makes the quorum real: two approvals from one person is one
 * person approving twice.
 */
export function evaluateStaffAuthority(args: {
  chain: ActingForChain;
  approvals: string[];
  grants: StaffGrant[];
  request: AuthorityRequest;
  quorum: QuorumPolicy;
  nowMs: number;
}): AuthorityVerdict {
  const gaps = chainGaps(args.chain);
  if (gaps.length > 0) {
    return {
      permitted: false,
      needsAnotherPrincipal: false,
      reason: `acting-for chain is incomplete: ${gaps.join(', ')}`,
    };
  }

  const distinct = [...new Set(args.approvals)].filter((did) => did !== '');
  if (!distinct.includes(args.chain.principalDid)) {
    // The principal who is ACTING must be among those who approved. Otherwise
    // one person could submit an order approved entirely by other people —
    // which reads as authorized and is nobody's decision to act on.
    return {
      permitted: false,
      needsAnotherPrincipal: false,
      reason: 'the acting principal has not approved',
    };
  }

  const carrying: StaffGrant[] = [];
  for (const principal of distinct) {
    const grant = args.grants.find(
      (candidate) =>
        candidate.principalDid === principal && covers(candidate, args.request, args.nowMs),
    );
    if (grant === undefined) {
      return {
        permitted: false,
        needsAnotherPrincipal: false,
        // Named, because both sides are the owner's own data and an operator
        // told only "refused" cannot tell a missing grant from an expired one.
        reason: `${principal} holds no live grant covering this order`,
      };
    }
    carrying.push(grant);
  }

  const threshold =
    args.quorum.secondPersonAtOrAboveMinorUnits === null ||
    args.quorum.currency !== args.request.total.currency
      ? null
      : minorUnits(args.quorum.secondPersonAtOrAboveMinorUnits);
  const total = minorUnits(args.request.total.minor_units);
  const needsTwo = threshold !== null && threshold >= 0n && total >= 0n && total >= threshold;

  if (needsTwo && distinct.length < 2) {
    return {
      permitted: false,
      needsAnotherPrincipal: true,
      reason: 'this amount needs a second person',
    };
  }

  return { permitted: true, via: carrying };
}
