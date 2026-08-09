/**
 * Sancho orders from ChairMaker ACROSS THE WIRE (§11.2a, §12.7).
 *
 * WHY THIS EXISTS ON TOP OF THE OTHER SIX JOURNEYS. Every one of them —
 * the commerce spine, the plugin lane, the buyer round trip, disaster
 * recovery, external fulfilment, discovery-to-purchase — hands the
 * supplier a body that some test constructed. None of them has an order
 * cross the D2D transport: sealed, signed, unsealed, signature-verified,
 * sender-bound, and only then admitted.
 *
 * That is the same defect class this subsystem keeps producing, one layer
 * out. The transport is well tested and commerce is well tested; what was
 * untested is the seam where a commerce order meets the transport's own
 * rules. A field the ingress needs but the envelope drops, or a sender
 * binding that reads the body instead of the authenticated envelope,
 * would pass every existing suite.
 *
 * THE CLAIM THIS MAKES, AND ITS LIMIT. Two Cores in one process, two
 * keypairs, real `sealMessage` / `receiveD2D`. No socket, no MsgBox
 * relay, no live nodes — §25.6's two-machine journey stays manual. What
 * it proves is that a commerce order survives the crypto and the
 * receive pipeline, which is strictly more than "the engines agree" and
 * strictly less than "it works between two machines".
 */

import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage } from '../../src/d2d/envelope';
import { addContact, clearGatesState } from '../../src/d2d/gates';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { resetAuditState } from '../../src/audit/service';
import { resetStagingState } from '../../src/staging/service';
import { clearReplayCache } from '../../src/transport/adversarial';
import { resetQuarantineState } from '../../src/d2d/quarantine';

import type { DinaMessage } from '../../src/d2d/wire';

const BUYER_DID = 'did:plc:sancho42';
const SUPPLIER_DID = 'did:plc:chairmaker99';

const sanchoPriv = new Uint8Array(32).fill(0x11);
const sanchoPub = getPublicKey(sanchoPriv);
const chairMakerPriv = new Uint8Array(32).fill(0x22);
const chairMakerPub = getPublicKey(chairMakerPriv);

// NO STORAGE. The receive pipeline's module-level state is what these cases
// touch, and a SQLite adapter opened here would be scaffolding nothing reads —
// which is the same "built but unused" shape the rest of this work kept
// finding in production code.
beforeEach(() => {
  clearGatesState();
  resetStagingState();
  resetAuditState();
  resetQuarantineState();
  clearReplayCache();
});

/** Sancho's outbound: a real `service.query`, sealed to ChairMaker. */
function sanchoSends(body: unknown, overrides: Partial<DinaMessage> = {}) {
  const message: DinaMessage = {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'service.query',
    from: BUYER_DID,
    to: SUPPLIER_DID,
    created_time: Date.now(),
    body: JSON.stringify(body),
    ...overrides,
  };
  return sealMessage(message, sanchoPriv, chairMakerPub);
}

const submitOrder = (queryId: string) => ({
  query_id: queryId,
  capability: 'submit_order',
  params: { purchase_order_id: 'po-wire-1', buyer_did: BUYER_DID },
  ttl_seconds: 60,
});

describe("Sancho's order reaches ChairMaker over D2D", () => {
  it('survives seal, signature verification and the receive pipeline', () => {
    addContact(BUYER_DID);
    const sealed = sanchoSends(submitOrder('q-wire-1'));

    const received = receiveD2D(sealed, chairMakerPub, chairMakerPriv, [sanchoPub], 'verified', {
      isCapabilityConfigured: (cap) => cap === 'submit_order',
    });

    expect(received.action).toBe('bypassed');
    // The SENDER the pipeline authenticated, not the one the body claims.
    expect(received.senderDID).toBe(BUYER_DID);
    expect(received.bypassedBody).toMatchObject({
      query_id: 'q-wire-1',
      capability: 'submit_order',
    });
  });

  it('drops an order whose signature is not Sancho’s', () => {
    // A stranger seals to ChairMaker and claims to be Sancho. The seal
    // succeeds — anyone may encrypt to a public key — and the SIGNATURE is
    // what fails. This is the check that makes `senderDID` above mean
    // something.
    addContact(BUYER_DID);
    const impostorPriv = new Uint8Array(32).fill(0x33);
    const message: DinaMessage = {
      id: 'msg-impostor',
      type: 'service.query',
      from: BUYER_DID,
      to: SUPPLIER_DID,
      created_time: Date.now(),
      body: JSON.stringify(submitOrder('q-wire-forged')),
    };
    const sealed = sealMessage(message, impostorPriv, chairMakerPub);

    const received = receiveD2D(sealed, chairMakerPub, chairMakerPriv, [sanchoPub], 'verified', {
      isCapabilityConfigured: (cap) => cap === 'submit_order',
    });

    expect(received.action).toBe('dropped');
    expect(received.signatureValid).toBe(false);
  });

  it('refuses a REPLAY of the same sealed order', () => {
    // §9.9's idempotency is a commerce rule, but the transport has its own
    // replay cache and it fires first. Both must hold: this pins the
    // transport half, and the commerce half is pinned by the admission
    // suites where a repeated idempotency key replays the acknowledgement.
    addContact(BUYER_DID);
    const sealed = sanchoSends(submitOrder('q-wire-replay'));
    const options = { isCapabilityConfigured: (cap: string) => cap === 'submit_order' };

    expect(receiveD2D(sealed, chairMakerPub, chairMakerPriv, [sanchoPub], 'verified', options).action).toBe(
      'bypassed',
    );
    const again = receiveD2D(sealed, chairMakerPub, chairMakerPriv, [sanchoPub], 'verified', options);
    expect(again.action).not.toBe('bypassed');
  });

  it('does not bypass a capability ChairMaker does not serve', () => {
    // The ingress lane is opt-in per capability. An order for something
    // this supplier never configured must not reach the commerce path at
    // all — it takes the ordinary staging route instead.
    addContact(BUYER_DID);
    const sealed = sanchoSends({ ...submitOrder('q-wire-unconfigured'), capability: 'not_offered' });

    const received = receiveD2D(sealed, chairMakerPub, chairMakerPriv, [sanchoPub], 'verified', {
      isCapabilityConfigured: (cap) => cap === 'submit_order',
    });

    expect(received.action).not.toBe('bypassed');
  });
});
