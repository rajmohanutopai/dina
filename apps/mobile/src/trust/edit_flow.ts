/**
 * Compose-flow edit data layer (TN-MOB-025).
 *
 * atproto records are immutable, so V1 ships **edit = delete +
 * republish** under the hood (plan §8.6, decision row 19). The mobile
 * UI labels it "Edit"; the wire-level operation is two atproto calls
 * sequenced through the outbox watcher.
 *
 * The interesting bit isn't the rearrangement of arguments — it's the
 * **cosignature-release warning**. From plan §8.6:
 *
 *   > Race: if the user has an in-flight cosig request on the
 *   > original attestation, the edit-republish breaks the
 *   > endorsement (endorsement's `target` AT-URI no longer
 *   > resolves). V1 surfaces a confirm dialog: "This review has 2
 *   > cosignatures. Editing will release them — they'll need to be
 *   > requested again."
 *
 * That warning has to be honest about what's about to happen — the
 * user has already received N cosignatures from people who thought
 * the *current* text was worth co-signing. Republishing under a new
 * AT-URI means those endorsements stop pointing at anything; the
 * cosigners will need to re-sign the new version. UX-wise we can't
 * sneak that behind a "Save changes" button.
 *
 * This module owns:
 *
 *   1. `deriveEditWarning(cosigCount)` — singular/plural copy
 *      + null when no warning is needed (no cosignatures on the
 *      original).
 *   2. `buildEditPlan(input)` — bundles the delete URI, the new
 *      record, and the warning into the data the screen needs.
 *      The actual `deleteRecord` + `createRecord` calls are screen
 *      / outbox concerns — this module hands them the plan.
 *
 * Pure function. No state. Tested under plain Jest. No dependency on
 * `@dina/core` or anything React.
 */

import type { Attestation } from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Why the edit needs a confirm dialog. Today there's only one reason
 * (`cosig_release`); the `kind` field is the discriminator if future
 * warnings ("this attestation has been replied-to — editing will
 * orphan the replies") get added. Callers should `switch` on `kind`
 * so a new variant lights up unhandled-case errors at every render
 * site.
 */
export interface EditWarning {
  readonly kind: 'cosig_release';
  /** How many cosignatures the original record carries. ≥ 1 by construction. */
  readonly cosigCount: number;
  readonly title: string;
  readonly body: string;
  readonly proceedLabel: string;
  readonly cancelLabel: string;
}

export interface EditPlanInput {
  /** AT-URI of the original record being replaced. */
  readonly originalUri: string;
  /** The updated record body to publish. */
  readonly updatedRecord: Attestation;
  /**
   * Cosignature count on the ORIGINAL record (i.e. how many
   * endorsements already point at `originalUri`). Pulled from the
   * subject-detail screen's already-fetched profile data — no
   * extra round-trip.
   */
  readonly cosigCount: number;
}

export interface EditPlan {
  readonly deleteUri: string;
  readonly republishRecord: Attestation;
  /** `null` when no confirm dialog is required. */
  readonly warning: EditWarning | null;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the warning that should be shown before the user proceeds
 * with an edit. Returns `null` when no warning is needed (zero
 * cosignatures on the original — nothing breaks).
 *
 * Singular / plural copy is split per cosigCount. We don't lean on
 * a generic plural rule helper because there's exactly one number
 * in play and the strings need editorial review anyway — adding a
 * pluralisation library here is over-engineering.
 *
 * Negative / non-finite cosigCount coerces to 0 (no warning) — bad
 * upstream data shouldn't surface a panicky modal.
 */
export function deriveEditWarning(cosigCount: number): EditWarning | null {
  const safe = sanitiseCount(cosigCount);
  if (safe === 0) return null;

  // Both copy variants follow the plan-§8.6 wording, with "this
  // review has N cosignatures" tightened to flow naturally with
  // singular vs plural.
  const body =
    safe === 1
      ? 'This review has 1 cosignature. Editing will release it — the cosigner will need to be asked again.'
      : `This review has ${safe} cosignatures. Editing will release them — the cosigners will need to be asked again.`;

  return {
    kind: 'cosig_release',
    cosigCount: safe,
    title: 'Edit will release cosignatures',
    body,
    // "Edit anyway" rather than "OK" — gives the user a chance to
    // back out by reading the verb before tapping. The cancel
    // label is "Keep as is" because the user's mental model is
    // "I have a saved review; if I cancel, that stays".
    proceedLabel: 'Edit anyway',
    cancelLabel: 'Keep as is',
  };
}

/**
 * Bundle everything the screen needs to drive the edit flow:
 *   - the AT-URI to delete,
 *   - the new record body to publish,
 *   - the warning (if any) to show first.
 *
 * The sequencing of `deleteRecord` + `createRecord` is the outbox
 * watcher's concern, not this module's. Same for the actual user-
 * dialog rendering — we just hand the screen a `warning` object it
 * formats with theme tokens.
 *
 * Strict input validation: `originalUri` must be a non-empty
 * `at://...` URI. We do not silently coerce a missing URI to "create
 * new" (which would lose the original's history) — that's a caller
 * bug worth surfacing.
 */
export function buildEditPlan(input: EditPlanInput): EditPlan {
  if (typeof input.originalUri !== 'string' || input.originalUri.length === 0) {
    throw new Error('buildEditPlan: originalUri must be a non-empty string');
  }
  if (!input.originalUri.startsWith('at://')) {
    throw new Error(
      `buildEditPlan: originalUri must be an atproto URI (at://...), got "${input.originalUri}"`,
    );
  }
  return {
    deleteUri: input.originalUri,
    republishRecord: input.updatedRecord,
    warning: deriveEditWarning(input.cosigCount),
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function sanitiseCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
