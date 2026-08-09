/**
 * The control plane (§17.1, §17.2, §17.3, §17.5).
 *
 * It schedules cells, issues bounded leases and counts usage. It cannot read a
 * tenant's data and has no way to acquire the ability: see `tenant.ts`.
 *
 * SINGLE-WRITER PER TENANT IS PRESERVED, not re-implemented. §17.1 says the
 * Home Node Lite model "remains authoritative per tenant", so this never opens
 * a second writer against a cell — a lease is a permit to ASK the cell, and the
 * cell serialises its own work exactly as a single Home Node does today.
 */

import {
  type CellLease,
  type CellState,
  type LeaseOutcome,
  type LeasePurpose,
  type TenantRecord,
} from './tenant';

/** Per-tenant usage, for §17.5's cost behaviour. */
export interface TenantMeter {
  /** Leases issued. The unit of work a hosting bill is actually made of. */
  leases: number;
  /** Leases refused for quota. Kept apart so an operator can see throttling. */
  refused: number;
  /** Wakes from `sealed`. The expensive transition worth watching. */
  wakes: number;
}

export interface TenantQuota {
  /** Leases per window. Zero means "this tenant may not be served". */
  maxLeases: number;
  windowMs: number;
}

interface Bucket {
  windowStartedAt: number;
  used: number;
}

export interface ControlPlaneDeps {
  now: () => number;
  /**
   * Lease ids. Injected because a control plane that mints its own randomness
   * cannot be tested for the property that matters — that two leases are never
   * interchangeable — and because a deployment may want them traceable.
   */
  newLeaseId: (tenantId: string, purpose: LeasePurpose) => string;
  leaseTtlMs: number;
  /** Quota per tenant. A tenant with no entry gets `defaultQuota`. */
  quotaFor?: (tenantId: string) => TenantQuota | undefined;
  defaultQuota: TenantQuota;
  /**
   * How long a cell may idle before it is sealed (§17.3). A hosting operator
   * trades wake latency against resident cost here; the sweep is explicit
   * rather than a timer so a scheduler owns its own cadence.
   */
  idleSealAfterMs: number;
}

export class ControlPlane {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly meters = new Map<string, TenantMeter>();
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly deps: ControlPlaneDeps) {
    if (deps.leaseTtlMs <= 0) throw new Error('leaseTtlMs must be positive');
    if (deps.idleSealAfterMs <= 0) throw new Error('idleSealAfterMs must be positive');
  }

  /**
   * Register a tenant. Sealed at birth, deliberately: a cell that has never
   * been unlocked has no key material resident, and starting `hot` would mean
   * the control plane could serve a tenant that had not yet proved it could
   * open its own store.
   */
  register(tenantId: string, did: string): TenantRecord {
    const existing = this.tenants.get(tenantId);
    if (existing !== undefined) return existing;
    const record: TenantRecord = {
      tenantId,
      did,
      state: 'sealed',
      lastActiveAtMs: this.deps.now(),
      reason: 'registered',
    };
    this.tenants.set(tenantId, record);
    this.meters.set(tenantId, { leases: 0, refused: 0, wakes: 0 });
    return record;
  }

  get(tenantId: string): TenantRecord | null {
    return this.tenants.get(tenantId) ?? null;
  }

  meter(tenantId: string): TenantMeter | null {
    return this.meters.get(tenantId) ?? null;
  }

  /**
   * Wake a sealed cell.
   *
   * THE TENANT'S OWN ACT. A worker never calls this: waking means key material
   * becomes resident, and §17.2's rule is that shared workers hold no reusable
   * key. The caller here is the tenant's own unlock path — an owner opening
   * the app, or an inbound message the tenant has already authorised delivery
   * for. Modelled as a distinct method rather than a side effect of `lease`
   * precisely so the two cannot be confused at a call site.
   */
  wake(tenantId: string, reason: string): TenantRecord | null {
    const record = this.tenants.get(tenantId);
    if (record === undefined) return null;
    if (record.state === 'sealed') {
      const meter = this.meters.get(tenantId);
      if (meter !== undefined) meter.wakes += 1;
    }
    record.state = 'hot';
    record.reason = reason;
    record.lastActiveAtMs = this.deps.now();
    return record;
  }

  /**
   * Issue a bounded lease against one tenant (§17.2).
   *
   * Refuses rather than waking. A worker that could wake a cell by asking for
   * work would make idle sealing decorative, and would let a shared component
   * decide when a tenant's keys become resident.
   */
  lease(tenantId: string, purpose: LeasePurpose): LeaseOutcome {
    const record = this.tenants.get(tenantId);
    if (record === undefined) {
      return { ok: false, refusal: 'unknown_tenant', detail: 'no such tenant' };
    }
    if (record.state === 'sealed') {
      return {
        ok: false,
        refusal: 'cell_sealed',
        detail: 'the cell is sealed; waking it is the tenant’s own act (§17.2)',
      };
    }
    const meter = this.meters.get(tenantId);
    if (!this.spend(tenantId)) {
      if (meter !== undefined) meter.refused += 1;
      return { ok: false, refusal: 'quota_exhausted', detail: 'lease quota exhausted (§17.5)' };
    }
    if (meter !== undefined) meter.leases += 1;
    const now = this.deps.now();
    record.state = 'hot';
    record.lastActiveAtMs = now;
    const lease: CellLease = {
      tenantId,
      leaseId: this.deps.newLeaseId(tenantId, purpose),
      purpose,
      expiresAtMs: now + this.deps.leaseTtlMs,
    };
    return { ok: true, lease };
  }

  /**
   * Is this lease usable, for THIS tenant and THIS purpose, right now?
   *
   * Checked by the cell rather than trusted from the holder. Every argument is
   * required: a check that defaulted the tenant would pass a lease for another
   * one, which is the only failure this function exists to prevent.
   */
  leaseAdmits(lease: CellLease, tenantId: string, purpose: LeasePurpose): boolean {
    if (lease.tenantId !== tenantId) return false;
    if (lease.purpose !== purpose) return false;
    return this.deps.now() < lease.expiresAtMs;
  }

  /**
   * Seal cells that have idled past the threshold (§17.3), returning the ones
   * that changed.
   *
   * A SWEEP, not a timer. The caller owns the cadence, so a deployment can run
   * it on its own scheduler, and a test can run it at an instant of its
   * choosing rather than waiting.
   */
  sweepIdle(): TenantRecord[] {
    const now = this.deps.now();
    const sealed: TenantRecord[] = [];
    for (const record of this.tenants.values()) {
      if (record.state === 'sealed') continue;
      if (now - record.lastActiveAtMs < this.deps.idleSealAfterMs) continue;
      record.state = 'sealed';
      record.reason = 'idle';
      sealed.push(record);
    }
    return sealed;
  }

  /** Move a hot cell to `cold` without sealing it — resident, not serving. */
  cool(tenantId: string, reason: string): CellState | null {
    const record = this.tenants.get(tenantId);
    if (record === undefined || record.state === 'sealed') return null;
    record.state = 'cold';
    record.reason = reason;
    return record.state;
  }

  private spend(tenantId: string): boolean {
    const quota = this.deps.quotaFor?.(tenantId) ?? this.deps.defaultQuota;
    if (quota.maxLeases <= 0) return false;
    const now = this.deps.now();
    const bucket = this.buckets.get(tenantId);
    if (bucket === undefined || now - bucket.windowStartedAt >= quota.windowMs) {
      this.buckets.set(tenantId, { windowStartedAt: now, used: 1 });
      return true;
    }
    if (bucket.used >= quota.maxLeases) return false;
    bucket.used += 1;
    return true;
  }
}
