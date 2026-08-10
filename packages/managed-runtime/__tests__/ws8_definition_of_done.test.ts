/**
 * WS-8's four Definitions of Done, stated as properties (§17).
 *
 * WHY THIS FILE EXISTS SEPARATELY from `control_plane.test.ts`, which already
 * covers the modules unit by unit. The WBS does not ask for unit coverage; it
 * asks for four specific CLAIMS:
 *
 *   8.1 tenant isolation provable
 *   8.2 per-install binding, no shared authority
 *   8.3 tenant-owned, exportable
 *   8.5 the owner's phone may sleep while read/quote work continues
 *
 * Each is a statement about what the system REFUSES or GUARANTEES across
 * modules, and a claim of that shape is only worth anything if something tries
 * to break it. So each case here attacks the property rather than exercising
 * the method: a lease used against the wrong tenant, a runner reaching for a
 * second install, an export asking for another tenant's blob, work continuing
 * while the owner is away.
 *
 * HONEST SCOPE, stated once. `@dina/managed-runtime` has NO production
 * importer — there is no hosting product for it to run inside yet. These
 * prove the module's properties, which is what can be proved without one; a
 * deployed control plane would still need its own operational validation.
 */

import {
  ControlPlane,
  HostedRunnerRegistry,
  ManagedBlobStore,
  type CellLease,
  type LeasePurpose,
} from '../src/index';

const T0 = 1_700_000_000_000;
const ALICE = 'tenant-alice';
const BOB = 'tenant-bob';

let now = T0;
const clock = (): number => now;

function plane(over: Partial<ConstructorParameters<typeof ControlPlane>[0]> = {}): ControlPlane {
  return new ControlPlane({
    now: clock,
    newLeaseId: (tenantId, purpose) => `lease:${tenantId}:${purpose}:${String(clock())}`,
    leaseTtlMs: 60_000,
    defaultQuota: { maxLeases: 100, windowMs: 60_000 },
    idleSealAfterMs: 300_000,
    ...over,
  });
}

/** A registered, awake tenant — the state a hosting operator serves from. */
function awake(cp: ControlPlane, tenantId: string, did: string): void {
  cp.register(tenantId, did);
  cp.wake(tenantId, 'tenant unlocked');
}

function leaseFor(cp: ControlPlane, tenantId: string, purpose: LeasePurpose): CellLease {
  const out = cp.lease(tenantId, purpose);
  if (!out.ok) throw new Error(`lease refused: ${out.refusal} ${out.detail}`);
  return out.lease;
}

beforeEach(() => {
  now = T0;
});

describe('8.1 — tenant isolation is provable', () => {
  it('a lease issued for one tenant is refused against another', () => {
    // THE WHOLE POINT of a bounded job. A shared worker holds a lease and
    // nothing else; if that lease admitted a second tenant, "multi-tenant"
    // would mean "one blast radius".
    const cp = plane();
    awake(cp, ALICE, 'did:plc:alice');
    awake(cp, BOB, 'did:plc:bob');

    const aliceLease = leaseFor(cp, ALICE, 'brain_job');
    expect(cp.leaseAdmits(aliceLease, ALICE, 'brain_job')).toBe(true);
    expect(cp.leaseAdmits(aliceLease, BOB, 'brain_job')).toBe(false);
  });

  it('a lease is bound to its PURPOSE as well as its tenant', () => {
    // A `metering_read` lease that could deliver inbound messages would let a
    // billing worker touch content. The purpose set is closed so a cell can
    // refuse by name rather than by interpretation.
    const cp = plane();
    awake(cp, ALICE, 'did:plc:alice');

    const metering = leaseFor(cp, ALICE, 'metering_read');
    expect(cp.leaseAdmits(metering, ALICE, 'metering_read')).toBe(true);
    expect(cp.leaseAdmits(metering, ALICE, 'inbound_delivery')).toBe(false);
  });

  it('an EXPIRED lease admits nothing, even for its own tenant and purpose', () => {
    const cp = plane({ leaseTtlMs: 1_000 });
    awake(cp, ALICE, 'did:plc:alice');
    const lease = leaseFor(cp, ALICE, 'brain_job');

    now = T0 + 1_001;
    expect(cp.leaseAdmits(lease, ALICE, 'brain_job')).toBe(false);
  });

  it('two leases are never interchangeable', () => {
    const cp = plane();
    awake(cp, ALICE, 'did:plc:alice');
    awake(cp, BOB, 'did:plc:bob');
    expect(leaseFor(cp, ALICE, 'brain_job').leaseId).not.toBe(
      leaseFor(cp, BOB, 'brain_job').leaseId,
    );
  });

  it('a SEALED cell cannot be leased — waking is the tenant’s own act', () => {
    // Registration alone does not make a tenant servable: a cell that has
    // never been unlocked holds no key material, so a worker asking for a
    // lease is asking the operator to open a vault it cannot open.
    const cp = plane();
    cp.register(ALICE, 'did:plc:alice');

    const refused = cp.lease(ALICE, 'brain_job');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusal).toBe('cell_sealed');
  });

  it('an unknown tenant is refused rather than served a default', () => {
    const refused = plane().lease('tenant-nobody', 'brain_job');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusal).toBe('unknown_tenant');
  });
});

