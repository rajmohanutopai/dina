/**
 * Task 4.64 — device token SHA-256 storage tests.
 */

import { createHash } from 'node:crypto';

import {
  DEVICE_TOKEN_BYTES,
  DEVICE_TOKEN_HASH_HEX_LENGTH,
  DeviceTokenError,
  DeviceTokenRegistry,
  hashDeviceToken,
  type DeviceTokenEvent,
} from '../src/pair/device_tokens';

function fixedClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function scriptedRandom(scripts: number[][]): (n: number) => Uint8Array {
  let i = 0;
  return (n) => {
    const next = scripts[i++];
    if (next === undefined) throw new Error(`scriptedRandom exhausted at call ${i}`);
    if (next.length !== n) {
      throw new Error(`scriptedRandom length ${next.length} != requested ${n}`);
    }
    return new Uint8Array(next);
  };
}

function seed(byte: number): number[] {
  return Array.from({ length: DEVICE_TOKEN_BYTES }, () => byte);
}

describe('hashDeviceToken (task 4.64)', () => {
  it('produces 64-char hex SHA-256', () => {
    const digest = hashDeviceToken('abc');
    expect(digest).toHaveLength(DEVICE_TOKEN_HASH_HEX_LENGTH);
    // Parity with Node's own SHA-256.
    expect(digest).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('rejects empty / non-string input', () => {
    expect(() => hashDeviceToken('')).toThrow(DeviceTokenError);
    expect(() => hashDeviceToken('' as unknown as string)).toThrow(DeviceTokenError);
  });
});

describe('DeviceTokenRegistry.issue (task 4.64)', () => {
  it('returns raw token + stores only the hash', () => {
    const clock = fixedClock();
    const reg = new DeviceTokenRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0xaa)]),
    });
    const out = reg.issue({ deviceName: 'phone' });
    expect(out.rawToken).toHaveLength(DEVICE_TOKEN_BYTES * 2); // hex
    expect(out.record.tokenHash).toBe(hashDeviceToken(out.rawToken));
    expect(out.record.deviceName).toBe('phone');
    expect(out.record.role).toBe('user');
    expect(out.record.createdAt).toBe(Math.floor(clock.nowMsFn() / 1000));
    expect(out.record.revoked).toBe(false);

    // The registry MUST NOT hold the raw token anywhere.
    // Snapshot all record fields and ensure none equals the raw hex.
    const stored = reg.get(out.deviceId)!;
    for (const v of Object.values(stored)) {
      expect(v).not.toBe(out.rawToken);
    }
  });

  it('accepts role=agent', () => {
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(0x01)]),
    });
    const out = reg.issue({ deviceName: 'agent-bot', role: 'agent' });
    expect(out.record.role).toBe('agent');
  });

  it('mints sequential ids by default', () => {
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(1), seed(2)]),
    });
    const a = reg.issue({ deviceName: 'phone' });
    const b = reg.issue({ deviceName: 'laptop' });
    expect(a.deviceId).toBe('dev-1');
    expect(b.deviceId).toBe('dev-2');
  });

  it('honours an explicit deviceId', () => {
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(3)]),
    });
    const out = reg.issue({ deviceName: 'phone', deviceId: 'my-id' });
    expect(out.deviceId).toBe('my-id');
  });

  it('throws duplicate_device_id on collision', () => {
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(4), seed(5)]),
    });
    reg.issue({ deviceName: 'a', deviceId: 'x' });
    const err = catchErr(() => reg.issue({ deviceName: 'b', deviceId: 'x' }));
    expect(err).toBeInstanceOf(DeviceTokenError);
    expect((err as DeviceTokenError).reason).toBe('duplicate_device_id');
  });

  it('rejects randomBytesFn returning the wrong length', () => {
    const reg = new DeviceTokenRegistry({ randomBytesFn: () => new Uint8Array(16) });
    expect(() => reg.issue({ deviceName: 'x' })).toThrow(/expected 32/);
  });

  it('emits issued event', () => {
    const events: DeviceTokenEvent[] = [];
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(7)]),
      onEvent: (e) => events.push(e),
    });
    const out = reg.issue({ deviceName: 'phone' });
    expect(events).toEqual([{ kind: 'issued', deviceId: out.deviceId, role: 'user' }]);
  });
});

