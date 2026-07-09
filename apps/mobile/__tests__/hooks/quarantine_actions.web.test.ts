/**
 * Web quarantine card actions — POST accept/block to the brain's compound
 * endpoints (F4/MRS-05). The E2E covers the happy path end-to-end; this pins
 * the URL/method/body contract + the fail-soft behavior deterministically.
 */

import { acceptQuarantine, blockQuarantine } from '../../src/hooks/quarantine_actions.web';

function mockFetch(impl: () => Promise<unknown>): jest.Mock {
  const m = jest.fn(impl);
  (globalThis as unknown as { fetch: unknown }).fetch = m;
  return m;
}

describe('quarantine_actions.web', () => {
  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = undefined;
  });

  // A realistic browser Response has `.json()` — the accept path reads it to
  // detect a PARTIAL release (`requarantined`).
  const okResponse = (body: unknown = {}) => ({ ok: true, json: async () => body });

  it('accept POSTs sender_did to /accept and returns true on a clean release', async () => {
    const m = mockFetch(async () => okResponse({ requarantined: 0 }));
    const ok = await acceptQuarantine('q-1', 'did:plc:x');
    expect(ok).toBe(true);
    expect(m).toHaveBeenCalledWith(
      '/api/v1/d2d/quarantine/accept',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ sender_did: 'did:plc:x' }) }),
    );
  });

  it('accept returns FALSE on a PARTIAL release (some messages re-quarantined)', async () => {
    // Core trusted the sender but couldn't re-stage every message → not a clean
    // success; the card must stay unresolved / retryable, not claim delivery.
    mockFetch(async () => okResponse({ requarantined: 1 }));
    expect(await acceptQuarantine('q-1', 'did:plc:x')).toBe(false);
  });

  it('block POSTs sender_did to /block', async () => {
    const m = mockFetch(async () => okResponse());
    const ok = await blockQuarantine('q-2', 'did:plc:y');
    expect(ok).toBe(true);
    expect(m).toHaveBeenCalledWith(
      '/api/v1/d2d/quarantine/block',
      expect.objectContaining({ body: JSON.stringify({ sender_did: 'did:plc:y' }) }),
    );
  });

  it('returns false on a non-ok response (card stays unresolved)', async () => {
    mockFetch(async () => ({ ok: false }));
    expect(await acceptQuarantine('q-1', 'did:plc:x')).toBe(false);
  });

  it('returns false (never throws) on a network failure', async () => {
    mockFetch(() => Promise.reject(new Error('network down')));
    expect(await blockQuarantine('q-1', 'did:plc:x')).toBe(false);
  });
});
