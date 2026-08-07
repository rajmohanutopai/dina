/**
 * QuoteFamily aggregate (ARCH-0a). These tests pin the rules that used
 * to be scattered across the admission engine, the revision verifier and
 * the ledger — most importantly EPOCH MONOTONICITY, which closes the
 * expired-pre-backup-head revival that expiry-based voiding missed.
 */

import { verifyQuoteRevisionExtends } from '@dina/commerce-protocol';

import {
  CommerceIntegrityError,
  InMemoryCommerceQuoteLedgerRepository,
  QuoteFamilyStore,
} from '../../src/commerce';

import { SUPPLIER_DID, makeQuoteRequest, makeRevision, makeSignedQuote } from './helpers';

const T0 = Date.parse('2026-08-07T12:30:00.000Z');
const BUYER = 'did:plc:buyer1234';

function makeStore(epoch = '1') {
  const ledger = new InMemoryCommerceQuoteLedgerRepository();
  const clock = { now: T0, epoch };
  const store = new QuoteFamilyStore({
    ledger,
    currentEpoch: () => clock.epoch,
    supplierDid: () => SUPPLIER_DID,
    now: () => clock.now,
  });
  return { ledger, clock, store };
}

const request = makeQuoteRequest();

describe('QuoteFamily', () => {
  describe('epoch monotonicity (§16.2)', () => {
    it('freezes a pre-restore family even when it is EXPIRED', () => {
      // The exact hole expiry-based voiding left open: voidUnexpired only
      // touches heads with valid_until > now, so an expired pre-backup
      // family survived a restore and a later revision could extend it
      // back to life on top of the backup's stale use counters.
      const { store, clock } = makeStore('1');
      const quote = makeSignedQuote(request, { valid_until: '2026-08-08T09:00:00.000Z' });
      const registered = store.register(quote, BUYER);
      expect(registered.ok).toBe(true);

      // Time passes: the family expires. Then a restore raises the epoch.
      clock.now = Date.parse('2026-08-09T00:00:00.000Z');
      clock.epoch = '2';

      const family = store.load(quote.quote_id);
      if (family === null) throw new Error('family missing');

      // Every mutating path refuses, without a fifth ad-hoc check.
      const extension = makeRevision(quote, { valid_until: '2026-08-20T09:00:00.000Z' });
      expect(family.advance(extension, quote, verifyQuoteRevisionExtends)).toEqual({
        ok: false,
        refusal: 'stale_epoch',
      });
      expect(family.hold('po-1')).toEqual({ ok: false, refusal: 'stale_epoch' });
      expect(
        family.admits(
          { buyer_did: BUYER, quote_digest: quote.quote_digest },
          () => quote,
          '2026-08-09T00:00:00.000Z',
          false,
        ),
      ).toEqual({ ok: false, refusal: 'stale_epoch' });
    });

    it('refuses to be BORN carrying a FUTURE epoch', () => {
      // The hole the "not stale" test could not see. A candidate that
      // declares epoch 999 at live epoch 1 registers happily, and then
      // survives every later restore: isStale() asks whether the head is
      // BELOW the live epoch, and 999 never is. Its pre-restore use
      // counters come back with it.
      const { store } = makeStore('1');
      const quote = makeSignedQuote(request, { supplier_epoch: '999' });
      expect(store.register(quote, BUYER)).toEqual({ ok: false, refusal: 'future_epoch' });
    });

    it('refuses to be BORN from another supplier (§9.12)', () => {
      const { store } = makeStore('1');
      const quote = makeSignedQuote(request, { supplier_did: 'did:plc:othersupplier9' });
      expect(store.register(quote, BUYER)).toEqual({ ok: false, refusal: 'foreign_supplier' });
    });

    it('refuses a revision from another supplier, even one that extends cleanly', () => {
      const { store } = makeStore('1');
      const quote = makeSignedQuote(request);
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');
      const hijack = makeRevision(quote, { supplier_did: 'did:plc:othersupplier9' });
      const outcome = reg.value.advance(hijack, quote, verifyQuoteRevisionExtends);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.refusal).toBe('foreign_supplier');
    });

    it('refuses to be BORN already stale', () => {
      const { store, clock } = makeStore('2');
      clock.epoch = '2';
      const quote = makeSignedQuote(request, { supplier_epoch: '1' });
      expect(store.register(quote, BUYER)).toEqual({ ok: false, refusal: 'stale_epoch' });
    });

    it('allows normal operation within the current epoch', () => {
      const { store } = makeStore('1');
      const quote = makeSignedQuote(request);
      const registered = store.register(quote, BUYER);
      if (!registered.ok) throw new Error('register failed');
      expect(registered.value.hold('po-1')).toEqual({ ok: true, value: undefined });
    });
  });

  describe('revision progression (§9.8)', () => {
    it('advances the validity window WITH the head', () => {
      const { store } = makeStore();
      const quote = makeSignedQuote(request);
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');

      const extended = makeRevision(quote, { valid_until: '2026-08-20T09:00:00.000Z' });
      expect(reg.value.advance(extended, quote, verifyQuoteRevisionExtends)).toEqual({
        ok: true,
        value: undefined,
      });
      const after = store.load(quote.quote_id);
      expect(after?.headDigest).toBe(extended.quote_digest);
      // The DEADLINE must move too. Left at revision 1's value, restore
      // voiding judges an extended, still-live quote by a stale window —
      // it looks expired, escapes voiding, and can be revived.
      expect(after?.validUntil).toBe(Date.parse('2026-08-20T09:00:00.000Z'));
      expect(after?.validUntil).not.toBe(Date.parse(quote.valid_until));
    });

    it('refuses a revision that does not extend the retained head', () => {
      const { store } = makeStore();
      const quote = makeSignedQuote(request);
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');

      const fork = makeRevision(quote, { previous_quote_digest: 'a'.repeat(64) });
      expect(reg.value.advance(fork, quote, verifyQuoteRevisionExtends)).toEqual({
        ok: false,
        refusal: 'revision_rejected',
        detail: expect.stringMatching(/supplier fork/) as unknown as string,
      });
    });

    it('requires every revision to carry the LIVE epoch exactly', () => {
      // In-chain regression belongs to the protocol verifier, not to the
      // aggregate: the aggregate only knows about restore history. What
      // the aggregate must NOT do is swallow the verifier's sentence —
      // "revision_rejected" alone tells an operator nothing.
      const { store } = makeStore('2');
      const quote = makeSignedQuote(request, { supplier_epoch: '2' });
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');

      const regressed = makeRevision(quote, { supplier_epoch: '1' });
      expect(reg.value.advance(regressed, quote, verifyQuoteRevisionExtends)).toEqual({
        ok: false,
        refusal: 'stale_epoch',
      });
      // The dangerous direction: a FUTURE epoch outlives the next restore,
      // because staleness compares the head against the live epoch.
      const ahead = makeRevision(quote, { supplier_epoch: '999' });
      expect(reg.value.advance(ahead, quote, verifyQuoteRevisionExtends)).toEqual({
        ok: false,
        refusal: 'future_epoch',
      });
    });
  });

  describe('admission precedence (§9.8)', () => {
    it('reports an EXPIRED superseded revision as expired, not superseded', () => {
      // §9.8 conditions the supersession answer on the revision being
      // "superseded but UNEXPIRED". Deciding supersession first made the
      // reason code depend on branch order rather than on the quote.
      const { store, clock } = makeStore();
      const quote = makeSignedQuote(request, { valid_until: '2026-08-08T09:00:00.000Z' });
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');
      const next = makeRevision(quote, { valid_until: '2026-08-20T09:00:00.000Z' });
      expect(reg.value.advance(next, quote, verifyQuoteRevisionExtends).ok).toBe(true);

      clock.now = Date.parse('2026-08-09T00:00:00.000Z');
      const family = store.load(quote.quote_id);
      // The order names revision 1: superseded AND expired.
      expect(
        family?.admits(
          { buyer_did: BUYER, quote_digest: quote.quote_digest },
          () => quote,
          '2026-08-09T00:00:00.000Z',
          false,
        ),
      ).toEqual({ ok: false, refusal: 'quote_expired' });
    });
  });

  describe('capacity', () => {
    it('refuses a second hold for the same order while capacity remains', () => {
      const { store } = makeStore();
      const quote = makeSignedQuote(request, { max_uses: '3' });
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');
      expect(reg.value.hold('po-1').ok).toBe(true);
      expect(reg.value.hold('po-1')).toEqual({ ok: false, refusal: 'duplicate_use' });
      // Capacity was NOT consumed by the refusal.
      expect(reg.value.hold('po-2').ok).toBe(true);
    });

    it('refuses to reserve capacity on an expired family, without being asked', () => {
      // hold() does not depend on admits() having run first. An aggregate
      // whose rules only hold when the caller calls in the right order is
      // the discipline this refactor exists to remove.
      const { store, clock } = makeStore();
      const quote = makeSignedQuote(request, { valid_until: '2026-08-08T09:00:00.000Z' });
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');

      clock.now = Date.parse('2026-08-08T09:00:00.001Z');
      const fresh = store.load(quote.quote_id);
      expect(fresh?.hold('po-1')).toEqual({ ok: false, refusal: 'quote_expired' });
    });

    it('blames the duplicate, not capacity, when a single-use order retries', () => {
      // Capacity-first ordering told a caller retrying its OWN order that
      // the quote was consumed — by the caller's own hold.
      const { store } = makeStore();
      const quote = makeSignedQuote(request, { max_uses: '1' });
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');
      expect(reg.value.hold('po-1').ok).toBe(true);
      expect(reg.value.hold('po-1')).toEqual({ ok: false, refusal: 'duplicate_use' });
    });

    it('reports consumed capacity as a REFUSAL, not an error', () => {
      const { store } = makeStore();
      const quote = makeSignedQuote(request, { max_uses: '1' });
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');
      expect(reg.value.hold('po-1').ok).toBe(true);

      // Capacity belongs to the hold, not to admits: check-and-act in one
      // step, so there is no window between reading the count and taking
      // the unit.
      const family = store.load(quote.quote_id);
      // Business outcome -> becomes a wire reason_code. Never thrown.
      expect(family?.hold('po-2')).toEqual({ ok: false, refusal: 'quote_consumed' });
    });
  });

  describe('refusals versus corruption', () => {
    it('THROWS when a settlement CAS fails — impossible state, not an outcome', () => {
      const { store } = makeStore();
      const quote = makeSignedQuote(request);
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');

      // No hold was ever taken, so the CAS cannot succeed. Silently
      // continuing here is how an order gets decided while its capacity
      // stays held forever.
      expect(() => reg.value.settle('po-never-held', 'committed')).toThrow(CommerceIntegrityError);
    });

    it('returns typed refusals for every ordinary business outcome', () => {
      const { store } = makeStore();
      const quote = makeSignedQuote(request);
      const reg = store.register(quote, BUYER);
      if (!reg.ok) throw new Error('register failed');

      const expired = reg.value.admits(
        { buyer_did: BUYER, quote_digest: quote.quote_digest },
        () => quote,
        '2027-01-01T00:00:00.000Z',
        false,
      );
      expect(expired).toEqual({ ok: false, refusal: 'quote_expired' });

      const foreign = reg.value.admits(
        { buyer_did: 'did:plc:someoneelse', quote_digest: quote.quote_digest },
        () => quote,
        '2026-08-07T12:30:00.000Z',
        false,
      );
      // Non-disclosing: a foreign buyer sees the same shape as unknown.
      expect(foreign).toEqual({ ok: false, refusal: 'quote_unknown' });

      const superseded = reg.value.admits(
        { buyer_did: BUYER, quote_digest: 'f'.repeat(64) },
        () => quote,
        '2026-08-07T12:30:00.000Z',
        false,
      );
      expect(superseded).toEqual({ ok: false, refusal: 'quote_superseded' });

      // A head the receipt store cannot produce is unknown, not a crash:
      // admits returns the record it judged, so the caller can never
      // price a different one than the one it validated.
      const missing = reg.value.admits(
        { buyer_did: BUYER, quote_digest: quote.quote_digest },
        () => null,
        '2026-08-07T12:30:00.000Z',
        false,
      );
      expect(missing).toEqual({ ok: false, refusal: 'quote_unknown' });

      const accepted = reg.value.admits(
        { buyer_did: BUYER, quote_digest: quote.quote_digest },
        () => quote,
        '2026-08-07T12:30:00.000Z',
        false,
      );
      expect(accepted).toEqual({ ok: true, value: quote });
    });
  });
});
