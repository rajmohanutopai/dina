/**
 * Task 4.62 — pairing code generator + registry tests.
 *
 * Uses an injected clock + injected random source so every assertion
 * is byte-exact. The Go-parity property (same secret → same code) is
 * pinned with a fixed fixture.
 */

import {
  CODE_COLLISION_RETRIES,
  DEFAULT_PAIRING_TTL_MS,
  MAX_PENDING_CODES,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_SECRET_BYTES,
  PairingCodeError,
  PairingCodeRegistry,
  deriveCode,
  type PairingCodeEvent,
} from '../src/pair/pairing_codes';

function fixedClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

/** Build a random source that emits the supplied byte-arrays in order. */
function scriptedRandom(scripts: number[][]): (n: number) => Uint8Array {
  let i = 0;
  return (n) => {
    const next = scripts[i++];
    if (next === undefined) throw new Error(`scriptedRandom: exhausted at call ${i}`);
    if (next.length !== n) {
      throw new Error(`scriptedRandom: script length ${next.length} != requested ${n}`);
    }
    return new Uint8Array(next);
  };
}

/** Seed-of-all-same-byte helper (produces 32-byte secrets trivially). */
function seed(byte: number): number[] {
  return Array.from({ length: PAIRING_SECRET_BYTES }, () => byte);
}

describe('deriveCode (task 4.62 pure derivation)', () => {
  it('is deterministic — same secret → same code', () => {
    const secret = new Uint8Array(seed(0xab));
    expect(deriveCode(secret)).toBe(deriveCode(secret));
  });

  it('emits 8 characters by default', () => {
    const code = deriveCode(new Uint8Array(seed(0x01)));
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
  });

  it('uses only Crockford Base32 characters', () => {
    const alphabetSet = new Set(PAIRING_ALPHABET);
    const ambiguous = new Set(['I', 'L', 'O', 'U']);
    // Exercise a range of seeds so the alphabet is reasonably spanned.
    for (let i = 0; i < 32; i++) {
      const code = deriveCode(new Uint8Array(seed(i * 7 + 3)));
      for (const ch of code) {
        expect(alphabetSet.has(ch)).toBe(true);
        expect(ambiguous.has(ch)).toBe(false);
      }
    }
  });

  it('rejects empty secret', () => {
    expect(() => deriveCode(new Uint8Array(0))).toThrow(/non-empty/);
  });

  it('rejects invalid length', () => {
    const secret = new Uint8Array(seed(1));
    expect(() => deriveCode(secret, 0)).toThrow(/length must be 1\.\.32/);
    expect(() => deriveCode(secret, 33)).toThrow(/length must be 1\.\.32/);
    expect(() => deriveCode(secret, 1.5)).toThrow(/length must be 1\.\.32/);
  });

  it('matches Go parity for a known seed (all-0x01 bytes)', () => {
    // sha256(0x01 × 32) = 72cd6e8422c407fb6d098690f1130b7de...
    // First 8 bytes mod 32 must map to the alphabet deterministically.
    // We compute the expected here to document the formula in-test.
    const secret = new Uint8Array(seed(0x01));
    const code = deriveCode(secret);
    // The first byte of sha256(0x01^32) is 0x72 = 114; 114 % 32 = 18;
    // PAIRING_ALPHABET[18] = 'J'.
    expect(code[0]).toBe('J');
  });
});

describe('PairingCodeRegistry.generate (task 4.62)', () => {
  it('returns {code, secret, record} with 8-char code + 32-byte secret', () => {
    const clock = fixedClock();
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0xaa)]),
    });
    const out = reg.generate();
    expect(out.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(out.secret.length).toBe(PAIRING_SECRET_BYTES);
    expect(out.record.code).toBe(out.code);
    expect(out.record.secret).toBe(out.secret);
    expect(out.record.createdAtMs).toBe(clock.nowMsFn());
    expect(out.record.expiresAtMs).toBe(clock.nowMsFn() + DEFAULT_PAIRING_TTL_MS);
    expect(out.record.used).toBe(false);
  });

  it('honours ttlMs override', () => {
    const clock = fixedClock();
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0x01)]),
      ttlMs: 30_000,
    });
    const out = reg.generate();
    expect(out.record.expiresAtMs - out.record.createdAtMs).toBe(30_000);
  });

  it('fires `generated` event', () => {
    const events: PairingCodeEvent[] = [];
    const reg = new PairingCodeRegistry({
      randomBytesFn: scriptedRandom([seed(0x55)]),
      onEvent: (e) => events.push(e),
    });
    const out = reg.generate();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'generated', code: out.code });
  });

  it('retries on live collision (same derived code while prior still live)', () => {
    const clock = fixedClock();
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0xaa), seed(0xaa), seed(0xbb)]),
    });
    const first = reg.generate();
    // Second call: same seed → same code → live collision → advance to 3rd script.
    const second = reg.generate();
    expect(second.code).not.toBe(first.code);
    expect(reg.size()).toBe(2);
  });

  it('throws collision_retries_exhausted when every attempt collides', () => {
    const clock = fixedClock();
    // Pre-populate with a code, then feed the same secret as every retry.
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0x33), ...Array.from({ length: CODE_COLLISION_RETRIES }, () => seed(0x33))]),
    });
    reg.generate();
    const err = catchErr(() => reg.generate());
    expect(err).toBeInstanceOf(PairingCodeError);
    expect((err as PairingCodeError).reason).toBe('collision_retries_exhausted');
  });

  it('throws too_many_pending at MAX_PENDING_CODES cap', () => {
    const scripts: number[][] = [];
    for (let i = 0; i < MAX_PENDING_CODES + 1; i++) {
      const b = new Array<number>(PAIRING_SECRET_BYTES);
      for (let j = 0; j < PAIRING_SECRET_BYTES; j++) b[j] = (i * 53 + j * 7) & 0xff;
      scripts.push(b);
    }
    const reg = new PairingCodeRegistry({ randomBytesFn: scriptedRandom(scripts) });
    for (let i = 0; i < MAX_PENDING_CODES; i++) reg.generate();
    const err = catchErr(() => reg.generate());
    expect(err).toBeInstanceOf(PairingCodeError);
    expect((err as PairingCodeError).reason).toBe('too_many_pending');
  });

  it('opportunistic sweep reclaims cap space when prior codes expired', () => {
    const clock = fixedClock();
    const scripts: number[][] = [];
    for (let i = 0; i < MAX_PENDING_CODES + 2; i++) {
      const b = new Array<number>(PAIRING_SECRET_BYTES);
      for (let j = 0; j < PAIRING_SECRET_BYTES; j++) b[j] = (i * 53 + j * 7) & 0xff;
      scripts.push(b);
    }
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom(scripts),
      ttlMs: 10_000,
    });
    for (let i = 0; i < MAX_PENDING_CODES; i++) reg.generate();
    // All expire
    clock.advance(10_001);
    // Next generate succeeds because sweep reclaims.
    expect(() => reg.generate()).not.toThrow();
    expect(reg.size()).toBe(1);
  });

  it('rejects randomBytesFn returning the wrong length', () => {
    const reg = new PairingCodeRegistry({
      randomBytesFn: () => new Uint8Array(16),
    });
    expect(() => reg.generate()).toThrow(/expected 32/);
  });
});

