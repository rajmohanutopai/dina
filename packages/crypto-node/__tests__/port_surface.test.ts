/**
 * Task 3.29 — per-method test coverage audit closure.
 *
 * Each primitive has its own dedicated test file (ed25519, x25519,
 * secp256k1, hashes, hkdf, sealed-box, argon2, random) exercising
 * deterministic RFC / OWASP / libsodium vectors plus boundary cases.
 * Byte-parity against Go Core lives in `cross_runtime_fixtures.test.ts`.
 *
 * This file closes out the gaps those per-primitive files don't
 * naturally cover:
 *
 *   1. **Aggregate port shape.** Every method declared on the port
 *      interfaces is reachable on `NodeCryptoAdapter`, returns a Promise,
 *      and produces a plain `Uint8Array` (not a Buffer subclass) where
 *      the contract calls for it.
 *
 *   2. **Module-load side effect.** The `@noble/ed25519` SHA-512 hook
 *      that's installed at module load (without it, `ed.sign` /
 *      `ed.getPublicKey` throw). Implicitly verified by every ed25519
 *      test, but pinned here explicitly so a future refactor that
 *      drops the hook surfaces immediately.
 *
 *   3. **OWASP defaults export.** `ARGON2_OWASP_DEFAULTS` is the
 *      canonical reference for the vault-KDF cost profile. Pin its
 *      values so callers (crypto-expo, test code) can trust them.
 *
 *   4. **Loader caching.** `loadSodium` + `loadArgon2` are one-shot
 *      async loaders — the cache means repeated calls don't re-enter
 *      `import()`. Verified indirectly by the sealed-box / argon2
 *      per-primitive files running multiple operations quickly; here
 *      we time a cold-start + warm-start pair as a weak sanity check
 *      (catches obvious regressions like accidentally clearing the
 *      cache on every call).
 */

import * as ed from '@noble/ed25519';
import { NodeCryptoAdapter, ARGON2_OWASP_DEFAULTS, type CryptoAdapterNode } from '../src';

