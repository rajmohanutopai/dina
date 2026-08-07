/**
 * Commerce store contracts (CMC-1) — dual harness: every suite runs
 * against the in-memory repo AND the real SQLCipher repo so the two
 * stay behaviour-identical (house §9.1 CAS-parity convention).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryCommerceEpochWatermarkRepository,
  InMemoryCommerceOrderRefRepository,
  InMemoryCommerceQuoteLedgerRepository,
  InMemoryCommerceReceiptRepository,
  InMemoryCommerceStatusHeadRepository,
  SQLiteCommerceEpochWatermarkRepository,
  SQLiteCommerceOrderRefRepository,
  SQLiteCommerceQuoteLedgerRepository,
  SQLiteCommerceReceiptRepository,
  SQLiteCommerceStatusHeadRepository,
  type CommerceEpochWatermarkRepository,
  type CommerceOrderRefRepository,
  type CommerceQuoteLedgerRepository,
  type CommerceReceiptRepository,
  type CommerceStatusHeadRepository,
} from '../../src/commerce';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

interface Harness {
  orderRefs: CommerceOrderRefRepository;
  quotes: CommerceQuoteLedgerRepository;
  statusHeads: CommerceStatusHeadRepository;
  receipts: CommerceReceiptRepository;
  watermarks: CommerceEpochWatermarkRepository;
  cleanup: () => void;
}

function inMemoryHarness(): Harness {
  return {
    orderRefs: new InMemoryCommerceOrderRefRepository(),
    quotes: new InMemoryCommerceQuoteLedgerRepository(),
    statusHeads: new InMemoryCommerceStatusHeadRepository(),
    receipts: new InMemoryCommerceReceiptRepository(),
    watermarks: new InMemoryCommerceEpochWatermarkRepository(),
    cleanup: () => undefined,
  };
}

function sqliteHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-commerce-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    orderRefs: new SQLiteCommerceOrderRefRepository(adapter),
    quotes: new SQLiteCommerceQuoteLedgerRepository(adapter),
    statusHeads: new SQLiteCommerceStatusHeadRepository(adapter),
    receipts: new SQLiteCommerceReceiptRepository(adapter),
    watermarks: new SQLiteCommerceEpochWatermarkRepository(adapter),
    cleanup: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const BUYER = 'did:plc:buyer1234';
const T0 = 1_700_000_000_000;

const baseRef = {
  buyerDid: BUYER,
  purchaseOrderId: 'po-1',
  idempotencyKey: 'idem-1',
  orderDigest: 'a'.repeat(64),
  quoteId: 'q-1',
  quoteDigest: 'b'.repeat(64),
  pinnedMajor: '1',
        admittedEpoch: '1',
        reconciliationRequired: false,
  decisionDeadlineAt: T0 + 60_000,
  createdAt: T0,
};

describe.each([
  ['in-memory', inMemoryHarness],
  ['sqlite', sqliteHarness],
])('commerce stores (%s)', (_label, makeHarness) => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  describe('order refs (§15.5/§9.9)', () => {
    it('enforces BOTH unique identities', () => {
      expect(h.orderRefs.createReserved(baseRef)).toBe(true);
      // Same order id, different key: refused.
      expect(h.orderRefs.createReserved({ ...baseRef, idempotencyKey: 'idem-2' })).toBe(false);
      // Same key, different order id: refused (keys cannot alias).
      expect(h.orderRefs.createReserved({ ...baseRef, purchaseOrderId: 'po-2' })).toBe(false);
      expect(h.orderRefs.getByOrderId(BUYER, 'po-1')?.state).toBe('reserved');
      expect(h.orderRefs.getByIdempotencyKey(BUYER, 'idem-1')?.purchaseOrderId).toBe('po-1');
    });

    it('effect_started is a one-way, pre-decision CAS', () => {
      h.orderRefs.createReserved(baseRef);
      expect(h.orderRefs.markEffectStarted(BUYER, 'po-1')).toBe(true);
      expect(h.orderRefs.markEffectStarted(BUYER, 'po-1')).toBe(false);
      expect(h.orderRefs.getByOrderId(BUYER, 'po-1')?.effectPhase).toBe('effect_started');
    });

    it('decision_timeout recovery can NEVER decide an effect_started row', () => {
      h.orderRefs.createReserved(baseRef);
      h.orderRefs.markEffectStarted(BUYER, 'po-1');
      expect(
        h.orderRefs.decide(BUYER, 'po-1', {
          acknowledgementJson: '{"kind":"rejected","reasonCode":"decision_timeout"}',
          decidedAt: T0 + 61_000,
          requirePreEffect: true,
        }),
      ).toBe(false);
      // The real terminal decision (no phase requirement) still lands once.
      expect(
        h.orderRefs.decide(BUYER, 'po-1', {
          acknowledgementJson: '{"kind":"accepted"}',
          externalRef: 'erp-77',
          decidedAt: T0 + 90_000,
        }),
      ).toBe(true);
      expect(
        h.orderRefs.decide(BUYER, 'po-1', {
          acknowledgementJson: '{"kind":"rejected"}',
          decidedAt: T0 + 91_000,
        }),
      ).toBe(false);
      const decided = h.orderRefs.getByOrderId(BUYER, 'po-1');
      expect(decided?.state).toBe('decided');
      expect(decided?.externalRef).toBe('erp-77');
    });

    it('lists only pre_effect rows past their deadline for the sweeper', () => {
      h.orderRefs.createReserved(baseRef);
      h.orderRefs.createReserved({
        ...baseRef,
        purchaseOrderId: 'po-2',
        idempotencyKey: 'idem-2',
      });
      h.orderRefs.markEffectStarted(BUYER, 'po-2');
      const expired = h.orderRefs.listExpiredPreEffect(T0 + 120_000);
      expect(expired.map((r) => r.purchaseOrderId)).toEqual(['po-1']);
      expect(h.orderRefs.listExpiredPreEffect(T0 + 1_000)).toEqual([]);
      expect(h.orderRefs.countReservedByMajor('1')).toBe(2);
    });
  });

  describe('quote ledger (§9.8/§9.9/§16.2)', () => {
    const head = {
      quoteId: 'q-1',
      buyerDid: BUYER,
      headDigest: 'c'.repeat(64),
      headRevision: '1',
      maxUses: '2',
      validUntil: T0 + 86_400_000,
      supplierEpoch: '1',
      createdAt: T0,
    };

    it('registers once and advances only through the head CAS', () => {
      expect(h.quotes.registerHead(head)).toBe(true);
      expect(h.quotes.registerHead(head)).toBe(false);
      expect(
        h.quotes.casAdvanceHead('q-1', 'd'.repeat(64), {
          headDigest: 'e'.repeat(64),
          headRevision: '2',
          supplierEpoch: '1',
          validUntil: T0 + 86_400_000,
          updatedAt: T0 + 1,
        }),
      ).toBe(false);
      expect(
        h.quotes.casAdvanceHead('q-1', 'c'.repeat(64), {
          headDigest: 'e'.repeat(64),
          headRevision: '2',
          supplierEpoch: '1',
          validUntil: T0 + 86_400_000,
          updatedAt: T0 + 1,
        }),
      ).toBe(true);
      expect(h.quotes.getHead('q-1')?.headRevision).toBe('2');
    });

    it('holds settle exactly once; refunds free capacity', () => {
      h.quotes.registerHead(head);
      expect(h.quotes.holdUse('q-1', 'po-1', T0)).toBe(true);
      expect(h.quotes.holdUse('q-1', 'po-1', T0)).toBe(false);
      expect(h.quotes.holdUse('q-1', 'po-2', T0)).toBe(true);
      expect(h.quotes.activeUseCount('q-1')).toBe(2);
      expect(h.quotes.settleUse('q-1', 'po-1', 'refunded', T0 + 5)).toBe(true);
      expect(h.quotes.settleUse('q-1', 'po-1', 'committed', T0 + 6)).toBe(false);
      expect(h.quotes.activeUseCount('q-1')).toBe(1);
      expect(h.quotes.settleUse('q-1', 'po-2', 'committed', T0 + 7)).toBe(true);
      expect(h.quotes.activeUseCount('q-1')).toBe(1);
      expect(h.quotes.getUse('q-1', 'po-1')).toBe('refunded');
    });

    it('§16.2 restore voiding kills unexpired capacity and blocks the CAS', () => {
      h.quotes.registerHead(head);
      h.quotes.registerHead({
        ...head,
        quoteId: 'q-expired',
        validUntil: T0 - 1,
      });
      expect(h.quotes.voidUnexpired(T0, T0 + 1)).toBe(1);
      expect(h.quotes.getHead('q-1')?.voided).toBe(true);
      expect(h.quotes.getHead('q-expired')?.voided).toBe(false);
      expect(
        h.quotes.casAdvanceHead('q-1', 'c'.repeat(64), {
          headDigest: 'e'.repeat(64),
          headRevision: '2',
          supplierEpoch: '2',
          validUntil: T0 + 86_400_000,
          updatedAt: T0 + 2,
        }),
      ).toBe(false);
    });
  });

  describe('status heads (§9.11/§16.2)', () => {
    const genesis = {
      buyerDid: BUYER,
      purchaseOrderId: 'po-1',
      headDigest: 'f'.repeat(64),
      headSequence: '0',
      state: 'accepted',
      supplierEpoch: '1',
      updatedAt: T0,
    };

    it('genesis inserts once; successors CAS against the digest', () => {
      expect(h.statusHeads.initGenesis(genesis)).toBe(true);
      expect(h.statusHeads.initGenesis(genesis)).toBe(false);
      expect(
        h.statusHeads.casAdvance(BUYER, 'po-1', '0'.repeat(64), {
          headDigest: '1'.repeat(64),
          headSequence: '1',
          state: 'preparing',
          supplierEpoch: '1',
          updatedAt: T0 + 1,
        }),
      ).toBe(false);
      expect(
        h.statusHeads.casAdvance(BUYER, 'po-1', 'f'.repeat(64), {
          headDigest: '1'.repeat(64),
          headSequence: '1',
          state: 'preparing',
          supplierEpoch: '1',
          updatedAt: T0 + 1,
        }),
      ).toBe(true);
    });

    it('a fence must strictly raise the epoch', () => {
      h.statusHeads.initGenesis(genesis);
      const fence = {
        headDigest: '2'.repeat(64),
        headSequence: '1',
        state: 'accepted',
        supplierEpoch: '1',
        updatedAt: T0 + 2,
      };
      expect(h.statusHeads.setFence(BUYER, 'po-1', fence)).toBe(false);
      expect(h.statusHeads.setFence(BUYER, 'po-1', { ...fence, supplierEpoch: '2' })).toBe(true);
      expect(h.statusHeads.get(BUYER, 'po-1')?.supplierEpoch).toBe('2');
    });
  });

  describe('receipts (§16.2)', () => {
    it('is first-writer-wins on record digest and lists in insertion order', () => {
      const receipt = {
        recordDigest: '9'.repeat(64),
        domain: 'order' as const,
        buyerDid: BUYER,
        quoteId: 'q-1',
        purchaseOrderId: 'po-1',
        recordJson: '{"purchaseOrderId":"po-1"}',
        evidenceJson: '{}',
        createdAt: T0,
      };
      expect(h.receipts.put(receipt)).toBe(true);
      expect(h.receipts.put({ ...receipt, recordJson: '{"tampered":true}' })).toBe(false);
      expect(h.receipts.get('9'.repeat(64))?.recordJson).toBe('{"purchaseOrderId":"po-1"}');
      h.receipts.put({
        ...receipt,
        recordDigest: '8'.repeat(64),
        domain: 'acknowledgement',
        createdAt: T0 + 1,
      });
      expect(h.receipts.listByOrder(BUYER, 'po-1').map((r) => r.domain)).toEqual([
        'order',
        'acknowledgement',
      ]);
      expect(h.receipts.listByQuote('q-1')).toHaveLength(2);
    });

    it('rejects unknown domains', () => {
      expect(() =>
        h.receipts.put({
          recordDigest: '7'.repeat(64),
          domain: 'invoice' as never,
          buyerDid: BUYER,
          quoteId: '',
          purchaseOrderId: '',
          recordJson: '{}',
          evidenceJson: '{}',
          createdAt: T0,
        }),
      ).toThrow(/unknown domain/);
    });
  });

  describe('epoch watermarks (§16.2)', () => {
    it('defaults to "0" and only ever rises (BigInt compare, not text)', () => {
      const supplier = 'did:plc:supplier5678';
      expect(h.watermarks.get(supplier)).toBe('0');
      expect(h.watermarks.raiseTo(supplier, '9', T0)).toBe('9');
      // '10' > '9' numerically but < lexicographically — the store must
      // compare as integers.
      expect(h.watermarks.raiseTo(supplier, '10', T0 + 1)).toBe('10');
      expect(h.watermarks.raiseTo(supplier, '2', T0 + 2)).toBe('10');
      expect(h.watermarks.get(supplier)).toBe('10');
    });
  });
});
