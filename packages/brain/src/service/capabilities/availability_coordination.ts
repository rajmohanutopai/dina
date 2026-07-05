/**
 * `availability_coordination` — the mutual meeting-coordination capability for
 * Contact Services (docs/CONTACT_SERVICES_ARCHITECTURE.md §6.1/§6.2).
 *
 * This is the SYMMETRIC counterpart to the appointment family: a provider
 * booking (`appointment_book`) is asymmetric — one party owns the inventory and
 * confirms — whereas coordinating a meeting between two peers is symmetric: both
 * have calendars, the exchange converges on a shared slot, and BOTH sides
 * confirm. So it carries its own schema rather than overloading
 * `appointment_book` (which could not answer "who confirms?": there, the
 * provider; here, both).
 *
 * Shape (one round of a repeated one-shot exchange — there is no protocol state
 * machine; the negotiation is the agents replying with these bodies):
 *   query  → { intent?, candidate_slots?, constraints? }
 *   reply  → { status: accepted | counter | needs_more_info, accepted_slots?,
 *              counter_slots?, message?, as_of? }
 * The final booking/reminder on each side is a LOCAL approval-gated commit, NOT
 * a service.query (§6.3) — so there is no `book` half here.
 *
 * Same canonical-form discipline as the appointment family: minimal
 * `{type, required, properties}` keys, snake_case wire names, human-cadence
 * natural-string times ("Tue 3pm", "2026-07-01T15:00") — not strict formats.
 */

import { validateAgainstSchema } from './schema_validator';

/**
 * A proposed meeting slot. `start` is the only required field; `end`/`note` are
 * optional (a single time like "Tue 3pm" is a valid proposal). Reused by params
 * (`candidate_slots`) and result (`accepted_slots`/`counter_slots`).
 */
const MeetingSlotSchema = {
  type: 'object',
  required: ['start'],
  properties: {
    start: { type: 'string' },
    end: { type: 'string' },
    note: { type: 'string' },
  },
} as const;

/**
 * Params for `availability_coordination`. ALL optional, like
 * `appointment_availability`: a first message typically carries
 * `candidate_slots` ("here are times I'm free"), but a bare request ("when are
 * you free next week?") carries only `intent` and elicits a `needs_more_info`
 * or `counter` reply. No identity slot — the peer is authenticated by the D2D
 * `from_did`, never a self-asserted string (confused-deputy discipline).
 */
export const AvailabilityCoordinationParamsSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string' },
    candidate_slots: { type: 'array', items: MeetingSlotSchema },
    constraints: { type: 'string' },
  },
} as const;

/**
 * Result for `availability_coordination`. `status` is the only required field
 * (mirroring the family convention — an honest `needs_more_info` must not fail
 * validation for lacking slots):
 *   - `accepted`        → `accepted_slots` carries the agreed time(s).
 *   - `counter`         → `counter_slots` carries the peer's alternative(s).
 *   - `needs_more_info`  → neither side has enough to converge yet.
 * `as_of` carries the staleness discipline for Tier 1 answers.
 */
export const AvailabilityCoordinationResultSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['accepted', 'counter', 'needs_more_info'] },
    accepted_slots: { type: 'array', items: MeetingSlotSchema },
    counter_slots: { type: 'array', items: MeetingSlotSchema },
    message: { type: 'string' },
    as_of: { type: 'string' },
  },
} as const;

export function validateAvailabilityCoordinationParams(params: unknown): string | null {
  return validateAgainstSchema(
    params,
    AvailabilityCoordinationParamsSchema,
    'availability_coordination params',
  );
}

export function validateAvailabilityCoordinationResult(result: unknown): string | null {
  return validateAgainstSchema(
    result,
    AvailabilityCoordinationResultSchema,
    'availability_coordination result',
  );
}
