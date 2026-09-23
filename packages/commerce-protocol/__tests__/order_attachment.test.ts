/**
 * OrderAttachment (JIFFY_MERCHANT_INTEGRATION_PLAN §3.3) — shape, vocabulary,
 * the frozen digest, and the pairwise binding against the retained order.
 */

import { createHash } from 'node:crypto';

import {
  FULFILMENT_EVIDENCE_STATES,
  ORDER_ATTACHMENT_KINDS,
  PAYMENT_EVIDENCE_STATES,
  readOrderAttachment,
  validateOrderAttachment,
  verifyOrderAttachmentAgainstOrder,
  type OrderAttachment,
  type OrderAttachmentBinding,
} from '../src/order_attachment';
import {
  TRADE_DIGEST_DOMAINS,
  TRADE_DIGEST_FIELD_BY_DOMAIN,
  tradeRecordDigest,
} from '../src/trade_digest';

const hash = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

const BUYER = 'did:plc:buyer0000000000000000000';
const SUPPLIER = 'did:plc:supplier000000000000000000';
const DEVICE = 'did:key:z6MkintegrationDevice00000000000';
const ORDER_DIGEST = 'a'.repeat(64);

function sealed(record: Record<string, unknown>): OrderAttachment {
  return {
    ...record,
    attachment_digest: tradeRecordDigest('order_attachment', record, hash),
  } as unknown as OrderAttachment;
}

function checkout(
  overrides: Record<string, unknown> = {},
  payload: Record<string, unknown> = {},
): OrderAttachment {
  return sealed({
    protocol_version: '1.0',
    attachment_id: 'att_checkout_1',
    purchase_order_id: 'po-1',
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    order_digest: ORDER_DIGEST,
    kind: 'checkout_handoff',
    source: { kind: 'integration', device_did: DEVICE, provider: 'clover' },
    payload: {
      session_ref: 'cs_123',
      url: 'https://pay.example.com/s/cs_123',
      amount: { currency: 'INR', minor_units: '50000' },
      ...payload,
    },
    issued_at: '2026-09-23T10:00:00.000Z',
    expires_at: '2026-09-24T10:00:00.000Z',
    ...overrides,
  });
}

function payment(
  payload: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): OrderAttachment {
  return sealed({
    protocol_version: '1.0',
    attachment_id: 'att_pay_1',
    purchase_order_id: 'po-1',
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    order_digest: ORDER_DIGEST,
    kind: 'payment_evidence',
    source: { kind: 'integration', device_did: DEVICE, provider: 'clover' },
    payload: {
      provider_ref: 'ch_1',
      amount: { currency: 'INR', minor_units: '50000' },
      state: 'captured',
      version: '1',
      ...payload,
    },
    issued_at: '2026-09-23T10:00:00.000Z',
    ...overrides,
  });
}

function fulfilment(payload: Record<string, unknown> = {}): OrderAttachment {
  return sealed({
    protocol_version: '1.0',
    attachment_id: 'att_ful_1',
    purchase_order_id: 'po-1',
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    order_digest: ORDER_DIGEST,
    kind: 'fulfilment_evidence',
    source: { kind: 'integration', device_did: DEVICE, provider: 'jiffy' },
    payload: { provider_ref: 'job_9', state: 'production_started', version: '3', ...payload },
    issued_at: '2026-09-23T10:00:00.000Z',
  });
}

const ORDER: OrderAttachmentBinding = {
  purchase_order_id: 'po-1',
  order_digest: ORDER_DIGEST,
  buyer_did: BUYER,
  supplier_did: SUPPLIER,
  protocol_version: '1.0',
  approved_total: { currency: 'INR', minor_units: '50000' },
};

