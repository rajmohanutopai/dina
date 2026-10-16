/**
 * The kinds of part a deal is made of (COMMITMENT_KERNEL §6) — kernel-owned.
 *
 * A pack's vocabulary names its parts; the kernel says what KIND each one is
 * and so how it may be checked. This first piece covers number parts, the
 * only kind today's engines bargain over: money (minor units) and ratios
 * (basis points, 0–10,000).
 *
 * DIRECTION COMES FROM WHO PAYS. Every number part declares a payer and a
 * payee among the deal's two parties (§3: both must be parties). A lower
 * value is better for the payer, a higher one for the payee — so a pack
 * cannot declare a direction that disagrees with who the money moves to, and
 * the rule against pricing for a third party has something to check.
 *
 * PURE: no I/O, no clock, no model.
 */

/** The two parties of a two-party deal (§6: every deal is built from these). */
export type PartyRole = 'buyer' | 'seller';

/** Number-part kinds the kernel knows. */
export type NumberPartKind = 'money' | 'ratio_bps';

export interface NumberPartSpec {
  name: string;
  kind: NumberPartKind;
  payer: PartyRole;
  payee: PartyRole;
}

export const MAX_RATIO_BPS = 10_000n;

const PART_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Validate a vocabulary's number parts: names well formed, unique and sorted
 * (one spelling, so two nodes digest the same bytes), each part's payer and
 * payee distinct parties. Returns the first problem, or null.
 */
export function validateNumberParts(parts: readonly NumberPartSpec[]): string | null {
  if (parts.length === 0) return 'parts: a vocabulary names at least one part';
  for (const [i, part] of parts.entries()) {
    const f = `parts[${String(i)}]`;
    if (!PART_NAME.test(part.name)) return `${f}.name: lowercase letters, digits and _`;
    if (i > 0 && parts[i - 1].name >= part.name) return `${f}.name: parts are unique and sorted`;
    if (part.kind !== 'money' && part.kind !== 'ratio_bps') return `${f}.kind: money | ratio_bps`;
    if (part.payer === part.payee) return `${f}: payer and payee are different parties`;
    for (const side of [part.payer, part.payee]) {
      if (side !== 'buyer' && side !== 'seller') return `${f}: payer and payee are deal parties`;
    }
  }
  return null;
}

/** Is `a` at least as good as `b` for `holder`, on this part? */
export function atLeastFor(part: NumberPartSpec, holder: PartyRole, a: bigint, b: bigint): boolean {
  return holder === part.payee ? a >= b : a <= b;
}
