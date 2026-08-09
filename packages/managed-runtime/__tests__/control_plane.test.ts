/**
 * §17 — the hosting layer, and the properties that make sharing safe.
 *
 * The load-bearing sentence is §17.2's: shared workers "never receive a
 * reusable tenant master key or unscoped database handle". Everything here is
 * a way of asking whether that is true of the code rather than of the prose.
 *
 * The strongest of those checks is a TYPE-LEVEL one and cannot be written as a
 * runtime assertion at all — `TenantRecord` has no field a key could go in and
 * `ManagedBlobStore` exposes no decrypt. A test can only show that the runtime
 * behaviour agrees; the design is what makes the failure impossible.
 */

import {
  ControlPlane,
  HostedRunnerRegistry,
  ManagedBlobStore,
  type CellLease,
  type LeasePurpose,
} from '../src/index';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

let clock = T0;
const now = (): number => clock;

let seq = 0;
const newLeaseId = (tenantId: string, purpose: LeasePurpose): string =>
  `lease-${tenantId}-${purpose}-${(seq += 1)}`;

function plane(over: Partial<ConstructorParameters<typeof ControlPlane>[0]> = {}): ControlPlane {
  return new ControlPlane({
    now,
    newLeaseId,
    leaseTtlMs: 5 * MINUTE,
    defaultQuota: { maxLeases: 100, windowMs: MINUTE },
    idleSealAfterMs: 30 * MINUTE,
    ...over,
  });
}

beforeEach(() => {
  clock = T0;
  seq = 0;
});

describe('cell lifecycle (§17.3)', () => {
  it('registers SEALED, because a cell that never unlocked holds no keys', () => {
    // Starting hot would mean the control plane could serve a tenant that had
    // not yet proved it can open its own store.
    const cp = plane();
    expect(cp.register('t-chairmaker', 'did:plc:chairmaker').state).toBe('sealed');
  });

  it('refuses to lease a sealed cell rather than waking it', () => {
    // A worker that could wake a cell by asking for work would make idle
    // sealing decorative, and would let a SHARED component decide when a
    // tenant's key material becomes resident.
    const cp = plane();
    cp.register('t-1', 'did:plc:one');
    const outcome = cp.lease('t-1', 'brain_job');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('cell_sealed');
  });

  it('serves once the tenant’s own unlock has woken the cell', () => {
    const cp = plane();
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner opened the app');
    const outcome = cp.lease('t-1', 'brain_job');
    expect(outcome.ok).toBe(true);
    expect(cp.meter('t-1')).toEqual({ leases: 1, refused: 0, wakes: 1 });
  });

  it('seals an idle cell on the sweep, and not before', () => {
    const cp = plane();
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner');
    clock = T0 + 29 * MINUTE;
    expect(cp.sweepIdle()).toEqual([]);
    clock = T0 + 31 * MINUTE;
    expect(cp.sweepIdle().map((r) => r.tenantId)).toEqual(['t-1']);
    expect(cp.get('t-1')?.state).toBe('sealed');
  });

  it('a lease keeps a cell alive — activity is what the sweep measures', () => {
    const cp = plane();
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner');
    clock = T0 + 20 * MINUTE;
    expect(cp.lease('t-1', 'scheduled_work').ok).toBe(true);
    clock = T0 + 45 * MINUTE; // 45 since wake, but only 25 since the lease
    expect(cp.sweepIdle()).toEqual([]);
  });

  it('counts wakes only from sealed — a hot cell re-woken is not a cold start', () => {
    // The expensive transition is the one worth metering. Counting every
    // `wake` call would bill a tenant for its own liveness.
    const cp = plane();
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'first');
    cp.wake('t-1', 'again');
    expect(cp.meter('t-1')?.wakes).toBe(1);
  });
});

