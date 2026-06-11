/**
 * `appointment_availability` + `appointment_book` capabilities — the
 * appointment family for human-scale providers (salons, consultants,
 * tutors, clinics).
 *
 * These are the flagship Tier 1 prompt-provider capabilities
 * (docs/SERVICE_PROVIDER_TIERS.md): a provider typically answers them
 * from an `instruction` + their own vault notes rather than an MCP
 * tool, so the schemas are deliberately human-cadence — natural-string
 * dates/times ("today", "4pm", "16:30"), not strict formats. The
 * requester's Dina renders the result; the provider's Dina (or agent)
 * fills it.
 *
 * Same canonical-form discipline as `eta_query.ts`: minimal
 * `{type, required, properties}` keys only — anything more gets folded
 * into the published schema hash and complicates cross-stack interop.
 *
 * Wire-format note: snake_case field names, matching the JSON that
 * rides `service.query` / `service.response` bodies.
 */

import { validateAgainstSchema } from './schema_validator';

// ---------------------------------------------------------------------------
// appointment_availability — "what slots are open?"
// ---------------------------------------------------------------------------

/**
 * Params for `appointment_availability`. ALL fields optional: "any
 * slots tomorrow?" carries only `date`; "haircut after 4 today" carries
 * all three. No identity slots — availability is provider-side data,
 * not subject-scoped (catalog: requires_subject_authorization=false).
 */
export const AppointmentAvailabilityParamsSchema = {
  type: 'object',
  properties: {
    service: { type: 'string' },
    date: { type: 'string' },
    time_after: { type: 'string' },
    time_before: { type: 'string' },
  },
} as const;

/**
 * Result for `appointment_availability`. `status` is the only required
 * field, mirroring the eta_query/price_check convention: `no_slots` and
 * `unknown` are honest answers and must not fail validation for lacking
 * `slots`. `as_of` carries the staleness discipline ("as of this
 * morning's notes") for Tier 1 answers.
 */
export const AppointmentAvailabilityResultSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'no_slots', 'unknown'] },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['time'],
        properties: {
          time: { type: 'string' },
          date: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    date: { type: 'string' },
    as_of: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

export function validateAppointmentAvailabilityParams(params: unknown): string | null {
  return validateAgainstSchema(params, AppointmentAvailabilityParamsSchema, 'appointment_availability params');
}

export function validateAppointmentAvailabilityResult(result: unknown): string | null {
  return validateAgainstSchema(result, AppointmentAvailabilityResultSchema, 'appointment_availability result');
}

// ---------------------------------------------------------------------------
// appointment_book — "book me that slot" (always review-gated)
// ---------------------------------------------------------------------------

/**
 * Params for `appointment_book`. `time` is the required discriminator —
 * a booking without a requested time is an availability question, not a
 * booking. Deliberately NO requester-name/identity param: the provider
 * authenticates the requester by the D2D `from_did` (contact lookup),
 * never by a self-asserted string — same confused-deputy discipline as
 * the MsgBox envelope rule.
 */
export const AppointmentBookParamsSchema = {
  type: 'object',
  required: ['time'],
  properties: {
    service: { type: 'string' },
    date: { type: 'string' },
    time: { type: 'string' },
    notes: { type: 'string' },
  },
} as const;

/**
 * Result for `appointment_book`. `confirmed` ("Booked for 4:30."),
 * `declined` (provider said no), `unavailable` (slot gone),
 * `unknown` (couldn't determine — e.g. stale notes).
 */
export const AppointmentBookResultSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['confirmed', 'declined', 'unavailable', 'unknown'] },
    time: { type: 'string' },
    date: { type: 'string' },
    service: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

export function validateAppointmentBookParams(params: unknown): string | null {
  return validateAgainstSchema(params, AppointmentBookParamsSchema, 'appointment_book params');
}

export function validateAppointmentBookResult(result: unknown): string | null {
  return validateAgainstSchema(result, AppointmentBookResultSchema, 'appointment_book result');
}
