/**
 * pairing_qr_payload tests.
 */

import {
  BuildQrError,
  PAIRING_PROTOCOL_VERSION,
  QR_SCHEME,
  buildPairingQr,
  parseQrPayload,
  type BuildQrInput,
} from '../src/brain/pairing_qr_payload';

function input(overrides: Partial<BuildQrInput> = {}): BuildQrInput {
  return {
    did: 'did:plc:homenode',
    endpoint: 'https://home.local:8100',
    challenge: 'abc123',
    expiresAtSec: 2_000_000_000,
    ...overrides,
  };
}

describe('constants', () => {
  it('QR_SCHEME is dina://pair/v1/', () => {
    expect(QR_SCHEME).toBe('dina://pair/v1/');
  });

  it('PAIRING_PROTOCOL_VERSION is 1', () => {
    expect(PAIRING_PROTOCOL_VERSION).toBe(1);
  });
});

describe('buildPairingQr — input validation', () => {
  it.each([
    ['null input', null],
    ['missing did', { ...input(), did: undefined as unknown as string }],
    ['non-DID did', { ...input(), did: 'not-a-did' }],
    ['empty endpoint', { ...input(), endpoint: '' }],
    ['malformed endpoint', { ...input(), endpoint: 'not a url' }],
    ['non-http endpoint', { ...input(), endpoint: 'ftp://x' }],
    ['empty challenge', { ...input(), challenge: '' }],
    ['zero expiry', { ...input(), expiresAtSec: 0 }],
    ['negative expiry', { ...input(), expiresAtSec: -1 }],
    ['NaN expiry', { ...input(), expiresAtSec: Number.NaN }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => buildPairingQr(bad as BuildQrInput)).toThrow(BuildQrError);
  });
});

describe('buildPairingQr — happy path', () => {
  it('produces a dina://pair/v1/<base64url> URL', () => {
    const qr = buildPairingQr(input());
    expect(qr.startsWith(QR_SCHEME)).toBe(true);
    const body = qr.slice(QR_SCHEME.length);
    expect(body.length).toBeGreaterThan(0);
    // base64url: [A-Za-z0-9_-]+, no padding.
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trip: build → parse returns the same fields', () => {
    const original = input({ deviceName: "Alonso's iPad" });
    const qr = buildPairingQr(original);
    const result = parseQrPayload(qr);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.did).toBe(original.did);
      expect(result.payload.endpoint).toBe(original.endpoint);
      expect(result.payload.challenge).toBe(original.challenge);
      expect(result.payload.expiresAtSec).toBe(original.expiresAtSec);
      expect(result.payload.deviceName).toBe("Alonso's iPad");
    }
  });

  it('omits deviceName when not supplied', () => {
    const qr = buildPairingQr(input());
    const result = parseQrPayload(qr);
    if (result.ok) expect(result.payload.deviceName).toBeUndefined();
  });
});

describe('parseQrPayload — input validation', () => {
  it.each([
    ['empty string', ''],
    ['null', null as unknown as string],
    ['non-string', 42 as unknown as string],
  ] as const)('%s → empty reason', (_l, bad) => {
    const r = parseQrPayload(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('wrong scheme → bad_scheme', () => {
    const r = parseQrPayload('https://example.com');
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('bad_scheme');
  });

  it('missing version segment → bad_version', () => {
    const r = parseQrPayload('dina://pair/');
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('bad_version');
  });

  it('unknown version → bad_version with version echoed', () => {
    const r = parseQrPayload('dina://pair/v99/somethingelse');
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('bad_version');
    if (r.reason === 'bad_version') expect(r.version).toBe('v99');
  });

  it('empty body → bad_encoding', () => {
    const r = parseQrPayload('dina://pair/v1/');
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('bad_encoding');
  });

  it('non-base64url body → bad_encoding', () => {
    const r = parseQrPayload('dina://pair/v1/!!@@##');
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('bad_encoding');
  });

  it('valid base64 but invalid JSON → bad_payload', () => {
    // "not json" base64url
    const body = Buffer.from('not json', 'utf8').toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const r = parseQrPayload(`dina://pair/v1/${body}`);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('bad_payload');
  });
});

describe('parseQrPayload — payload validation', () => {
  function craftWithPayload(payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    return `${QR_SCHEME}${body}`;
  }

  it.each([
    ['non-object payload', '"just-a-string"'],
    ['wrong version', { version: 2, did: 'did:plc:x', endpoint: 'https://x', challenge: 'c', expiresAtSec: 1 }],
    ['missing did', { version: 1, endpoint: 'https://x', challenge: 'c', expiresAtSec: 1 }],
    ['non-DID did', { version: 1, did: 'x', endpoint: 'https://x', challenge: 'c', expiresAtSec: 1 }],
    ['empty endpoint', { version: 1, did: 'did:plc:x', endpoint: '', challenge: 'c', expiresAtSec: 1 }],
    ['non-http endpoint', { version: 1, did: 'did:plc:x', endpoint: 'ftp://x', challenge: 'c', expiresAtSec: 1 }],
    ['missing challenge', { version: 1, did: 'did:plc:x', endpoint: 'https://x', expiresAtSec: 1 }],
    ['non-positive expiresAtSec', { version: 1, did: 'did:plc:x', endpoint: 'https://x', challenge: 'c', expiresAtSec: 0 }],
    ['non-string deviceName', { version: 1, did: 'did:plc:x', endpoint: 'https://x', challenge: 'c', expiresAtSec: 1, deviceName: 42 }],
  ] as const)('%s → bad_payload', (_l, payload) => {
    const qr = typeof payload === 'string' ? craftWithPayload(JSON.parse(payload)) : craftWithPayload(payload);
    const r = parseQrPayload(qr);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('bad_payload');
  });
});

describe('parseQrPayload — expiry check', () => {
  it('expired when nowSec > expiresAtSec', () => {
    const qr = buildPairingQr(input({ expiresAtSec: 1000 }));
    const r = parseQrPayload(qr, { nowSec: 2000 });
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('expired');
    if (r.reason === 'expired') {
      expect(r.expiresAtSec).toBe(1000);
      expect(r.nowSec).toBe(2000);
    }
  });

  it('not expired when nowSec < expiresAtSec', () => {
    const qr = buildPairingQr(input({ expiresAtSec: 2000 }));
    const r = parseQrPayload(qr, { nowSec: 1000 });
    expect(r.ok).toBe(true);
  });

  it('no nowSec → no expiry check', () => {
    const qr = buildPairingQr(input({ expiresAtSec: 1 }));
    const r = parseQrPayload(qr);
    expect(r.ok).toBe(true);
  });

  it('nowSec === expiresAtSec → expired (inclusive)', () => {
    const qr = buildPairingQr(input({ expiresAtSec: 1000 }));
    const r = parseQrPayload(qr, { nowSec: 1000 });
    if (r.ok) throw new Error('expected expired');
    expect(r.reason).toBe('expired');
  });
});

describe('buildPairingQr — QR density', () => {
  it('payload is reasonably compact', () => {
    const qr = buildPairingQr(input({ deviceName: "Alonso's iPad" }));
    // Typical QR codes handle up to ~400 alphanumeric chars easily; we
    // should be well under that.
    expect(qr.length).toBeLessThan(400);
  });
});
