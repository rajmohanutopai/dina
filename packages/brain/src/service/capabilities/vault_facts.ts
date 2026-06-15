/**
 * Deterministic vault-fact builders for vault-MUTATING capabilities.
 *
 * SECURITY (prompt-injection containment): a Tier-1 execution answers an
 * EXTERNAL requester whose params reach the model verbatim, and the system
 * prompt is NOT a boundary against injection. The `record_to_vault` write tool
 * must therefore NOT let the model author the persisted text — a malicious
 * `notes` param could otherwise prompt-inject the approved booking turn into
 * writing a broader/false fact (e.g. "this customer gets free service forever")
 * into the provider's own vault.
 *
 * So the model only TRIGGERS a write (per its instruction); the ACTUAL persisted
 * fact is built HERE, in code, from the VALIDATED params/result plus the
 * Core-authenticated requester DID (`from_did`). Every value is collapsed to a
 * single short line (`cleanField`) so a long/multi-line field can't smuggle
 * pseudo-instructions into the note, and the attacker-controlled `notes` field
 * is never included. The result `status` gate (`mutation_success_statuses`) is
 * applied by the runtime BEFORE this builder runs — a builder only ever sees a
 * successful mutation.
 */

/** Inputs a fact builder may read — all already validated by the runtime. */
export interface VaultFactContext {
  /** The query params (schema-validated at ingress). Opaque shape. */
  params: unknown;
  /** The final, schema-valid, SUCCESSFUL result object. */
  result: Record<string, unknown>;
  /** Requester DID, authenticated at Core ingress (`from_did`). Never self-asserted. */
  requesterDid?: string;
}

/**
 * Build the exact `{summary, body}` to persist, or `null` when there is nothing
 * concrete to record (the runtime then writes nothing). Pure + deterministic —
 * no model text, no I/O.
 */
export type VaultFactBuilder = (ctx: VaultFactContext) => { summary: string; body: string } | null;

/** Max length of any single templated field — keeps a value a short label, never
 *  a multi-line carrier for injected "instructions". */
const MAX_FIELD = 80;

/** Collapse whitespace/newlines and bound length. Non-strings → ''. */
function cleanField(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
}

/**
 * `appointment_book` → "slot taken" record. Built from the REQUESTED params
 * (what the booking is for), falling back to the confirmed result for any field
 * the params omit. Deliberately excludes the free-text `notes` param (the
 * injection vector). Returns `null` if there is no concrete time to pin.
 */
const buildAppointmentBookFact: VaultFactBuilder = ({ params, result, requesterDid }) => {
  const p = (params ?? {}) as Record<string, unknown>;
  const r = result ?? {};
  const time = cleanField(p.time) || cleanField(r.time);
  if (time === '') return null;
  const date = cleanField(p.date) || cleanField(r.date);
  const service = cleanField(p.service) || cleanField(r.service) || 'appointment';
  const when = [date, time].filter((s) => s !== '').join(' ');
  const who = cleanField(requesterDid);
  const forWhom = who !== '' ? ` for ${who}` : '';
  return {
    summary: `Booked: ${when} — ${service} (slot taken)`,
    body: `Confirmed booking${forWhom}: ${service} at ${when}. This slot is no longer available.`,
  };
};

/** Canonical-capability → deterministic fact builder. A mutating capability with
 *  NO entry here can never persist a write (the runtime fail-closes — there is no
 *  code-authored fact to commit, and the model is never trusted to author one). */
const VAULT_FACT_BUILDERS: Readonly<Record<string, VaultFactBuilder>> = Object.freeze({
  appointment_book: buildAppointmentBookFact,
});

/** Resolve the deterministic fact builder for a canonical capability id. */
export function getVaultFactBuilder(canonicalCapability: string): VaultFactBuilder | undefined {
  return VAULT_FACT_BUILDERS[canonicalCapability];
}
