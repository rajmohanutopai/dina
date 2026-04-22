/**
 * DEF-1 — egress integration tests for service.query / service.response
 * in `sendD2D`.
 *
 * Focus: verify the bypass path does what the decision layer promises,
 * and that the existing gates still fire for non-service traffic
 * (regression coverage).
 */

import { sendD2D } from '../../src/d2d/send';
import { addContact, clearGatesState } from '../../src/d2d/gates';
import { setDeliveryFetchFn, resetDeliveryDeps } from '../../src/transport/delivery';
import { clearOutbox } from '../../src/transport/outbox';
import { resetAuditState } from '../../src/audit/service';
import { getPublicKey } from '../../src/crypto/ed25519';
import {
  providerWindow,
  resetServiceWindows,
  setProviderWindow,
  requesterWindow,
} from '../../src/service/windows';
import type { ProviderServiceResolver } from '../../src/service/bypass';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const senderPriv = TEST_ED25519_SEED;
const senderDID = 'did:plc:sender';
const busDID = 'did:plc:bus42';
const recipientPub = getPublicKey(new Uint8Array(32).fill(0x42));

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

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    recipientDID: busDID,
    messageType: 'service.query',
    body: JSON.stringify(queryBody),
    senderDID,
    senderPrivateKey: senderPriv,
    recipientPublicKey: recipientPub,
    serviceType: 'DinaMsgBox' as const,
    endpoint: 'wss://mailbox.dinakernel.com',
    ...overrides,
  };
}

function okFetch(): jest.Mock {
  // MsgBox returns `{status: 'delivered'}` or `{status: 'buffered'}`; the
  // delivery module only marks a send successful when status matches.
  return jest.fn(
    async () => new Response(JSON.stringify({ status: 'delivered' }), { status: 200 }),
  );
}

function resolverThat(answer: boolean): ProviderServiceResolver {
  return { isDiscoverableService: async () => answer };
}

beforeEach(() => {
  clearGatesState();
  clearOutbox();
  resetAuditState();
  resetServiceWindows();
  setDeliveryFetchFn(okFetch());
});

afterAll(() => {
  resetDeliveryDeps();
  resetServiceWindows();
});

// ---------------------------------------------------------------------------
// service.query — egress bypass
// ---------------------------------------------------------------------------

