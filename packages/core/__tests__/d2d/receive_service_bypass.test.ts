/**
 * DEF-2 — ingress bypass tests for `service.query` / `service.response` in
 * the receive pipeline.
 */

import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { resetStagingState } from '../../src/staging/service';
import { resetAuditState, queryAudit } from '../../src/audit/service';
import { resetQuarantineState } from '../../src/d2d/quarantine';
import { clearReplayCache } from '../../src/transport/adversarial';
import { getPublicKey } from '../../src/crypto/ed25519';
import {
  providerWindow,
  requesterWindow,
  resetServiceWindows,
  setRequesterWindow,
} from '../../src/service/windows';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const senderPriv = TEST_ED25519_SEED;
const senderPub = getPublicKey(senderPriv);
const recipientPriv = new Uint8Array(32).fill(0x42);
const recipientPub = getPublicKey(recipientPriv);

const BUS_DID = 'did:plc:bus42';
const REQUESTER_DID = 'did:plc:requester';

const queryBody = {
  query_id: 'q-test-1',
  capability: 'eta_query',
  params: { location: { lat: 37.77, lng: -122.41 } },
  ttl_seconds: 60,
};

const responseBody = {
  query_id: 'q-test-1',
  capability: 'eta_query',
  status: 'success' as const,
  result: { eta_minutes: 45 },
  ttl_seconds: 60,
};

function buildSealed(overrides?: Partial<DinaMessage>) {
  const msg: DinaMessage = {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'service.query',
    from: REQUESTER_DID,
    to: 'did:plc:recipient',
    created_time: Date.now(),
    body: JSON.stringify(queryBody),
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
  resetServiceWindows();
});

afterAll(() => {
  resetServiceWindows();
});

// ---------------------------------------------------------------------------
// service.query ingress
// ---------------------------------------------------------------------------

describe('receive_pipeline — service.query ingress', () => {
  it('bypasses when the capability is configured locally', () => {
    const payload = buildSealed({ from: REQUESTER_DID });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown', {
      isCapabilityConfigured: (cap) => cap === 'eta_query',
    });

    expect(result.action).toBe('bypassed');
    expect(result.messageType).toBe('service.query');
    expect(result.senderDID).toBe(REQUESTER_DID);
    expect(result.bypassedBody).toMatchObject({
      query_id: queryBody.query_id,
      capability: queryBody.capability,
    });
  });

  it('opens the provider window for future response egress', () => {
    const payload = buildSealed({ from: REQUESTER_DID });
    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown', {
      isCapabilityConfigured: (cap) => cap === 'eta_query',
    });

    expect(providerWindow().peek(REQUESTER_DID, queryBody.query_id, queryBody.capability)).toBe(
      true,
    );
  });

  it('drops when the capability is not configured', () => {
    const payload = buildSealed({ from: REQUESTER_DID });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown', {
      isCapabilityConfigured: () => false,
    });

    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/not configured/);
    // Provider window was never opened.
    expect(providerWindow().size()).toBe(0);
  });

  it('drops with body_invalid reason on malformed body', () => {
    const payload = buildSealed({
      from: REQUESTER_DID,
      body: JSON.stringify({ capability: 'eta_query' }), // missing query_id
    });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown', {
      isCapabilityConfigured: () => true,
    });

    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/query_id/);
  });

  it('blocked sender is dropped even with valid capability', () => {
    const payload = buildSealed({ from: REQUESTER_DID });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'blocked', {
      isCapabilityConfigured: () => true,
    });

    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/blocked/);
    expect(providerWindow().size()).toBe(0);
  });

  it('emits structured audit for accepted service.query', () => {
    const payload = buildSealed({ from: REQUESTER_DID, id: 'msg-accept' });
    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown', {
      isCapabilityConfigured: () => true,
    });

    const entries = queryAudit({});
    const accept = entries.find((e) => e.action === 'd2d_recv_service_accepted');
    expect(accept).toBeDefined();
    expect(accept?.detail).toContain('capability=eta_query');
  });

  it('emits structured audit for denied service.query', () => {
    const payload = buildSealed({ from: REQUESTER_DID });
    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown', {
      isCapabilityConfigured: () => false,
    });

    const entries = queryAudit({});
    const deny = entries.find((e) => e.action === 'd2d_recv_service_denied');
    expect(deny).toBeDefined();
    expect(deny?.detail).toContain('reason=not_configured');
  });
});

// ---------------------------------------------------------------------------
// service.response ingress
// ---------------------------------------------------------------------------

describe('receive_pipeline — service.response ingress', () => {
  it('bypasses and consumes the requester window on match', () => {
    // Pre-open the requester window (as sendD2D would).
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);

    const payload = buildSealed({
      type: 'service.response',
      from: BUS_DID,
      body: JSON.stringify(responseBody),
    });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    expect(result.action).toBe('bypassed');
    // Window is consumed — one-shot.
    expect(requesterWindow().size()).toBe(0);
  });

  it('drops when no requester window exists (spoof guard)', () => {
    const payload = buildSealed({
      type: 'service.response',
      from: BUS_DID,
      body: JSON.stringify(responseBody),
    });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/no active requester window/);
  });

  it('drops when window belongs to a different DID', () => {
    // Open window for a DIFFERENT DID than the sender.
    setRequesterWindow('did:plc:other', responseBody.query_id, responseBody.capability, 60);

    const payload = buildSealed({
      type: 'service.response',
      from: BUS_DID,
      body: JSON.stringify(responseBody),
    });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    expect(result.action).toBe('dropped');
    // Original window is NOT consumed.
    expect(requesterWindow().size()).toBe(1);
  });

  it('second response for the same window is dropped (one-shot)', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);

    const first = receiveD2D(
      buildSealed({
        type: 'service.response',
        from: BUS_DID,
        body: JSON.stringify(responseBody),
        id: 'msg-first',
      }),
      recipientPub,
      recipientPriv,
      [senderPub],
      'unknown',
    );
    expect(first.action).toBe('bypassed');

    const second = receiveD2D(
      buildSealed({
        type: 'service.response',
        from: BUS_DID,
        body: JSON.stringify(responseBody),
        id: 'msg-second',
      }),
      recipientPub,
      recipientPriv,
      [senderPub],
      'unknown',
    );
    expect(second.action).toBe('dropped');
  });

  it('blocked sender is dropped even with an open window', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);

    const payload = buildSealed({
      type: 'service.response',
      from: BUS_DID,
      body: JSON.stringify(responseBody),
    });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'blocked');

    expect(result.action).toBe('dropped');
    expect(result.reason).toMatch(/blocked/);
    // Window untouched.
    expect(requesterWindow().size()).toBe(1);
  });

  it('drops malformed response body without consuming the window', () => {
    setRequesterWindow(BUS_DID, responseBody.query_id, responseBody.capability, 60);

    const payload = buildSealed({
      type: 'service.response',
      from: BUS_DID,
      body: JSON.stringify({ ...responseBody, status: 'maybe' }),
    });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');

    expect(result.action).toBe('dropped');
    expect(requesterWindow().size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression — non-service traffic unchanged
// ---------------------------------------------------------------------------

describe('receive_pipeline — non-service regression', () => {
  it('social.update still stages / quarantines as before', () => {
    const payload = buildSealed({
      type: 'social.update',
      body: JSON.stringify({ text: 'hi' }),
    });
    const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');
    // 'unknown' sender → quarantine, not bypass.
    expect(result.action).toBe('quarantined');
  });
});
