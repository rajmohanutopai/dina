/**
 * Task 4.65 — live-reload device tokens into the auth validator tests.
 *
 * The core invariant: validator holds a *reference* to the registry
 * (not a snapshot), so issue/revoke/touch in the registry is visible
 * on the very next `validate()` call without reloading the validator.
 */

import { DeviceTokenRegistry } from '../src/pair/device_tokens';
import {
  DeviceTokenBearerValidator,
  authenticateBearerFromDeviceRegistry,
  type DeviceTokenValidationDetail,
} from '../src/auth/device_token_validator';

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
  return Array.from({ length: 32 }, () => byte);
}

describe('DeviceTokenBearerValidator (task 4.65)', () => {
  describe('validate — basic semantics', () => {
    it('returns ok=true with the record for a live token', () => {
      const registry = new DeviceTokenRegistry({
        randomBytesFn: scriptedRandom([seed(0x01)]),
      });
      const { rawToken, deviceId } = registry.issue({ deviceName: 'phone' });
      const validator = new DeviceTokenBearerValidator(registry);
      const result = validator.validate(rawToken);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.deviceLabel).toBe('phone');
      expect(result.record.deviceId).toBe(deviceId);
    });

    it('returns unknown_token for a well-formed but unknown token', () => {
      const registry = new DeviceTokenRegistry({
        randomBytesFn: scriptedRandom([seed(0x02)]),
      });
      registry.issue({ deviceName: 'phone' });
      const validator = new DeviceTokenBearerValidator(registry);
      const result = validator.validate('00'.repeat(32));
      expect(result).toEqual({ ok: false, reason: 'unknown_token' });
    });

    it('returns missing for an empty token', () => {
      const validator = new DeviceTokenBearerValidator(new DeviceTokenRegistry());
      expect(validator.validate('')).toEqual({ ok: false, reason: 'missing' });
    });

    it('returns unknown_token for malformed (non-hex) token input', () => {
      const validator = new DeviceTokenBearerValidator(new DeviceTokenRegistry());
      // Hash-lookup reduces any non-empty input to a 64-char hex — the
      // validator reports it as unknown_token rather than leaking the
      // raw format distinction, which is the right UX here.
      expect(validator.validate('not-hex-at-all')).toEqual({
        ok: false,
        reason: 'unknown_token',
      });
    });
  });

  describe('live reload — registry changes visible immediately', () => {
    it('newly-issued token authenticates on the next call without validator rebuild', () => {
      const registry = new DeviceTokenRegistry({
        randomBytesFn: scriptedRandom([seed(0x11), seed(0x22)]),
      });
      const validator = new DeviceTokenBearerValidator(registry);
      // First: one device exists
      const first = registry.issue({ deviceName: 'phone' });
      expect(validator.validate(first.rawToken).ok).toBe(true);
      // Add another device — validator sees it on the SAME instance
      const second = registry.issue({ deviceName: 'laptop' });
      const result = validator.validate(second.rawToken);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.record.deviceName).toBe('laptop');
    });

    it('revoked token stops authenticating on the next call', () => {
      const registry = new DeviceTokenRegistry({
        randomBytesFn: scriptedRandom([seed(0x33)]),
      });
      const validator = new DeviceTokenBearerValidator(registry);
      const { rawToken, deviceId } = registry.issue({ deviceName: 'phone' });
      expect(validator.validate(rawToken).ok).toBe(true);
      registry.revoke(deviceId);
      expect(validator.validate(rawToken)).toEqual({ ok: false, reason: 'unknown_token' });
    });

    it('re-issued token under the same deviceName is a distinct token — old one stays unknown', () => {
      const registry = new DeviceTokenRegistry({
        randomBytesFn: scriptedRandom([seed(0x44), seed(0x55)]),
      });
      const validator = new DeviceTokenBearerValidator(registry);
      const first = registry.issue({ deviceName: 'phone' });
      registry.revoke(first.deviceId);
      const second = registry.issue({ deviceName: 'phone' });
      expect(validator.validate(first.rawToken)).toEqual({
        ok: false,
        reason: 'unknown_token',
      });
      const ok = validator.validate(second.rawToken);
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.record.deviceId).toBe(second.deviceId);
    });
  });

  describe('touchOnSuccess', () => {
    it('does NOT update lastSeen by default', () => {
      let nowMs = 1_700_000_000_000;
      const registry = new DeviceTokenRegistry({
        nowMsFn: () => nowMs,
        randomBytesFn: scriptedRandom([seed(0x66)]),
      });
      const validator = new DeviceTokenBearerValidator(registry);
      const { rawToken, deviceId } = registry.issue({ deviceName: 'phone' });
      const lastSeenBefore = registry.get(deviceId)!.lastSeen;
      nowMs += 60_000;
      validator.validate(rawToken);
      expect(registry.get(deviceId)!.lastSeen).toBe(lastSeenBefore);
    });

    it('DOES update lastSeen when touchOnSuccess=true', () => {
      let nowMs = 1_700_000_000_000;
      const registry = new DeviceTokenRegistry({
        nowMsFn: () => nowMs,
        randomBytesFn: scriptedRandom([seed(0x77)]),
      });
      const validator = new DeviceTokenBearerValidator(registry, { touchOnSuccess: true });
      const { rawToken, deviceId } = registry.issue({ deviceName: 'phone' });
      const lastSeenBefore = registry.get(deviceId)!.lastSeen;
      nowMs += 60_000;
      validator.validate(rawToken);
      expect(registry.get(deviceId)!.lastSeen).toBe(Math.floor(nowMs / 1000));
      expect(registry.get(deviceId)!.lastSeen).toBeGreaterThan(lastSeenBefore);
    });

    it('touchOnSuccess does NOT fire on failed validation', () => {
      let nowMs = 1_700_000_000_000;
      const registry = new DeviceTokenRegistry({
        nowMsFn: () => nowMs,
        randomBytesFn: scriptedRandom([seed(0x88)]),
      });
      const validator = new DeviceTokenBearerValidator(registry, { touchOnSuccess: true });
      const { rawToken: _goodToken, deviceId } = registry.issue({ deviceName: 'phone' });
      const lastSeenBefore = registry.get(deviceId)!.lastSeen;
      nowMs += 60_000;
      validator.validate('00'.repeat(32));
      expect(registry.get(deviceId)!.lastSeen).toBe(lastSeenBefore);
    });
  });
});

