/**
 * Display data layer for the namespace management screen (TN-MOB-014).
 *
 * The screen renders a list of the user's pseudonymous namespaces, each
 * with its index, fragment, and freshness state ("active" — present in
 * the most recent PLC op). This module derives the displayable rows
 * from the raw PLC operation document.
 *
 * Pure data, no React, no I/O. Tested with plain Jest. The screen
 * layer (`app/trust/namespace.tsx`) wraps with theme tokens, layout,
 * and the "Add namespace" CTA; the runner that signs + submits the
 * PLC update lives elsewhere (TN-IDENT-005 + TN-IDENT-006).
 *
 * Why a separate data module rather than inlining in the screen:
 *   - The same derivation feeds the namespace screen, the
 *     reviewer-profile drill-down (when the viewer is the author),
 *     and any future debug overlay. One function for all three sites
 *     keeps the rules from drifting.
 *   - Pure-function unit tests are cheap; rendering tests are
 *     coarser and slower. The display logic deserves the lighter
 *     test surface.
 *   - Malformed PLC ops (a `verificationMethods` object with
 *     non-namespace keys, or numeric-format keys we don't recognise)
 *     need a single tolerator point.
 */

import { nextAvailableNamespaceIndex } from './plc_namespace';

/**
 * One row in the namespace screen's list. Display-ready — the screen
 * binds these directly to React Native primitives.
 */
export interface NamespaceRow {
  /** The numeric index — `0`, `1`, `2`, ... */
  readonly index: number;
  /** The fragment as published in the DID doc — `namespace_<N>`. */
  readonly fragment: string;
  /** Convenience: the full DID URL (`did:plc:xxxx#namespace_<N>`). */
  readonly verificationMethodId: string;
}

/**
 * Derive the display-ready namespace rows from a raw PLC op object
 * (the one the user's current `plc.directory` lookup returned).
 *
 * Behaviour:
 *   - Returns rows in numeric-index ascending order, regardless of
 *     key order in the source object (deterministic UI).
 *   - Filters out non-`namespace_<N>` keys (root-identity signing
 *     keys, capabilityInvocation keys, etc. — those aren't user-
 *     created namespaces and don't belong on this screen).
 *   - Tolerates a missing / malformed `verificationMethods` object
 *     by returning `[]` (the screen renders the "no namespaces yet"
 *     empty state).
 *   - Returns the verificationMethodId in fully-qualified DID URL
 *     form so the screen can copy-to-clipboard or pass to the
 *     reviewer-profile route handler.
 */
export function deriveNamespaceRows(
  did: string,
  priorSignedOperation: Record<string, unknown> | null | undefined,
): NamespaceRow[] {
  if (priorSignedOperation == null) return [];
  const vms = priorSignedOperation.verificationMethods;
  if (!vms || typeof vms !== 'object') return [];

  const rows: NamespaceRow[] = [];
  for (const k of Object.keys(vms as Record<string, unknown>)) {
    const m = /^namespace_(\d+)$/.exec(k);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 0) continue;
    rows.push({
      index: n,
      fragment: k,
      verificationMethodId: `${did}#${k}`,
    });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows;
}

/**
 * Whether the user can add another namespace right now. V1 has no
 * cap (the PLC composer's only constraint is fragment uniqueness),
 * but a `null` prior op (offline / never resolved) means the screen
 * disables the CTA — without a prior op, the composer has nothing
 * to derive the next index from.
 */
export function canAddNamespace(
  priorSignedOperation: Record<string, unknown> | null | undefined,
): boolean {
  return priorSignedOperation != null;
}

/**
 * Compute the index the next "+ Add namespace" tap will create.
 * Surfaced to the screen so the CTA can read "Add namespace_3" rather
 * than the generic "Add namespace" — small clarity win for users with
 * multiple namespaces who are about to make a key decision.
 *
 * Returns `null` when the prior op isn't loaded yet — the screen
 * keeps the CTA disabled.
 */
export function nextNamespaceIndexFor(
  priorSignedOperation: Record<string, unknown> | null | undefined,
): number | null {
  if (priorSignedOperation == null) return null;
  return nextAvailableNamespaceIndex(priorSignedOperation);
}
