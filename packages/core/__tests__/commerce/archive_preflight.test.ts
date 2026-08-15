/**
 * WS-4.2 — commerce archive preflight (§16.2 fail-closed reconstruction).
 *
 * The restore fence already answers the counter question. This is the OTHER
 * half: an archive can be perfectly consistent about capacity and still
 * describe a node that cannot answer for its own orders — orders whose quotes
 * are absent, chains whose head receipts were never carried.
 *
 * Those failures are silent at import and loud months later, when a
 * counterparty reconciles against evidence this node no longer holds. So the
 * tests are written from that end: for each cross-reference, what does the
 * node become if it imports anyway.
 */

import {
  describePreflightRefusal,
  preflightCommerceArchive,
  REQUIRED_COMMERCE_TABLES,
  type CommerceArchiveTables,
} from '../../src/commerce/archive_preflight';

import { commerceRecordDigest, type Sha256Fn } from '@dina/commerce-protocol';
import { sha256 } from '@noble/hashes/sha2.js';

const hash: Sha256Fn = (data) => sha256(data);

const BUYER = 'did:plc:buyer';

/**
 * A REAL receipt: a record, and the digest that record actually produces.
 *
 * The fixture used to file an invented digest under the domain
 * `order_status`, which is not in the vocabulary at all — so it described a
 * receipt no node could ever have written, and the suite validated an archive
 * shape production never emits. Receipts are what every cross-table check is
 * measured against, so a fake one made every other assertion in this file
 * agree with a lie.
 */
function receipt(domain: 'status' | 'order', record: Record<string, unknown>) {
  const digestField = domain === 'status' ? 'status_digest' : 'order_digest';
  const full = { ...record, [digestField]: '' };
  const digest = commerceRecordDigest(domain, full, hash);
  return {
    record_digest: digest,
    domain,
    record_json: JSON.stringify({ ...record, [digestField]: digest }),
  };
}

const STATUS_RECEIPT = receipt('status', { purchase_order_id: 'po-1', state: 'accepted' });
const ORDER_RECEIPT = receipt('order', { purchase_order_id: 'po-1', buyer_did: BUYER });
const DIGEST_A = STATUS_RECEIPT.record_digest;
const DIGEST_B = ORDER_RECEIPT.record_digest;
/**
 * Well-formed hex64 that names no receipt in the archive. The whole point of
 * checking against the receipt SET rather than against a regex is that this
 * value passes every shape test.
 */
const ABSENT_DIGEST = 'f'.repeat(64);
/** The proposal the §16.2 ceremony recovered for a re-adopted order. */
const RECOVERED_ORDER_RECEIPT = receipt('order', {
  purchase_order_id: 'po-recovered',
  buyer_did: BUYER,
});

/** The retained proposal of an order this node refused. */
const REFUSED_ORDER_RECEIPT = receipt('order', {
  purchase_order_id: 'po-refused',
  buyer_did: BUYER,
});

/** A small archive that is internally coherent — the baseline every case bends. */
function coherent(): CommerceArchiveTables {
  return {
    commerce_receipts: [STATUS_RECEIPT, ORDER_RECEIPT],
    commerce_order_refs: [
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-1',
        quote_id: 'q-1',
        order_digest: DIGEST_B,
      },
    ],
    commerce_quote_heads: [{ quote_id: 'q-1', head_digest: DIGEST_B }],
    commerce_quote_uses: [{ quote_id: 'q-1', purchase_order_id: 'po-1' }],
    commerce_status_heads: [{ buyer_did: BUYER, purchase_order_id: 'po-1', head_digest: DIGEST_A }],
    commerce_epoch_watermarks: [{ supplier_did: 'did:plc:supplier', epoch: '3' }],
  };
}

/** Every table present and empty — a node that had commerce and no orders. */
function empty(): CommerceArchiveTables {
  return Object.fromEntries(REQUIRED_COMMERCE_TABLES.map((t) => [t, []]));
}

