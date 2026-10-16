/**
 * Revising an offer inside per-part limits (COMMITMENT_KERNEL §7,
 * "Limit-only models") — the rules today's term engine applies to a whole
 * offer, moved into the kernel unchanged.
 *
 *   - A FIRST OFFER never asks the owner: a part short of its automatic
 *     limit is raised to it.
 *   - A REVISION clamps each part, and NEVER RETREATS from what the other
 *     side already holds: when the clamp would go back, the current value is
 *     kept and only the question to the owner is raised.
 *   - If a hard limit has moved past the current offer (the owner tightened
 *     it), the offer no longer stands for that part: hold, do not revise
 *     around it.
 *   - An OWNER'S YES concedes only: it moves a part toward the other side
 *     and only within the hard limits now in force.
 *
 * Parts are walked in the vocabulary's order. PURE: no I/O, no clock.
 */

import { clampPart, type PartBounds } from './limits';
import { atLeastFor, type NumberPartSpec, type PartyRole } from './parts';

type Values<N extends string> = Record<N, bigint>;

/** A first offer: each part raised to its automatic limit if short of it. */
export function firstWithinLimits<N extends string>(
  parts: readonly NumberPartSpec[],
  holder: PartyRole,
  proposed: Values<N>,
  bounds: Record<N, PartBounds>,
): Values<N> {
  const signed = {} as Values<N>;
  for (const part of parts) {
    const name = part.name as N;
    signed[name] = atLeastFor(part, holder, proposed[name], bounds[name].auto)
      ? proposed[name]
      : bounds[name].auto;
  }
  return signed;
}

export type LimitRevision<N extends string> =
  /** A hard limit now forbids the current offer: hold, do not revise. */
  | { kind: 'hold' }
  /**
   * What may be signed. `asked` holds the parts the owner is asked about;
   * `unchanged` means nothing moved, so the current offer stands.
   */
  | { kind: 'signed'; signed: Values<N>; asked: Partial<Values<N>>; unchanged: boolean };

export function reviseWithinLimits<N extends string>(args: {
  parts: readonly NumberPartSpec[];
  holder: PartyRole;
  current: Values<N>;
  proposed: Values<N>;
  bounds: Record<N, PartBounds>;
  authorised: ReadonlyMap<string, bigint>;
}): LimitRevision<N> {
  const { parts, holder, current, proposed, bounds, authorised } = args;
  const signed = {} as Values<N>;
  const asked: Partial<Values<N>> = {};
  for (const part of parts) {
    const name = part.name as N;
    if (!atLeastFor(part, holder, current[name], bounds[name].hard)) return { kind: 'hold' };
    const clamp = clampPart(
      part,
      holder,
      proposed[name],
      bounds[name],
      authorised.get(name) ?? null,
    );
    signed[name] = atLeastFor(part, holder, clamp.value, current[name])
      ? current[name]
      : clamp.value;
    if (clamp.needsOwner) asked[name] = clamp.asked;
  }
  const unchanged = parts.every((part) => signed[part.name as N] === current[part.name as N]);
  return { kind: 'signed', signed, asked, unchanged };
}

/**
 * The offer an owner's yes allows: each authorised value that concedes is
 * taken, the rest carried over. Null when nothing moves, or when any part of
 * the result is past a hard limit in force now.
 */
export function ownerConcession<N extends string>(args: {
  parts: readonly NumberPartSpec[];
  holder: PartyRole;
  current: Values<N>;
  authorised: ReadonlyMap<string, bigint>;
  bounds: Record<N, PartBounds>;
}): Values<N> | null {
  const { parts, holder, current, authorised, bounds } = args;
  const signed = { ...current };
  for (const part of parts) {
    const value = authorised.get(part.name);
    const name = part.name as N;
    if (value !== undefined && !atLeastFor(part, holder, value, current[name]))
      signed[name] = value;
  }
  if (parts.every((part) => signed[part.name as N] === current[part.name as N])) return null;
  return meetsHardLimits(parts, holder, signed, bounds) ? signed : null;
}

/** Does every part clear its hard limit? The line when the owner approves in person. */
export function meetsHardLimits<N extends string>(
  parts: readonly NumberPartSpec[],
  holder: PartyRole,
  values: Values<N>,
  bounds: Record<N, PartBounds>,
): boolean {
  return parts.every((part) =>
    atLeastFor(part, holder, values[part.name as N], bounds[part.name as N].hard),
  );
}