describe('8.2 — per-install runner binding, with no shared authority', () => {
  const bind = (registry: HostedRunnerRegistry, tenantId: string, installId: string): void => {
    registry.bind({ runnerDid: 'did:plc:runner1', tenantId, installId, active: true });
  };

  it('a runner bound to one install cannot act for another', () => {
    const registry = new HostedRunnerRegistry();
    bind(registry, ALICE, 'install-a');

    expect(registry.admits('did:plc:runner1', ALICE, 'install-a').ok).toBe(true);
    const other = registry.admits('did:plc:runner1', ALICE, 'install-b');
    expect(other.ok).toBe(false);
    expect(!other.ok && other.refusal).toBe('not_bound_to_install');
  });

  it('a runner bound under one tenant cannot act under another', () => {
    // The cross-tenant case is the one that matters: a hosted runner is shared
    // infrastructure, so an install id alone must never be enough. The refusal
    // NAMES the tenant boundary rather than the install, which is what tells an
    // operator whether they are looking at a misconfiguration or an intrusion.
    const registry = new HostedRunnerRegistry();
    bind(registry, ALICE, 'install-a');

    const crossed = registry.admits('did:plc:runner1', BOB, 'install-a');
    expect(crossed.ok).toBe(false);
    expect(!crossed.ok && crossed.refusal).toBe('not_bound_to_tenant');
  });

  it('an unbound runner is refused, and is distinguishable from a misbound one', () => {
    const registry = new HostedRunnerRegistry();
    const nobody = registry.admits('did:plc:stranger', ALICE, 'install-a');
    expect(nobody.ok).toBe(false);
    expect(!nobody.ok && nobody.refusal).toBe('unknown_runner');
  });

  it('suspending a vendor FLEET stops every tenant it serves at once', () => {
    // A vendor whose keys leaked must be stoppable without walking every
    // tenant that hired them; per-binding revocation alone would leave the
    // slowest operator exposed for as long as the walk takes.
    const registry = new HostedRunnerRegistry();
    bind(registry, ALICE, 'install-a');
    bind(registry, BOB, 'install-b');
    expect(registry.admits('did:plc:runner1', BOB, 'install-b').ok).toBe(true);

    registry.suspendFleet('did:plc:runner1');
    for (const [tenant, install] of [
      [ALICE, 'install-a'],
      [BOB, 'install-b'],
    ] as const) {
      const v = registry.admits('did:plc:runner1', tenant, install);
      expect(v.ok).toBe(false);
      expect(!v.ok && v.refusal).toBe('fleet_suspended');
    }

    registry.resumeFleet('did:plc:runner1');
    expect(registry.admits('did:plc:runner1', ALICE, 'install-a').ok).toBe(true);
  });

  it('an INACTIVE binding is refused while the row survives, so it is revocable', () => {
    const registry = new HostedRunnerRegistry();
    registry.bind({
      runnerDid: 'did:plc:runner1',
      tenantId: ALICE,
      installId: 'install-a',
      active: false,
    });
    const v = registry.admits('did:plc:runner1', ALICE, 'install-a');
    expect(v.ok).toBe(false);
    expect(!v.ok && v.refusal).toBe('binding_suspended');
  });
});

