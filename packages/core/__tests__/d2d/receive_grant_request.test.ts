/**
 * service.grant_request ingress tests (Contact Services §5.2) — a contact's
 * requester-initiated preflight for a relationship (talk-surface) service. The
 * receive pipeline accepts it ONLY from an established contact, validates the
 * body, routes it to the grant-request handler (fire-and-forget), and returns
 * `bypassed`. It is NEVER staged to the vault. The handler's policy/grant
 * behaviour is covered by grant_request_handler.test.ts.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { resetAuditState } from '../../src/audit/service';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { resetQuarantineState } from '../../src/d2d/quarantine';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { resetStagingState } from '../../src/staging/service';
import { clearReplayCache } from '../../src/transport/adversarial';


const senderPriv = TEST_ED25519_SEED;
const senderPub = getPublicKey(senderPriv);
const recipientPriv = new Uint8Array(32).fill(0x42);
const recipientPub = getPublicKey(recipientPriv);

const REQUESTER_DID = 'did:plc:alonso';

const requestBody = {
  request_id: 'req-1',
  capability: 'availability_coordination',
  intent: 'find a time next week',
  requested_surface: 'talk',
};

function buildSealed(body: unknown, overrides?: Partial<DinaMessage>) {
  const msg: DinaMessage = {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'service.grant_request',
    from: REQUESTER_DID,
    to: 'did:plc:recipient',
    created_time: Date.now(),
    body: JSON.stringify(body),
    ...overrides,
  };
  return sealMessage(msg, senderPriv, recipientPub);
}

beforeEach(() => {
  clearGatesState();
  resetStagingState();
  resetAuditState();
  resetQuarantineState();
  clearReplayCache();
});

describe('receive_pipeline — service.grant_request ingress', () => {
  it('accepts a request from an established contact (bypassed, never vaulted)', () => {
    const result = receiveD2D(
      buildSealed(requestBody),
      recipientPub,
      recipientPriv,
      [senderPub],
      'verified',
    );
    expect(result.action).toBe('bypassed');
    expect(result.messageType).toBe('service.grant_request');
  });

  it('REJECTS a request from a non-contact (lazy-allow is contacts-only)', () => {
    const result = receiveD2D(
      buildSealed(requestBody),
      recipientPub,
      recipientPriv,
      [senderPub],
      'unknown',
    );
    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/not a known contact/);
  });

  it('DROPS a request with an invalid body (missing capability)', () => {
    const bad = { request_id: 'x', requested_surface: 'talk' };
    const result = receiveD2D(
      buildSealed(bad),
      recipientPub,
      recipientPriv,
      [senderPub],
      'verified',
    );
    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/service\.grant_request invalid/);
  });

  it('DROPS a request whose requested_surface is not "talk"', () => {
    const bad = {
      request_id: 'x',
      capability: 'availability_coordination',
      requested_surface: 'services',
    };
    const result = receiveD2D(
      buildSealed(bad),
      recipientPub,
      recipientPriv,
      [senderPub],
      'verified',
    );
    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/requested_surface/);
  });
});