describe('a coherent archive passes', () => {
  it('accepts a complete, internally consistent commerce set', () => {
    const verdict = preflightCommerceArchive(coherent());
    expect(verdict).toEqual({ ok: true, findings: [], predatesCommerce: false });
  });

  it('accepts every table present and empty', () => {
    // "This node had commerce and no orders" is a real state, and the check
    // must not confuse having nothing with carrying nothing.
    const verdict = preflightCommerceArchive(empty());
    expect(verdict.ok).toBe(true);
    expect(verdict.predatesCommerce).toBe(false);
  });
});

describe('all six tables or none', () => {
  /**
   * The compatibility case, and the reason this is not a plain required-table
   * check. The shipped app predates commerce and its backups will be restored
   * for years; refusing them would be a data-loss bug wearing an integrity
   * check's clothes.
   */
  it('accepts an archive that predates commerce entirely', () => {
    const verdict = preflightCommerceArchive({});
    expect(verdict.ok).toBe(true);
    expect(verdict.predatesCommerce).toBe(true);
  });

  it('refuses a TORN set — some commerce tables but not all', () => {
    // Every archive this code produces writes all six, empty arrays included.
    // A partial set means something else assembled it, and the tables that
    // survived are exactly the ones the missing ones would have vouched for.
    const torn = coherent();
    delete torn.commerce_quote_heads;
    const verdict = preflightCommerceArchive(torn);
    expect(verdict.ok).toBe(false);
    expect(verdict.predatesCommerce).toBe(false);
    expect(verdict.findings.some((f) => f.refusal === 'missing_table')).toBe(true);
  });

  it('names the missing table, and does not go on to report its dangling children', () => {
    // A torn set produces cascading nonsense — every order would look like it
    // referenced a missing quote. Reporting "your quote table is absent" once
    // is the finding; the cascade is noise that hides it.
    const torn = coherent();
    delete torn.commerce_quote_heads;
    const verdict = preflightCommerceArchive(torn);
    expect(verdict.findings).toEqual([
      expect.objectContaining({ refusal: 'missing_table', table: 'commerce_quote_heads' }),
    ]);
  });

  it.each(REQUIRED_COMMERCE_TABLES)('refuses when %s alone is absent', (absent) => {
    // Built by omission rather than by deleting a key, so the case really is
    // "this table was never in the archive" and not "it is present and
    // undefined" — which is the shape a `delete` on a typed object leaves and
    // a different thing for `Array.isArray` to be asked about.
    const full = coherent();
    const torn = Object.fromEntries(
      Object.entries(full).filter(([table]) => table !== absent),
    ) as CommerceArchiveTables;
    expect(preflightCommerceArchive(torn).ok).toBe(false);
  });
});

