/**
 * SLIP-0010 for P-256 ("Nist256p1 seed"), against the official vectors
 * (https://github.com/satoshilabs/slips/blob/master/slip-0010.md), plus the
 * frozen Dina vectors for the ES256 signing keys at m/9999'/5'/{generation}'
 * (A2A, docs/A2A_IMPLEMENTATION_PLAN.md D4) and m/9999'/6'/{generation}' (UCP,
 * docs/UCP_IMPLEMENTATION_PLAN.md §3.1). Only hardened steps are checked:
 * Dina derives nothing else.
 */

import { p256 } from '@noble/curves/nist.js';

import { deriveP256SigningKey, derivePath, derivePathP256, deriveUcpSigningKey } from '../../src';
import { deriveMasterKeyP256 } from '../../src/crypto/slip0010';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

describe('SLIP-0010 nist256p1 official vectors', () => {
  const seed1 = bytes('000102030405060708090a0b0c0d0e0f');

  it('test vector 1: master', () => {
    const m = deriveMasterKeyP256(seed1);
    expect(hex(m.chainCode)).toBe(
      'beeb672fe4621673f722f38529c07392fecaa61015c80c34f29ce8b41b3cb6ea',
    );
    expect(hex(m.key)).toBe('612091aaa12e22dd2abef664f8a01a82cae99ad7441b7ef8110424915c268bc2');
  });

  it("test vector 1: m/0'", () => {
    const k = derivePathP256(seed1, "m/0'");
    expect(hex(k.chainCode)).toBe(
      '3460cea53e6a6bb5fb391eeef3237ffd8724bf0a40e94943c98b83825342ee11',
    );
    expect(hex(k.privateKey)).toBe(
      '6939694369114c67917a182c59ddb8cafc3004e63ca5d3b84403ba8613debc0c',
    );
    expect(hex(k.publicKey)).toBe(
      '0384610f5ecffe8fda089363a41f56a5c7ffc1d81b59a612d0d649b2d22355590c',
    );
  });

  it("derivation retry: m/28578' takes the 0x01 || IR re-hash", () => {
    const k = derivePathP256(seed1, "m/28578'");
    expect(hex(k.chainCode)).toBe(
      'e94c8ebe30c2250a14713212f6449b20f3329105ea15b652ca5bdfc68f6c65c2',
    );
    expect(hex(k.privateKey)).toBe(
      '06f0db126f023755d0b8d86d4591718a5210dd8d024e3e14b6159d63f53aa669',
    );
    expect(hex(k.publicKey)).toBe(
      '02519b5554a4872e8c9c1c847115363051ec43e93400e030ba3c36b52a3e70a5b7',
    );
  });

  it('seed retry: the first I is not a valid key', () => {
    const m = deriveMasterKeyP256(
      bytes('a7305bc8df8d0951f0cb224c0e95d7707cbdf2c6ce7e8d481fec69c7ff5e9446'),
    );
    expect(hex(m.chainCode)).toBe(
      '7762f9729fed06121fd13f326884c82f59aa95c57ac492ce8c9654e60efd130c',
    );
    expect(hex(m.key)).toBe('3b8c18469a4634517d6d0b65448f8e6c62091b45540a1743c5846be55d47d88f');
  });

  it('test vector 2: master', () => {
    const m = deriveMasterKeyP256(
      bytes(
        'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542',
      ),
    );
    expect(hex(m.chainCode)).toBe(
      '96cd4465a9644e31528eda3592aa35eb39a9527769ce1855beafc1b81055e75d',
    );
    expect(hex(m.key)).toBe('eaa31c2e46ca2962227cf21d73a7ef0ce8b31c756897521eb6c7b39796633357');
  });
});

