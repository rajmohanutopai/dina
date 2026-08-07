/**
 * Epoch service (CMC-6 supplier half): fail-closed until established,
 * genesis publication, CAS-serialized restores, restore voiding.
 */

import { commerceRecordDigest } from '@dina/commerce-protocol';

import {
  CommerceEpochService,
  InMemoryCommerceQuoteLedgerRepository,
  QuoteFamilyStore,
  InMemoryCommerceReceiptRepository,
} from '../../src/commerce';


import { hash } from './helpers';

import type { CommerceEpochRecord } from '@dina/commerce-protocol';

const SUPPLIER_DID = 'did:plc:supplier5678';
const T0 = 1_700_000_000_000;

/** A fake PDS: holds the live record, CAS on previous digest. */
class FakeRepo {
  live: CommerceEpochRecord | null = null;

  fetchLive = async (): Promise<CommerceEpochRecord | null> => this.live;

  publish = async (
    record: CommerceEpochRecord,
    previous: CommerceEpochRecord | null,
  ): Promise<boolean> => {
    const currentDigest = this.live?.epoch_digest ?? null;
    const expectedDigest = previous?.epoch_digest ?? null;
    if (currentDigest !== expectedDigest) return false; // CAS loss
    this.live = record;
    return true;
  };
}

function makeService(repo: FakeRepo) {
  const quotes = new InMemoryCommerceQuoteLedgerRepository();
  const receipts = new InMemoryCommerceReceiptRepository();
  const service = new CommerceEpochService({
    tx: (fn) => fn(),
    families: new QuoteFamilyStore({ ledger: quotes, currentEpoch: () => '1',
    supplierDid: () => SUPPLIER_DID, now: () => T0 }),
    receipts,
    businessDid: SUPPLIER_DID,
    fetchLive: repo.fetchLive,
    publish: repo.publish,
    now: () => T0,
  });
  return { service, quotes, receipts };
}

