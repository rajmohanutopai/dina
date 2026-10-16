/**
 * COMMITMENT_KERNEL §6 step 6, §15 step 7 — the `commitment.option` family on
 * the receive pipeline.
 *
 *   I-01  from a stranger, a request (or any other kind) is dropped;
 *   I-02  from a stranger, a fallback notice reaches the handler (a buyer who
 *         ordered through the AppView has no contact row); the handler keeps
 *         it only for this node's own order from that supplier.
 */

import { randomBytes } from 'node:crypto';

import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { setNodeDID } from '../../src/pairing/ceremony';

const SUPPLIER = 'did:plc:supplier00000000000000000';
const BUYER = 'did:plc:buyer000000000000000000000';
const supplierPriv = new Uint8Array(randomBytes(32));
const supplierPub = getPublicKey(supplierPriv);
const buyerPriv = new Uint8Array(randomBytes(32));
const buyerPub = getPublicKey(buyerPriv);

function deliver(body: Record<string, unknown>) {
  setNodeDID(BUYER);
  const msg: DinaMessage = {
    id: `opt-${Math.random().toString(36).slice(2)}`,
    type: 'commitment.option',
    from: SUPPLIER,
    to: BUYER,
    created_time: Date.now(),
    body: JSON.stringify(body),
  };
  return receiveD2D(
    sealMessage(msg, supplierPriv, buyerPub),
    buyerPub,
    buyerPriv,
    [supplierPub],
    'unknown',
  );
}

describe('the option family from a stranger', () => {
  it('I-01: a request is dropped', () => {
    const result = deliver({
      v: 1,
      kind: 'request',
      request_id: 'req-1',
      service_at: '2026-11-10T09:00:00Z',
      crates: 1,
    });
    expect(result.action).toBe('dropped');
  });

  it('I-02: a fallback notice reaches the handler', () => {
    const result = deliver({
      v: 1,
      kind: 'fallback',
      purchase_order_id: 'po-1',
      quote_id: 'q-1',
      alternative_id: 'partner_00112233',
      at: '2026-11-07T09:00:00.000Z',
    });
    expect(result.action).toBe('bypassed');
    expect(result.reason).toMatch(/option handler/);
  });
});