describe('bounded leases (§17.2)', () => {
  it('a lease names ONE tenant and one purpose', () => {
    const cp = plane();
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner');
    const outcome = cp.lease('t-1', 'brain_job');
    if (!outcome.ok) throw new Error('expected a lease');
    const lease: CellLease = outcome.lease;
    expect(cp.leaseAdmits(lease, 't-1', 'brain_job')).toBe(true);
    // The whole point: it does not travel.
    expect(cp.leaseAdmits(lease, 't-2', 'brain_job')).toBe(false);
    expect(cp.leaseAdmits(lease, 't-1', 'inbound_delivery')).toBe(false);
  });

  it('expires', () => {
    const cp = plane();
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner');
    const outcome = cp.lease('t-1', 'brain_job');
    if (!outcome.ok) throw new Error('expected a lease');
    clock = T0 + 5 * MINUTE;
    expect(cp.leaseAdmits(outcome.lease, 't-1', 'brain_job')).toBe(false);
  });

  it('two tenants never share a lease id', () => {
    const cp = plane();
    for (const id of ['t-1', 't-2']) {
      cp.register(id, `did:plc:${id}`);
      cp.wake(id, 'owner');
    }
    const a = cp.lease('t-1', 'brain_job');
    const b = cp.lease('t-2', 'brain_job');
    if (!a.ok || !b.ok) throw new Error('expected leases');
    expect(a.lease.leaseId).not.toBe(b.lease.leaseId);
  });
});

describe('quotas and metering (§17.5)', () => {
  it('refuses past the quota, and records the refusal apart from the grants', () => {
    // Kept apart so an operator reading a console can see THROTTLING rather
    // than inferring it from a number that stopped rising.
    const cp = plane({ defaultQuota: { maxLeases: 2, windowMs: MINUTE } });
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner');
    expect(cp.lease('t-1', 'brain_job').ok).toBe(true);
    expect(cp.lease('t-1', 'brain_job').ok).toBe(true);
    const third = cp.lease('t-1', 'brain_job');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.refusal).toBe('quota_exhausted');
    expect(cp.meter('t-1')).toEqual({ leases: 2, refused: 1, wakes: 1 });
  });

  it('a new window restores capacity', () => {
    const cp = plane({ defaultQuota: { maxLeases: 1, windowMs: MINUTE } });
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner');
    expect(cp.lease('t-1', 'brain_job').ok).toBe(true);
    expect(cp.lease('t-1', 'brain_job').ok).toBe(false);
    clock = T0 + MINUTE;
    expect(cp.lease('t-1', 'brain_job').ok).toBe(true);
  });

  it('one tenant exhausting its quota does not touch another’s', () => {
    // Noisy-neighbour isolation, which is the operational half of §17.1.
    const cp = plane({ defaultQuota: { maxLeases: 1, windowMs: MINUTE } });
    for (const id of ['loud', 'quiet']) {
      cp.register(id, `did:plc:${id}`);
      cp.wake(id, 'owner');
    }
    expect(cp.lease('loud', 'brain_job').ok).toBe(true);
    expect(cp.lease('loud', 'brain_job').ok).toBe(false);
    expect(cp.lease('quiet', 'brain_job').ok).toBe(true);
  });

  it('a zero quota means "do not serve", not "serve unlimited"', () => {
    // The fail-closed reading of an unset or suspended plan. A zero that meant
    // "no limit" is the classic way a suspended tenant keeps being served.
    const cp = plane({ defaultQuota: { maxLeases: 0, windowMs: MINUTE } });
    cp.register('t-1', 'did:plc:one');
    cp.wake('t-1', 'owner');
    expect(cp.lease('t-1', 'brain_job').ok).toBe(false);
  });
});

