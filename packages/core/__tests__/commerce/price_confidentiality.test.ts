/**
 * §14.2 price confidentiality, and what it does NOT promise (WS-6.5).
 *
 * The row's open clause said "the §14.2 surface is only as strong as 0.4", and
 * 0.4 — audience binding as a required argument — shipped. That makes the
 * clause stale, but a stale clause is not evidence: it says the dependency
 * landed, not that the surface holds. So this drives both halves of §14.2.
 *
 * CLAIM ONE — customer-specific pricing is a PRIVATE D2D record. A signed
 * quote is bound to one buyer and cannot be used by another (0.4), and nothing
 * customer-specific reaches the public catalog: the publication gate carries a
 * CLOSED public vocabulary, so a per-customer price column is refused because
 * the gate does not know what it is, not because it recognised it.
 *
 * CLAIM TWO is the one that rots, because it is a claim about COPY. §14.2:
 * "A private quote is confidential, not anonymous. The supplier necessarily
 * sees the authenticated buyer DID… The UI and consent copy must not imply
 * that D2D signing hides the requester." Nothing enforces prose, so this file
 * enforces it: every owner-facing string the commerce surface ships is checked
 * for a promise of anonymity. A sentence like "your identity is hidden from
 * the supplier" would be false, and false in the direction that gets somebody
 * to disclose a purchasing pattern they would have kept to themselves.
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { describeOrderForOwner, newBuyerOrder } from '../../src/commerce/buyer_reconciliation';
import { gateCatalogForPublication } from '../../src/commerce/catalog_leakage';
import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';

import type { Sha256Fn } from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);
const SUPPLIER = 'did:plc:chairmaker99';

describe('claim one: customer-specific pricing never reaches the public catalog', () => {
  /**
   * Field names a supplier might reasonably choose for a per-customer price.
   * Each is refused for the SAME reason — it is not in the public vocabulary —
   * which is the property worth having: the gate does not need to have thought
   * of the name.
   */
  it.each([
    ['customer_price', { customer_price: '4200' }],
    ['contract_price', { contract_price: '4200' }],
    ['negotiated_rate', { negotiated_rate: '0.82' }],
    ['discount_tier', { discount_tier: 'gold' }],
    ['credit_terms', { credit_terms: 'net-60' }],
    ['a per-buyer map', { prices_by_buyer: { 'did:plc:sancho42': '4200' } }],
  ])('refuses %s', (_name, extra) => {
    const verdict = gateCatalogForPublication([
      { product: { scheme: 'gtin', value: '05012345678900' }, name: 'Oak chair', ...extra },
    ]);
    expect(verdict.clean).toBe(false);
    expect(verdict.findings.length).toBeGreaterThan(0);
  });

  it('names the FIELD and never echoes its value', () => {
    // Reporting a leak by repeating it turns one leak into two — the verdict
    // travels into logs and owner surfaces.
    const secret = 'sk-live-0123456789abcdef';
    const verdict = gateCatalogForPublication([
      { product: { scheme: 'gtin', value: '05012345678900' }, name: 'Oak chair', api_key: secret },
    ]);
    expect(verdict.clean).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain(secret);
  });

  it('still publishes an honest LIST price, because that is advertising', () => {
    // §14.2 protects customer-SPECIFIC pricing. A published list price is the
    // supplier's own choice and is what lets a buyer decide whether to ask for
    // a quote at all; refusing it would make the gate useless rather than
    // careful.
    const built = buildCatalogSnapshot({
      supplierDid: SUPPLIER,
      catalogId: 'chairmaker-main',
      protocolVersion: '1.0',
      publishedAt: '2026-08-09T09:00:00.000Z',
      items: [
        {
          product: { scheme: 'gtin', value: '05012345678900' },
          name: 'Oak chair',
          list_price: '5000',
          currency: 'INR',
        },
      ],
      previous: null,
      sha256: hash,
    });
    expect(built.ok).toBe(true);
  });

  it('refuses the whole publication, not the offending item', () => {
    // A snapshot is content-addressed and published: it does not un-publish.
    // Dropping the bad item and shipping the rest would publish a catalog the
    // supplier never reviewed.
    const built = buildCatalogSnapshot({
      supplierDid: SUPPLIER,
      catalogId: 'chairmaker-main',
      protocolVersion: '1.0',
      publishedAt: '2026-08-09T09:00:00.000Z',
      items: [
        { product: { scheme: 'gtin', value: '05012345678900' }, name: 'Oak chair' },
        { product: { scheme: 'gtin', value: '05012345678917' }, internal_cost: '3100' },
      ],
      previous: null,
      sha256: hash,
    });
    expect(built).toMatchObject({ ok: false, refusal: 'leakage_refused' });
  });
});

/**
 * CLAIM TWO. §14.2 is explicit that confidentiality is not anonymity, and that
 * the copy must not imply otherwise. Prose has no compiler, so this is the
 * compiler.
 *
 * Scanned rather than listed: a test naming today's strings would pass for ever
 * while a new screen shipped the sentence §14.2 forbids.
 */
describe('claim two: nothing we ship promises the supplier cannot see who asked', () => {
  const COMMERCE_SRC = path.join(__dirname, '..', '..', 'src', 'commerce');

  /**
   * Phrases that would make §14.2's own warning false. Matched on the RENDERED
   * text of owner-facing strings, not on code — a variable called
   * `anonymousQuote` is a naming choice; a card that says "anonymous" is a
   * promise.
   */
  const FORBIDDEN = [
    /\banonymous(ly)?\b/i,
    /\banonymised?\b/i,
    /\banonymized?\b/i,
    /identity is hidden/i,
    /hides your identity/i,
    /without revealing (who|your)/i,
    /they (will not|won'?t) know who/i,
  ];

  /** Every string literal in a file, which is where owner-facing copy lives. */
  function stringLiterals(source: string): string[] {
    const out: string[] = [];
    for (const match of source.matchAll(/'([^'\\\n]{8,})'|"([^"\\\n]{8,})"|`([^`\\]{8,})`/g)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  it('no commerce source ships a phrase that promises anonymity', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(COMMERCE_SRC)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(COMMERCE_SRC, file), 'utf8');
      for (const literal of stringLiterals(source)) {
        // Comments are excluded by construction — this reads literals only, so
        // a doc-comment DISCUSSING anonymity (as §14.2 itself must) is not a
        // promise the product makes.
        if (FORBIDDEN.some((pattern) => pattern.test(literal))) {
          offenders.push(`${file}: ${literal.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the owner-facing order card says nothing about who can see the request', () => {
    // The card an owner actually reads. It describes what THIS node knows
    // about the order; claiming anything about the supplier's visibility would
    // be a claim §14.2 says we must not make.
    const view = describeOrderForOwner({
      ...newBuyerOrder('po-1', {
        orderDigest: 'a'.repeat(64),
        idempotencyKey: 'idem-1',
        protocolVersion: '1.0',
        serviceRkey: 'self',
        quoteDigest: 'b'.repeat(64),
        quoteId: 'q-1',
        buyerDid: 'did:plc:sancho42',
        supplierDid: 'did:plc:chairmaker99',
      }),
      state: 'outcome_unknown',
      nextPollAtMs: 1,
      pollCount: 1,
    });
    const rendered = `${view.headline} ${view.detail ?? ''}`;
    for (const pattern of FORBIDDEN) expect(rendered).not.toMatch(pattern);
  });
});
