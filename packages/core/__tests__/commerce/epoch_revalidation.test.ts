/**
 * §16.2's bounded-interval re-verification (WS-2.4).
 *
 * THE SCENARIO THIS EXISTS FOR. A supplier node is running. Somebody restores
 * the same business identity on another machine, which publishes epoch 2 and
 * voids the backup's quote capacity. The first node knows nothing about it: it
 * cached epoch 1 at boot and goes on signing quotes and status updates at
 * epoch 1 for ever. Counterparties reject those records — that is the hard
 * enforcement and it is elsewhere — but from inside, a node signing into a
 * wall is indistinguishable from a node nobody is buying from.
 *
 * The spec's answer is one sentence: "Signing nodes also re-verify the live
 * epoch on a bounded interval, so a forgotten pre-restore node converges."
 * Converging means STOPPING, not adopting: a node that adopted the higher
 * epoch would resume signing beside the node that actually restored, holding
 * pre-restore capacity counters that the fence had already voided.
 */

import {
  CommerceEpochService,
  CommerceTransaction,
  InMemoryCommerceQuoteLedgerRepository,
  InMemoryCommerceReceiptRepository,
  QuoteFamilyStore,
} from '../../src/commerce';

import type { CommerceEpochRecord } from '@dina/commerce-protocol';

const SUPPLIER_DID = 'did:plc:supplier5678';
const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** A fake PDS: holds the live record, CAS on previous digest. */
class FakeRepo {
  live: CommerceEpochRecord | null = null;
  /** Set to throw on the next read, standing in for an unreachable repo. */
  unreachable = false;

  fetchLive = async (): Promise<CommerceEpochRecord | null> => {
    if (this.unreachable) throw new Error('ECONNREFUSED');
    return this.live;
  };

  publish = async (
    record: CommerceEpochRecord,
    previous: CommerceEpochRecord | null,
  ): Promise<boolean> => {
    if ((this.live?.epoch_digest ?? null) !== (previous?.epoch_digest ?? null)) return false;
    this.live = record;
    return true;
  };
}

function makeService(repo: FakeRepo, clock: { now: number }, overrides: object = {}) {
  const ledger = new InMemoryCommerceQuoteLedgerRepository();
  return new CommerceEpochService({
    transaction: new CommerceTransaction((fn: () => void) => {
      fn();
    }),
    families: new QuoteFamilyStore({
      ledger,
      currentEpoch: () => '1',
      supplierDid: () => SUPPLIER_DID,
      now: () => clock.now,
    }),
    receipts: new InMemoryCommerceReceiptRepository(),
    businessDid: SUPPLIER_DID,
    fetchLive: repo.fetchLive,
    publish: repo.publish,
    now: () => clock.now,
    ...overrides,
  });
}

describe('revalidate — the forgotten pre-restore node', () => {
  it('confirms an unchanged live record and keeps signing', async () => {
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock);
    await service.establish();

    clock.now = T0 + HOUR;
    expect(await service.revalidate()).toEqual({ kind: 'current', epoch: '1' });
    expect(service.currentEpoch()).toBe('1');
  });

  it('STOPS signing when the live epoch has moved past this node', async () => {
    // The whole point. Another machine restored this identity; this node is a
    // superseded generation and every further signature would be worthless.
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const stale = makeService(repo, clock);
    await stale.establish();

    const restorer = makeService(repo, clock);
    await restorer.establish();
    const two = await restorer.establishAfterRestore();
    expect(two.epoch).toBe('2');

    const outcome = await stale.revalidate();
    expect(outcome).toMatchObject({ kind: 'stopped', epoch: '1' });
    expect(outcome.kind === 'stopped' ? outcome.reason : '').toContain('superseded');
    // Fail closed, and say why: an operator reading `currentEpoch()`'s throw
    // must be able to tell "superseded" from "never established".
    expect(() => stale.currentEpoch()).toThrow(/signing stopped at epoch 1/);
    expect(stale.established).toBe(false);
  });

  it('does NOT adopt the higher epoch, and never voids capacity', async () => {
    // Adopting would put two generations under one identity, both "current",
    // with this one still holding the pre-restore capacity the fence voided
    // on the other. Stopping is the convergence the spec asks for.
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const stale = makeService(repo, clock);
    await stale.establish();

    const restorer = makeService(repo, clock);
    await restorer.establish();
    await restorer.establishAfterRestore();

    await stale.revalidate();
    expect(() => stale.currentEpoch()).toThrow();
    // A second pass must not resurrect it either.
    expect(await stale.revalidate()).toMatchObject({ kind: 'stopped' });
  });

  it('stops when the live record was rolled back below what this node signed at', async () => {
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock);
    await service.establish();
    const two = await service.establishAfterRestore();
    expect(two.epoch).toBe('2');

    // Somebody put epoch 1 back. That is the fence itself rolling back, and
    // it is not the same thing as being superseded: this node signed at a
    // HIGHER epoch than the repo now claims exists.
    repo.live = await makeService(new FakeRepo(), clock).establish();
    expect(repo.live.epoch).toBe('1');

    const outcome = await service.revalidate();
    expect(outcome).toMatchObject({ kind: 'stopped' });
    expect(outcome.kind === 'stopped' ? outcome.reason : '').toContain('rolled back');
  });

  it('stops when the live record is GONE, rather than reading absence as consent', async () => {
    // This node published or adopted an epoch, so an empty repo means the
    // record was deleted. Treating that as "no epoch yet, carry on" would let
    // a deleted fence authorise signing for ever.
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock);
    await service.establish();

    repo.live = null;
    expect(await service.revalidate()).toMatchObject({ kind: 'stopped' });
    expect(() => service.currentEpoch()).toThrow(/gone from the repo/);
  });

  it('stops when the record was replaced IN PLACE at the same epoch number', async () => {
    // Same number, different digest: somebody rewrote the fence. The digest
    // covers `activated_at`, so this cannot happen by accident.
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock);
    const genesis = await service.establish();

    const rewritten = makeService(new FakeRepo(), { now: T0 + 5_000 });
    repo.live = await rewritten.establish();
    expect(repo.live.epoch).toBe(genesis.epoch);
    expect(repo.live.epoch_digest).not.toBe(genesis.epoch_digest);

    expect(await service.revalidate()).toMatchObject({ kind: 'stopped' });
    expect(() => service.currentEpoch()).toThrow(/replaced in place/);
  });

  it('stops when the live record turns out to belong to another business', async () => {
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock);
    await service.establish();

    const foreign = new FakeRepo();
    const other = new CommerceEpochService({
      transaction: new CommerceTransaction((fn: () => void) => {
        fn();
      }),
      families: new QuoteFamilyStore({
        ledger: new InMemoryCommerceQuoteLedgerRepository(),
        currentEpoch: () => '1',
        supplierDid: () => 'did:plc:someoneelse00000',
        now: () => clock.now,
      }),
      receipts: new InMemoryCommerceReceiptRepository(),
      businessDid: 'did:plc:someoneelse00000',
      fetchLive: foreign.fetchLive,
      publish: foreign.publish,
      now: () => clock.now,
    });
    repo.live = await other.establish();

    expect(await service.revalidate()).toMatchObject({ kind: 'stopped' });
    expect(() => service.currentEpoch()).toThrow(/different business DID/);
  });
});