describe('cross-table references must resolve', () => {
  /**
   * The order references a quote the archive does not carry. §16.2 re-derives
   * capacity from orders rather than adopting the counters — with the quote
   * gone there is nothing to re-derive against, so the restored node holds an
   * order it can neither price nor charge against any quote's capacity.
   */
  it('refuses an order whose quote is missing', () => {
    const tables = coherent();
    tables.commerce_quote_heads = [];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({
        refusal: 'dangling_quote_reference',
        table: 'commerce_order_refs',
        key: `${BUYER}:po-1`,
      }),
    );
  });

  it('refuses a use counter whose quote is missing', () => {
    // A use against a quote nobody has is capacity spent against nothing. It
    // can never be reconciled and never released.
    const tables = coherent();
    tables.commerce_quote_uses = [{ quote_id: 'q-gone', purchase_order_id: 'po-1' }];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({
        refusal: 'dangling_quote_reference',
        table: 'commerce_quote_uses',
      }),
    );
  });

  /**
   * §9.11 line checks read the ORDER's accepted lines. A chain without its
   * order can never legally advance again — it is frozen at import, and the
   * freeze looks exactly like a supplier who stopped reporting.
   */
  it('refuses a status chain whose order is missing', () => {
    const tables = coherent();
    tables.commerce_order_refs = [];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({
        refusal: 'dangling_order_reference',
        table: 'commerce_status_heads',
      }),
    );
  });

  /**
   * `loadHeadStatus` fails closed when the head record is unreadable, so a
   * chain whose head receipt is absent is frozen from the moment it is
   * restored — every future signing attempt refuses.
   */
  it('refuses a chain head naming a receipt the archive does not carry', () => {
    const tables = coherent();
    tables.commerce_receipts = [];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({
        refusal: 'dangling_receipt_reference',
        table: 'commerce_status_heads',
      }),
    );
  });

  /**
   * THE SAME RULE, FOR THE OTHER TWO LINKS. The chain head was the only
   * digest→receipt link the preflight checked. `order_digest` was checked for
   * hex64 and nothing more, and `commerce_quote_heads.head_digest` was declared
   * on the row type and then discarded entirely — so an archive naming receipts
   * it does not carry passed, and the failure surfaced later as
   * `decideOrderInTx` refusing every admission with "order receipt missing".
   *
   * A well-formed digest naming nothing is the case that matters: shape checks
   * pass it, and only set membership catches it.
   */
  it('refuses an order naming a receipt the archive does not carry', () => {
    const tables = coherent();
    tables.commerce_order_refs = [
      { buyer_did: BUYER, purchase_order_id: 'po-1', quote_id: 'q-1', order_digest: ABSENT_DIGEST },
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({
        refusal: 'dangling_receipt_reference',
        table: 'commerce_order_refs',
      }),
    );
  });

  it('refuses a quote head naming a receipt the archive does not carry', () => {
    const tables = coherent();
    tables.commerce_quote_heads = [{ quote_id: 'q-1', head_digest: ABSENT_DIGEST }];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({
        refusal: 'dangling_receipt_reference',
        table: 'commerce_quote_heads',
      }),
    );
  });

  it('matches the head against the RECEIPT set, not merely against hex', () => {
    // A well-formed digest that names nothing is the interesting case: shape
    // checks pass it, and only set membership catches it.
    const tables = coherent();
    tables.commerce_status_heads = [
      { buyer_did: BUYER, purchase_order_id: 'po-1', head_digest: 'c'.repeat(64) },
    ];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });
});

describe('row shapes', () => {
  it('refuses a receipt digest that is not hex64', () => {
    const tables = coherent();
    tables.commerce_receipts = [{ record_digest: 'not-a-digest' }];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ refusal: 'bad_row_shape', table: 'commerce_receipts' }),
    );
  });

  it('refuses an UPPERCASE digest AS A SHAPE ERROR', () => {
    // Digests are compared as strings across every commerce table, so a
    // case-variant one matches nothing while looking correct to a reader.
    //
    // The refusal KIND is the assertion, not merely `ok === false`. A
    // case-insensitive check would still fail this archive — the head's
    // lowercase digest would stop matching the uppercased receipt — but it
    // would report a dangling reference, sending an operator hunting for a
    // record that is right there. Naming the case rule is the finding.
    const tables = coherent();
    tables.commerce_receipts = [{ record_digest: DIGEST_A.toUpperCase() }];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ refusal: 'bad_row_shape', table: 'commerce_receipts' }),
    );
  });

  it('refuses an order missing its identity columns', () => {
    const tables = coherent();
    tables.commerce_order_refs = [{ quote_id: 'q-1', order_digest: DIGEST_B }];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings[0]?.refusal).toBe('bad_row_shape');
  });

  it.each([
    ['buyer_did', { purchase_order_id: 'po-9', head_digest: DIGEST_A }],
    ['purchase_order_id', { buyer_did: BUYER, head_digest: DIGEST_A }],
  ])('refuses a status head missing %s', (_column, row) => {
    const tables = coherent();
    tables.commerce_status_heads = [row];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });

  it('refuses an order digest that is not hex64', () => {
    const tables = coherent();
    tables.commerce_order_refs = [
      { buyer_did: BUYER, purchase_order_id: 'po-1', quote_id: 'q-1', order_digest: 'x' },
    ];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });

  it('refuses a watermark with no supplier or no epoch', () => {
    const tables = coherent();
    tables.commerce_epoch_watermarks = [{ supplier_did: 'did:plc:s' }];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });

  /**
   * The column name is `supplier_did`. An earlier draft of this checker read
   * `counterparty_did` — the name the SPEC uses for the concept — and would
   * have refused every real archive carrying a watermark. Nothing caught it,
   * because these fixtures were hand-built and agreed with the module on the
   * wrong name. Naming the schema in an assertion is the cheap half of the
   * fix; the real half is the export/import test that now seeds a watermark.
   */
  it('reads the SCHEMA’s column name, not the spec’s word for the concept', () => {
    const tables = coherent();
    tables.commerce_epoch_watermarks = [{ counterparty_did: 'did:plc:s', epoch: '3' } as never];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });

  it('ignores columns it does not read', () => {
    // The check owns referential integrity, not the schema. An extra column is
    // caught by restoreTable, which fails closed on any non-schema name.
    const tables = coherent();
    // An extra column on a receipt that is otherwise REAL. The old fixture
    // used an invented digest under a domain outside the vocabulary, so it
    // asserted "extra columns are ignored" against a row that would now be
    // refused for a different and correct reason — the assertion would have
    // gone on passing for the wrong one.
    tables.commerce_receipts = [
      { ...STATUS_RECEIPT, something_else: 1 } as never,
      ORDER_RECEIPT,
    ];
    expect(preflightCommerceArchive(tables).ok).toBe(true);
  });
});