describe('NodeCryptoAdapter — port-surface coverage audit (3.29)', () => {
  const adapter: CryptoAdapterNode = new NodeCryptoAdapter();

  // Fresh seed for any method that needs one.
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;

  it('every port method returns a Promise', () => {
    const message = new Uint8Array([1, 2, 3]);
    const sig = new Uint8Array(64);
    const key32 = new Uint8Array(32);
    const key33 = new Uint8Array(33);

    const calls: Array<[string, Promise<unknown>]> = [
      ['ed25519DerivePath', adapter.ed25519DerivePath(seed, "m/0'")],
      ['ed25519Sign', adapter.ed25519Sign(seed, message)],
      ['ed25519Verify', adapter.ed25519Verify(key32, message, sig)],
      ['x25519FromEd25519Public', adapter.x25519FromEd25519Public(key32)],
      ['x25519FromEd25519Private', adapter.x25519FromEd25519Private(key32)],
      ['x25519ScalarMult', adapter.x25519ScalarMult(key32, key32)],
      ['secp256k1DerivePath', adapter.secp256k1DerivePath(seed, "m/0'")],
      ['secp256k1Sign', adapter.secp256k1Sign(key32, message)],
      ['secp256k1Verify', adapter.secp256k1Verify(key33, message, sig)],
      ['sha256', adapter.sha256(message)],
      ['blake2b', adapter.blake2b(message, 32)],
      ['hkdfSha256', adapter.hkdfSha256(seed, key32, new Uint8Array(0), 32)],
      ['sealedBoxSeal', adapter.sealedBoxSeal(message, key32)],
      ['sealedBoxOpen', adapter.sealedBoxOpen(new Uint8Array(48), key32, key32)],
      ['argon2idHash', adapter.argon2idHash(message, key32, 32, { timeCost: 1, memoryCost: 8 })],
      ['randomBytes', adapter.randomBytes(8)],
    ];

    for (const [name, p] of calls) {
      expect(p).toBeInstanceOf(Promise);
      // Swallow errors — individual per-method files assert correctness;
      // here we only care about the shape contract.
      p.catch(() => undefined);
    }
    // Port surface has 16 runtime-callable methods (matches
    // ed25519×3 + x25519×3 + secp256k1×3 + hash×2 + hkdf + sealed-box×2 +
    // argon2 + random). If this number drifts, update both this
    // assertion and the audit doc comment above.
    expect(calls.length).toBe(16);
  });

  it('ed25519 outputs are plain Uint8Array (not Buffer subclass)', async () => {
    const r = await adapter.ed25519DerivePath(seed, "m/0'");
    expect(r.privateKey.constructor.name).toBe('Uint8Array');
    expect(r.publicKey.constructor.name).toBe('Uint8Array');
    expect(r.chainCode.constructor.name).toBe('Uint8Array');
    const sig = await adapter.ed25519Sign(r.privateKey, new Uint8Array([42]));
    expect(sig.constructor.name).toBe('Uint8Array');
  });

  it('hash + random + argon2 outputs are plain Uint8Array', async () => {
    const inputs = new Uint8Array([1, 2, 3]);
    const sha = await adapter.sha256(inputs);
    expect(sha.constructor.name).toBe('Uint8Array');
    const blake = await adapter.blake2b(inputs, 32);
    expect(blake.constructor.name).toBe('Uint8Array');
    const rnd = await adapter.randomBytes(16);
    expect(rnd.constructor.name).toBe('Uint8Array');
    const kdf = await adapter.argon2idHash(inputs, new Uint8Array(16), 32, {
      timeCost: 1,
      memoryCost: 8,
    });
    expect(kdf.constructor.name).toBe('Uint8Array');
  });

  it('@noble/ed25519 SHA-512 hook is installed at module load', () => {
    // Without this hook, `ed.sign` / `ed.getPublicKey` throw at runtime
    // ("noble-ed25519: sha512 is not configured"). If a refactor drops
    // the hook, this guard fires instead of the 16+ ed25519 tests.
    const h = ed.hashes as { sha512?: unknown };
    expect(typeof h.sha512).toBe('function');
  });

  it('ARGON2_OWASP_DEFAULTS matches the documented profile', () => {
    expect(ARGON2_OWASP_DEFAULTS).toEqual({
      timeCost: 2,
      memoryCost: 19 * 1024, // 19 MiB
      parallelism: 1,
    });
    // Object.freeze → consumers can't mutate the shared reference.
    expect(Object.isFrozen(ARGON2_OWASP_DEFAULTS)).toBe(true);
  });

  it('sealed-box loader is cached (second call not materially slower)', async () => {
    // Weak sanity check for the `loadSodium` cache. The WASM init (`sodium.ready`)
    // takes ~10-30ms cold; warm should be <1ms. We allow a generous 10x headroom
    // so the test survives CI jitter.
    const pub = (await adapter.ed25519DerivePath(seed, "m/0'")).publicKey;
    const msg = new Uint8Array([0, 0, 0]);

    const t0 = performance.now();
    await adapter.sealedBoxSeal(msg, pub);
    const cold = performance.now() - t0;

    const t1 = performance.now();
    await adapter.sealedBoxSeal(msg, pub);
    const warm = performance.now() - t1;

    // Warm must be faster — or at least not dramatically slower, which
    // would indicate the cache is being rebuilt on every call.
    expect(warm).toBeLessThan(Math.max(cold * 10, 50));
  });

  it('argon2 loader is cached (second call not materially slower)', async () => {
    const pw = new Uint8Array([1, 2]);
    const salt = new Uint8Array(16).fill(0x55);
    const params = { timeCost: 1, memoryCost: 8, parallelism: 1 };

    const t0 = performance.now();
    await adapter.argon2idHash(pw, salt, 16, params);
    const cold = performance.now() - t0;

    const t1 = performance.now();
    await adapter.argon2idHash(pw, salt, 16, params);
    const warm = performance.now() - t1;

    expect(warm).toBeLessThan(Math.max(cold * 10, 50));
  });
});
