/**
 * Mobile Scenario 3 — D2D end-to-end, node A sends to node B.
 *
 * Pipeline mirrored:
 *   Node A: sendD2D → buildMessage → sign → sealMessage
 *     → (in prod: MsgBox WebSocket relay) → opaque bytes on the wire
 *   Node B: receiveD2D → unseal → verify signature → trust gate
 *     → scenario gate → stage to vault (type-map) + audit
 *
 * The MsgBox hop is in-memory here (hand the sealed payload straight
 * to B's pipeline) — that's the correct abstraction boundary: the
 * relay carries opaque bytes, it doesn't participate in the crypto or
 * the staging decision. Every cryptographic + policy check that would
 * run in production runs here.
 *
 * What this catches vs the simulator:
 *   - All D2D logic bugs (seal/verify/trust/scenario/stage)
 *   - Envelope shape drift (any protocol-wire-format regression)
 *   - Stage-to-vault type mapping
 *
 * What simulator still catches:
 *   - MsgBox WebSocket transport (compression=false, auth handshake,
 *     reconnect)
 *   - Hermes/iOS native crypto differences
 */

import { getPublicKey } from '@dina/core/src/crypto/ed25519';
import { sealMessage, unsealMessage } from '@dina/core/src/d2d/envelope';
import { verifyMessage } from '@dina/core/src/d2d/signature';
import { receiveD2D } from '@dina/core/src/d2d/receive_pipeline';
import { addContact, clearGatesState } from '@dina/core/src/d2d/gates';
import { resetStagingState, listByStatus } from '@dina/core/src/staging/service';
import { makeDinaMessage, resetFactoryCounters } from '@dina/test-harness';
import { MSG_TYPE_SOCIAL_UPDATE } from '@dina/protocol';

describe('mobile Scenario 3 — D2D node A → node B', () => {
  // Two "nodes" sharing this Jest process — each has its own
  // Ed25519 signing keypair. The key choice is deterministic so
  // audit logs + test output are reproducible.
  const aliceSeed = new Uint8Array(32).fill(0x11);
  const alicePub = getPublicKey(aliceSeed);
  const aliceDID = 'did:key:alice-test';
  const bobSeed = new Uint8Array(32).fill(0x22);
  const bobPub = getPublicKey(bobSeed);
  const bobDID = 'did:key:bob-test';

  beforeEach(() => {
    clearGatesState();
    resetStagingState();
    // Keep message-id factory counters deterministic per test — the
    // replay cache keys on `senderDID|messageID`, so a fresh sequence
    // guarantees we don't hit a leftover from a prior test.
    resetFactoryCounters();
  });

  it('A sends "arriving in 15 min" → B unseal+verify+stage succeeds', () => {
    // Bob has Alice in his contact directory — trust check passes.
    addContact(aliceDID);

    // ---- NODE A: send side ----
    const message = makeDinaMessage({
      from: aliceDID,
      to: bobDID,
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: 'I am arriving in 15 minutes' }),
    });
    const sealedPayload = sealMessage(message, aliceSeed, bobPub);

    // ---- WIRE (opaque bytes — what MsgBox carries) ----
    expect(sealedPayload.c).toBeTruthy();
    expect(sealedPayload.s).toMatch(/^[0-9a-f]{128}$/);
    // Ciphertext hides the plaintext body
    const decoded = Buffer.from(sealedPayload.c, 'base64').toString('utf-8');
    expect(decoded).not.toContain('arriving');

    // ---- NODE B: receive side ----
    const result = receiveD2D(
      sealedPayload,
      bobPub,
      bobSeed,
      [alicePub], // sender's verification keys (from Alice's DID doc)
      'contact_ring1', // trust level Bob has for Alice
    );

    expect(result.action).toBe('staged');
    expect(result.signatureValid).toBe(true);
    expect(result.senderDID).toBe(aliceDID);
    expect(result.messageType).toBe(MSG_TYPE_SOCIAL_UPDATE);
    expect(result.stagingId).toBeTruthy();

    // B's staging inbox has the received row — the staging drain
    // would then classify + resolve it into B's vault.
    const staged = listByStatus('received');
    expect(staged.length).toBe(1);
    expect(staged[0]!.id).toBe(result.stagingId);
  });

  it('unknown sender is kept out of the received inbox (dropped or quarantined)', () => {
    // Alice NOT added to Bob's contacts — trust level 'unknown'.
    const message = makeDinaMessage({
      from: aliceDID,
      to: bobDID,
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: 'hello stranger' }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);

    const result = receiveD2D(sealed, bobPub, bobSeed, [alicePub], 'unknown');
    // The current pipeline drops unknown senders outright (trust gate
    // has no `unknown → quarantine` branch, it treats unknown as
    // untrusted). If the policy is later softened to quarantine
    // instead, both outcomes are acceptable so long as the message
    // never reaches the received queue.
    expect(['dropped', 'quarantined']).toContain(result.action);
    expect(result.signatureValid).toBe(true);
    expect(listByStatus('received').length).toBe(0);
  });

  it('tampered ciphertext → unseal fails → dropped', () => {
    addContact(aliceDID);
    const message = makeDinaMessage({
      from: aliceDID,
      to: bobDID,
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: 'hi' }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);

    // Flip a byte in the ciphertext mid-payload — Poly1305 MAC fails.
    const tamperedBytes = Buffer.from(sealed.c, 'base64');
    tamperedBytes[40]! ^= 0xff;
    const tampered = { c: tamperedBytes.toString('base64'), s: sealed.s };

    const result = receiveD2D(tampered, bobPub, bobSeed, [alicePub], 'contact_ring1');
    expect(result.action).toBe('dropped');
    expect(result.signatureValid).toBe(false);
  });

  it('wrong sender key in verification list → signature check fails → dropped', () => {
    addContact(aliceDID);
    const message = makeDinaMessage({
      from: aliceDID,
      to: bobDID,
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: 'hi' }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);

    // Bob's DID doc has the WRONG pubkey for Alice — signature verify fails.
    const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));
    const result = receiveD2D(sealed, bobPub, bobSeed, [wrongPub], 'contact_ring1');
    expect(result.action).toBe('dropped');
    expect(result.signatureValid).toBe(false);
  });

  it('E2E encryption round-trip — recipient extracts original plaintext', () => {
    const message = makeDinaMessage({
      from: aliceDID,
      to: bobDID,
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: 'secret arrival time 3pm' }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);

    // Recipient-side: only Bob can unseal.
    const unsealed = unsealMessage(sealed, bobPub, bobSeed);
    expect(unsealed.message.from).toBe(aliceDID);
    expect(JSON.parse(unsealed.message.body).text).toBe('secret arrival time 3pm');

    // Independent signature check (what a relay or archive would do
    // if it had access to the plaintext but wanted to prove authorship).
    expect(verifyMessage(unsealed.message, unsealed.signatureHex, [alicePub])).toBe(true);
  });
});
