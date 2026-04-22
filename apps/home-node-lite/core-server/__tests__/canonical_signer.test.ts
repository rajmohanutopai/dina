/**
 * canonical_signer tests — closes the 5.9 follow-up.
 */

import { createHash } from 'node:crypto';

import {
  EMPTY_BODY_HASH_HEX,
  buildCanonicalString,
  createCanonicalSigner,
} from '../src/brain/canonical_signer';
import {
  createEd25519Signer,
  verifyEd25519,
  type Ed25519Signer,
} from '../src/brain/ed25519_signer';

function seed(byte = 0x7): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (byte + i) & 0xff;
  return out;
}

function rig(): { did: string; signer: Ed25519Signer; publicKey: Uint8Array } {
  const ed = createEd25519Signer(seed(0x42));
  return {
    did: 'did:plc:brain-server',
    signer: ed,
    publicKey: ed.publicKey(),
  };
}

describe('buildCanonicalString', () => {
  it('joins fields with LF + upper-cases method', () => {
    const canon = buildCanonicalString({
      method: 'post',
      path: '/v1/vault/store',
      query: 'persona=general',
      timestamp: '1700000000000',
      nonce: 'ab12',
      bodyHashHex: 'abc',
    });
    expect(canon).toBe(
      'POST\n/v1/vault/store\npersona=general\n1700000000000\nab12\nabc',
    );
  });
});

describe('createCanonicalSigner — construction', () => {
  it.each([
    ['null opts', null],
    ['non-DID did', { did: 'alice', signer: rig().signer }],
    ['missing did', { signer: rig().signer }],
    ['missing signer', { did: 'did:plc:x' }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(
      () =>
        createCanonicalSigner(
          bad as unknown as Parameters<typeof createCanonicalSigner>[0],
        ),
    ).toThrow();
  });

  it('exposes the bound DID', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer });
    expect(s.did).toBe(did);
  });
});

describe('createCanonicalSigner.sign — shape', () => {
  it('returns the 4 canonical headers', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({
      did,
      signer,
      nowMsFn: () => 1700000000000,
      nonceFn: () => 'deadbeef',
    });
    const r = s.sign({ method: 'GET', path: '/v1/healthz' });
    expect(r.headers).toEqual({
      'x-did': did,
      'x-timestamp': '1700000000000',
      'x-nonce': 'deadbeef',
      'x-signature': expect.any(String),
    });
    expect(r.headers['x-signature'].length).toBeGreaterThan(0);
  });

  it('empty-body hash is precomputed SHA-256("")', () => {
    expect(EMPTY_BODY_HASH_HEX).toBe(
      createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    );
  });

  it.each([
    ['missing method', { path: '/x' }],
    ['empty method', { method: '', path: '/x' }],
    ['missing path', { method: 'GET' }],
    ['empty path', { method: 'GET', path: '' }],
    ['non-string query', { method: 'GET', path: '/x', query: 42 as unknown as string }],
    ['non-finite timestamp', { method: 'GET', path: '/x', timestampMs: Number.POSITIVE_INFINITY }],
    ['empty nonce', { method: 'GET', path: '/x', nonce: '' }],
  ] as const)('validates — %s', (_l, bad) => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer });
    expect(() =>
      s.sign(bad as unknown as Parameters<typeof s.sign>[0]),
    ).toThrow();
  });
});

describe('createCanonicalSigner.sign — body encoding', () => {
  it('object body JSON-encoded', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({
      did, signer,
      nowMsFn: () => 1, nonceFn: () => 'n',
    });
    const r = s.sign({
      method: 'POST',
      path: '/x',
      body: { k: 'v' },
    });
    expect(new TextDecoder().decode(r.bodyBytes)).toBe('{"k":"v"}');
  });

  it('string body UTF-8 encoded', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer, nowMsFn: () => 1, nonceFn: () => 'n' });
    const r = s.sign({ method: 'POST', path: '/x', body: 'hello' });
    expect(new TextDecoder().decode(r.bodyBytes)).toBe('hello');
  });

  it('Uint8Array body passed through', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer, nowMsFn: () => 1, nonceFn: () => 'n' });
    const bytes = new Uint8Array([1, 2, 3]);
    const r = s.sign({ method: 'POST', path: '/x', body: bytes });
    expect(Array.from(r.bodyBytes)).toEqual([1, 2, 3]);
  });

  it('undefined body → empty bytes + precomputed empty-hash in canonical string', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer, nowMsFn: () => 1, nonceFn: () => 'n' });
    const r = s.sign({ method: 'GET', path: '/x' });
    expect(r.bodyBytes.length).toBe(0);
    expect(r.canonicalString.endsWith(EMPTY_BODY_HASH_HEX)).toBe(true);
  });

  it('array body JSON-encoded', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer, nowMsFn: () => 1, nonceFn: () => 'n' });
    const r = s.sign({ method: 'POST', path: '/x', body: [1, 2, 3] });
    expect(new TextDecoder().decode(r.bodyBytes)).toBe('[1,2,3]');
  });
});

