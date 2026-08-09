/**
 * §9.8 / §25.3 — the BUYER's half of quote-revision fork detection.
 *
 * §25.3 asks for "quote revision chains reject forks and unchained revisions
 * (supplier-side CAS at signing; buyer-side detection)". Only the first half
 * existed: `verifyQuoteRevisionExtends` ran exclusively inside supplier
 * admission, where the party running the check is the party being checked. A
 * buyer had nothing to compare an arriving revision against.
 *
 * So a supplier could hand one buyer revision 3 of a quote and another buyer a
 * different revision 3, or open a chain at revision 4 and be believed about
 * three revisions the buyer never saw — re-pricing dressed as a revision.
 *
 * Every fixture comes from the shared builders, so the digests and the terms
 * digest are the protocol's own. A hand-built quote fails `readSignedQuote`
 * and every case returns `unreadable` — green about nothing.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SQLiteBuyerQuoteRepository,
  verifyInboundQuote,
  type BuyerQuoteIngest,
} from '../../src/commerce/buyer_quotes';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { BUYER_DID, SUPPLIER_DID, makeQuoteRequest, makeRevision, makeSignedQuote } from './helpers';

import type { SignedQuote } from '@dina/commerce-protocol';

const PASSHEX = randomBytes(32).toString('hex');
const NOW = Date.parse('2026-08-01T10:00:00.000Z');

let dir: string;
let adapter: NodeSQLiteAdapter;
let repository: SQLiteBuyerQuoteRepository;
let quote: SignedQuote;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-buyerquote-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  repository = new SQLiteBuyerQuoteRepository(adapter);
  quote = makeSignedQuote(makeQuoteRequest());
});

afterEach(() => {
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function ingest(candidate: unknown, over: { supplierDid?: string; buyerDid?: string } = {}): BuyerQuoteIngest {
  return verifyInboundQuote({
    supplierDid: over.supplierDid ?? SUPPLIER_DID,
    buyerDid: over.buyerDid ?? BUYER_DID,
    quote: candidate,
    repository,
    nowMs: NOW,
  });
}

describe('opening a chain (§9.8)', () => {
  it('accepts revision 1 and records it', () => {
    // ONE, not zero. A status chain's genesis is sequence "0" and a quote
    // chain's first revision is "1"; assuming one convention covered both was
    // the first thing this suite corrected.
    expect(ingest(quote)).toEqual({ outcome: 'applied', revision: '1' });
    expect(repository.chain(SUPPLIER_DID, quote.quote_id)).toHaveLength(1);
  });

  it('REFUSES a chain that opens above revision 1', () => {
    // The re-pricing case. A supplier handing a buyer revision 4 out of
    // nowhere is asking to be believed about three revisions that buyer has
    // never seen, and every one of them could have carried a different price.
    const later = makeRevision(quote);
    const result = ingest(later);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/first revision seen is 2, expected 1/);
    expect(repository.chain(SUPPLIER_DID, quote.quote_id)).toHaveLength(0);
  });

  it('refuses an unreadable document rather than storing it', () => {
    expect(ingest({ quote_id: 'q-1', quote_revision: '1' }).outcome).toBe('unreadable');
    expect(ingest(null).outcome).toBe('unreadable');
  });
});

describe('audience binding — the quote must be addressed to THIS node (§9.8)', () => {
  it('refuses a quote signed by a supplier that is not the sender', () => {
    const result = ingest(quote, { supplierDid: 'did:plc:impostor' });
    expect(result.outcome).toBe('not_our_quote');
    expect(result.detail).toMatch(/authenticated sender/);
  });

  it('refuses a quote addressed to a different buyer', () => {
    // §9.8's whole point. A supplier relaying somebody else's quote — or a
    // peer replaying one it intercepted — must not have it recorded as an
    // offer this node received.
    const result = ingest(quote, { buyerDid: 'did:plc:somebodyelse' });
    expect(result.outcome).toBe('not_our_quote');
    expect(result.detail).toMatch(/not this node/);
    expect(repository.chain(SUPPLIER_DID, quote.quote_id)).toHaveLength(0);
  });

  it('checks binding BEFORE the chain, so another buyer’s quote is not a fork', () => {
    expect(ingest(quote).outcome).toBe('applied');
    // Reporting this as a fork would accuse this supplier of contradicting a
    // chain it never addressed to us.
    expect(ingest(makeRevision(quote), { buyerDid: 'did:plc:somebodyelse' }).outcome).toBe(
      'not_our_quote',
    );
  });
});

describe('revisions (§9.8)', () => {
  beforeEach(() => {
    expect(ingest(quote).outcome).toBe('applied');
  });

  it('accepts a revision that extends the head', () => {
    const next = makeRevision(quote);
    expect(ingest(next)).toEqual({ outcome: 'applied', revision: '2' });
    expect(repository.chain(SUPPLIER_DID, quote.quote_id).map((q) => q.quote_revision)).toEqual([
      '1',
      '2',
    ]);
  });

  it('is idempotent: the same revision twice is a duplicate, not a fork', () => {
    const next = makeRevision(quote);
    expect(ingest(next).outcome).toBe('applied');
    expect(ingest(next)).toEqual({ outcome: 'duplicate', revision: '2' });
    expect(repository.chain(SUPPLIER_DID, quote.quote_id)).toHaveLength(2);
  });

  it('DETECTS A FORK: a second, different revision of one head', () => {
    // The case supplier-side CAS is supposed to prevent, arriving from a
    // supplier that did not run one — two buyers told two different prices
    // under one revision number.
    expect(ingest(makeRevision(quote)).outcome).toBe('applied');
    const rival = makeRevision(quote, { valid_until: '2026-09-09T09:00:00.000Z' });
    const result = ingest(rival);
    expect(result.outcome).toBe('fork');
    // The head did NOT move.
    expect(repository.chain(SUPPLIER_DID, quote.quote_id)).toHaveLength(2);
  });

  it('refuses a revision that does not name the head', () => {
    const orphan = makeRevision(quote, { previous_quote_digest: 'c'.repeat(64) });
    const result = ingest(orphan);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/does not extend the held head/);
  });

  it('refuses a revision-number jump', () => {
    const jumped = makeRevision(quote, { quote_revision: '7' });
    const result = ingest(jumped);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/expected revision 2, got 7/);
  });

  it('refuses a revision that changed max_uses', () => {
    // §9.8: capacity is immutable within a quote_id. Changing it mid-chain
    // would let a supplier quietly expand or shrink what a held quote can buy.
    const widened = makeRevision(quote, { max_uses: '9' });
    const result = ingest(widened);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/max_uses is immutable/);
  });

  it('refuses a revision whose supplier_epoch regressed — a stale pre-restore signer', () => {
    // Its own chain, opened at a HIGHER epoch. Epoch '0' is not a canonical
    // positive integer, so a regression to zero is refused structurally and
    // proves nothing about §16.2 — the same trap the status chain sprang.
    const raised = makeSignedQuote(makeQuoteRequest({ request_id: 'req-epoch' }), {
      quote_id: 'q-epoch',
      supplier_epoch: '5',
    });
    expect(ingest(raised).outcome).toBe('applied');
    const stale = makeRevision(raised, { supplier_epoch: '4' });
    const result = ingest(stale);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/supplier_epoch regressed/);
  });

  it('refuses a revision that re-pointed the quote at another request', () => {
    const rewritten = makeRevision(quote, { request_id: 'req-somewhere-else' });
    const result = ingest(rewritten);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/immutable field request_id changed/);
  });
});

describe('what the store refuses to hand back', () => {
  it('throws rather than returning a row that no longer matches its record', () => {
    expect(ingest(quote).outcome).toBe('applied');
    // The chain is the yardstick the next revision is measured against, and
    // the row is editable by anything with the database open.
    adapter.run(`UPDATE commerce_buyer_quotes SET record_json = ? WHERE quote_id = ?`, [
      JSON.stringify({ ...quote, quote_revision: '9' }),
      quote.quote_id,
    ]);
    expect(() => repository.chain(SUPPLIER_DID, quote.quote_id)).toThrow(/stored quote/);
  });
});
