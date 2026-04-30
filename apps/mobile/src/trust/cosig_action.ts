/**
 * Cosig recipient-action data layer (TN-MOB-043).
 *
 * Per plan §10:
 *
 *   > Action choice emits `trust.cosig.accept` (publishes endorsement
 *   > + sends D2D response) or `trust.cosig.reject`.
 *
 * This module owns the **decline** half of the action surface — pure
 * builders for the D2D `trust.cosig.reject` message + actionability
 * derivation that the action-sheet UI consults to enable/disable
 * buttons.
 *
 *   - `classifyActionable(state, nowMs)` — returns whether the
 *     request is still actionable, with a precise enum status the
 *     screen can show as a toast on a stale tap.
 *   - `buildCosigRejectFrame({requestId, reason, text?, nowMs})` —
 *     returns a wire-validated `CosigReject` body, ready for the
 *     D2D send layer to wrap in an envelope. Throws on invalid
 *     input (sender bug — caller should have classified first).
 *
 * The endorse half (publish endorsement record + build accept frame)
 * lives separately (TN-MOB-042) because it needs the published
 * record's AT-URI + CID first; bundling them would conflate two
 * different control flows.
 *
 * Pure functions. No state, no I/O. The screen wires these to the
 * inbox store + the D2D send transport.
 *
 * Why a separate module rather than inlining into the action-sheet
 * handler:
 *   - The "is this still actionable?" check fires from at least
 *     three call sites: button enable/disable, tap-handler guard,
 *     and the auto-expire sweeper (when it processes pending
 *     rows). One function feeds all three; without it the rules
 *     drift.
 *   - The reject frame builder has frozen-by-test rules (closed
 *     reason enum, ISO `createdAt`, length caps from
 *     `@dina/protocol`'s `validateCosigReject`). Sender-side
 *     validation prevents a malformed message landing on the
 *     wire — protocol's validator is the authority but the mobile
 *     builder is the first defence.
 */

import {
  COSIG_REJECT_TYPE,
  validateCosigReject,
  type CosigReject,
  type CosigRejectReason,
  type CosigState,
} from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Why a request is — or isn't — actionable. The screen reads this to
 * pick an enable/disable + toast strategy:
 *   - `pending` → buttons enabled.
 *   - `expired` / `already-accepted` / `already-rejected` → buttons
 *     disabled, status used to render a "this request is no longer
 *     actionable" pill.
 */
export type ActionableStatus =
  | 'pending'
  | 'expired'
  | 'already-accepted'
  | 'already-rejected';

export interface ActionableResult {
  readonly actionable: boolean;
  readonly status: ActionableStatus;
}

export interface BuildRejectFrameInput {
  readonly requestId: string;
  readonly reason: CosigRejectReason;
  /**
   * Optional free-text — surfaced to the requester. Caller is
   * responsible for trimming UX whitespace; this builder validates
   * the post-trim length but does not silently truncate (a 1001-char
   * note would lose the user's last sentence — better to throw).
   */
  readonly text?: string;
  /** Wall-clock — injectable for deterministic tests. */
  readonly nowMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

const ACTIONABLE_PENDING: ActionableResult = Object.freeze({
  actionable: true,
  status: 'pending',
});
const ACTIONABLE_EXPIRED: ActionableResult = Object.freeze({
  actionable: false,
  status: 'expired',
});
const ACTIONABLE_ACCEPTED: ActionableResult = Object.freeze({
  actionable: false,
  status: 'already-accepted',
});
const ACTIONABLE_REJECTED: ActionableResult = Object.freeze({
  actionable: false,
  status: 'already-rejected',
});

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Decide whether the recipient can still endorse / decline a cosig
 * request given its current state machine value + the wall-clock.
 *
 * Rules:
 *   - `pending` AND `nowMs < expiresAt` → actionable.
 *   - `pending` AND `nowMs >= expiresAt` → `expired` (boundary
 *     closes — matches `cosig_inbox.classifyState`).
 *   - terminal accepted/rejected → not actionable, regardless of
 *     clock (cosigned-then-time-passed is still cosigned).
 *
 * Module-level frozen result constants so identical states return
 * identity-equal results — cheap React reconciliation.
 *
 * Throws on a malformed `expiresAt` rather than coercing to "always
 * expired" — silent coercion would close an active row on a wire
 * format bug; throwing surfaces the issue to the screen's error
 * boundary instead.
 */
export function classifyActionable(state: CosigState, nowMs: number): ActionableResult {
  switch (state.status) {
    case 'accepted':
      return ACTIONABLE_ACCEPTED;
    case 'rejected':
      return ACTIONABLE_REJECTED;
    case 'expired':
      return ACTIONABLE_EXPIRED;
    case 'pending': {
      const expMs = parseISOMs(state.expiresAt);
      return nowMs < expMs ? ACTIONABLE_PENDING : ACTIONABLE_EXPIRED;
    }
  }
}

/**
 * Build a `CosigReject` D2D body ready for envelope wrapping.
 *
 * Sender-side validation: rejects an empty `requestId`, an unknown
 * `reason`, an over-long `text`, or a non-finite `nowMs` — anything
 * that would land as a `validateCosigReject` failure on the wire.
 * Throwing on the sender side gives the screen a synchronous error
 * to display rather than discovering the failure asynchronously
 * after a network round-trip.
 *
 * `text` is optional; only carried through when present (omits the
 * field entirely otherwise so the wire shape stays compatible with
 * `exactOptionalPropertyTypes`).
 */
export function buildCosigRejectFrame(input: BuildRejectFrameInput): CosigReject {
  if (typeof input.nowMs !== 'number' || !Number.isFinite(input.nowMs)) {
    throw new Error('buildCosigRejectFrame: nowMs must be a finite number');
  }
  const createdAt = new Date(input.nowMs).toISOString();

  const frame: CosigReject = {
    type: COSIG_REJECT_TYPE,
    requestId: input.requestId,
    reason: input.reason,
    createdAt,
    ...(input.text !== undefined ? { text: input.text } : {}),
  };

  // Re-route through the protocol's authoritative validator so the
  // rules can never drift between sender and recipient. Any error
  // text from the protocol surfaces verbatim.
  const errors = validateCosigReject(frame);
  if (errors.length > 0) {
    throw new Error(`buildCosigRejectFrame: invalid frame — ${errors.join('; ')}`);
  }
  return frame;
}

// ─── Internal ─────────────────────────────────────────────────────────────

function parseISOMs(iso: string): number {
  if (typeof iso !== 'string' || iso.length === 0) {
    throw new Error('classifyActionable: state.expiresAt must be an ISO-8601 string');
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(
      `classifyActionable: state.expiresAt is not a valid ISO-8601 datetime: "${iso}"`,
    );
  }
  return ms;
}