describe('revalidate — an unreachable repo', () => {
  it('does not stop on a single failed read', async () => {
    // A blip must not take a healthy supplier off the market. One failed read
    // is evidence of nothing.
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock);
    await service.establish();

    repo.unreachable = true;
    clock.now = T0 + HOUR;
    const outcome = await service.revalidate();
    expect(outcome).toMatchObject({ kind: 'unreachable', epoch: '1', staleForMs: HOUR });
    expect(service.currentEpoch()).toBe('1');
  });

  it('refuses to sign once the staleness bound passes', async () => {
    // A node that cannot re-read its repo cannot learn it was superseded, and
    // "I cannot check" for long enough is the forgotten node.
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock, { maxStalenessMs: 24 * HOUR });
    await service.establish();

    repo.unreachable = true;
    clock.now = T0 + 24 * HOUR;
    expect(service.currentEpoch()).toBe('1');

    clock.now = T0 + 24 * HOUR + 1;
    expect(() => service.currentEpoch()).toThrow(/unverified for/);
    // NOT `stopped`: the node has learned nothing, so it must recover the
    // moment the repo answers again.
    repo.unreachable = false;
    expect(await service.revalidate()).toEqual({ kind: 'current', epoch: '1' });
    expect(service.currentEpoch()).toBe('1');
  });

  it('starts the staleness clock at establishment, not at zero', async () => {
    // `establish()` IS a successful live read. Without this, `currentEpoch()`
    // would refuse the instant establishment returned.
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock, { maxStalenessMs: HOUR });
    await service.establish();
    expect(service.currentEpoch()).toBe('1');
    expect(service.staleForMs).toBe(0);
  });

  it('reports staleness only while established', async () => {
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock);
    expect(service.staleForMs).toBeNull();
    await service.establish();
    clock.now = T0 + 500;
    expect(service.staleForMs).toBe(500);
  });
});

describe('revalidateIfDue — the bounded interval', () => {
  it('does nothing before the interval elapses', async () => {
    let reads = 0;
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock, {
      revalidationIntervalMs: HOUR,
      fetchLive: async () => {
        reads += 1;
        return repo.live;
      },
    });
    await service.establish();
    const afterEstablish = reads;

    clock.now = T0 + HOUR - 1;
    expect(await service.revalidateIfDue()).toBeNull();
    expect(reads).toBe(afterEstablish);

    clock.now = T0 + HOUR;
    expect(await service.revalidateIfDue()).toEqual({ kind: 'current', epoch: '1' });
    expect(reads).toBe(afterEstablish + 1);
  });

  it('is quiet on a node that never established an epoch', async () => {
    const service = makeService(new FakeRepo(), { now: T0 });
    expect(await service.revalidateIfDue()).toBeNull();
    expect(await service.revalidate()).toEqual({ kind: 'not_established' });
  });

  it('keeps reporting stopped without re-reading, once stopped', async () => {
    let reads = 0;
    const repo = new FakeRepo();
    const clock = { now: T0 };
    const service = makeService(repo, clock, {
      fetchLive: async () => {
        reads += 1;
        if (repo.unreachable) throw new Error('ECONNREFUSED');
        return repo.live;
      },
    });
    await service.establish();
    repo.live = null;
    await service.revalidate();
    const afterStop = reads;

    expect(await service.revalidate()).toMatchObject({ kind: 'stopped', epoch: '1' });
    // A stopped node must not keep hammering the repo hoping for a different
    // answer: recovering is an operator act (a restore), not a retry.
    expect(reads).toBe(afterStop);
    expect(await service.revalidateIfDue()).toBeNull();
  });
});