describe('forged receipts (§16.2 — the archive is attacker-influenced)', () => {
  // WHY THIS MATTERS MORE THAN THE STRUCTURAL CHECKS. Everything else here
  // asks whether the archive agrees with ITSELF, and a self-authored archive
  // agrees with itself perfectly. Receipts are the yardstick every other
  // table is measured against, so a forged receipt is not one bad row — it
  // is a corrupted measure that makes all the other checks pass.

  it('refuses a record that does not hash to the digest it is filed under', () => {
    const tables = coherent();
    tables.commerce_receipts = [
      // The digest of a real status receipt, over a record claiming a
      // DIFFERENT state. Structurally flawless; cryptographically a lie.
      {
        ...STATUS_RECEIPT,
        record_json: JSON.stringify({
          purchase_order_id: 'po-1',
          state: 'delivered',
          status_digest: STATUS_RECEIPT.record_digest,
        }),
      },
      ORDER_RECEIPT,
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ refusal: 'forged_receipt', table: 'commerce_receipts' }),
    );
  });

  it('refuses a receipt filed under a domain with no digest rule', () => {
    // Cannot-derive is a refusal. Admitting it would make "verified" mean
    // "verified, or filed under a domain someone invented".
    const tables = coherent();
    tables.commerce_receipts = [
      { ...STATUS_RECEIPT, domain: 'order_status' },
      ORDER_RECEIPT,
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ refusal: 'forged_receipt' }),
    );
  });

  it('refuses a receipt carrying no record at all', () => {
    const tables = coherent();
    tables.commerce_receipts = [
      { record_digest: STATUS_RECEIPT.record_digest, domain: 'status' },
      ORDER_RECEIPT,
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ refusal: 'forged_receipt' }),
    );
  });

  it('refuses a record_json that is not JSON', () => {
    const tables = coherent();
    tables.commerce_receipts = [{ ...STATUS_RECEIPT, record_json: 'not json' }, ORDER_RECEIPT];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });

  it('a forged receipt stops counting as a receipt, so what named it now dangles', () => {
    // The consequence worth pinning. A forged row is not merely reported —
    // it is EXCLUDED from the set every cross-reference resolves against, so
    // the status head that named it is reported dangling too.
    //
    // I first wrote this expecting the opposite: that the tampered receipt
    // keeps its digest and therefore still satisfies its referrers, leaving
    // the forgery as the only finding. The code is right and the expectation
    // was wrong. Admitting a forged row as a valid reference target would
    // make the structural checks pass against a record nobody signed, which
    // is precisely the yardstick problem this check exists to remove.
    const tables = coherent();
    tables.commerce_receipts = [
      {
        ...STATUS_RECEIPT,
        record_json: JSON.stringify({
          purchase_order_id: 'po-1',
          state: 'cancelled',
          status_digest: STATUS_RECEIPT.record_digest,
        }),
      },
      ORDER_RECEIPT,
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings.map((f) => f.refusal)).toEqual([
      'forged_receipt',
      'dangling_receipt_reference',
    ]);
  });
});

