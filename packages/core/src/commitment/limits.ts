/**
 * Per-part limits in a limit-only model (COMMITMENT_KERNEL §7) — the part of
 * the envelope today's term engine already runs, moved into the kernel
 * unchanged.
 *
 * A part carries a hard limit (never signed past) and an automatic one (the
 * furthest Core signs alone). Limits never trade one part against another:
 * a hard floor on share of sales holds however good the rent is. The holder
 * is the party the limits protect; for a store's floors that is the seller.
 *
 * PURE: no I/O, no clock, no model.
 */

import { atLeastFor, MAX_RATIO_BPS, type NumberPartSpec, type PartyRole } from './parts';

export interface PartBounds {
  hard: bigint;
  auto: bigint;
}

export type PartClamp =
  /** Within what Core signs alone. */
  | { value: bigint; needsOwner: false }
  /** The proposal went past the automatic limit but not past the hard one. */
  | { value: bigint; needsOwner: true; asked: bigint };

/**
 * Move a value in the holder's favour by `count × premiumBps`, rounding once
 * in the holder's favour; ratio parts are capped at 10,000 bps.
 */
export function applyPremium(
  part: NumberPartSpec,
  holder: PartyRole,
  value: bigint,
  count: number,
  premiumBps: number,
): bigint {
  if (count <= 0 || premiumBps <= 0) return value;
  const numerator = value * BigInt(10_000 + count * premiumBps);
  // The holder wants higher when it is paid: round UP; when it pays, DOWN.
  let moved = holder === part.payee ? (numerator + 9_999n) / 10_000n : numerator / 10_000n;
  if (part.kind === 'ratio_bps' && moved > MAX_RATIO_BPS) moved = MAX_RATIO_BPS;
  return moved;
}

/**
 * Where a proposal for one part lands: an owner-authorised value between the
 * limits is honoured; otherwise the proposal is moved to the automatic limit,
 * and a proposal past it is reported so the owner can be asked — about the
 * proposal when it is within the hard limit, about the hard limit when it is
 * past it. Equal limits raise no question. Nothing is ever past the hard limit.
 */
export function clampPart(
  part: NumberPartSpec,
  holder: PartyRole,
  proposed: bigint,
  bounds: PartBounds,
  ownerAuthorised: bigint | null,
): PartClamp {
  const atLeast = (a: bigint, b: bigint): boolean => atLeastFor(part, holder, a, b);
  const authorisedUsable =
    ownerAuthorised !== null &&
    atLeast(ownerAuthorised, bounds.hard) &&
    !atLeast(ownerAuthorised, bounds.auto);
  const lowestAllowed = authorisedUsable ? ownerAuthorised : bounds.auto;
  if (atLeast(proposed, lowestAllowed)) return { value: proposed, needsOwner: false };
  if (!authorisedUsable && bounds.hard !== bounds.auto) {
    const asked = atLeast(proposed, bounds.hard) ? proposed : bounds.hard;
    return { value: bounds.auto, needsOwner: true, asked };
  }
  return { value: lowestAllowed, needsOwner: false };
}
