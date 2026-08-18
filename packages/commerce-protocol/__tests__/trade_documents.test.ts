/**
 * Trade documents (TRADE_FIRST_STRATEGY §3.4, §4.2, §4.3) — shapes,
 * digests, kind narrowing, and the pairwise cross-document verifiers.
 * One named negative per rule; every happy path recomputes its digest
 * rather than trusting the fixture.
 */

import { createHash } from 'node:crypto';

import {
  KNOWN_DELIVERY_RECEIPT_REASONS,
  KNOWN_QUOTE_DECLINE_REASONS,
  MAX_TRADE_LINES,
  TRADE_DIGEST_DOMAINS,
  readDeliveryNote,
  readDeliveryReceipt,
  readPaymentAcknowledgement,
  readPaymentNote,
  readQuoteDecline,
  tradeRecordDigest,
  validateDeliveryNote,
  validateDeliveryReceipt,
  validatePaymentAcknowledgement,
  validatePaymentNote,
  validateQuoteDecline,
  verifyDeliveryReceiptAgainstNote,
  verifyPaymentAckAgainstNote,
  verifyQuoteDeclineAgainstRequest,
  type DeliveryNote,
  type DeliveryReceipt,
  type PaymentAcknowledgement,
  type PaymentNote,
  type QuoteDecline,
} from '../src/trade_documents';

import type { QuoteRequest } from '../src/quote';

const hash = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());

const HEX = 'a'.repeat(64);
const BUYER = 'did:plc:buyer0000000000000000000';
const SUPPLIER = 'did:plc:supplier000000000000000000';

function sealed<T extends Record<string, unknown>>(
  domain: Parameters<typeof tradeRecordDigest>[0],
  digestField: string,
  record: T,
): T {
  return { ...record, [digestField]: tradeRecordDigest(domain, record, hash) };
}

// ---------------------------------------------------------------------------
// Fixtures — digests always recomputed, never hand-written
// ---------------------------------------------------------------------------

function makeDecline(overrides: Partial<QuoteDecline> = {}): QuoteDecline {
  return sealed('quote_decline', 'decline_digest', {
    protocol_version: '1.0',
    decline_id: 'dec-1',
    request_id: 'req-1',
    request_digest: HEX,
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    reason_code: 'capacity',
    issued_at: '2026-08-17T10:00:00.000Z',
    ...overrides,
  }) as QuoteDecline;
}

function makeNote(overrides: Partial<DeliveryNote> = {}): DeliveryNote {
  return sealed('delivery_note', 'note_digest', {
    protocol_version: '1.0',
    delivery_note_id: 'dn-1',
    purchase_order_id: 'po-1',
    order_digest: HEX,
    supplier_order_id: 'so-1',
    lines: [
      { line_id: 'line-1', delivered_quantity: { value: '10', unit_code: 'each' } },
      { line_id: 'line-2', delivered_quantity: { value: '4', unit_code: 'each' } },
    ],
    dispatched_at: '2026-08-17T09:00:00.000Z',
    ...overrides,
  }) as DeliveryNote;
}

function makeReceipt(note: DeliveryNote, overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return sealed('delivery_receipt', 'receipt_digest', {
    protocol_version: note.protocol_version,
    delivery_receipt_id: 'dr-1',
    delivery_note_digest: tradeRecordDigest(
      'delivery_note',
      note as unknown as Record<string, unknown>,
      hash,
    ),
    lines: [
      { line_id: 'line-1', accepted_quantity: { value: '10', unit_code: 'each' } },
      {
        line_id: 'line-2',
        accepted_quantity: { value: '3', unit_code: 'each' },
        reason_code: 'damaged',
      },
    ],
    received_at: '2026-08-17T12:00:00.000Z',
    ...overrides,
  }) as DeliveryReceipt;
}

