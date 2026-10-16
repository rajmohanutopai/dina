/**
 * The offer chain (COMMITMENT_KERNEL §5, §10) — each offer names the one
 * before it, and only certain offers may still be taken up. Kernel-owned;
 * the documents themselves stay the pack's wire format.
 *
 * WHICH OFFER A YES MAY BIND. The chain's head — or the one just before it
 * when the head was signed on the owner's yes (a revision that answers the
 * offer it revises, rather than a counter). A yes only concedes, so the
 * older offer is at least as good for its signer on every part, and a party
 * that said yes to it while the revision was in flight still has a deal.
 *
 * LATENESS IS JUDGED ON THE SIGNED TIME (SHELF_SPACE_NEGOTIATION §7.1 step
 * 5): a yes signed before the offer expired counts, if it arrives within a
 * bounded grace.
 *
 * PURE: no I/O, no clock.
 */

export interface ChainLink {
  digest: string;
  previousDigest?: string;
  /** The document this link was sent in answer to. */
  answersDigest: string | null;
}

/** The digests a yes may bind, given the chain in revision order. */
export function bindableDigests(chain: readonly ChainLink[]): string[] {
  const head = chain[chain.length - 1];
  if (head === undefined) return [];
  const out = [head.digest];
  if (head.previousDigest !== undefined && head.answersDigest === head.previousDigest) {
    out.push(head.previousDigest);
  }
  return out;
}

export type Lateness = 'in_time' | 'signed_after_expiry' | 'arrived_too_late';

export function judgeLateness(args: {
  signedAtMs: number;
  validUntilMs: number;
  nowMs: number;
  graceMs: number;
}): Lateness {
  if (args.signedAtMs > args.validUntilMs) return 'signed_after_expiry';
  if (args.nowMs > args.validUntilMs + args.graceMs) return 'arrived_too_late';
  return 'in_time';
}