describe('CommerceEpochService', () => {
  it('fails closed until established', () => {
    const { service } = makeService(new FakeRepo());
    expect(() => service.currentEpoch()).toThrow(/fail-closed/);
  });

  it('publishes the genesis on first establish and adopts the live record later', async () => {
    const repo = new FakeRepo();
    const { service } = makeService(repo);
    const genesis = await service.establish();
    expect(genesis.epoch).toBe('1');
    expect(genesis.reason).toBe('initial');
    expect(service.currentEpoch()).toBe('1');

    // A second node adopts, never re-publishes.
    const { service: second } = makeService(repo);
    const adopted = await second.establish();
    expect(adopted.epoch_digest).toBe(genesis.epoch_digest);
  });

  it('restore increments via CAS, voids unexpired capacity, records the fence event', async () => {
    const repo = new FakeRepo();
    const { service } = makeService(repo);
    const genesis = await service.establish();

    const { service: restored, quotes, receipts } = makeService(repo);
    quotes.registerHead({
      quoteId: 'q-1',
      buyerDid: 'did:plc:buyer1234',
      headDigest: 'a'.repeat(64),
      headRevision: '1',
      maxUses: '1',
      validUntil: T0 + 86_400_000,
      supplierEpoch: '1',
      createdAt: T0 - 1000,
    });

    const next = await restored.establishAfterRestore();
    expect(next.epoch).toBe('2');
    expect(next.reason).toBe('restore');
    // Assert against the GENESIS digest captured before the restore.
    // The old form compared repo.live?.previous_epoch_digest to itself
    // (repo.live IS `next` once publish succeeds), so the chain link was
    // asserted nowhere and a buildRecord that dropped the pointer passed.
    expect(next.previous_epoch_digest).toBe(genesis.epoch_digest);
    expect(restored.currentEpoch()).toBe('2');
    expect(quotes.getHead('q-1')?.voided).toBe(true);
    expect(receipts.get(next.epoch_digest)?.domain).toBe('restore_fence_event');
  });

  it('concurrent restores serialize: the loser LOSES a CAS, then retries onto the next epoch', async () => {
    const repo = new FakeRepo();
    const { service } = makeService(repo);
    const genesis = await service.establish();

    // First restorer wins epoch 2 out-of-band.
    const { service: winner } = makeService(repo);
    const two = await winner.establishAfterRestore();
    expect(two.epoch).toBe('2');

    // The loser must hold a STALE snapshot on its first read — otherwise
    // it reads epoch 2, builds 3, and its first CAS simply succeeds, so
    // the retry loop is never exercised and `if (!published) continue;`
    // could be a throw with this test still green.
    let reads = 0;
    let publishes = 0;
    const loserQuotes = new InMemoryCommerceQuoteLedgerRepository();
    const loserReceipts = new InMemoryCommerceReceiptRepository();
    const loser = new CommerceEpochService({
      tx: (fn) => fn(),
      families: new QuoteFamilyStore({ ledger: loserQuotes, currentEpoch: () => '1',
    supplierDid: () => SUPPLIER_DID, now: () => T0 }),
      receipts: loserReceipts,
      businessDid: SUPPLIER_DID,
      fetchLive: async () => {
        reads += 1;
        return reads === 1 ? genesis : repo.live; // stale on the first read
      },
      publish: async (record, previous) => {
        publishes += 1;
        return repo.publish(record, previous);
      },
      now: () => T0,
    });

    const three = await loser.establishAfterRestore();
    expect(three.epoch).toBe('3');
    expect(three.previous_epoch_digest).toBe(two.epoch_digest);
    // Proof the CAS actually lost once and the loop retried.
    expect(publishes).toBe(2);
    expect(reads).toBe(2);
  });

  it('refuses a live epoch record belonging to a different business DID (§16.2)', async () => {
    // The epoch record is the restore fence for ONE identity. Adopting
    // another DID's record — a misconfigured repo pointer, a rotation, a
    // shared PDS client — stamps an arbitrary epoch into every quote and
    // status this node goes on to sign.
    const repo = new FakeRepo();
    const { service } = makeService(repo);
    const mine = await service.establish();

    const theirs = { ...mine, business_did: 'did:plc:someotherbusiness' };
    const rebuilt = {
      ...theirs,
      epoch_digest: commerceRecordDigest(
        'epoch',
        Object.fromEntries(
          Object.entries(theirs).filter(([k]) => k !== 'epoch_digest'),
        ) as Record<string, unknown>,
        hash,
      ),
    } as CommerceEpochRecord;

    const foreignRepo = new FakeRepo();
    foreignRepo.live = rebuilt;
    const { service: probe } = makeService(foreignRepo);
    await expect(probe.establish()).rejects.toThrow(/different business DID/);
    await expect(probe.establishAfterRestore()).rejects.toThrow(/different business DID/);
  });

  it('refuses a live epoch record that is malformed or digest-forged (§16.2)', async () => {
    const repo = new FakeRepo();
    const { service } = makeService(repo);
    const genesis = await service.establish();

    // (a) tampered digest — structurally plausible, cryptographically not.
    const forged = { ...genesis, epoch_digest: 'f'.repeat(64) };
    let publishes = 0;
    const makeProbe = (live: CommerceEpochRecord) =>
      new CommerceEpochService({
        tx: (fn) => fn(),
        families: new QuoteFamilyStore({
          ledger: new InMemoryCommerceQuoteLedgerRepository(),
          currentEpoch: () => '1',
    supplierDid: () => SUPPLIER_DID,
          now: () => T0,
        }),
        receipts: new InMemoryCommerceReceiptRepository(),
        businessDid: SUPPLIER_DID,
        fetchLive: async () => live,
        publish: async () => {
          publishes += 1;
          return true;
        },
        now: () => T0,
      });

    await expect(makeProbe(forged).establishAfterRestore()).rejects.toThrow(/live record rejected/);

    // (b) non-canonical epoch string — must not reach BigInt and crash.
    const malformed = { ...genesis, epoch: '01' } as CommerceEpochRecord;
    await expect(makeProbe(malformed).establishAfterRestore()).rejects.toThrow(
      /live record rejected/,
    );

    // Nothing was published on either rejection.
    expect(publishes).toBe(0);
  });
});