function makePaymentNote(overrides: Partial<PaymentNote> = {}): PaymentNote {
  return sealed('payment_note', 'note_digest', {
    protocol_version: '1.0',
    payment_note_id: 'pn-1',
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    amount: { currency: 'INR', minor_units: '500000' },
    method: 'upi',
    external_ref: 'upi-ref-123',
    paid_at: '2026-08-17T13:00:00.000Z',
    ...overrides,
  }) as PaymentNote;
}

function makeAck(
  note: PaymentNote,
  overrides: Partial<Record<string, unknown>> = {},
): PaymentAcknowledgement {
  return sealed('payment_ack', 'ack_digest', {
    protocol_version: note.protocol_version,
    payment_ack_id: 'pa-1',
    payment_note_digest: tradeRecordDigest(
      'payment_note',
      note as unknown as Record<string, unknown>,
      hash,
    ),
    kind: 'received',
    amount_received: { ...note.amount },
    acknowledged_at: '2026-08-17T14:00:00.000Z',
    ...overrides,
  }) as unknown as PaymentAcknowledgement;
}

// ---------------------------------------------------------------------------
// Digest family
// ---------------------------------------------------------------------------

describe('trade digest family', () => {
  it('covers exactly the five trade domains', () => {
    expect([...TRADE_DIGEST_DOMAINS].sort()).toEqual(
      ['delivery_note', 'delivery_receipt', 'payment_ack', 'payment_note', 'quote_decline'].sort(),
    );
  });

  it('the same payload digests differently under every domain', () => {
    const payload = { alpha: '1' };
    const digests = TRADE_DIGEST_DOMAINS.map((d) => tradeRecordDigest(d, payload, hash));
    expect(new Set(digests).size).toBe(TRADE_DIGEST_DOMAINS.length);
  });

  it('a tampered field fails digest verification on every document', () => {
    expect(validateQuoteDecline({ ...makeDecline(), reason_code: 'policy' }, hash)).toContain(
      'digest',
    );
    const note = makeNote();
    expect(validateDeliveryNote({ ...note, supplier_order_id: 'so-2' }, hash)).toContain('digest');
    const pay = makePaymentNote();
    expect(
      validatePaymentNote({ ...pay, amount: { currency: 'INR', minor_units: '1' } }, hash),
    ).toContain('digest');
  });
});

// ---------------------------------------------------------------------------
// QuoteDecline
// ---------------------------------------------------------------------------

describe('QuoteDecline (§3.4)', () => {
  it('a valid decline reads typed', () => {
    const read = readQuoteDecline(makeDecline(), hash);
    expect(read.ok).toBe(true);
  });

  it('the reason vocabulary is open but bounded, and the known set is pinned', () => {
    expect([...KNOWN_QUOTE_DECLINE_REASONS]).toEqual(['out_of_region', 'capacity', 'policy']);
    expect(validateQuoteDecline(makeDecline({ reason_code: 'my_own_policy_code' }), hash)).toBeNull();
    expect(validateQuoteDecline(makeDecline({ reason_code: '' }), hash)).toContain('reason_code');
    expect(validateQuoteDecline(makeDecline({ reason_code: 'x'.repeat(65) }), hash)).toContain(
      'reason_code',
    );
  });

  it('binds to the RETAINED request: id, digest, parties, §9.13 version', () => {
    const request = {
      protocol_version: '1.0',
      request_id: 'req-1',
      request_digest: HEX,
      buyer_did: BUYER,
      supplier_did: SUPPLIER,
    } as unknown as QuoteRequest;
    expect(verifyQuoteDeclineAgainstRequest(makeDecline(), request)).toBeNull();
    expect(
      verifyQuoteDeclineAgainstRequest(makeDecline({ request_id: 'req-2' }), request),
    ).toContain('request_id');
    expect(
      verifyQuoteDeclineAgainstRequest(makeDecline({ request_digest: 'b'.repeat(64) }), request),
    ).toContain('request_digest');
    expect(
      verifyQuoteDeclineAgainstRequest(makeDecline({ buyer_did: SUPPLIER }), request),
    ).toContain('parties');
    expect(
      verifyQuoteDeclineAgainstRequest(makeDecline({ protocol_version: '1.1' }), request),
    ).toContain('§9.13');
  });
});

