/**
 * DEF-2 — ingress bypass tests for `service.query` / `service.response` in
 * the receive pipeline.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { resetAuditState, queryAudit } from '../../src/audit/service';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { resetQuarantineState } from '../../src/d2d/quarantine';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import {
  providerWindow,
  requesterWindow,
  resetServiceWindows,
  setRequesterWindow,
} from '../../src/service/windows';
import { resetStagingState } from '../../src/staging/service';
import { clearReplayCache } from '../../src/transport/adversarial';


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

  it('bounds and single-lines a hostile capability before it reaches the audit chain', () => {
    // §22 — on an inbound `service.query` the peer chooses `capability`
    // freely, and the wire validator asks only for a non-empty string: no
    // length bound, no charset limit, no newline exclusion. It is interpolated
    // straight into the `d2d_recv_service_accepted` detail, so unbounded a
    // peer can write as much as it likes into the owner's durable log — and
    // embedded newlines make one entry render as several, dressing a forged
    // line up as a real audit record.
    //
    // CAPABILITY, not `query_id`, and the difference is the whole test. On the
    // RESPONSE path both fields must match a window the buyer itself opened
    // (`requester.peek(fromDID, query_id, capability)`), so a peer cannot
    // choose them there. On the QUERY path there is no window yet, and this is
    // the field that reaches a log. A first version of this test drove
    // `query_id` and passed with the guard removed, because that value never
    // reaches an audit detail on this path — it was asserting nothing.
    //
    // Bounded at the SINK rather than per call site: three lines already
    // interpolated peer strings this way and the next would have had to
    // remember. `appendAudit` cannot be bypassed.
    const hostile = `cap-${'A'.repeat(900)}\nd2d_recv_service_accepted forged=yes`;
    const payload = buildSealed({
      body: JSON.stringify({ ...queryBody, capability: hostile }),
    });

    receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown', {
      isCapabilityConfigured: () => true,
    });

    const entries = queryAudit({});
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // No entry can be made to look like two.
      expect(entry.detail).not.toContain('\n');
      expect(entry.detail).not.toContain('\r');
      // And none can be made unbounded.
      expect((entry.detail ?? '').length).toBeLessThanOrEqual(512);
    }
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
