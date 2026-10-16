/**
 * An agreement's life after binding (COMMITMENT_KERNEL §10, "The agreement
 * and its life") — the rules today's term engine applies to ending a deal,
 * moved into the kernel unchanged.
 *
 *   - AN ENDING'S DATE. Notice runs from the date the sender signs, so the
 *     receiver accepts that date only when the document reached it soon
 *     after (`windowMs`) and not from the future beyond a clock's drift.
 *     Otherwise a party could backdate an ending and skip the notice.
 *   - A TRIAL waives the notice, but only for an ending that reached the
 *     receiver before the trial ended; one dated into the trial and arriving
 *     later is refused.
 *   - THE END. An agreement ends at its own end, or at the earliest ending
 *     on record. An ending the other side refused takes no effect on either
 *     side. An ending this node sent frees what the agreement held only once
 *     the other side stored it: until then a refusal could restore the deal.
 *
 * A renewal is a new agreement, not an amendment. PURE: no I/O, no clock.
 */

export type EndingArrival = 'in_time' | 'dated_after_arrival' | 'dated_too_early';

export function judgeEndingArrival(args: {
  signedAtMs: number;
  receivedAtMs: number;
  windowMs: number;
  driftMs: number;
}): EndingArrival {
  if (args.signedAtMs > args.receivedAtMs + args.driftMs) return 'dated_after_arrival';
  if (args.signedAtMs < args.receivedAtMs - args.windowMs) return 'dated_too_early';
  return 'in_time';
}

/** Does an ending that claims the trial's waiver arrive too late to have it? */
export function trialWaiverArrivedLate(args: {
  signedAtMs: number;
  trialEndMs: number | undefined;
  receivedAtMs: number;
  driftMs: number;
}): boolean {
  return (
    args.trialEndMs !== undefined &&
    args.signedAtMs < args.trialEndMs &&
    args.receivedAtMs - args.driftMs >= args.trialEndMs
  );
}

export interface EndingOnRecord {
  effectiveAtMs: number;
  /** The other side refused it: it takes no effect. */
  refused: boolean;
  /** Received from the other side, or sent and stored by it. */
  confirmed: boolean;
}

export function foldAgreementEnd(args: { endMs: number; endings: readonly EndingOnRecord[] }): {
  /** When it ends, or ended. */
  endsAtMs: number;
  /** Until when it holds what it binds, for new deals. */
  heldUntilMs: number;
  /** An ending is on record (it may take effect later). */
  ended: boolean;
} {
  let endsAtMs = args.endMs;
  let heldUntilMs = args.endMs;
  let ended = false;
  for (const ending of args.endings) {
    if (ending.refused) continue;
    ended = true;
    endsAtMs = Math.min(endsAtMs, ending.effectiveAtMs);
    if (ending.confirmed) heldUntilMs = Math.min(heldUntilMs, ending.effectiveAtMs);
  }
  return { endsAtMs, heldUntilMs, ended };
}