describe('DeviceTokenRegistry.verify (task 4.64)', () => {
  it('returns the matching record for the raw token', () => {
    const reg = new DeviceTokenRegistry({ randomBytesFn: scriptedRandom([seed(0xab)]) });
    const out = reg.issue({ deviceName: 'phone' });
    const verified = reg.verify(out.rawToken);
    expect(verified).toBeDefined();
    expect(verified!.deviceId).toBe(out.deviceId);
  });

  it('returns undefined for a wrong token (same length)', () => {
    const reg = new DeviceTokenRegistry({ randomBytesFn: scriptedRandom([seed(0x01)]) });
    reg.issue({ deviceName: 'phone' });
    // 32-byte hex that does not match any stored hash.
    const bad = '00'.repeat(DEVICE_TOKEN_BYTES);
    expect(reg.verify(bad)).toBeUndefined();
  });

  it('returns undefined for malformed input', () => {
    const reg = new DeviceTokenRegistry({ randomBytesFn: scriptedRandom([seed(0x02)]) });
    reg.issue({ deviceName: 'phone' });
    expect(reg.verify('')).toBeUndefined();
    expect(reg.verify('not-hex-at-all')).toBeUndefined();
  });

  it('does NOT match a revoked device', () => {
    const reg = new DeviceTokenRegistry({ randomBytesFn: scriptedRandom([seed(0x33)]) });
    const out = reg.issue({ deviceName: 'phone' });
    reg.revoke(out.deviceId);
    expect(reg.verify(out.rawToken)).toBeUndefined();
  });

  it('does NOT update lastSeen (caller is responsible)', () => {
    const clock = fixedClock();
    const reg = new DeviceTokenRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(0x44)]),
    });
    const out = reg.issue({ deviceName: 'phone' });
    const lastSeenBefore = reg.get(out.deviceId)!.lastSeen;
    clock.advance(60_000);
    reg.verify(out.rawToken);
    const lastSeenAfter = reg.get(out.deviceId)!.lastSeen;
    expect(lastSeenAfter).toBe(lastSeenBefore);
  });

  it('discriminates between two live devices without false positives', () => {
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(0x55), seed(0x66)]),
    });
    const a = reg.issue({ deviceName: 'a' });
    const b = reg.issue({ deviceName: 'b' });
    expect(reg.verify(a.rawToken)!.deviceId).toBe(a.deviceId);
    expect(reg.verify(b.rawToken)!.deviceId).toBe(b.deviceId);
  });
});

describe('DeviceTokenRegistry.revoke + touch (task 4.64)', () => {
  it('revoke flips live→revoked + returns true once', () => {
    const reg = new DeviceTokenRegistry({ randomBytesFn: scriptedRandom([seed(1)]) });
    const out = reg.issue({ deviceName: 'x' });
    expect(reg.revoke(out.deviceId)).toBe(true);
    expect(reg.revoke(out.deviceId)).toBe(false); // idempotent no-op
  });

  it('revoke throws unknown_device on missing id', () => {
    const reg = new DeviceTokenRegistry();
    const err = catchErr(() => reg.revoke('ghost'));
    expect((err as DeviceTokenError).reason).toBe('unknown_device');
  });

  it('revoke emits event', () => {
    const events: DeviceTokenEvent[] = [];
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(2)]),
      onEvent: (e) => events.push(e),
    });
    const out = reg.issue({ deviceName: 'x' });
    events.length = 0;
    reg.revoke(out.deviceId);
    expect(events).toEqual([{ kind: 'revoked', deviceId: out.deviceId }]);
  });

  it('touch updates lastSeen to current clock', () => {
    const clock = fixedClock();
    const reg = new DeviceTokenRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(3)]),
    });
    const out = reg.issue({ deviceName: 'x' });
    clock.advance(90_000);
    reg.touch(out.deviceId);
    expect(reg.get(out.deviceId)!.lastSeen).toBe(Math.floor(clock.nowMsFn() / 1000));
  });

  it('touch throws unknown_device on missing id', () => {
    const reg = new DeviceTokenRegistry();
    const err = catchErr(() => reg.touch('ghost'));
    expect((err as DeviceTokenError).reason).toBe('unknown_device');
  });
});

describe('DeviceTokenRegistry.list* (task 4.64)', () => {
  it('listLive excludes revoked devices and orders by createdAt asc', () => {
    const clock = fixedClock();
    const reg = new DeviceTokenRegistry({
      nowMsFn: clock.nowMsFn,
      randomBytesFn: scriptedRandom([seed(1), seed(2), seed(3)]),
    });
    const a = reg.issue({ deviceName: 'a' });
    clock.advance(1000);
    const b = reg.issue({ deviceName: 'b' });
    clock.advance(1000);
    const c = reg.issue({ deviceName: 'c' });
    reg.revoke(b.deviceId);
    const live = reg.listLive().map((d) => d.deviceId);
    expect(live).toEqual([a.deviceId, c.deviceId]);
  });

  it('listAll includes revoked devices', () => {
    const reg = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(1), seed(2)]),
    });
    const a = reg.issue({ deviceName: 'a' });
    const b = reg.issue({ deviceName: 'b' });
    reg.revoke(a.deviceId);
    expect(reg.listAll().map((d) => d.deviceId).sort()).toEqual(
      [a.deviceId, b.deviceId].sort(),
    );
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