describe('the digest', () => {
  it('is the sixth trade-family domain and is FROZEN', () => {
    expect(TRADE_DIGEST_DOMAINS).toContain('order_attachment');
    expect(TRADE_DIGEST_FIELD_BY_DOMAIN.order_attachment).toBe('attachment_digest');
    // Computed once from this exact record; a change here is a wire break.
    expect(checkout().attachment_digest).toBe(
      '61d26497a4f20b3f598fc34f0f014fc1208802f9bf37ee35dbafc75036a6be1e',
    );
  });

  it('excludes its own field and catches a tampered one on every kind', () => {
    for (const doc of [checkout(), payment(), fulfilment()]) {
      expect(validateOrderAttachment(doc, hash)).toBeNull();
      expect(
        validateOrderAttachment({ ...doc, issued_at: '2026-09-23T11:00:00.000Z' }, hash),
      ).toContain('digest');
      expect(
        validateOrderAttachment(
          { ...doc, payload: { ...doc.payload, provider_ref: 'other' } },
          hash,
        ),
      ).toContain('digest');
    }
  });

  it('tolerates an unknown field the sender digested (§9.13) and refuses one it did not', () => {
    const grown = sealed({ ...checkout(), attachment_digest: undefined, future_field: 'x' });
    expect(validateOrderAttachment(grown, hash)).toBeNull();
    expect(validateOrderAttachment({ ...checkout(), future_field: 'x' }, hash)).toContain('digest');
    // `1e400` parses to Infinity: no canonical spelling, so a refusal string, never a throw.
    expect(
      validateOrderAttachment({ ...checkout(), future_field: Number.POSITIVE_INFINITY }, hash),
    ).toContain('canonicalizable');
  });
});

describe('shape', () => {
  it('reads each kind typed', () => {
    for (const doc of [checkout(), payment(), fulfilment()]) {
      const read = readOrderAttachment(doc, hash);
      expect(read.ok && read.attachment.kind).toBe(doc.kind);
    }
    expect([...ORDER_ATTACHMENT_KINDS]).toEqual([
      'checkout_handoff',
      'payment_evidence',
      'fulfilment_evidence',
    ]);
    expect([...PAYMENT_EVIDENCE_STATES]).toEqual(['authorized', 'captured', 'refunded', 'failed']);
    expect([...FULFILMENT_EVIDENCE_STATES]).toEqual([
      'production_started',
      'ready',
      'handed_to_carrier',
    ]);
  });

  it('the source is always an integration device with a provider token', () => {
    expect(
      validateOrderAttachment(
        sealed({
          ...checkout(),
          attachment_digest: undefined,
          source: { kind: 'supplier', device_did: DEVICE, provider: 'clover' },
        }),
        hash,
      ),
    ).toContain('source.kind');
    expect(
      validateOrderAttachment(
        sealed({
          ...checkout(),
          attachment_digest: undefined,
          source: { kind: 'integration', device_did: 'nope', provider: 'clover' },
        }),
        hash,
      ),
    ).toContain('device_did');
    expect(
      validateOrderAttachment(
        sealed({
          ...checkout(),
          attachment_digest: undefined,
          source: { kind: 'integration', device_did: DEVICE, provider: 'Clover Inc' },
        }),
        hash,
      ),
    ).toContain('provider');
    expect(
      validateOrderAttachment(
        sealed({ ...checkout(), attachment_digest: undefined, source: undefined }),
        hash,
      ),
    ).toContain('source');
  });

  it('a checkout link is https with a host and no credentials, and its amount is positive', () => {
    for (const url of [
      'http://pay.example.com/s/1',
      'https://user:pw@pay.example.com/s/1',
      'https://localhost/s/1',
      'https://pay.example.com/s/1 2',
      'ftp://x.y/z',
      `https://pay.example.com/${'a'.repeat(2100)}`,
    ]) {
      expect([url, validateOrderAttachment(checkout({}, { url }), hash)]).toEqual([
        url,
        expect.stringContaining('url'),
      ]);
    }
    expect(
      validateOrderAttachment(
        checkout({}, { url: 'https://pay.example.com:8443/s/1?x=1#y' }),
        hash,
      ),
    ).toBeNull();
    // A port past 65535 and a control or bidi character in the path fail here, not on the phone.
    expect(
      validateOrderAttachment(checkout({}, { url: 'https://pay.example.com:99999/s/1' }), hash),
    ).toContain('url');
    expect(
      validateOrderAttachment(checkout({}, { url: 'https://pay.example.com/s/\u0001x' }), hash),
    ).toContain('url');
    expect(
      validateOrderAttachment(checkout({}, { url: 'https://pay.example.com/s/\u200bx' }), hash),
    ).toContain('url');
    expect(
      validateOrderAttachment(
        checkout({}, { amount: { currency: 'INR', minor_units: '0' } }),
        hash,
      ),
    ).toContain('positive');
    expect(
      validateOrderAttachment(
        checkout({}, { amount: { currency: 'inr', minor_units: '5' } }),
        hash,
      ),
    ).toContain('money');
    expect(validateOrderAttachment(checkout({}, { session_ref: '' }), hash)).toContain(
      'session_ref',
    );
  });

  it('evidence carries a bounded provider ref, a known state, a decimal version, and only a known method', () => {
    expect(validateOrderAttachment(payment({ state: 'settled' }), hash)).toContain('state');
    expect(validateOrderAttachment(payment({ version: '0' }), hash)).toContain('version');
    expect(validateOrderAttachment(payment({ version: '01' }), hash)).toContain('version');
    expect(validateOrderAttachment(payment({ version: 1 }), hash)).toContain('version');
    expect(validateOrderAttachment(payment({ method: 'card' }), hash)).toContain('method');
    expect(validateOrderAttachment(payment({ method: 'upi' }), hash)).toBeNull();
    expect(
      validateOrderAttachment(payment({ amount: { currency: 'INR', minor_units: '0' } }), hash),
    ).toContain('positive');
    expect(validateOrderAttachment(payment({ provider_ref: 'x'.repeat(201) }), hash)).toContain(
      'provider_ref',
    );
    expect(validateOrderAttachment(payment({ provider_ref: 'bad\u0000ref' }), hash)).toContain(
      'control',
    );
    expect(validateOrderAttachment(fulfilment({ state: 'delivered' }), hash)).toContain('state');
  });

  it('refuses an unknown kind, a mismatched payload, and an expiry that is not after issue', () => {
    expect(
      validateOrderAttachment(
        sealed({ ...checkout(), attachment_digest: undefined, kind: 'refund_evidence' }),
        hash,
      ),
    ).toContain('kind');
    expect(
      validateOrderAttachment(
        sealed({ ...checkout(), attachment_digest: undefined, kind: 'payment_evidence' }),
        hash,
      ),
    ).toContain('provider_ref');
    expect(
      validateOrderAttachment(checkout({ expires_at: '2026-09-23T10:00:00.000Z' }), hash),
    ).toContain('expires_at');
    expect(validateOrderAttachment(checkout({ expires_at: 'tomorrow' }), hash)).toContain(
      'expires_at',
    );
    expect(validateOrderAttachment(payment({}, { expires_at: undefined }), hash)).toBeNull();
    expect(validateOrderAttachment(null, hash)).toContain('object');
  });
});

