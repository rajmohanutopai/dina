/**
 * Item 5 — typed-origin vault capability (Plugin Developer Surface §5/§14).
 *
 * Every operation at the vault storage seam has an ORIGIN — WHO/what is asking.
 * A compromised Brain (or an over-broad agent) must not be able to turn a read
 * path into a write or a delete, regardless of which persona happens to be open.
 * This module is the coarse origin × operation gate that sits *above* the
 * persona gate (`requireAgentPersonaAccess`, `vault.ts:37`): the persona gate
 * decides WHICH personas an agent may touch; this decides WHAT an origin may do
 * at all.
 *
 *   origin          read  search  write  delete   meaning
 *   ─────────────── ───── ─────── ────── ──────── ─────────────────────────────
 *   owner_request    ✓      ✓       ✓      ✓       the owner's own app / CLI
 *   staging_item     ✓      ✗       ✓      ✗       ingest pipeline: dedup-read + store
 *   service_task     ✓      ✓       ✗      ✗       answering a query: bounded read only
 *   agent_ask        ✓      ✓       ✗      ✗       external coding agent: read, persona-gated
 *
 * A read/search origin can NEVER write or delete — that's the invariant. Writes
 * belong to the owner or the ingest pipeline; deletes belong to the owner alone.
 * Persona-scoped read gating (free vs sensitive/locked) is layered on top for
 * the `agent_ask`/`service_task` origins and stays where it already lives.
 *
 * Pure module (no I/O) — it lives in `@dina/core` proper and is enforced at the
 * storage seam by the caller, which knows the origin.
 */

export type VaultOrigin = 'owner_request' | 'staging_item' | 'service_task' | 'agent_ask';
export type VaultOperation = 'read' | 'search' | 'write' | 'delete';

export const VAULT_ORIGINS: readonly VaultOrigin[] = [
  'owner_request',
  'staging_item',
  'service_task',
  'agent_ask',
];

/** True for origins whose reads must additionally pass the persona gate. */
export const PERSONA_GATED_ORIGINS: ReadonlySet<VaultOrigin> = new Set<VaultOrigin>([
  'agent_ask',
  'service_task',
]);

/**
 * Origin × operation matrix. Own-property lookups only (no inherited members) so
 * an attacker-controlled origin string can never resolve to a prototype method.
 */
const MATRIX: Record<VaultOrigin, Record<VaultOperation, boolean>> = {
  owner_request: { read: true, search: true, write: true, delete: true },
  staging_item: { read: true, search: false, write: true, delete: false },
  service_task: { read: true, search: true, write: false, delete: false },
  agent_ask: { read: true, search: true, write: false, delete: false },
};

/** Is `origin` a known typed origin? */
export function isVaultOrigin(origin: string): origin is VaultOrigin {
  return Object.prototype.hasOwnProperty.call(MATRIX, origin);
}

/**
 * Coarse origin × operation check. Fail-closed: an unknown origin or unknown
 * operation is DENIED (never allowed by falling through to an inherited member).
 */
export function isVaultOperationAllowed(origin: string, operation: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(MATRIX, origin)) return false;
  const row = MATRIX[origin as VaultOrigin];
  if (!Object.prototype.hasOwnProperty.call(row, operation)) return false;
  return row[operation as VaultOperation] === true;
}

export interface VaultCapability {
  origin: VaultOrigin;
  /** Personas this capability may touch; undefined ⇒ deferred to the persona gate. */
  personas?: readonly string[];
  /** The authenticated principal (agent DID / owner), for the audit trail. */
  principal?: string;
}

export type VaultCapabilityCheck =
  | { ok: true }
  | { ok: false; reason: 'unknown_origin' | 'operation_denied' | 'persona_out_of_scope' };

/**
 * Assert a capability may perform `operation` on `persona`. This is the coarse
 * gate; the caller still runs the fine-grained persona gate for sensitive/locked
 * personas on the read origins.
 */
export function checkVaultCapability(
  cap: VaultCapability,
  operation: VaultOperation,
  persona?: string,
): VaultCapabilityCheck {
  if (!isVaultOrigin(cap.origin)) return { ok: false, reason: 'unknown_origin' };
  if (!isVaultOperationAllowed(cap.origin, operation))
    return { ok: false, reason: 'operation_denied' };
  if (
    persona !== undefined &&
    cap.personas !== undefined &&
    !cap.personas.includes(persona)
  ) {
    return { ok: false, reason: 'persona_out_of_scope' };
  }
  return { ok: true };
}
