/**
 * Tenant identity and the cell lifecycle (§17.1, §17.3).
 *
 * WHAT A TENANT IS HERE. §17.1 keeps the single-writer Home Node model
 * authoritative PER TENANT, so a tenant is not a column — it is a whole Core
 * with its own encrypted store, identity, grants, workflows and audit history.
 * This package never reaches inside one. It decides which cell is awake, hands
 * out SCOPED leases to reach it, and counts what that costs.
 *
 * WHY THAT BOUNDARY IS THE WHOLE DESIGN. §17.2 lists what may be shared —
 * control-plane metadata, the AppView, MsgBox, stateless Brain workers, the
 * package cache, supervision, metering, backup — and then states the rule that
 * makes sharing safe: "Shared workers receive bounded tenant jobs. They never
 * receive a reusable tenant master key or unscoped database handle."
 *
 * So the control plane holds METADATA ABOUT tenants and never their keys. That
 * is not a convention here; `TenantRecord` has nowhere to put a key, and the
 * only way to reach a cell's data is a `CellLease` that expires. A design where
 * the key could be stored and merely should not be is a design where one day it
 * is.
 */

/** Cell states (§17.3). Ordered by how much a tenant is currently costing. */
export type CellState =
  /** Warm: workers may be given leases now. */
  | 'hot'
  /**
   * Idle but resident. Wakes without touching cold storage, and is the state
   * a scheduler reclaims from first.
   */
  | 'cold'
  /**
   * Sealed: no key material is resident anywhere. A lease requires a wake,
   * and a wake requires the tenant's own unlock.
   */
  | 'sealed';

/**
 * What the control plane knows about a tenant.
 *
 * NO KEY, NO CONNECTION STRING, NO HANDLE — see the module note. Everything
 * here is metadata a hosting operator needs to schedule and bill, and none of
 * it would help an attacker read a tenant's vault.
 */
export interface TenantRecord {
  tenantId: string;
  /** The tenant's own DID. An identifier, not a credential. */
  did: string;
  state: CellState;
  /** Epoch ms of the last lease issued, for idle reclamation. */
  lastActiveAtMs: number;
  /** Why the cell is in its current state, for an operator reading a console. */
  reason: string;
}

/**
 * A bounded permit to act on ONE tenant, for a bounded time (§17.2).
 *
 * This is the "bounded tenant job" the spec asks for, made into a value. A
 * shared worker holds one of these and nothing else: it names one tenant, it
 * expires, and it cannot be widened. There is deliberately no `allTenants`
 * lease and no way to derive a second tenant's lease from a first.
 */
export interface CellLease {
  tenantId: string;
  /** Opaque, single-tenant, single-purpose. Never a key. */
  leaseId: string;
  /** What this lease may do. Checked by the cell, not by the holder. */
  purpose: LeasePurpose;
  expiresAtMs: number;
}

/**
 * What a shared worker may be asked to do (§17.2).
 *
 * A CLOSED set, because the point of a bounded job is that its bound is
 * legible. `reason` strings would let a caller invent a purpose no cell knows
 * how to refuse.
 */
export type LeasePurpose =
  /** Stateless reasoning over a payload the cell already scoped. */
  | 'brain_job'
  /** A catalog refresh or other scheduled maintenance. */
  | 'scheduled_work'
  /** Deliver an inbound message into the tenant's own pipeline. */
  | 'inbound_delivery'
  /** Read metering counters. Never tenant content. */
  | 'metering_read';

export type LeaseRefusal =
  | 'unknown_tenant'
  /** The cell is sealed; a wake is the tenant's own act, not a worker's. */
  | 'cell_sealed'
  | 'quota_exhausted';

export type LeaseOutcome =
  | { ok: true; lease: CellLease }
  | { ok: false; refusal: LeaseRefusal; detail: string };
