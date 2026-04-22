/**
 * Task 4.24 — service-allowlist DID → CallerType resolver tests.
 */

import { ServiceAllowlist } from '../src/auth/service_allowlist';

const BRAIN = 'did:plc:brain-01';
const ADMIN = 'did:plc:admin-01';
const CONNECTOR_A = 'did:plc:gmail-connector';
const CONNECTOR_B = 'did:plc:calendar-connector';
const DEVICE_A = 'did:plc:phone';
const DEVICE_B = 'did:plc:laptop';
const AGENT_A = 'did:plc:openclaw-session-1';

describe('ServiceAllowlist (task 4.24)', () => {
  describe('construction', () => {
    it('rejects empty brainDid', () => {
      expect(() => new ServiceAllowlist({ brainDid: '' })).toThrow(/brainDid is required/);
    });

    it('brainDid alone is sufficient (no other categories)', () => {
      const al = new ServiceAllowlist({ brainDid: BRAIN });
      expect(al.lookup(BRAIN)).toEqual({ ok: true, callerType: 'brain' });
      expect(al.lookup(ADMIN)).toEqual({ ok: false, reason: 'unknown_did' });
    });
  });

  describe('lookup priority', () => {
    it('brain > admin > connector > device > agent', () => {
      const al = new ServiceAllowlist({
        brainDid: BRAIN,
        adminDid: ADMIN,
        connectorDids: [CONNECTOR_A],
        deviceDids: [DEVICE_A],
        agentDids: [AGENT_A],
      });
      expect(al.lookup(BRAIN)).toEqual({ ok: true, callerType: 'brain' });
      expect(al.lookup(ADMIN)).toEqual({ ok: true, callerType: 'admin' });
      expect(al.lookup(CONNECTOR_A)).toEqual({ ok: true, callerType: 'connector' });
      expect(al.lookup(DEVICE_A)).toEqual({ ok: true, callerType: 'device' });
      expect(al.lookup(AGENT_A)).toEqual({ ok: true, callerType: 'agent' });
    });

    it('DID in both brain + device position → brain wins (policy: higher priority)', () => {
      const al = new ServiceAllowlist({
        brainDid: BRAIN,
        deviceDids: [BRAIN], // misconfigured — same DID in two lists
      });
      expect(al.lookup(BRAIN)).toEqual({ ok: true, callerType: 'brain' });
    });
  });

  describe('unknown DID', () => {
    it('returns unknown_did for a DID that isn\'t in any list', () => {
      const al = new ServiceAllowlist({ brainDid: BRAIN });
      expect(al.lookup('did:plc:random')).toEqual({ ok: false, reason: 'unknown_did' });
    });

    it('returns unknown_did for empty string', () => {
      const al = new ServiceAllowlist({ brainDid: BRAIN });
      expect(al.lookup('')).toEqual({ ok: false, reason: 'unknown_did' });
    });
  });

  describe('multi-entry sets', () => {
    it('accepts multiple connectors', () => {
      const al = new ServiceAllowlist({
        brainDid: BRAIN,
        connectorDids: [CONNECTOR_A, CONNECTOR_B],
      });
      expect(al.lookup(CONNECTOR_A)).toEqual({ ok: true, callerType: 'connector' });
      expect(al.lookup(CONNECTOR_B)).toEqual({ ok: true, callerType: 'connector' });
    });

    it('accepts multiple devices', () => {
      const al = new ServiceAllowlist({
        brainDid: BRAIN,
        deviceDids: [DEVICE_A, DEVICE_B],
      });
      expect(al.lookup(DEVICE_A)).toEqual({ ok: true, callerType: 'device' });
      expect(al.lookup(DEVICE_B)).toEqual({ ok: true, callerType: 'device' });
    });
  });

  describe('live reload via setConfig', () => {
    it('setConfig replaces all lists atomically', () => {
      const al = new ServiceAllowlist({
        brainDid: BRAIN,
        connectorDids: [CONNECTOR_A],
      });
      expect(al.lookup(CONNECTOR_A)).toEqual({ ok: true, callerType: 'connector' });

      al.setConfig({
        brainDid: BRAIN,
        connectorDids: [CONNECTOR_B], // replaced
      });
      expect(al.lookup(CONNECTOR_A)).toEqual({ ok: false, reason: 'unknown_did' });
      expect(al.lookup(CONNECTOR_B)).toEqual({ ok: true, callerType: 'connector' });
    });

    it('setConfig can change the brain DID', () => {
      const al = new ServiceAllowlist({ brainDid: BRAIN });
      al.setConfig({ brainDid: 'did:plc:new-brain' });
      expect(al.lookup(BRAIN)).toEqual({ ok: false, reason: 'unknown_did' });
      expect(al.lookup('did:plc:new-brain')).toEqual({ ok: true, callerType: 'brain' });
    });

    it('setConfig rejects empty brainDid', () => {
      const al = new ServiceAllowlist({ brainDid: BRAIN });
      expect(() => al.setConfig({ brainDid: '' })).toThrow(/brainDid is required/);
    });
  });

  describe('setAgentSessions churn', () => {
    it('updates only the agent list', () => {
      const al = new ServiceAllowlist({
        brainDid: BRAIN,
        connectorDids: [CONNECTOR_A],
        agentDids: [AGENT_A],
      });
      al.setAgentSessions(['did:plc:new-agent']);
      expect(al.lookup(AGENT_A)).toEqual({ ok: false, reason: 'unknown_did' });
      expect(al.lookup('did:plc:new-agent')).toEqual({ ok: true, callerType: 'agent' });
      // Connectors + brain untouched.
      expect(al.lookup(CONNECTOR_A)).toEqual({ ok: true, callerType: 'connector' });
      expect(al.lookup(BRAIN)).toEqual({ ok: true, callerType: 'brain' });
    });
  });

  describe('stats', () => {
    it('reports per-category counts', () => {
      const al = new ServiceAllowlist({
        brainDid: BRAIN,
        adminDid: ADMIN,
        connectorDids: [CONNECTOR_A, CONNECTOR_B],
        deviceDids: [DEVICE_A],
      });
      expect(al.stats()).toEqual({
        brain: 1,
        admin: 1,
        connectors: 2,
        devices: 1,
        agents: 0,
      });
    });

    it('admin: 0 when no admin configured', () => {
      const al = new ServiceAllowlist({ brainDid: BRAIN });
      expect(al.stats().admin).toBe(0);
    });
  });
});