describe('sendD2D — service.query egress bypass', () => {
  it('allows send to a public-service DID with NO contact entry', async () => {
    const result = await sendD2D(
      baseReq({
        providerServiceResolver: resolverThat(true),
      }),
    );
    expect(result.sent).toBe(true);
    expect(result.deniedAt).toBeUndefined();
  });

  it('denies send when the resolver says NOT public', async () => {
    const result = await sendD2D(
      baseReq({
        providerServiceResolver: resolverThat(false),
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.deniedAt).toBe('service_bypass');
    expect(result.error).toMatch(/does not advertise/);
  });

  it('without a resolver, still requires the contact gate (no silent bypass)', async () => {
    // No resolver passed; contact not added → contact gate denies.
    const result = await sendD2D(baseReq({}));
    expect(result.sent).toBe(false);
    expect(result.deniedAt).toBe('contact');
  });

  it('without a resolver but WITH a contact, contact-gate allows normally', async () => {
    addContact(busDID);
    const result = await sendD2D(baseReq({}));
    expect(result.sent).toBe(true);
  });

  it('opens the requester window on successful bypass', async () => {
    await sendD2D(baseReq({ providerServiceResolver: resolverThat(true) }));
    expect(requesterWindow().peek(busDID, queryBody.query_id, queryBody.capability)).toBe(true);
  });

  it('rejects malformed service.query body (decision layer catches it)', async () => {
    const result = await sendD2D(
      baseReq({
        body: '{not json',
        providerServiceResolver: resolverThat(true),
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.deniedAt).toBe('service_bypass');
    expect(result.error).toMatch(/invalid JSON/);
  });

  it('rejects body missing query_id', async () => {
    const bad = { capability: 'eta_query', params: {}, ttl_seconds: 30 };
    const result = await sendD2D(
      baseReq({
        body: JSON.stringify(bad),
        providerServiceResolver: resolverThat(true),
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/query_id/);
  });
});

// ---------------------------------------------------------------------------
// service.response — provider-window reserve/commit/release
// ---------------------------------------------------------------------------

describe('sendD2D — service.response provider window', () => {
  it('allows send when a provider window exists; commits on success', async () => {
    setProviderWindow(busDID, responseBody.query_id, responseBody.capability, 60);

    const result = await sendD2D(
      baseReq({
        messageType: 'service.response',
        body: JSON.stringify(responseBody),
      }),
    );

    expect(result.sent).toBe(true);
    // Committed → entry consumed.
    expect(providerWindow().size()).toBe(0);
  });

  it('denies send when no provider window is open', async () => {
    const result = await sendD2D(
      baseReq({
        messageType: 'service.response',
        body: JSON.stringify(responseBody),
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.deniedAt).toBe('service_bypass');
    expect(result.error).toMatch(/no provider window/);
  });

  it('two concurrent responses: exactly one succeeds (race guard)', async () => {
    setProviderWindow(busDID, responseBody.query_id, responseBody.capability, 60);

    const [r1, r2] = await Promise.all([
      sendD2D(
        baseReq({
          messageType: 'service.response',
          body: JSON.stringify(responseBody),
        }),
      ),
      sendD2D(
        baseReq({
          messageType: 'service.response',
          body: JSON.stringify(responseBody),
        }),
      ),
    ]);

    const winners = [r1, r2].filter((r) => r.sent).length;
    expect(winners).toBe(1);
  });

  it('release after network error → next attempt can re-reserve', async () => {
    setProviderWindow(busDID, responseBody.query_id, responseBody.capability, 60);

    // Inject a throwing fetch → delivery catch block runs.
    setDeliveryFetchFn(
      jest.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const first = await sendD2D(
      baseReq({
        messageType: 'service.response',
        body: JSON.stringify(responseBody),
      }),
    );
    expect(first.sent).toBe(true); // queued
    expect(first.queued).toBe(true);
    expect(first.delivered).toBe(false);

    // Window still present, not reserved.
    expect(providerWindow().size()).toBe(1);
    expect(providerWindow().reserve(busDID, responseBody.query_id, responseBody.capability)).toBe(
      true,
    );
  });

  it('validates response body before touching the window', async () => {
    setProviderWindow(busDID, responseBody.query_id, responseBody.capability, 60);

    const result = await sendD2D(
      baseReq({
        messageType: 'service.response',
        body: JSON.stringify({ ...responseBody, status: 'maybe' }),
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/status/);
    // Window is untouched — still reservable.
    expect(providerWindow().reserve(busDID, responseBody.query_id, responseBody.capability)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Regression — non-service traffic unchanged
// ---------------------------------------------------------------------------

describe('sendD2D — non-service traffic regression', () => {
  it('social.update still requires a contact (no silent bypass)', async () => {
    const result = await sendD2D(
      baseReq({
        messageType: 'social.update',
        body: JSON.stringify({ text: 'hi' }),
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.deniedAt).toBe('contact');
  });

  it('safety.alert still bypasses scenario gate', async () => {
    addContact(busDID);
    const result = await sendD2D(
      baseReq({
        messageType: 'safety.alert',
        body: JSON.stringify({ message: 'fire', severity: 'high' }),
      }),
    );
    expect(result.sent).toBe(true);
  });

  it('invalid V1 type is still rejected', async () => {
    const result = await sendD2D(
      baseReq({
        messageType: 'unknown.weird',
        body: '{}',
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.deniedAt).toBe('type_enforcement');
  });
});
