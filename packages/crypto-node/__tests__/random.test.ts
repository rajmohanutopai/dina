/**
 * `@dina/crypto-node` randomBytes behavior tests (task 3.28).
 *
 * Thin wrapper over `node:crypto.randomBytes`. Tests verify the
 * wrapper contract (length, non-negative int, Uint8Array return)
 * rather than the CSPRNG quality — that's `node:crypto`'s job.
 */

import { NodeCryptoAdapter } from '../src';

describe('NodeCryptoAdapter — randomBytes (task 3.28)', () => {
  const adapter = new NodeCryptoAdapter();

  it('returns the requested number of bytes', async () => {
    for (const n of [1, 16, 32, 64, 128]) {
      const out = await adapter.randomBytes(n);
      expect(out.length).toBe(n);
      expect(out).toBeInstanceOf(Uint8Array);
    }
  });

  it('returns zero-length Uint8Array for count=0', async () => {
    const out = await adapter.randomBytes(0);
    expect(out.length).toBe(0);
    expect(out).toBeInstanceOf(Uint8Array);
  });

  it('two consecutive calls produce different bytes (statistical sanity)', async () => {
    // Not a CSPRNG strength test — just a sanity that we're not
    // returning constant zeros / a deterministic sequence.
    const a = await adapter.randomBytes(32);
    const b = await adapter.randomBytes(32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('32 bytes of output contains at least one non-zero byte', async () => {
    const out = await adapter.randomBytes(32);
    const allZero = out.every((b) => b === 0);
    expect(allZero).toBe(false);
  });

  it('rejects non-integer counts', async () => {
    await expect(adapter.randomBytes(1.5)).rejects.toThrow(
      /must be a non-negative integer/,
    );
  });

  it('rejects negative counts', async () => {
    await expect(adapter.randomBytes(-1)).rejects.toThrow(
      /must be a non-negative integer/,
    );
  });

  it('rejects NaN', async () => {
    await expect(adapter.randomBytes(Number.NaN)).rejects.toThrow(
      /must be a non-negative integer/,
    );
  });

  it('output is a plain Uint8Array (not a Buffer)', async () => {
    const out = await adapter.randomBytes(32);
    // Node Buffer IS a Uint8Array subclass, so `instanceof Uint8Array`
    // is true for both. The stricter check: `constructor.name`.
    expect(out.constructor.name).toBe('Uint8Array');
  });
});