describe('binding to the retained order', () => {
  it('a matching attachment binds; every mismatch names itself', () => {
    expect(verifyOrderAttachmentAgainstOrder(checkout(), ORDER)).toBeNull();
    expect(verifyOrderAttachmentAgainstOrder(payment(), ORDER)).toBeNull();
    expect(
      verifyOrderAttachmentAgainstOrder(checkout({ purchase_order_id: 'po-2' }), ORDER),
    ).toContain('purchase_order_id');
    expect(
      verifyOrderAttachmentAgainstOrder(checkout({ order_digest: 'b'.repeat(64) }), ORDER),
    ).toContain('order_digest');
    expect(verifyOrderAttachmentAgainstOrder(checkout({ buyer_did: SUPPLIER }), ORDER)).toContain(
      'parties',
    );
    expect(verifyOrderAttachmentAgainstOrder(checkout({ supplier_did: BUYER }), ORDER)).toContain(
      'parties',
    );
    expect(
      verifyOrderAttachmentAgainstOrder(checkout({ protocol_version: '1.1' }), ORDER),
    ).toContain('§9.13');
  });

  it('a checkout can never change price or currency: the amount must equal the accepted total to the paisa', () => {
    expect(
      verifyOrderAttachmentAgainstOrder(
        checkout({}, { amount: { currency: 'INR', minor_units: '50001' } }),
        ORDER,
      ),
    ).toContain('total');
    expect(
      verifyOrderAttachmentAgainstOrder(
        checkout({}, { amount: { currency: 'USD', minor_units: '50000' } }),
        ORDER,
      ),
    ).toContain('total');
    // Canonical spelling is compared as VALUE: a leading zero would fail Money's
    // own shape check first, so equal values always spell equally here.
    expect(
      verifyOrderAttachmentAgainstOrder(checkout(), {
        ...ORDER,
        approved_total: { currency: 'INR', minor_units: '50000' },
      }),
    ).toBeNull();
    // Evidence amounts are the processor's word, not a term: a partial capture binds.
    expect(
      verifyOrderAttachmentAgainstOrder(
        payment({ amount: { currency: 'INR', minor_units: '100' } }),
        ORDER,
      ),
    ).toBeNull();
  });
});