describe('authenticateBearerFromDeviceRegistry (task 4.65)', () => {
  it('extracts + validates in one call', () => {
    const registry = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(0x91)]),
    });
    const { rawToken } = registry.issue({ deviceName: 'phone' });
    const validator = new DeviceTokenBearerValidator(registry);
    const out = authenticateBearerFromDeviceRegistry(`Bearer ${rawToken}`, validator);
    expect(out.ok).toBe(true);
  });

  it.each([
    ['missing header (undefined)', undefined, 'missing' as const],
    ['missing header (null)', null, 'missing' as const],
    ['empty header', '', 'missing' as const],
    ['wrong scheme', 'Basic dXNlcjpwYXNz', 'malformed' as const],
    ['bearer with no token', 'Bearer ', 'malformed' as const],
  ])('rejects %s → reason=%s', (_label, header, reason) => {
    const validator = new DeviceTokenBearerValidator(new DeviceTokenRegistry());
    const out = authenticateBearerFromDeviceRegistry(
      header,
      validator,
    ) as Extract<DeviceTokenValidationDetail, { ok: false }>;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe(reason);
  });

  it('accepts case-insensitive Bearer scheme', () => {
    const registry = new DeviceTokenRegistry({
      randomBytesFn: scriptedRandom([seed(0xa1)]),
    });
    const { rawToken } = registry.issue({ deviceName: 'phone' });
    const validator = new DeviceTokenBearerValidator(registry);
    expect(authenticateBearerFromDeviceRegistry(`bearer ${rawToken}`, validator).ok).toBe(
      true,
    );
  });
});