describe("Dina ES256 signing key at m/9999'/5'/{generation}'", () => {
  const seed = bytes('b0a1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f');

  it('is frozen for generation 0 and 1', () => {
    const g0 = deriveP256SigningKey(seed, 0);
    expect(hex(g0.privateKey)).toBe(
      '0356a08dc41101d9aed496e51a079ba22d851e88ccf71c438c67aeeb8939b583',
    );
    expect(hex(g0.publicKey)).toBe(
      '0250b035a25b41bc47337931b52a383efae4562bd71070bfbef0cff5666b632997',
    );
    const g1 = deriveP256SigningKey(seed, 1);
    expect(hex(g1.privateKey)).toBe(
      '1182299a10f59738b8655768ea7a625851fbe6b1f87487c93eee6554bdcab2e1',
    );
    expect(hex(g1.publicKey)).toBe(
      '037732eb953bcd11655e588ce210afc3e48b4fa7aaa60965f07ee8c58e9277c3c4',
    );
  });

  it("equals the generic path m/9999'/5'/0'", () => {
    expect(deriveP256SigningKey(seed, 0)).toEqual(derivePathP256(seed, "m/9999'/5'/0'"));
  });

  it('signs and verifies ES256 (the raw r||s form JWS uses)', () => {
    const key = deriveP256SigningKey(seed, 0);
    const msg = new TextEncoder().encode('jws signing input');
    const sig = p256.sign(msg, key.privateKey);
    expect(sig).toHaveLength(64);
    expect(p256.verify(sig, msg, key.publicKey)).toBe(true);
  });

  it('keeps the same hardened-only and no-44 rules as the other curves', () => {
    expect(() => derivePathP256(seed, 'm/9999/5/0')).toThrow(/hardened/);
    expect(() => derivePathP256(seed, "m/44'/0'")).toThrow(/44/);
    expect(() => derivePathP256(new Uint8Array(32), "m/9999'/5'/0'")).toThrow(/all-zero/);
  });

  it.each([1.5, -1, 2 ** 31, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses generation %p instead of deriving some other key',
    (generation) => {
      expect(() => deriveP256SigningKey(seed, generation)).toThrow(/generation/);
    },
  );

  it.each([
    "m/9999'/5'/01'",
    "m/9999'/5'/1.5'",
    "m/9999'/5'/2147483648'",
    "m/9999'/5'/+1'",
    "m/9999'/5'/'",
  ])('refuses the non-canonical or out-of-range path %s', (path) => {
    expect(() => derivePathP256(seed, path)).toThrow(/invalid index/);
    expect(() => derivePath(seed, path)).toThrow(/invalid index/);
  });

  it('still accepts the largest hardened index', () => {
    expect(() => derivePathP256(seed, "m/9999'/5'/2147483647'")).not.toThrow();
  });

  it('never yields the same key as the Ed25519 tree at the same path', () => {
    // Different HMAC curve keys separate the trees even at an identical path.
    expect(hex(deriveP256SigningKey(seed, 0).privateKey)).not.toBe(
      hex(derivePath(seed, "m/9999'/5'/0'").privateKey),
    );
  });
});

describe("Dina UCP signing key at m/9999'/6'/{generation}'", () => {
  const seed = bytes('b0a1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f');

  // The private keys were also computed by an independent SLIP-0010 script
  // (HMAC-SHA512 and addition mod n only), not just copied from this code.
  it('is frozen for generation 0 and 1', () => {
    const g0 = deriveUcpSigningKey(seed, 0);
    expect(hex(g0.privateKey)).toBe(
      '9d085278bb3ed9c89e4ad5d05b34e6805a52c903aca30a65655560fd5bada0c6',
    );
    expect(hex(g0.publicKey)).toBe(
      '03f92cde21e978a9886726cc37e966e4841d18837f7a4e23ecd6d397d774e9186f',
    );
    const g1 = deriveUcpSigningKey(seed, 1);
    expect(hex(g1.privateKey)).toBe(
      '1ea2796920542ab16c1e4499b7503022a134fa82db9dc715f8f168c11a12d1cd',
    );
    expect(hex(g1.publicKey)).toBe(
      '031b9426ac6caf1bd386830ed8b23b1d979bb9ceeb4530e476470580233a0ce5e8',
    );
  });

  it("equals the generic path m/9999'/6'/0', and is never the A2A key", () => {
    expect(deriveUcpSigningKey(seed, 0)).toEqual(derivePathP256(seed, "m/9999'/6'/0'"));
    expect(deriveUcpSigningKey(seed, 0).privateKey).not.toEqual(
      deriveP256SigningKey(seed, 0).privateKey,
    );
  });

  it.each([1.5, -1, 2 ** 31, Number.NaN])('refuses generation %p', (generation) => {
    expect(() => deriveUcpSigningKey(seed, generation)).toThrow(/generation/);
  });
});
