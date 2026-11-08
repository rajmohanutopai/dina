/**
 * The khata and the rest of a business's books survive a restore
 * (docs/STATE_MACHINES.md COM-3; USER_BACKUP.md). Real export, real import, two
 * separate sets of SQLite files.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { tradeRecordDigest } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { preflightCommerceArchive } from '../../src/commerce/archive_preflight';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import {
  SQLiteTradeDocumentRepository,
  verifyInboundDeliveryReceipt,
  verifyInboundPaymentNote,
} from '../../src/commerce/trade_ledger';
import { TradeLedgerService } from '../../src/commerce/trade_ledger_service';
import { tradeRelationshipReaders } from '../../src/commerce/trade_readers';
import {
  buildArchivePayload,
  createArchive,
  importArchive,
  importArchivePayload,
  setArchiveDataSource,
  type ArchiveDataSource,
} from '../../src/export/archive';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  hash,
  makeAcknowledgement,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from '../commerce/helpers';

const PASS = 'correct horse battery staple';
const PASSHEX = randomBytes(32).toString('hex');
const SUPPLIER = 'did:plc:supplierS';
const BUYER = 'did:plc:buyerOne';

interface Node {
  dir: string;
  db: NodeSQLiteAdapter;
}
function freshNode(): Node {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-ledger-archive-'));
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  return { dir, db };
}
function close(node: Node): void {
  node.db.close();
  fs.rmSync(node.dir, { recursive: true, force: true });
}
const source = (node: Node): ArchiveDataSource => ({
  identityAdapter: () => node.db,
  personaSources: async () => [],
  openPersonaForRestore: async () => {
    throw new Error('no personas here');
  },
  hasExistingUserData: async () => false,
});

function seat(node: Node, self: string): { runtime: CommerceRuntime; service: TradeLedgerService; docs: SQLiteTradeDocumentRepository } {
  const docs = new SQLiteTradeDocumentRepository(node.db);
  const runtime = createCommerceRuntime({
    adapter: node.db,
    supplierDid: () => self,
    currentEpoch: () => '1',
    now: () => Date.now(),
  });
  installCommerceRuntime(runtime);
  const service = new TradeLedgerService({
    documents: docs,
    nodeDid: () => self,
    now: () => Date.now(),
    ...tradeRelationshipReaders(runtime),
  });
  return { runtime, service, docs };
}

const qty = (value: string): { value: string; unit_code: string } => ({ value, unit_code: 'each' });

function retainOrder(runtime: CommerceRuntime, po: string): void {
  const request = makeQuoteRequest({ buyer_did: BUYER, supplier_did: SUPPLIER } as never);
  const product = { scheme: 'gtin', value: '09506000134352' };
  const quote = makeSignedQuote(request, {
    quote_id: `q-${po}`,
    valid_until: '2036-01-01T00:00:00.000Z',
    lines: [
      {
        line_id: 'l1',
        requested_product: product,
        offered_product: product,
        quantity: { value: '100', unit_code: 'each' },
        price_basis: { value: '1', unit_code: 'each' },
        unit_price: { currency: 'INR', minor_units: '500' },
        line_subtotal: { currency: 'INR', minor_units: '50000' },
        stock_status: 'available',
      },
    ],
    total: { currency: 'INR', minor_units: '50000' },
  } as never);
  const order = makeOrder(quote, request.delivery.projection, {
    purchase_order_id: po,
    idempotency_key: `idem-${po}`,
  });
  const ack = makeAcknowledgement({
    purchase_order_id: po,
    order_digest: order.order_digest,
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    accepted_quote_digest: quote.quote_digest,
    acknowledgement_id: `ack-${po}`,
  } as never);
  const put = (
    recordDigest: string,
    domain: 'quote' | 'order' | 'acknowledgement',
    record: unknown,
    purchaseOrderId: string,
  ): void => {
    runtime.receipts.put({
      recordDigest,
      domain,
      buyerDid: BUYER,
      quoteId: quote.quote_id,
      purchaseOrderId,
      recordJson: JSON.stringify(record),
      evidenceJson: '{}',
      createdAt: 1,
    });
  };
  put(quote.quote_digest, 'quote', quote, '');
  put(order.order_digest, 'order', order, po);
  put(ack.acknowledgement_digest, 'acknowledgement', ack, po);
}

afterEach(() => {
  installCommerceRuntime(null);
  setArchiveDataSource(null);
});

async function roundTrip(src: Node, dest: Node): Promise<void> {
  setArchiveDataSource(source(src));
  const archive = await createArchive(PASS);
  setArchiveDataSource(source(dest));
  await importArchive(archive, PASS);
}

describe('COM-3: the books travel', () => {
  it('a full khata reads the same statement on both sides of a restore, and its rules still hold', async () => {
    const src = freshNode();
    const dest = freshNode();
    try {
      const a = seat(src, SUPPLIER);
      retainOrder(a.runtime, 'po-1');
      const first = a.service.issueDeliveryNote({
        counterpartyDid: BUYER,
        purchaseOrderId: 'po-1',
        supplierOrderId: 'so',
        lines: [{ line_id: 'l1', delivered_quantity: qty('60') }],
      });
      if (!first.ok) throw new Error(first.refusal);
      const unanswered = a.service.issueDeliveryNote({
        counterpartyDid: BUYER,
        purchaseOrderId: 'po-1',
        supplierOrderId: 'so',
        lines: [{ line_id: 'l1', delivered_quantity: qty('20') }],
      });
      if (!unanswered.ok) throw new Error(unanswered.refusal);
      const receiptOf = (noteDigest: string, id: string, n: string): Record<string, unknown> => {
        const draft = {
          protocol_version: '1.0',
          delivery_receipt_id: id,
          delivery_note_digest: noteDigest,
          lines: [{ line_id: 'l1', accepted_quantity: qty(n) }],
          received_at: new Date().toISOString(),
        };
        return { ...draft, receipt_digest: tradeRecordDigest('delivery_receipt', draft as never, hash) };
      };
      const readers = tradeRelationshipReaders(a.runtime);
      expect(
        verifyInboundDeliveryReceipt({
          senderDid: BUYER,
          selfDid: SUPPLIER,
          receipt: receiptOf(first.document.note_digest, 'dr-1', '60'),
          repository: a.docs,
          readOrder: (po) => readers.readOrder(BUYER, po, 'supplier'),
          evidenceJson: '{}',
          nowMs: Date.now(),
        }).outcome,
      ).toBe('applied');
      const payDraft = {
        protocol_version: '1.0',
        payment_note_id: 'pn-1',
        buyer_did: BUYER,
        supplier_did: SUPPLIER,
        amount: { currency: 'INR', minor_units: '10000' },
        method: 'upi',
        paid_at: new Date().toISOString(),
      };
      const pay = { ...payDraft, note_digest: tradeRecordDigest('payment_note', payDraft as never, hash) };
      expect(
        verifyInboundPaymentNote({
          senderDid: BUYER,
          selfDid: SUPPLIER,
          note: pay,
          repository: a.docs,
          evidenceJson: '{}',
          nowMs: Date.now(),
        }).outcome,
      ).toBe('applied');
      expect(
        a.service.acknowledgePayment({
          paymentNoteDigest: pay.note_digest,
          kind: 'received',
          amountReceived: { currency: 'INR', minor_units: '10000' },
        }).ok,
      ).toBe(true);
      const before = a.service.statement({ counterpartyDid: BUYER, currency: 'INR', role: 'supplier' });
      if (!before.ok) throw new Error(before.error);
      expect(before.balance).toMatchObject({ direction: 'buyer_owes', minor_units: '20000' });

      await roundTrip(src, dest);

      const b = seat(dest, SUPPLIER);
      const after = b.service.statement({ counterpartyDid: BUYER, currency: 'INR', role: 'supplier' });
      if (!after.ok) throw new Error(after.error);
      expect(after.balance).toEqual(before.balance);

      // A late answer to a note from before the restore still lands.
      const restoredReaders = tradeRelationshipReaders(b.runtime);
      expect(
        verifyInboundDeliveryReceipt({
          senderDid: BUYER,
          selfDid: SUPPLIER,
          receipt: receiptOf(unanswered.document.note_digest, 'dr-2', '20'),
          repository: b.docs,
          readOrder: (po) => restoredReaders.readOrder(BUYER, po, 'supplier'),
          evidenceJson: '{}',
          nowMs: Date.now(),
        }).outcome,
      ).toBe('applied');
      // Goods already delivered cannot be delivered again on paper.
      const overrun = b.service.issueDeliveryNote({
        counterpartyDid: BUYER,
        purchaseOrderId: 'po-1',
        supplierOrderId: 'so',
        lines: [{ line_id: 'l1', delivered_quantity: qty('21') }],
      });
      expect(!overrun.ok && overrun.refusal).toContain('cumulative');
    } finally {
      close(src);
      close(dest);
    }
  });

  it('the rest of the books travel; live authority and what rebuilds do not', async () => {
    const src = freshNode();
    try {
      const payload = await buildArchivePayload(source(src));
      const present = (table: string): boolean => payload.identity.tables[table] !== undefined;
      for (const table of [
        'commerce_trade_documents',
        'commerce_decline_documents',
        'commerce_revshare_documents',
        'commerce_order_attachments',
        'commerce_trade_spool',
        'commerce_invites',
        'commerce_catalog_drafts',
        'commerce_sku_assignments',
        'commerce_sku_highwater',
      ]) {
        expect([table, present(table)]).toEqual([table, true]);
      }
      for (const table of [
        'commerce_staff_grants',
        'commerce_staff_pins',
        'commerce_staff_pin_attempts',
        'commerce_staff_clearances',
        'commerce_order_approvals',
        'commerce_order_drafts',
        'commerce_image_artifacts',
        'commerce_image_egress_authorizations',
        'commerce_credentials',
        'commerce_pending_decisions',
      ]) {
        expect([table, present(table)]).toEqual([table, false]);
      }
    } finally {
      close(src);
    }
  });

  it('restored form: an open invite comes back revoked, an active one stays; only live catalogue work returns', async () => {
    const src = freshNode();
    const dest = freshNode();
    try {
      const invite = (nonce: string, state: string): void => {
        src.db.execute(
          `INSERT INTO commerce_invites (nonce, role, state, direction, counterparty_did, offer_json,
             expires_at, created_at, updated_at)
           VALUES (?, 'inviter', ?, 'i_supply_you', 'did:plc:x', '{}', 9999999999999, 1, 1)`,
          [nonce, state],
        );
      };
      invite('n-offered', 'offered');
      invite('n-held', 'held');
      invite('n-redeemed', 'redeemed');
      invite('n-active', 'active');
      invite('n-revoked', 'revoked');
      src.db.execute(
        `INSERT INTO commerce_sku_highwater (issuer_did, high_water) VALUES ('did:plc:s', 41)`,
      );
      const sku = (value: string, published: number): void => {
        src.db.execute(
          `INSERT INTO commerce_sku_assignments (issuer_did, scheme, value, assignment_id, catalog_id,
             draft_id, published, created_at_ms)
           VALUES ('did:plc:s', 'sku', ?, ?, 'cat', 'drf', ?, 1)`,
          [value, `asg-${value}`, published],
        );
      };
      sku('P-0001', 1);
      sku('P-0002', 0);
      const draft = (id: string, state: string): void => {
        src.db.execute(
          `INSERT INTO commerce_catalog_drafts (draft_id, catalog_id, state, created_at_ms, updated_at_ms) VALUES (?, 'cat', ?, 1, 1)`,
          [id, state],
        );
      };
      draft('drf-live', 'published');
      draft('drf-open', 'approved');

      await roundTrip(src, dest);

      expect(
        dest.db.query('SELECT nonce, state FROM commerce_invites ORDER BY nonce').map((r) => [r.nonce, r.state]),
      ).toEqual([
        ['n-active', 'active'],
        ['n-held', 'revoked'],
        ['n-offered', 'revoked'],
        ['n-redeemed', 'revoked'],
        ['n-revoked', 'revoked'],
      ]);
      expect(dest.db.query('SELECT high_water FROM commerce_sku_highwater')).toEqual([
        { high_water: 41 },
      ]);
      expect(dest.db.query('SELECT value FROM commerce_sku_assignments')).toEqual([
        { value: 'P-0001' },
      ]);
      expect(dest.db.query('SELECT draft_id FROM commerce_catalog_drafts')).toEqual([
        { draft_id: 'drf-live' },
      ]);
    } finally {
      close(src);
      close(dest);
    }
  });

  it('a backup from before these tables leaves the live rows alone', async () => {
    const src = freshNode();
    const dest = freshNode();
    try {
      dest.db.execute(
        `INSERT INTO commerce_sku_highwater (issuer_did, high_water) VALUES ('did:plc:s', 41)`,
      );
      const payload = await buildArchivePayload(source(src));
      delete payload.identity.tables['commerce_sku_highwater'];
      setArchiveDataSource(source(dest));
      await importArchivePayload(payload, { force: true });
      expect(dest.db.query('SELECT high_water FROM commerce_sku_highwater')).toEqual([
        { high_water: 41 },
      ]);
    } finally {
      close(src);
      close(dest);
    }
  });

  it('preflight refuses a ledger row that does not hash to its key', () => {
    const empty = {
      commerce_receipts: [],
      commerce_order_refs: [],
      commerce_quote_heads: [],
      commerce_quote_uses: [],
      commerce_status_heads: [],
      commerce_epoch_watermarks: [],
    };
    const draft = {
      protocol_version: '1.0',
      payment_note_id: 'pn-1',
      buyer_did: BUYER,
      supplier_did: SUPPLIER,
      amount: { currency: 'INR', minor_units: '10000' },
      method: 'upi',
      paid_at: '2026-08-01T00:00:00.000Z',
    };
    const note = { ...draft, note_digest: tradeRecordDigest('payment_note', draft as never, hash) };
    const row = (recordJson: string, recordDigest: string): Record<string, unknown> => ({
      record_digest: recordDigest,
      kind: 'payment_note',
      record_json: recordJson,
    });
    expect(
      preflightCommerceArchive({
        ...empty,
        commerce_trade_documents: [row(JSON.stringify(note), note.note_digest)],
      } as never).ok,
    ).toBe(true);
    const edited = { ...note, amount: { currency: 'INR', minor_units: '1' } };
    const verdict = preflightCommerceArchive({
      ...empty,
      commerce_trade_documents: [row(JSON.stringify(edited), note.note_digest)],
    } as never);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatchObject({
      refusal: 'forged_document',
      table: 'commerce_trade_documents',
    });
    // A legacy decline row the v42 migration left behind is not read, so it passes.
    expect(
      preflightCommerceArchive({
        ...empty,
        commerce_trade_documents: [{ record_digest: 'x', kind: 'quote_decline', record_json: '{}' }],
      } as never).ok,
    ).toBe(true);
  });
});