describe('8.3 — the managed store is tenant-owned and exportable', () => {
  it('one tenant cannot read another’s blob', () => {
    const store = new ManagedBlobStore(clock);
    store.put(ALICE, 'catalog.json', new TextEncoder().encode('alice catalog'));

    expect(store.get(ALICE, 'catalog.json').ok).toBe(true);
    expect(store.get(BOB, 'catalog.json').ok).toBe(false);
  });

  it('an export lists ONLY the asking tenant’s own objects', () => {
    // §17.2's "tenant-owned, exportable". An export that leaked a neighbour's
    // object NAMES would be a directory of who hosts what.
    const store = new ManagedBlobStore(clock);
    store.put(ALICE, 'a1.json', new TextEncoder().encode('a'));
    store.put(ALICE, 'a2.json', new TextEncoder().encode('aa'));
    store.put(BOB, 'b1.json', new TextEncoder().encode('b'));

    const names = store.list(ALICE).map((b) => b.name).sort();
    expect(names).toEqual(['a1.json', 'a2.json']);
  });

  it('a delete by one tenant does not touch another’s object of the same name', () => {
    const store = new ManagedBlobStore(clock);
    store.put(ALICE, 'catalog.json', new TextEncoder().encode('alice'));
    store.put(BOB, 'catalog.json', new TextEncoder().encode('bob'));

    store.delete(ALICE, 'catalog.json');
    expect(store.get(ALICE, 'catalog.json').ok).toBe(false);
    expect(store.get(BOB, 'catalog.json').ok).toBe(true);
  });
});

describe('8.5 — the owner’s phone may sleep while work continues', () => {
  it('read and quote work keeps its lease while the owner is away', () => {
    // §17.5's actual promise. "Available" for a business means a buyer's
    // question is answered at 2am; if serving one required the owner's device
    // to be awake, the hosting product would not be one.
    const cp = plane();
    awake(cp, ALICE, 'owner unlocked at start of day');

    // Hours pass with no owner interaction at all.
    now = T0 + 8 * 3_600_000;
    const lease = cp.lease(ALICE, 'scheduled_work');
    expect(lease.ok).toBe(true);
  });

  it('metering counts the work, so an operator can bill a sleeping owner’s node', () => {
    const cp = plane();
    awake(cp, ALICE, 'unlocked');
    leaseFor(cp, ALICE, 'brain_job');
    leaseFor(cp, ALICE, 'scheduled_work');

    const meter = cp.meter(ALICE);
    expect(meter?.leases).toBe(2);
    expect(meter?.wakes).toBe(1);
  });

  it('quota exhaustion is REFUSED and counted, not silently served', () => {
    // A throttled tenant an operator cannot see is a support ticket with no
    // evidence attached.
    const cp = plane({ defaultQuota: { maxLeases: 1, windowMs: 60_000 } });
    awake(cp, ALICE, 'unlocked');
    leaseFor(cp, ALICE, 'brain_job');

    const refused = cp.lease(ALICE, 'brain_job');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusal).toBe('quota_exhausted');
    expect(cp.meter(ALICE)?.refused).toBe(1);
  });

  it('an idle cell is sealed, and serving it again needs a wake', () => {
    // The cost half of the same promise: staying available must not mean
    // staying resident. After the sweep, key material is gone and a worker
    // cannot quietly re-open the tenant on its own.
    const cp = plane({ idleSealAfterMs: 1_000 });
    awake(cp, ALICE, 'unlocked');
    leaseFor(cp, ALICE, 'brain_job');

    now = T0 + 1_001;
    const sealed = cp.sweepIdle();
    expect(sealed.map((t) => t.tenantId)).toContain(ALICE);
    expect(cp.get(ALICE)?.state).toBe('sealed');

    const refused = cp.lease(ALICE, 'brain_job');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusal).toBe('cell_sealed');
  });
});