// ---------------------------------------------------------------------------
// DeliveryNote
// ---------------------------------------------------------------------------

describe('DeliveryNote (§4.2)', () => {
  it('a valid note reads typed', () => {
    expect(readDeliveryNote(makeNote(), hash).ok).toBe(true);
  });

  it('a zero delivered_quantity is refused — refusal lives on the receipt', () => {
    const note = makeNote({
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '0', unit_code: 'each' } }],
    });
    expect(validateDeliveryNote(note, hash)).toContain('quantity');
  });

  it('refuses empty, oversized and duplicate line lists', () => {
    expect(validateDeliveryNote(makeNote({ lines: [] }), hash)).toContain('non-empty');
    const big = Array.from({ length: MAX_TRADE_LINES + 1 }, (_, i) => ({
      line_id: `line-${String(i)}`,
      delivered_quantity: { value: '1', unit_code: 'each' },
    }));
    expect(validateDeliveryNote(makeNote({ lines: big }), hash)).toContain('exceeds');
    const dup = makeNote({
      lines: [
        { line_id: 'line-1', delivered_quantity: { value: '1', unit_code: 'each' } },
        { line_id: 'line-1', delivered_quantity: { value: '2', unit_code: 'each' } },
      ],
    });
    expect(validateDeliveryNote(dup, hash)).toContain('duplicate');
  });

  it('expected_by is optional but must be ISO UTC when present', () => {
    expect(validateDeliveryNote(makeNote({ expected_by: '2026-08-20T00:00:00.000Z' }), hash)).toBeNull();
    expect(validateDeliveryNote(makeNote({ expected_by: 'tomorrow' }), hash)).toContain(
      'expected_by',
    );
  });
});

// ---------------------------------------------------------------------------
// DeliveryReceipt
// ---------------------------------------------------------------------------

