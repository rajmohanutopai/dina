/**
 * Promised capacity across bundles and live deals (COMMITMENT_KERNEL §8 step
 * 9): two crates of spare room are never promised twice. A bundle (one deal
 * across several resources, §6) counts every member's promises together, and
 * against what the owner already promised in live deals.
 *
 * PURE: the caller says what is already promised; this module adds and
 * compares.
 */

import type { DealPart, DealVersion } from './value_model';

export interface Capacity {
  /** The promise dimension that is counted (crates, hours). */
  dimension: string;
  /** The most the owner can promise in all. */
  amount: bigint;
}

function counted(part: DealPart, dimension: string): bigint {
  if (part.kind !== 'promise') return 0n;
  const v = part.dimensions[dimension];
  return typeof v === 'bigint' ? v : typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : 0n;
}

/**
 * Does a deal — one version, or every member of a bundle — fit beside what is
 * already promised? Only promises the owner keeps count (`mine`). Returns the
 * first promise kind past its capacity, or null when everything fits.
 */
export function overCapacity(args: {
  capacities: Readonly<Record<string, Capacity>>;
  already: Readonly<Record<string, bigint>>;
  members: readonly DealVersion[];
  mine: (part: Extract<DealPart, { kind: 'promise' }>) => boolean;
}): string | null {
  for (const [name, cap] of Object.entries(args.capacities)) {
    let total = args.already[name] ?? 0n;
    for (const member of args.members)
      for (const part of member.parts)
        if (part.kind === 'promise' && part.name === name && args.mine(part))
          total += counted(part, cap.dimension);
    if (total > cap.amount) return name;
  }
  return null;
}
