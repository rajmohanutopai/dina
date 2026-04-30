/**
 * Sender-side cosig footer derivation (TN-MOB-044).
 *
 * Per plan §10:
 *
 *   > the user's own attestation detail screen shows pending cosig
 *   > requests inline ("2 pending") and accepted cosigs as a
 *   > "Co-signed by Sancho · Albert" footer once endorsements land.
 *
 * This module owns the **derivation** — given the local cosig state
 * machines (one per cosignature request the user sent for this
 * attestation) plus a name resolver, return the two render-ready
 * pieces of UX:
 *
 *   - **Pending label** ("2 pending") — null when nothing is
 *     in flight; singular vs plural copy.
 *   - **Accepted footer** ("Co-signed by Sancho · Albert") — null
 *     when nothing has landed; ordered list of resolved names with
 *     a stable separator.
 *
 * Closed-but-not-success states (`expired`, `rejected`) DO NOT
 * surface here. The plan covers them via separate inbox UX
 * (auto-expired / declined-with-reason rows). Mixing them into the
 * footer would conflate "nobody accepted" with "everyone declined"
 * and lose the distinction the user needs to decide whether to
 * re-ask.
 *
 * Pure function. No state. No I/O. The screen wires the result into
 * a `<Text>` view; this module never touches React.
 *
 * Why a separate module rather than folding into the screen:
 *   - The same derivation is read by the attestation detail screen,
 *     the share-sheet preview, and a future activity-feed renderer.
 *     One function feeds all three; without it each call site
 *     re-implements the singular/plural + separator rules and they
 *     drift.
 *   - Tests for the rules (singular / plural / fallback name /
 *     order preservation / empty-set) run as plain Jest, no RN
 *     deps.
 */

import type { CosigState } from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/** A single accepted cosignature, ready to render. */
export interface AcceptedCosig {
  /** The originating request id — stable identifier across re-renders. */
  readonly requestId: string;
  /** Resolved display name, or the fallback when unresolved. */
  readonly name: string;
  /** Endorsement record AT-URI, carried through for tap → detail. */
  readonly endorsementUri: string;
}

export interface CosigFooterData {
  /** Number of cosig requests still in `pending` state. */
  readonly pendingCount: number;
  /**
   * "2 pending" / "1 pending", or `null` when nothing is in flight.
   * The screen renders this as an inline subtitle on the user's own
   * attestation detail card.
   */
  readonly pendingLabel: string | null;
  /** Number of cosig requests in `accepted` state. */
  readonly acceptedCount: number;
  /** Resolved names in input order — preserves the order the user sent. */
  readonly acceptedNames: readonly string[];
  /** Carried-through endorsement metadata for tap → detail navigation. */
  readonly accepted: readonly AcceptedCosig[];
  /**
   * "Co-signed by Sancho · Albert", or `null` when no cosig has landed.
   * The middle dot (U+00B7) matches plan §10's example separator —
   * unicode rather than " - " or " | " so the footer reads compactly
   * on mobile widths.
   */
  readonly acceptedLabel: string | null;
}

export interface CosigFooterInput {
  /** All cosig request states for this attestation, in any order. */
  readonly states: readonly CosigState[];
  /**
   * Optional resolver mapping `state.requestId` → display name.
   * `null` / `undefined` / empty / whitespace falls back to a generic
   * "Someone" label — never render a raw DID, which would be
   * user-hostile. The screen layer is the source of truth for the
   * lookup; passing in a resolved record keeps this module React-free.
   */
  readonly recipientNames?: Readonly<Record<string, string | null | undefined>>;
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Name fallback when the contact resolver hasn't produced a display
 * name yet (transient state at boot, contact removed, name gone).
 * "Someone" is intentionally vague but never user-hostile — the
 * sender's own footer should never expose a raw DID.
 */
export const FALLBACK_RECIPIENT_NAME = 'Someone';

/**
 * Joiner between accepted names. Plan §10 verbatim is "Sancho · Albert"
 * — middle dot (U+00B7) flanked by single spaces. Module-level constant
 * so a copy edit cannot drift the separator across screens.
 */
export const ACCEPTED_NAME_SEPARATOR = ' · ';

/** Frozen empty array — module-level so empty results share a reference. */
const EMPTY_NAMES: readonly string[] = Object.freeze([]);
const EMPTY_ACCEPTED: readonly AcceptedCosig[] = Object.freeze([]);

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Derive the render-ready footer data from a list of cosig states.
 *
 *   - Counts pending and accepted.
 *   - Resolves accepted recipients to display names (with fallback).
 *   - Formats the inline pending label and the "Co-signed by" footer.
 *
 * Order of `acceptedNames` matches the input `states` array order so
 * the screen's render is stable across re-renders. Callers wanting
 * chronological order should sort by `acceptedAt` before passing in.
 *
 * Throws on a non-array `states` input rather than coercing — silent
 * coercion would render a blank footer and hide a real wire bug.
 */
export function deriveCosigFooter(input: CosigFooterInput): CosigFooterData {
  if (!Array.isArray(input.states)) {
    throw new Error('deriveCosigFooter: states must be an array');
  }
  const namesMap = input.recipientNames ?? {};

  let pendingCount = 0;
  const accepted: AcceptedCosig[] = [];

  for (const state of input.states) {
    if (state.status === 'pending') {
      pendingCount += 1;
      continue;
    }
    if (state.status === 'accepted') {
      accepted.push({
        requestId: state.requestId,
        name: resolveName(namesMap[state.requestId]),
        endorsementUri: state.endorsementUri,
      });
    }
    // `expired` / `rejected` intentionally skipped — surfaced
    // elsewhere (inbox auto-expired row / declined-with-reason).
  }

  const acceptedNames =
    accepted.length === 0 ? EMPTY_NAMES : Object.freeze(accepted.map((a) => a.name));
  const frozenAccepted: readonly AcceptedCosig[] =
    accepted.length === 0 ? EMPTY_ACCEPTED : Object.freeze(accepted);

  return {
    pendingCount,
    pendingLabel: pendingCount > 0 ? `${pendingCount} pending` : null,
    acceptedCount: accepted.length,
    acceptedNames,
    accepted: frozenAccepted,
    acceptedLabel:
      acceptedNames.length === 0
        ? null
        : `Co-signed by ${acceptedNames.join(ACCEPTED_NAME_SEPARATOR)}`,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function resolveName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return FALLBACK_RECIPIENT_NAME;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_RECIPIENT_NAME;
}