describe('PairingCodeRegistry.complete (task 4.62)', () => {
  it('consumes a live code and returns the record', () => {
    const clock = fixedClock();
    const events: PairingCodeEvent[] = [];
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0x42)]),
      onEvent: (e) => events.push(e),
    });
    const { code, secret } = reg.generate();
    const record = reg.complete(code);
    expect(record.secret).toEqual(secret);
    expect(record.used).toBe(true);
    expect(reg.size()).toBe(0);
    expect(events.some((e) => e.kind === 'consumed')).toBe(true);
  });

  it('throws invalid_code on unknown code', () => {
    const reg = new PairingCodeRegistry();
    const err = catchErr(() => reg.complete('NOSUCHCD'));
    expect((err as PairingCodeError).reason).toBe('invalid_code');
  });

  it('throws code_expired past TTL', () => {
    const clock = fixedClock();
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0x77)]),
      ttlMs: 1000,
    });
    const { code } = reg.generate();
    clock.advance(1001);
    const err = catchErr(() => reg.complete(code));
    expect((err as PairingCodeError).reason).toBe('code_expired');
    expect(reg.size()).toBe(0); // auto-removed
  });

  it('rejects a second attempt (single-use) with invalid_code', () => {
    // First complete() deletes the record, so second call gets invalid_code.
    const reg = new PairingCodeRegistry({
      randomBytesFn: scriptedRandom([seed(0x88)]),
    });
    const { code } = reg.generate();
    reg.complete(code);
    const err = catchErr(() => reg.complete(code));
    expect((err as PairingCodeError).reason).toBe('invalid_code');
  });
});

describe('PairingCodeRegistry.sweepExpired + isLive', () => {
  it('sweepExpired removes only live-expired codes and emits events', () => {
    const clock = fixedClock();
    const events: PairingCodeEvent[] = [];
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(1), seed(2), seed(3)]),
      ttlMs: 1000,
      onEvent: (e) => events.push(e),
    });
    reg.generate();
    reg.generate();
    clock.advance(999); // not yet expired
    reg.generate(); // third, still fresh
    clock.advance(2); // now first two are past TTL by 1ms; third still fresh
    events.length = 0;
    expect(reg.sweepExpired()).toBe(2);
    expect(events.filter((e) => e.kind === 'expired')).toHaveLength(2);
    expect(reg.size()).toBe(1);
  });

  it('isLive reflects used/expired state', () => {
    const clock = fixedClock();
    const reg = new PairingCodeRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0xa1), seed(0xa2)]),
      ttlMs: 1000,
    });
    const { code: a } = reg.generate();
    const { code: b } = reg.generate();
    expect(reg.isLive(a)).toBe(true);
    reg.complete(a);
    expect(reg.isLive(a)).toBe(false);
    clock.advance(1001);
    expect(reg.isLive(b)).toBe(false);
    expect(reg.isLive('GHOST')).toBe(false);
  });
});

describe('constructor validation', () => {
  it('rejects non-positive ttlMs', () => {
    expect(() => new PairingCodeRegistry({ ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
    expect(() => new PairingCodeRegistry({ ttlMs: NaN })).toThrow(/ttlMs must be > 0/);
  });
});

describe('constants', () => {
  it('PAIRING_ALPHABET is Crockford Base32 (32 chars, no I/L/O/U)', () => {
    expect(PAIRING_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(PAIRING_ALPHABET).toHaveLength(32);
  });
  it('DEFAULT_PAIRING_TTL_MS = 5 minutes', () => {
    expect(DEFAULT_PAIRING_TTL_MS).toBe(5 * 60 * 1000);
  });
  it('MAX_PENDING_CODES matches Go cap', () => {
    expect(MAX_PENDING_CODES).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function catchErr(fn: () => void): Error | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}
