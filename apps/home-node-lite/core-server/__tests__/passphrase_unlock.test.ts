/**
 * Task 4.69 — Argon2id passphrase unlock tests.
 *
 * Uses REDUCED Argon2id params (memory=1024 KiB, iterations=1) so the
 * suite runs in ~10 ms instead of ~2 s. Production callers use the
 * 128 MiB / 3-iter defaults from `@dina/core.ARGON2ID_PARAMS`.
 */

import {
  computePassphraseRecord,
  constantTimeEqual,
  MIN_PASSPHRASE_LENGTH,
  PASSPHRASE_SALT_BYTES,
  PassphraseRegistry,
  verifyPassphrase,
} from '../src/persona/passphrase_unlock';

const fastParams = {
  memory: 1024,
  iterations: 1,
  parallelism: 1,
};

function fixedRandom(bytes: number[]): (n: number) => Uint8Array {
  return (n) => {
    if (n !== bytes.length) throw new Error(`expected ${bytes.length} bytes, got ${n}`);
    return new Uint8Array(bytes);
  };
}

const validPassphrase = 'correct-horse-battery-staple';

describe('computePassphraseRecord + verifyPassphrase (task 4.69)', () => {
  it('round-trips — verify succeeds for the correct passphrase', async () => {
    const record = await computePassphraseRecord(validPassphrase, { params: fastParams });
    await expect(verifyPassphrase(validPassphrase, record)).resolves.toBe(true);
  });

  it('rejects a wrong passphrase', async () => {
    const record = await computePassphraseRecord(validPassphrase, { params: fastParams });
    await expect(verifyPassphrase('wrong-one-entirely', record)).resolves.toBe(false);
  });

  it('returns false for empty passphrase on verify without hitting the KDF', async () => {
    const record = await computePassphraseRecord(validPassphrase, { params: fastParams });
    await expect(verifyPassphrase('', record)).resolves.toBe(false);
  });

  it('rejects passphrases shorter than MIN_PASSPHRASE_LENGTH at record-create', async () => {
    await expect(
      computePassphraseRecord('short', { params: fastParams }),
    ).rejects.toThrow(/at least 8 characters/);
    expect(MIN_PASSPHRASE_LENGTH).toBe(8);
  });

  it('emits a 16-byte salt and 32-byte hash with the documented params', async () => {
    const record = await computePassphraseRecord(validPassphrase, { params: fastParams });
    expect(record.salt.length).toBe(PASSPHRASE_SALT_BYTES);
    expect(record.hash.length).toBe(32);
    expect(record.memory).toBe(1024);
    expect(record.iterations).toBe(1);
    expect(record.parallelism).toBe(1);
  });

  it('captures createdAtMs from the injected clock', async () => {
    const record = await computePassphraseRecord(validPassphrase, {
      params: fastParams,
      nowMsFn: () => 1_700_000_000_000,
    });
    expect(record.createdAtMs).toBe(1_700_000_000_000);
  });

  it('different salts produce different hashes for the same passphrase', async () => {
    const a = await computePassphraseRecord(validPassphrase, {
      params: fastParams,
      randomBytesFn: fixedRandom(Array.from({ length: 16 }, () => 1)),
    });
    const b = await computePassphraseRecord(validPassphrase, {
      params: fastParams,
      randomBytesFn: fixedRandom(Array.from({ length: 16 }, () => 2)),
    });
    expect(constantTimeEqual(a.hash, b.hash)).toBe(false);
  });

  it('same salt + same passphrase + same params → deterministic hash', async () => {
    const salt = fixedRandom(Array.from({ length: 16 }, () => 7));
    const a = await computePassphraseRecord(validPassphrase, {
      params: fastParams,
      randomBytesFn: salt,
    });
    const b = await computePassphraseRecord(validPassphrase, {
      params: fastParams,
      randomBytesFn: fixedRandom(Array.from({ length: 16 }, () => 7)),
    });
    expect(constantTimeEqual(a.hash, b.hash)).toBe(true);
  });

  it('rejects randomBytesFn that returns the wrong number of bytes', async () => {
    await expect(
      computePassphraseRecord(validPassphrase, {
        params: fastParams,
        randomBytesFn: () => new Uint8Array(8), // supposed to be 16
      }),
    ).rejects.toThrow(/returned 8 bytes, expected 16/);
  });
});

describe('PassphraseRegistry (task 4.69)', () => {
  it('set → verify round-trip', async () => {
    const reg = new PassphraseRegistry({ params: fastParams });
    await reg.set('/financial', validPassphrase);
    await expect(reg.verify('/financial', validPassphrase)).resolves.toBe(true);
    await expect(reg.verify('/financial', 'wrong')).resolves.toBe(false);
  });

  it('verify on an unknown persona returns false (no distinguishable timing)', async () => {
    const reg = new PassphraseRegistry({ params: fastParams });
    await expect(reg.verify('/nobody', validPassphrase)).resolves.toBe(false);
  });

  it('set replaces an existing record with a fresh salt', async () => {
    const reg = new PassphraseRegistry({ params: fastParams });
    await reg.set('/financial', 'first-passphrase');
    const first = reg.snapshot('/financial');
    await reg.set('/financial', 'second-passphrase');
    const second = reg.snapshot('/financial');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Fresh salt → different hash + different salt bytes.
    expect(constantTimeEqual(first!.hash, second!.hash)).toBe(false);
    expect(constantTimeEqual(first!.salt, second!.salt)).toBe(false);
    // Old passphrase is dead.
    await expect(reg.verify('/financial', 'first-passphrase')).resolves.toBe(false);
    await expect(reg.verify('/financial', 'second-passphrase')).resolves.toBe(true);
  });

  it('remove drops the record', async () => {
    const reg = new PassphraseRegistry({ params: fastParams });
    await reg.set('/financial', validPassphrase);
    expect(reg.remove('/financial')).toBe(true);
    expect(reg.has('/financial')).toBe(false);
    expect(reg.remove('/financial')).toBe(false);
  });

  it('rejects set() with empty persona name', async () => {
    const reg = new PassphraseRegistry({ params: fastParams });
    await expect(reg.set('', validPassphrase)).rejects.toThrow(/persona is required/);
  });

  it('snapshot + load preserves verifiability across instances', async () => {
    const a = new PassphraseRegistry({ params: fastParams });
    await a.set('/financial', validPassphrase);
    const snap = a.snapshot('/financial');
    expect(snap).toBeDefined();

    const b = new PassphraseRegistry({ params: fastParams });
    b.load('/financial', snap!);
    await expect(b.verify('/financial', validPassphrase)).resolves.toBe(true);
  });

  it('size reflects the count of stored personas', async () => {
    const reg = new PassphraseRegistry({ params: fastParams });
    expect(reg.size()).toBe(0);
    await reg.set('/a', validPassphrase);
    await reg.set('/b', validPassphrase);
    expect(reg.size()).toBe(2);
    reg.remove('/a');
    expect(reg.size()).toBe(1);
  });
});

describe('constantTimeEqual', () => {
  it('true for equal arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('false for unequal same-length arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('false for different lengths', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('handles empty arrays', () => {
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});
