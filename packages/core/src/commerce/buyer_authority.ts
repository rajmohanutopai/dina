/**
 * §7.2 / §7.3 — WHO may commit this business, resolved by Core (DR-1).
 *
 * THE DEFECT THIS CLOSES, stated plainly because the WBS and the
 * implementation notes both claimed the opposite. `evaluateStaffAuthority` was
 * written, tested, and reachable only through an OPTIONAL `authority` argument
 * on `submitApprovedOrder`. Neither order route supplied it. So spend
 * ceilings, category and branch authority, quorum and time-bounded delegation
 * were dead on every real order — exercised only by tests that handed the
 * function its argument directly. WS-8.4 was marked DONE with the DoD "WIRED
 * into the buyer executor BEFORE the §15.2 binding … there is NO owner branch
 * that skips evaluation". That was false as built.
 *
 * The orphan guard could not see it: it matches symbol names, and
 * `buyer_executor.ts` names the symbol. A rule can have a caller and still
 * never run.
 *
 * TWO CHANGES TOGETHER, because either alone leaves the hole open. The routes
 * now resolve authority through this seam, and `submitApprovedOrder` takes it
 * as a REQUIRED argument so no future caller can quietly omit it. A type is
 * the only guard that cannot be forgotten.
 *
 * FAIL CLOSED WHEN NO PROVIDER IS INSTALLED. A node that cannot say who is
 * allowed to commit its business must not commit it. §7.3's pilot shape is the
 * single-approver CONFIGURATION below — one grant, evaluated like any other —
 * rather than an owner branch that skips the check, because "the owner is
 * obviously allowed" is exactly the reasoning that produced the dead code
 * path in the first place.
 */


import type { BuyerApprovalContext } from './approval_payload';
import type { ActingForChain, QuorumPolicy, StaffGrant } from './staff_authority';
import type { PurchaseOrderProposal } from '@dina/commerce-protocol';

/** Everything §7.2/§7.3 needs to decide whether this order may be committed. */
export interface BuyerAuthority {
  chain: ActingForChain;
  /** The principals who approved. A SET at evaluation: two approvals from one
   *  person is one person approving twice. */
  approvals: string[];
  grants: StaffGrant[];
  quorum: QuorumPolicy;
}

/**
 * Resolve authority for one order.
 *
 * Takes the order and the retained approval context so a provider can scope a
 * grant to the supplier, the listing and the amount actually being committed.
 * Returns null when this node has no authority record for the acting
 * principal — which is a REFUSAL, not a default: §7.3 says an owner with no
 * grant record is not an owner.
 */
export type BuyerAuthorityProvider = (args: {
  order: PurchaseOrderProposal;
  context: BuyerApprovalContext;
  serviceRkey: string;
}) => BuyerAuthority | null;

let provider: BuyerAuthorityProvider | null = null;

/** Install at boot; pass null on shutdown. */
export function installBuyerAuthorityProvider(next: BuyerAuthorityProvider | null): void {
  provider = next;
}

export function getBuyerAuthorityProvider(): BuyerAuthorityProvider | null {
  return provider;
}

/**
 * The §7.3 pilot configuration: ONE approver, expressed as one grant.
 *
 * NOT AN EXEMPTION. The owner is evaluated by the same code as a category
 * buyer or a delegated signer; they simply hold an `owner` grant. That
 * distinction is the whole point of the DoD's "an owner with no grant record
 * is not an owner" — a node whose composition root forgets to install a
 * provider refuses to buy rather than buying freely.
 *
 * `quorum` disables the second-person rule by default because a single-owner
 * business has no second person; a deployment that wants one sets a ceiling.
 */
export function singleOwnerAuthority(args: {
  ownerDid: string;
  order: PurchaseOrderProposal;
  context: BuyerApprovalContext;
  serviceRkey: string;
  /** Orders at or above this need a second person. Null disables the rule. */
  secondPersonAtOrAboveMinorUnits?: string | null;
}): BuyerAuthority {
  const chain: ActingForChain = {
    // AUTHENTICATED, never a body field. The caller of this helper is the
    // composition root, which knows who unlocked this node.
    principalDid: args.ownerDid,
    installId: args.context.install.installId,
    actingForBusinessDid: args.context.actingBusinessDid,
    authorityDomain: args.context.principal.authorityDomain,
    policyRevision: args.context.principal.policyRevision,
    supplierDid: args.order.supplier_did,
    serviceRkey: args.serviceRkey,
    quoteDigest: args.order.quote_digest,
    orderDigest: args.order.order_digest,
  };
  return {
    chain,
    approvals: [args.ownerDid],
    grants: [{ kind: 'owner', principalDid: args.ownerDid }],
    quorum: {
      secondPersonAtOrAboveMinorUnits: args.secondPersonAtOrAboveMinorUnits ?? null,
      currency: args.order.approved_total.currency,
    },
  };
}