describe('createCanonicalSigner.sign — round trip', () => {
  it('signature verifies via verifyEd25519', () => {
    const { did, signer, publicKey } = rig();
    const s = createCanonicalSigner({
      did, signer,
      nowMsFn: () => 1_700_000_000_000,
      nonceFn: () => 'fixed-nonce',
    });
    const r = s.sign({
      method: 'POST',
      path: '/v1/vault/store',
      query: 'persona=general',
      body: { item: { type: 'email', summary: 's', timestamp: 1 } },
    });
    const sigBytes = new Uint8Array(Buffer.from(r.headers['x-signature'], 'base64'));
    const canonBytes = new TextEncoder().encode(r.canonicalString);
    expect(verifyEd25519(publicKey, canonBytes, sigBytes)).toBe(true);
  });

  it('tampered canonical string → verification fails', () => {
    const { did, signer, publicKey } = rig();
    const s = createCanonicalSigner({
      did, signer,
      nowMsFn: () => 1, nonceFn: () => 'n',
    });
    const r = s.sign({ method: 'GET', path: '/v1/healthz' });
    const sigBytes = new Uint8Array(Buffer.from(r.headers['x-signature'], 'base64'));
    // Tamper with the canonical string — sig must not verify.
    const tampered = new TextEncoder().encode(r.canonicalString + 'x');
    expect(verifyEd25519(publicKey, tampered, sigBytes)).toBe(false);
  });

  it('body hash changes with body content', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer, nowMsFn: () => 1, nonceFn: () => 'n' });
    const a = s.sign({ method: 'POST', path: '/x', body: { n: 1 } });
    const b = s.sign({ method: 'POST', path: '/x', body: { n: 2 } });
    expect(a.canonicalString).not.toBe(b.canonicalString);
    expect(a.headers['x-signature']).not.toBe(b.headers['x-signature']);
  });

  it('same timestamp + nonce + payload → same signature (deterministic Ed25519)', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({
      did, signer,
      nowMsFn: () => 1_700_000_000_000,
      nonceFn: () => 'fixed',
    });
    const a = s.sign({ method: 'POST', path: '/x', body: { n: 1 } });
    const b = s.sign({ method: 'POST', path: '/x', body: { n: 1 } });
    expect(a.headers['x-signature']).toBe(b.headers['x-signature']);
  });

  it('different nonces → different signatures for same payload', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer, nowMsFn: () => 1 });
    let n = 0;
    const s2 = createCanonicalSigner({
      did, signer, nowMsFn: () => 1,
      nonceFn: () => `nonce-${n++}`,
    });
    const a = s2.sign({ method: 'GET', path: '/x' });
    const b = s2.sign({ method: 'GET', path: '/x' });
    expect(a.headers['x-nonce']).not.toBe(b.headers['x-nonce']);
    expect(a.headers['x-signature']).not.toBe(b.headers['x-signature']);
    void s;
  });
});

describe('createCanonicalSigner — injection', () => {
  it('honours timestampMs override', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer });
    const r = s.sign({ method: 'GET', path: '/x', timestampMs: 123456, nonce: 'n' });
    expect(r.headers['x-timestamp']).toBe('123456');
  });

  it('honours nonce override', () => {
    const { did, signer } = rig();
    const s = createCanonicalSigner({ did, signer, nowMsFn: () => 1 });
    const r = s.sign({ method: 'GET', path: '/x', nonce: 'custom-nonce' });
    expect(r.headers['x-nonce']).toBe('custom-nonce');
  });

  it('sha256Fn override changes body hash', () => {
    const { did, signer } = rig();
    const canned = new Uint8Array(32);
    canned[0] = 0xde;
    canned[1] = 0xad;
    canned[31] = 0xef;
    const s = createCanonicalSigner({
      did, signer,
      nowMsFn: () => 1, nonceFn: () => 'n',
      sha256Fn: () => canned,
    });
    const r = s.sign({ method: 'POST', path: '/x', body: { n: 1 } });
    // Expected hex: 'de' + 'ad' + 29 * '00' + 'ef' (32 bytes total, 64 chars).
    expect(r.canonicalString.endsWith('dead' + '00'.repeat(29) + 'ef')).toBe(true);
  });
});