describe('§17.4 hosted runner binding', () => {
  const VENDOR = 'did:key:zVendorFleet';

  it('MULTIPLEXES where bound, and only there', () => {
    const reg = new HostedRunnerRegistry();
    reg.bind({ runnerDid: VENDOR, tenantId: 't-a', installId: 'i-a', active: true });
    reg.bind({ runnerDid: VENDOR, tenantId: 't-b', installId: 'i-b', active: true });
    expect(reg.admits(VENDOR, 't-a', 'i-a').ok).toBe(true);
    expect(reg.admits(VENDOR, 't-b', 'i-b').ok).toBe(true);

    // The §17.4 sentence: a vendor-wide identity alone claims nothing.
    const stolen = reg.admits(VENDOR, 't-c', 'i-c');
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.refusal).toBe('not_bound_to_tenant');
  });

  it('binds to an INSTALL, not merely to a tenant', () => {
    const reg = new HostedRunnerRegistry();
    reg.bind({ runnerDid: VENDOR, tenantId: 't-a', installId: 'i-a', active: true });
    const wrongInstall = reg.admits(VENDOR, 't-a', 'i-other');
    expect(wrongInstall.ok).toBe(false);
    if (!wrongInstall.ok) expect(wrongInstall.refusal).toBe('not_bound_to_install');
  });

  it('a suspended binding stops that tenant and leaves the others', () => {
    const reg = new HostedRunnerRegistry();
    reg.bind({ runnerDid: VENDOR, tenantId: 't-a', installId: 'i-a', active: false });
    reg.bind({ runnerDid: VENDOR, tenantId: 't-b', installId: 'i-b', active: true });
    const suspended = reg.admits(VENDOR, 't-a', 'i-a');
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.refusal).toBe('binding_suspended');
    expect(reg.admits(VENDOR, 't-b', 'i-b').ok).toBe(true);
  });

  it('a fleet suspension stops EVERY tenant at once', () => {
    // The operator's stop when a hosted runner is compromised. A loop over
    // bindings could fail partway and leave a subset of businesses still being
    // served by a runner already judged hostile.
    const reg = new HostedRunnerRegistry();
    reg.bind({ runnerDid: VENDOR, tenantId: 't-a', installId: 'i-a', active: true });
    reg.bind({ runnerDid: VENDOR, tenantId: 't-b', installId: 'i-b', active: true });
    reg.suspendFleet(VENDOR);
    expect(reg.admits(VENDOR, 't-a', 'i-a').ok).toBe(false);
    expect(reg.admits(VENDOR, 't-b', 'i-b').ok).toBe(false);
    expect(reg.tenantsFor(VENDOR)).toEqual([]);
    reg.resumeFleet(VENDOR);
    expect(reg.tenantsFor(VENDOR)).toEqual(['t-a', 't-b']);
  });

  it('an unknown runner is refused without naming what exists', () => {
    const reg = new HostedRunnerRegistry();
    reg.bind({ runnerDid: VENDOR, tenantId: 't-a', installId: 'i-a', active: true });
    const other = reg.admits('did:key:zSomebodyElse', 't-a', 'i-a');
    expect(other.ok).toBe(false);
    // `unknown_runner`, not `not_bound_to_tenant`: the least that is still
    // true, so a probe learns nothing about which tenants or installs exist.
    if (!other.ok) expect(other.refusal).toBe('unknown_runner');
  });
});

describe('managed storage (§17.2, WS-8.3)', () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('returns a tenant’s ciphertext byte-identically', () => {
    const store = new ManagedBlobStore(now);
    const cipher = bytes('opaque-vault-archive');
    store.put('t-a', 'vault.age', cipher);
    const read = store.get('t-a', 'vault.age');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.ciphertext).toEqual(cipher);
  });

  it('does not hand one tenant another’s object', () => {
    const store = new ManagedBlobStore(now);
    store.put('t-a', 'vault.age', bytes('a'));
    const read = store.get('t-b', 'vault.age');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal).toBe('not_found');
  });

  it('lists only the asking tenant’s objects — an export manifest, not a dump', () => {
    const store = new ManagedBlobStore(now);
    store.put('t-a', 'vault.age', bytes('a'));
    store.put('t-a', 'catalog.age', bytes('c'));
    store.put('t-b', 'vault.age', bytes('b'));
    expect(store.list('t-a').map((e) => e.name)).toEqual(['catalog.age', 'vault.age']);
    // Names and digests only: listing is not reading.
    expect(Object.keys(store.list('t-a')[0] ?? {})).toEqual(['name', 'digest', 'storedAtMs']);
  });

  it('REFUSES a blob whose bytes no longer match its digest', () => {
    // A backup that changed under us is exactly the object a tenant would
    // restore from without looking, so it must not come back at all.
    const store = new ManagedBlobStore(now);
    const stored = store.put('t-a', 'vault.age', bytes('original'));
    stored.ciphertext.set([0x00], 0);
    const read = store.get('t-a', 'vault.age');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal).toBe('corrupt');
  });

  it('COPIES on write, so a caller reusing its buffer cannot rewrite history', () => {
    const store = new ManagedBlobStore(now);
    const buffer = bytes('first-value-here');
    store.put('t-a', 'vault.age', buffer);
    buffer.set([0x00], 0);
    const read = store.get('t-a', 'vault.age');
    // Still readable and still the original — the store kept its own copy, so
    // the digest check reports corruption only for real corruption.
    expect(read.ok).toBe(true);
  });

  it('reports whether a delete deleted anything', () => {
    const store = new ManagedBlobStore(now);
    store.put('t-a', 'vault.age', bytes('a'));
    expect(store.delete('t-a', 'vault.age')).toBe(true);
    expect(store.delete('t-a', 'vault.age')).toBe(false);
  });
});