describe('duplicate keys', () => {
  it('refuses the same order twice', () => {
    const tables = coherent();
    tables.commerce_order_refs = [
      ...(tables.commerce_order_refs ?? []),
      ...(tables.commerce_order_refs ?? []),
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ refusal: 'duplicate_key', table: 'commerce_order_refs' }),
    );
  });

  it('refuses the same quote id twice', () => {
    // Two heads for one quote id means the restore's INSERT OR REPLACE picks a
    // winner by row order — capacity would depend on archive ordering.
    const tables = coherent();
    tables.commerce_quote_heads = [
      { quote_id: 'q-1', head_digest: DIGEST_A },
      { quote_id: 'q-1', head_digest: DIGEST_B },
    ];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });

  it('refuses the same receipt digest twice', () => {
    const tables = coherent();
    tables.commerce_receipts = [{ record_digest: DIGEST_A }, { record_digest: DIGEST_A }];
    expect(preflightCommerceArchive(tables).ok).toBe(false);
  });
});

describe('the report', () => {
  it('returns EVERY finding, not the first', () => {
    // An operator deciding whether to restore needs the shape of the damage,
    // not its earliest symptom.
    const tables = coherent();
    tables.commerce_quote_heads = [];
    tables.commerce_receipts = [];
    const verdict = preflightCommerceArchive(tables);
    const kinds = new Set(verdict.findings.map((f) => f.refusal));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('never reproduces a row’s contents', () => {
    // An archive is somebody's ledger. A restore failure is not a reason to
    // print it — the findings name tables and keys, never values.
    const tables = coherent();
    tables.commerce_order_refs = [
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-1',
        quote_id: 'q-gone',
        order_digest: DIGEST_B,
        secret_margin: 'do-not-print',
      } as never,
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(JSON.stringify(verdict)).not.toContain('do-not-print');
  });

  it('summarises refusals by kind and count', () => {
    const tables = coherent();
    tables.commerce_quote_heads = [];
    const line = describePreflightRefusal(preflightCommerceArchive(tables));
    expect(line).toContain('dangling_quote_reference');
    expect(line).toContain('×');
  });

  it('does not put a buyer DID in the summary line', () => {
    // The summary is the string that reaches a thrown Error, and errors reach
    // logs. Keys stay in the structured findings.
    const tables = coherent();
    tables.commerce_quote_heads = [];
    expect(describePreflightRefusal(preflightCommerceArchive(tables))).not.toContain(BUYER);
  });
});

/**
 * THE TWO REFERENCES THAT CANNOT SATISFY THE CROSS-CHECKS, EVER.
 *
 * Both checks below started as "an order names a quote / a receipt this
 * archive does not contain", stated as if every order reference could always
 * satisfy them. Two cannot, and both are produced by ordinary operation:
 *
 *   - a REFUSED order, when the refusal reason WAS that this node had no such
 *     quote. Any peer can provoke it by proposing against a quote_id this node
 *     never issued.
 *   - a RE-ADOPTED order (§12.7), rebuilt from a buyer's held evidence. This
 *     node never received the order document and never knew its quote.
 *
 * `importArchive` throws on any finding, so requiring the impossible of them
 * turned one refused order into a `.dina` backup that could never be restored
 * — a remotely triggerable, permanent loss of the owner's backup, produced by
 * the check that exists to PREVENT loss.
 */
describe('references a node cannot fully describe', () => {
  const REFUSAL_JSON = JSON.stringify({
    kind: 'rejected',
    reason_code: 'quote_unknown',
    purchase_order_id: 'po-refused',
  });

  it('accepts a REFUSED order whose quote this node never had', () => {
    const tables = coherent();
    tables.commerce_receipts = [...tables.commerce_receipts!, REFUSED_ORDER_RECEIPT];
    tables.commerce_order_refs = [
      ...tables.commerce_order_refs!,
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-refused',
        // The quote_id the BUYER named. There is no family for it — that IS
        // the refusal reason.
        quote_id: 'q-never-issued',
        order_digest: REFUSED_ORDER_RECEIPT.record_digest,
        acknowledgement_json: REFUSAL_JSON,
      },
    ];
    expect(preflightCommerceArchive(tables)).toEqual({
      ok: true,
      findings: [],
      predatesCommerce: false,
    });
  });

  it('still requires the ORDER RECEIPT of a refused order', () => {
    // The exemption is narrow on purpose. A refusal may name a quote this node
    // never had; it may NOT lose the proposal it refused, because the proposal
    // arrived and the refusal does not unsend it.
    const tables = coherent();
    tables.commerce_order_refs = [
      ...tables.commerce_order_refs!,
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-refused',
        quote_id: 'q-never-issued',
        order_digest: ABSENT_DIGEST,
        acknowledgement_json: REFUSAL_JSON,
      },
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.refusal)).toContain('dangling_receipt_reference');
  });

  it('accepts a RE-ADOPTED order with no order receipt and no quote', () => {
    // §12.7 rebuilds the reference from the buyer's acknowledgement alone.
    // `quote_id` is empty and no order receipt exists, by construction.
    const tables = coherent();
    tables.commerce_order_refs = [
      ...tables.commerce_order_refs!,
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-readopted',
        quote_id: '',
        order_digest: ABSENT_DIGEST,
        reconciliation_required: 1,
      },
    ];
    expect(preflightCommerceArchive(tables)).toEqual({
      ok: true,
      findings: [],
      predatesCommerce: false,
    });
  });

  it('REFUSES an ordinary order missing its receipt and its quote', () => {
    // The baseline the exemptions must not cost: no re-adoption flag, a quote
    // it DOES name, and neither the receipt nor the family present. That is
    // exactly the torn archive this check exists to catch.
    const tables = coherent();
    tables.commerce_order_refs = [
      ...tables.commerce_order_refs!,
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-torn',
        quote_id: 'q-absent',
        order_digest: ABSENT_DIGEST,
      },
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.refusal)).toEqual(
      expect.arrayContaining(['dangling_receipt_reference', 'dangling_quote_reference']),
    );
  });

  /**
   * THE FLAG IS TRANSIENT AND THE TRAP IS NOT.
   *
   * `reconciliation_required` is cleared by the owner's §16.2 ceremony, and
   * clearing it does not conjure the quote family this node never issued. An
   * exemption keyed on the flag therefore covered a re-adopted order right up
   * until the owner RECOVERED it — and the first backup after a successful
   * recovery was the unrestorable one.
   */
  it('accepts a re-adopted order AFTER the ceremony has cleared its flag', () => {
    const tables = coherent();
    tables.commerce_receipts = [...tables.commerce_receipts!, RECOVERED_ORDER_RECEIPT];
    tables.commerce_order_refs = [
      ...tables.commerce_order_refs!,
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-recovered',
        // The ceremony restored the ORDER (its receipt is present now) and
        // left the quote id empty, because there is no quote to restore.
        quote_id: '',
        order_digest: RECOVERED_ORDER_RECEIPT.record_digest,
        reconciliation_required: 0,
      },
    ];
    expect(preflightCommerceArchive(tables)).toEqual({
      ok: true,
      findings: [],
      predatesCommerce: false,
    });
  });

  it('does not let an UNREADABLE acknowledgement claim the refusal exemption', () => {
    // A corrupt column must narrow nothing: the parse fails, the row is
    // treated as an ordinary decided order, and the quote check applies.
    const tables = coherent();
    tables.commerce_receipts = [...tables.commerce_receipts!, REFUSED_ORDER_RECEIPT];
    tables.commerce_order_refs = [
      ...tables.commerce_order_refs!,
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-refused',
        quote_id: 'q-never-issued',
        order_digest: REFUSED_ORDER_RECEIPT.record_digest,
        acknowledgement_json: '{not json',
      },
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.refusal)).toContain('dangling_quote_reference');
  });

  it('does not let an ACCEPTED acknowledgement claim the refusal exemption', () => {
    const tables = coherent();
    tables.commerce_receipts = [...tables.commerce_receipts!, REFUSED_ORDER_RECEIPT];
    tables.commerce_order_refs = [
      ...tables.commerce_order_refs!,
      {
        buyer_did: BUYER,
        purchase_order_id: 'po-refused',
        quote_id: 'q-never-issued',
        order_digest: REFUSED_ORDER_RECEIPT.record_digest,
        acknowledgement_json: JSON.stringify({ kind: 'accepted' }),
      },
    ];
    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.refusal)).toContain('dangling_quote_reference');
  });
});