describe('DeliveryReceipt (§4.2)', () => {
  const note = makeNote();

  it('a valid receipt reads typed, and the known reasons are pinned buyer-side', () => {
    expect(readDeliveryReceipt(makeReceipt(note), hash).ok).toBe(true);
    expect([...KNOWN_DELIVERY_RECEIPT_REASONS]).toEqual([
      'damaged',
      'short',
      'wrong_item',
      'refused',
    ]);
  });

  it('ZERO acceptance is legal — a fully refused shipment is a value, not an error', () => {
    const refused = makeReceipt(note, {
      lines: [
        {
          line_id: 'line-1',
          accepted_quantity: { value: '0', unit_code: 'each' },
          reason_code: 'refused',
        },
      ],
    });
    expect(validateDeliveryReceipt(refused, hash)).toBeNull();
  });

  it('pairwise: accepts ≤ delivered, same unit, no invented lines, §9.13 version', () => {
    expect(verifyDeliveryReceiptAgainstNote(makeReceipt(note), note, hash)).toBeNull();

    const over = makeReceipt(note, {
      lines: [{ line_id: 'line-1', accepted_quantity: { value: '11', unit_code: 'each' } }],
    });
    expect(verifyDeliveryReceiptAgainstNote(over, note, hash)).toContain('more than');

    const wrongUnit = makeReceipt(note, {
      lines: [{ line_id: 'line-1', accepted_quantity: { value: '1', unit_code: 'kg' } }],
    });
    expect(verifyDeliveryReceiptAgainstNote(wrongUnit, note, hash)).not.toBeNull();

    const invented = makeReceipt(note, {
      lines: [{ line_id: 'line-9', accepted_quantity: { value: '1', unit_code: 'each' } }],
    });
    expect(verifyDeliveryReceiptAgainstNote(invented, note, hash)).toContain('not on the note');

    const wrongVersion = makeReceipt(note, { protocol_version: '1.1' });
    expect(verifyDeliveryReceiptAgainstNote(wrongVersion, note, hash)).toContain('§9.13');

    const wrongNote = makeReceipt(note, { delivery_note_digest: 'b'.repeat(64) });
    expect(verifyDeliveryReceiptAgainstNote(wrongNote, note, hash)).toContain('retained note');
  });

  it('a receipt may omit note lines — omitted is unreceipted, never invalid', () => {
    const partial = makeReceipt(note, {
      lines: [{ line_id: 'line-1', accepted_quantity: { value: '10', unit_code: 'each' } }],
    });
    expect(verifyDeliveryReceiptAgainstNote(partial, note, hash)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PaymentNote + PaymentAcknowledgement
// ---------------------------------------------------------------------------

describe('PaymentNote (§4.2)', () => {
  it('a valid note reads typed; zero and unknown methods refuse', () => {
    expect(readPaymentNote(makePaymentNote(), hash).ok).toBe(true);
    expect(
      validatePaymentNote(
        makePaymentNote({ amount: { currency: 'INR', minor_units: '0' } }),
        hash,
      ),
    ).toContain('positive');
    expect(
      validatePaymentNote(makePaymentNote({ method: 'barter' as never }), hash),
    ).toContain('method');
  });

  it('order_refs stay advisory: bounded, unique, and optional', () => {
    expect(validatePaymentNote(makePaymentNote({ order_refs: ['po-1', 'po-2'] }), hash)).toBeNull();
    expect(validatePaymentNote(makePaymentNote({ order_refs: [] }), hash)).toContain('non-empty');
    expect(
      validatePaymentNote(makePaymentNote({ order_refs: ['po-1', 'po-1'] }), hash),
    ).toContain('duplicate');
  });
});

describe('PaymentAcknowledgement (§4.2/§4.4)', () => {
  const note = makePaymentNote();

  it('received REQUIRES amount_received; disputed FORBIDS it', () => {
    expect(readPaymentAcknowledgement(makeAck(note), hash).ok).toBe(true);
    const missing = makeAck(note, { amount_received: undefined });
    expect(validatePaymentAcknowledgement(missing, hash)).toContain('amount_received');
    const disputed = makeAck(note, { kind: 'disputed', amount_received: undefined });
    expect(validatePaymentAcknowledgement(disputed, hash)).toBeNull();
    const disputedWithAmount = makeAck(note, { kind: 'disputed' });
    expect(validatePaymentAcknowledgement(disputedWithAmount, hash)).toContain('forbidden');
  });

  it('pairwise: same currency, never more than asserted, §9.13 version, digest binding', () => {
    expect(verifyPaymentAckAgainstNote(makeAck(note), note, hash)).toBeNull();

    const partial = makeAck(note, { amount_received: { currency: 'INR', minor_units: '400000' } });
    expect(verifyPaymentAckAgainstNote(partial, note, hash)).toBeNull();

    const over = makeAck(note, { amount_received: { currency: 'INR', minor_units: '500001' } });
    expect(verifyPaymentAckAgainstNote(over, note, hash)).toContain('exceeds');

    const wrongCurrency = makeAck(note, {
      amount_received: { currency: 'USD', minor_units: '1' },
    });
    expect(verifyPaymentAckAgainstNote(wrongCurrency, note, hash)).toContain('currency');

    const wrongVersion = makeAck(note, { protocol_version: '1.1' });
    expect(verifyPaymentAckAgainstNote(wrongVersion, note, hash)).toContain('§9.13');

    const wrongNote = makeAck(note, { payment_note_digest: 'b'.repeat(64) });
    expect(verifyPaymentAckAgainstNote(wrongNote, note, hash)).toContain('retained note');
  });

  it('a disputed ack passes the pairwise check without any amount rule', () => {
    const disputed = makeAck(note, { kind: 'disputed', amount_received: undefined });
    expect(verifyPaymentAckAgainstNote(disputed, note, hash)).toBeNull();
  });
});
