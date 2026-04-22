/**
 * T2.63 — Device registry: register, list, revoke, getByPublicKey.
 *
 * Source: ARCHITECTURE.md Section 2.63
 */

import {
  registerDevice,
  listDevices,
  listActiveDevices,
  getDevice,
  getByPublicKey,
  revokeDevice,
  isDeviceActive,
  touchDevice,
  deviceCount,
  getDeviceByDID,
  resetDeviceRegistry,
} from '../../src/devices/registry';

describe('Device Registry', () => {
  beforeEach(() => resetDeviceRegistry());

  describe('registerDevice', () => {
    it('registers with generated deviceId', () => {
      const d = registerDevice('iPhone 15', 'z6MkPhoneKey123', 'rich');
      expect(d.deviceId).toMatch(/^dev-[0-9a-f]{16}$/);
      expect(d.deviceName).toBe('iPhone 15');
      expect(d.publicKeyMultibase).toBe('z6MkPhoneKey123');
      expect(d.role).toBe('rich');
      expect(d.revoked).toBe(false);
    });

    it('stores creation timestamp', () => {
      const before = Date.now();
      const d = registerDevice('iPad', 'z6MkTabletKey', 'rich');
      expect(d.createdAt).toBeGreaterThanOrEqual(before);
    });

    it('rejects empty name', () => {
      expect(() => registerDevice('', 'z6MkKey', 'rich')).toThrow('name is required');
    });

    it('rejects empty publicKeyMultibase', () => {
      expect(() => registerDevice('Phone', '', 'rich')).toThrow('publicKeyMultibase is required');
    });

    it('rejects duplicate public key', () => {
      registerDevice('Phone 1', 'z6MkSameKey', 'rich');
      expect(() => registerDevice('Phone 2', 'z6MkSameKey', 'rich')).toThrow(
        'key already registered',
      );
    });

    it('allows re-registration of revoked key', () => {
      const d1 = registerDevice('Phone 1', 'z6MkReusedKey', 'rich');
      revokeDevice(d1.deviceId);
      const d2 = registerDevice('Phone 2', 'z6MkReusedKey', 'rich');
      expect(d2.deviceId).not.toBe(d1.deviceId);
    });

    it('supports all device roles', () => {
      expect(registerDevice('Rich', 'z6MkR', 'rich').role).toBe('rich');
      expect(registerDevice('Thin', 'z6MkT', 'thin').role).toBe('thin');
      expect(registerDevice('CLI', 'z6MkC', 'cli').role).toBe('cli');
    });
  });

  describe('listDevices', () => {
    it('returns all devices including revoked', () => {
      const d = registerDevice('Phone', 'z6MkKey1', 'rich');
      registerDevice('Tablet', 'z6MkKey2', 'rich');
      revokeDevice(d.deviceId);
      expect(listDevices()).toHaveLength(2);
    });

    it('returns empty when none registered', () => {
      expect(listDevices()).toEqual([]);
    });
  });

  describe('listActiveDevices', () => {
    it('excludes revoked devices', () => {
      const d = registerDevice('Phone', 'z6MkKey1', 'rich');
      registerDevice('Tablet', 'z6MkKey2', 'rich');
      revokeDevice(d.deviceId);
      const active = listActiveDevices();
      expect(active).toHaveLength(1);
      expect(active[0].deviceName).toBe('Tablet');
    });
  });

  describe('getDevice', () => {
    it('returns device by ID', () => {
      const d = registerDevice('Phone', 'z6MkKey', 'rich');
      expect(getDevice(d.deviceId)!.deviceName).toBe('Phone');
    });

    it('returns null for unknown ID', () => {
      expect(getDevice('dev-nonexistent')).toBeNull();
    });
  });

  describe('getByPublicKey', () => {
    it('returns device by multibase public key', () => {
      registerDevice('Phone', 'z6MkLookup', 'rich');
      const d = getByPublicKey('z6MkLookup');
      expect(d).not.toBeNull();
      expect(d!.deviceName).toBe('Phone');
    });

    it('returns null for unknown key', () => {
      expect(getByPublicKey('z6MkUnknown')).toBeNull();
    });
  });

  describe('revokeDevice', () => {
    it('marks device as revoked', () => {
      const d = registerDevice('Phone', 'z6MkKey', 'rich');
      expect(revokeDevice(d.deviceId)).toBe(true);
      expect(getDevice(d.deviceId)!.revoked).toBe(true);
    });

    it('returns false for unknown ID', () => {
      expect(revokeDevice('dev-nonexistent')).toBe(false);
    });

    it('revoked device fails isDeviceActive', () => {
      const d = registerDevice('Phone', 'z6MkKey', 'rich');
      expect(isDeviceActive(d.deviceId)).toBe(true);
      revokeDevice(d.deviceId);
      expect(isDeviceActive(d.deviceId)).toBe(false);
    });
  });

  describe('isDeviceActive', () => {
    it('true for active device', () => {
      const d = registerDevice('Phone', 'z6MkKey', 'rich');
      expect(isDeviceActive(d.deviceId)).toBe(true);
    });

    it('false for unknown device', () => {
      expect(isDeviceActive('dev-missing')).toBe(false);
    });
  });

  describe('touchDevice', () => {
    it('updates lastSeen', () => {
      const d = registerDevice('Phone', 'z6MkKey', 'rich');
      const before = Date.now();
      touchDevice(d.deviceId);
      expect(getDevice(d.deviceId)!.lastSeen).toBeGreaterThanOrEqual(before);
    });
  });

  describe('deviceCount', () => {
    it('counts all devices', () => {
      registerDevice('A', 'z6MkA', 'rich');
      registerDevice('B', 'z6MkB', 'thin');
      expect(deviceCount()).toBe(2);
    });
  });

  describe('DID field + getDeviceByDID', () => {
    it('registered device has a DID', () => {
      const device = registerDevice('Phone', 'z6MkPhone1', 'rich');
      expect(device.did).toBeTruthy();
      expect(device.did).toContain('did:key:');
    });

    it('getDeviceByDID returns device', () => {
      const device = registerDevice('Phone', 'z6MkPhoneX', 'rich');
      const found = getDeviceByDID(device.did);
      expect(found).not.toBeNull();
      expect(found!.deviceId).toBe(device.deviceId);
      expect(found!.deviceName).toBe('Phone');
    });

    it('getDeviceByDID returns null for unknown DID', () => {
      expect(getDeviceByDID('did:key:z6MkUnknown')).toBeNull();
    });

    it('DID is derived from public key (deterministic)', () => {
      const d1 = registerDevice('A', 'z6MkSameKey', 'rich');
      // Can't register same key twice, but DID should be consistent
      expect(d1.did).toContain('z6MkSameKey');
    });

    it('different keys produce different DIDs', () => {
      const d1 = registerDevice('A', 'z6MkKeyAlpha', 'rich');
      const d2 = registerDevice('B', 'z6MkKeyBeta', 'thin');
      expect(d1.did).not.toBe(d2.did);
    });
  });

  describe('authType field', () => {
    it('registered device has authType "ed25519"', () => {
      const device = registerDevice('Phone', 'z6MkAuth1', 'rich');
      expect(device.authType).toBe('ed25519');
    });
  });

  describe('ErrDeviceRevoked (double-revocation)', () => {
    it('throws on double-revocation', () => {
      const device = registerDevice('Phone', 'z6MkRevoke2', 'rich');
      revokeDevice(device.deviceId);
      expect(() => revokeDevice(device.deviceId)).toThrow('already revoked');
    });

    it('first revocation succeeds', () => {
      const device = registerDevice('Phone', 'z6MkRevoke3', 'rich');
      expect(revokeDevice(device.deviceId)).toBe(true);
    });

    it('returns false for unknown device (not an error)', () => {
      expect(revokeDevice('dev-nonexistent')).toBe(false);
    });
  });
});
