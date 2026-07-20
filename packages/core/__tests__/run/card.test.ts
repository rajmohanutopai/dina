/**
 * ISVC-10 (E76-05/06) — payload integrity + classify-view rendering unit tests.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  parseRunMessagePayload,
  parseResultCardPayload,
  renderRunPayloadView,
} from '../../src/run/card';

const enc = new TextEncoder();

/** Build the wire envelope + the SHA-256 digests a provider would sign. */
function envelope(card: unknown, params: unknown): {
  payload: Uint8Array;
  cardDigest: string;
  paramsDigest: string;
} {
  const cardStr = JSON.stringify(card);
  const paramsStr = JSON.stringify(params);
  return {
    payload: enc.encode(JSON.stringify({ card: cardStr, params: paramsStr })),
    cardDigest: bytesToHex(sha256(enc.encode(cardStr))),
    paramsDigest: bytesToHex(sha256(enc.encode(paramsStr))),
  };
}

describe('parseRunMessagePayload (E76-05)', () => {
  it('accepts a card+params envelope whose bytes hash to the signed digests', () => {
    const { payload, cardDigest, paramsDigest } = envelope(
      { version: 1, blocks: [{ kind: 'title', text: 'Hi' }] },
      { a: 1 },
    );
    const r = parseRunMessagePayload(payload, cardDigest, paramsDigest);
    expect(r.ok).toBe(true);
  });

  it('rejects a card_digest mismatch', () => {
    const { payload, paramsDigest } = envelope({ version: 1, blocks: [] }, {});
    const r = parseRunMessagePayload(payload, 'c'.repeat(64), paramsDigest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('card_digest_mismatch');
  });

  it('rejects a params_digest mismatch', () => {
    const { payload, cardDigest } = envelope({ version: 1, blocks: [] }, { a: 1 });
    const r = parseRunMessagePayload(payload, cardDigest, 'p'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('params_digest_mismatch');
  });

  it('rejects a card that fails validateCardSpec (a non-object card)', () => {
    const { payload, cardDigest, paramsDigest } = envelope('not-a-card', {});
    const r = parseRunMessagePayload(payload, cardDigest, paramsDigest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_card');
  });

  it('rejects a non-envelope payload', () => {
    const r = parseRunMessagePayload(enc.encode('garbage'), 'a', 'b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed_envelope');
  });

  it('rejects an oversized payload', () => {
    const r = parseRunMessagePayload(new Uint8Array(64 * 1024 + 1), 'a', 'b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversized');
  });
});

describe('parseResultCardPayload (81B-04)', () => {
  /** A completion's result card is a BARE serialized CardSpec (no params envelope);
   *  the signed `result_card_digest` is over those exact card bytes. */
  function resultCard(card: unknown): { payload: Uint8Array; digest: string } {
    const bytes = enc.encode(JSON.stringify(card));
    return { payload: bytes, digest: bytesToHex(sha256(bytes)) };
  }

  it('accepts a bare result card whose bytes hash to the signed digest', () => {
    const { payload, digest } = resultCard({
      version: 1,
      blocks: [{ kind: 'title', text: 'Booked' }],
    });
    const r = parseResultCardPayload(payload, digest);
    expect(r.ok).toBe(true);
  });

  it('rejects a result card whose bytes do not hash to the signed digest', () => {
    const { payload } = resultCard({ version: 1, blocks: [] });
    const r = parseResultCardPayload(payload, 'c'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('card_digest_mismatch');
  });

  it('rejects a non-CardSpec payload even when its digest matches', () => {
    const { payload, digest } = resultCard('not-a-card');
    const r = parseResultCardPayload(payload, digest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_card');
  });

  it('rejects malformed (non-JSON) bytes even when its digest matches', () => {
    const payload = enc.encode('}{ not json');
    const digest = bytesToHex(sha256(payload));
    const r = parseResultCardPayload(payload, digest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('rejects an oversized result card', () => {
    const r = parseResultCardPayload(new Uint8Array(64 * 1024 + 1), 'a'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversized');
  });
});

describe('renderRunPayloadView (E76-06)', () => {
  it('renders the card title + body from a stored envelope', () => {
    const { payload } = envelope(
      { version: 1, blocks: [{ kind: 'title', text: 'Route 42' }, { kind: 'body', text: 'ETA 5m' }] },
      {},
    );
    const v = renderRunPayloadView(payload);
    expect(v.title).toBe('Route 42');
    expect(v.body).toContain('ETA 5m');
  });

  it('returns empty text for a non-envelope (never throws)', () => {
    expect(renderRunPayloadView(enc.encode('garbage'))).toEqual({ title: '', body: '' });
  });
});
