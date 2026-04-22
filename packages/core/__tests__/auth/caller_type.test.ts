/**
 * T2.10 — Caller type resolution: map authenticated DID → caller type.
 *
 * Source: ARCHITECTURE.md Section 2.10
 */

import {
  resolveCallerType,
  registerService,
  registerDevice,
  unregisterDevice,
  isService,
  isDevice,
  listServices,
  listDevices,
  resetCallerTypeState,
} from '../../src/auth/caller_type';

describe('Caller Type Resolution', () => {
  beforeEach(() => resetCallerTypeState());

  describe('service resolution', () => {
    it('Brain DID → CallerType.service', () => {
      registerService('did:key:z6MkBrain', 'brain');
      const result = resolveCallerType('did:key:z6MkBrain');
      expect(result.callerType).toBe('service');
      expect(result.name).toBe('brain');
      expect(result.did).toBe('did:key:z6MkBrain');
    });

    it('admin connector DID → CallerType.service', () => {
      registerService('did:key:z6MkAdmin', 'admin');
      const result = resolveCallerType('did:key:z6MkAdmin');
      expect(result.callerType).toBe('service');
    });

    it('multiple services registered', () => {
      registerService('did:key:z6MkBrain', 'brain');
      registerService('did:key:z6MkConnector', 'gmail-connector');
      expect(isService('did:key:z6MkBrain')).toBe(true);
      expect(isService('did:key:z6MkConnector')).toBe(true);
      expect(listServices()).toHaveLength(2);
    });
  });

  describe('device resolution', () => {
    it('paired device DID → CallerType.device', () => {
      registerDevice('did:key:z6MkPhone', 'iPhone 15');
      const result = resolveCallerType('did:key:z6MkPhone');
      expect(result.callerType).toBe('device');
      expect(result.name).toBe('iPhone 15');
    });

    it('unregistered device → revocation', () => {
      registerDevice('did:key:z6MkPhone', 'iPhone 15');
      unregisterDevice('did:key:z6MkPhone');
      const result = resolveCallerType('did:key:z6MkPhone');
      expect(result.callerType).toBe('unknown');
    });

    it('multiple devices registered', () => {
      registerDevice('did:key:z6MkPhone', 'iPhone');
      registerDevice('did:key:z6MkTablet', 'iPad');
      expect(listDevices()).toHaveLength(2);
    });
  });

  describe('agent resolution (forwarded)', () => {
    it('service + X-Agent-DID → CallerType.agent', () => {
      registerService('did:key:z6MkBrain', 'brain');
      const result = resolveCallerType('did:key:z6MkBrain', 'did:key:z6MkAgentBot');
      expect(result.callerType).toBe('agent');
      expect(result.did).toBe('did:key:z6MkAgentBot');
      expect(result.name).toContain('agent via brain');
    });

    it('device + X-Agent-DID → still device (only services can forward agents)', () => {
      registerDevice('did:key:z6MkPhone', 'iPhone');
      const result = resolveCallerType('did:key:z6MkPhone', 'did:key:z6MkAgent');
      expect(result.callerType).toBe('device');
    });

    it('unknown DID + agent header → still unknown', () => {
      const result = resolveCallerType('did:key:z6MkUnknown', 'did:key:z6MkAgent');
      expect(result.callerType).toBe('unknown');
    });
  });

  describe('unknown resolution', () => {
    it('unregistered DID → CallerType.unknown', () => {
      const result = resolveCallerType('did:key:z6MkStranger');
      expect(result.callerType).toBe('unknown');
      expect(result.did).toBe('did:key:z6MkStranger');
      expect(result.name).toBeUndefined();
    });
  });

  describe('priority: service > device', () => {
    it('DID registered as both → service wins', () => {
      const did = 'did:key:z6MkDual';
      registerService(did, 'service-role');
      registerDevice(did, 'device-role');
      const result = resolveCallerType(did);
      expect(result.callerType).toBe('service');
    });
  });

  describe('isService / isDevice', () => {
    it('isService returns true for registered services', () => {
      registerService('did:key:z6MkBrain', 'brain');
      expect(isService('did:key:z6MkBrain')).toBe(true);
      expect(isService('did:key:z6MkOther')).toBe(false);
    });

    it('isDevice returns true for registered devices', () => {
      registerDevice('did:key:z6MkPhone', 'iPhone');
      expect(isDevice('did:key:z6MkPhone')).toBe(true);
      expect(isDevice('did:key:z6MkOther')).toBe(false);
    });
  });

  describe('reset', () => {
    it('resetCallerTypeState clears all registries', () => {
      registerService('did:key:z6MkBrain', 'brain');
      registerDevice('did:key:z6MkPhone', 'iPhone');
      resetCallerTypeState();
      expect(listServices()).toHaveLength(0);
      expect(listDevices()).toHaveLength(0);
    });
  });
});
