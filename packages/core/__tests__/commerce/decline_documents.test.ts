/**
 * The quote-decline ledger (§5.B1 Cut 1) — the money-free slice carved out of
 * the trade-document ledger. Store discipline (digest idempotency,
 * verified-on-read), the inbound verifier's binding + one-answer rules, and the
 * §5.B1 acceptance: a real store round-trip (persist → reload → compare) with a
 * digest cross-check that rejects a tampered row. One body runs against real
 * SQLite AND the in-memory double, so the double cannot be quietly more
 * permissive.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { tradeRecordDigest, type QuoteDecline, type QuoteRequest, type Sha256Fn } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  DeclineLedgerIntegrityError,
  InMemoryDeclineDocumentRepository,
  SQLiteDeclineDocumentRepository,
  authorQuoteDecline,
  rehydrateDeclineDocument,
  verifyInboundQuoteDecline,
  type DeclineDocumentRepository,
} from '../../src/commerce/decline_documents';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const BUYER = 'did:plc:tradebuyer000000000000000';
const SUPPLIER = 'did:plc:tradesupplier0000000000000';
const T0 = 1_800_000_000_000;

function sealedDecline(overrides: Partial<QuoteDecline> = {}): QuoteDecline {
  const draft = {
    protocol_version: '1.0',
    decline_id: `dec-${randomBytes(4).toString('hex')}`,
    request_id: 'req-1',
    request_digest: 'e'.repeat(64),
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    reason_code: 'capacity',
    issued_at: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
  return { ...draft, decline_digest: tradeRecordDigest('quote_decline', draft, hash) } as QuoteDecline;
}

const retainedRequest = {
  protocol_version: '1.0',
  request_id: 'req-1',
  request_digest: 'e'.repeat(64),
  buyer_did: BUYER,
  supplier_did: SUPPLIER,
} as unknown as QuoteRequest;

interface Backend {
  name: string;
  make: () => { repo: DeclineDocumentRepository; close: () => void };
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-decline-ledger-'));
      const adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteDeclineDocumentRepository(adapter),
        close: () => {
          adapter.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'memory',
    make: () => ({ repo: new InMemoryDeclineDocumentRepository(), close: () => undefined }),
  },
];

describe.each(backends)('decline ledger ($name)', ({ make }) => {
  let repo: DeclineDocumentRepository;
  let close: () => void;

  beforeEach(() => {
    ({ repo, close } = make());
  });

  afterEach(() => {
    close();
  });

  const ingestDecline = (
    decline: QuoteDecline,
    extra: Partial<Parameters<typeof verifyInboundQuoteDecline>[0]> = {},
  ) =>
    verifyInboundQuoteDecline({
      senderDid: SUPPLIER,
      selfDid: BUYER,
      decline,
      repository: repo,
      readRequest: (id) => (id === 'req-1' ? retainedRequest : null),
      evidenceJson: '{}',
      nowMs: T0,
      ...extra,
    });

  describe('inbound QuoteDecline (at the buyer)', () => {
    it('applies once per request; a different second decline conflicts', () => {
      const decline = sealedDecline();
      expect(ingestDecline(decline).outcome).toBe('applied');
      expect(ingestDecline(decline).outcome).toBe('duplicate');
      expect(ingestDecline(sealedDecline({ reason_code: 'policy' })).outcome).toBe('conflict');
    });

    it('binds: unknown request, wrong sender, digest mismatch', () => {
      expect(ingestDecline(sealedDecline({ request_id: 'req-9' })).outcome).toBe('refused');
      expect(ingestDecline(sealedDecline(), { senderDid: BUYER }).outcome).toBe('not_ours');
      expect(ingestDecline(sealedDecline({ request_digest: 'f'.repeat(64) })).detail).toContain(
        'request_digest',
      );
    });
  });

  describe('store round-trip (§5.B1 acceptance)', () => {
    it('persists a decline, reloads it, and compares it — a real store round-trip', () => {
      const decline = sealedDecline();
      expect(ingestDecline(decline).outcome).toBe('applied');

      const row = repo.get(decline.decline_digest);
      if (row === null) throw new Error('expected the decline to be stored');
      const reloaded = rehydrateDeclineDocument(row);
      expect(reloaded).toEqual(decline);
      // The ROW the verifier wrote, not only the record inside it: the inbound
      // leg names the sender as counterparty and the request it answers.
      expect(row).toMatchObject({
        direction: 'inbound',
        counterpartyDid: SUPPLIER,
        requestDigest: decline.request_digest,
        recordDigest: decline.decline_digest,
      });
    });

    it('rejects a stored row whose record no longer matches its digest', () => {
      const decline = sealedDecline();
      ingestDecline(decline);
      const row = repo.get(decline.decline_digest);
      if (row === null) throw new Error('expected the decline to be stored');

      // A validly-sealed but DIFFERENT decline under the original row's digest
      // key — the row-level cross-check must reject it (§5.B1: preserve the
      // stored-row recordDigest check, not just the JSON-level validation).
      const other = sealedDecline({ reason_code: 'policy' });
      const tampered = { ...row, recordJson: JSON.stringify(other) };
      expect(() => rehydrateDeclineDocument(tampered)).toThrow(DeclineLedgerIntegrityError);
    });

    it('answersTo returns declines for the request, empty for an unknown one', () => {
      const decline = sealedDecline();
      ingestDecline(decline);
      expect(repo.answersTo(decline.request_digest).map((r) => r.recordDigest)).toEqual([
        decline.decline_digest,
      ]);
      expect(repo.answersTo('0'.repeat(64))).toEqual([]);
    });
  });

  describe('authorQuoteDecline (§3.4 — the supplier side)', () => {
    it('authors an OUTBOUND decline the buyer then verifies inbound (cross-node round trip)', () => {
      const authored = authorQuoteDecline({
        request: retainedRequest,
        reasonCode: 'capacity',
        nodeDid: SUPPLIER,
        nowMs: T0,
        repository: repo,
      });
      expect(authored.ok).toBe(true);
      if (!authored.ok) return;

      const row = repo.get(authored.document.decline_digest);
      if (row === null) throw new Error('expected the authored decline to be stored');
      expect(row.direction).toBe('outbound');
      expect(rehydrateDeclineDocument(row)).toEqual(authored.document);

      // The buyer's inbound verifier accepts the supplier-authored decline.
      const buyerDeclines = new InMemoryDeclineDocumentRepository();
      expect(
        verifyInboundQuoteDecline({
          senderDid: SUPPLIER,
          selfDid: BUYER,
          decline: authored.document,
          repository: buyerDeclines,
          readRequest: (id) => (id === 'req-1' ? retainedRequest : null),
          evidenceJson: '{}',
          nowMs: T0,
        }).outcome,
      ).toBe('applied');
    });

    it('refuses to author for a request this node does not supply, and refuses a second decline', () => {
      expect(
        authorQuoteDecline({
          request: retainedRequest,
          reasonCode: 'capacity',
          nodeDid: BUYER, // not the request's supplier
          nowMs: T0,
          repository: repo,
        }).ok,
      ).toBe(false);

      const author = () =>
        authorQuoteDecline({
          request: retainedRequest,
          reasonCode: 'capacity',
          nodeDid: SUPPLIER,
          nowMs: T0,
          repository: repo,
        });
      expect(author().ok).toBe(true);
      const second = author();
      expect(!second.ok && second.refusal).toContain('already has a decline');
    });
  });
});

describe('v42 migration — declines carved into their own table', () => {
  it('an upgraded node keeps declines written before Cut 2 (copied to the new table)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-decline-migrate-'));
    const adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    try {
      // A node at the pre-Cut-2 schema: the shared table exists, the decline
      // table does not yet.
      applyMigrations(
        adapter,
        IDENTITY_MIGRATIONS.filter((m) => m.version < 42),
      );
      const decline = sealedDecline();
      adapter.run(
        `INSERT INTO commerce_trade_documents
           (record_digest, kind, counterparty_did, purchase_order_id,
            answers_digest, direction, record_json, evidence_json, created_at)
         VALUES (?, 'quote_decline', ?, '', ?, 'inbound', ?, '{}', ?)`,
        [decline.decline_digest, SUPPLIER, decline.request_digest, JSON.stringify(decline), T0],
      );

      // Upgrade: v42 creates the decline table and copies the row over.
      applyMigrations(adapter, IDENTITY_MIGRATIONS);

      const repo = new SQLiteDeclineDocumentRepository(adapter);
      const row = repo.get(decline.decline_digest);
      if (row === null) throw new Error('expected the pre-existing decline to be copied');
      expect(row.direction).toBe('inbound');
      expect(repo.answersTo(decline.request_digest).map((r) => r.recordDigest)).toEqual([
        decline.decline_digest,
      ]);
      // And it still rehydrates through the digest cross-check.
      expect(rehydrateDeclineDocument(row)).toEqual(decline);
    } finally {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
