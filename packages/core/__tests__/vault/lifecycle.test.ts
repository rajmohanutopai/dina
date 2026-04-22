/**
 * T1G.1 — Vault persona tier lifecycle.
 *
 * | Tier      | Boot   | Brain  | Agents            |
 * |-----------|--------|--------|-------------------|
 * | default   | open   | free   | free              |
 * | standard  | open   | free   | session grant     |
 * | sensitive | closed | approval | approval + grant |
 * | locked    | closed | denied | denied            |
 *
 * Source: core/test/vault_test.go
 */

import {
  autoOpensOnBoot,
  requiresApproval,
  requiresPassphrase,
  brainCanAccess,
  agentCanAccess,
} from '../../src/vault/lifecycle';

describe('Vault Persona Tier Lifecycle', () => {
  describe('autoOpensOnBoot', () => {
    it('default → auto-opens', () => {
      expect(autoOpensOnBoot('default')).toBe(true);
    });
    it('standard → auto-opens', () => {
      expect(autoOpensOnBoot('standard')).toBe(true);
    });
    it('sensitive → does NOT auto-open', () => {
      expect(autoOpensOnBoot('sensitive')).toBe(false);
    });
    it('locked → does NOT auto-open', () => {
      expect(autoOpensOnBoot('locked')).toBe(false);
    });
  });

  describe('requiresApproval', () => {
    it('default → no approval', () => {
      expect(requiresApproval('default')).toBe(false);
    });
    it('standard → no approval', () => {
      expect(requiresApproval('standard')).toBe(false);
    });
    it('sensitive → requires approval', () => {
      expect(requiresApproval('sensitive')).toBe(true);
    });
    it('locked → requires passphrase (not approval)', () => {
      expect(requiresApproval('locked')).toBe(false);
    });
  });

  describe('requiresPassphrase', () => {
    it('only locked tier requires passphrase', () => {
      expect(requiresPassphrase('default')).toBe(false);
      expect(requiresPassphrase('standard')).toBe(false);
      expect(requiresPassphrase('sensitive')).toBe(false);
      expect(requiresPassphrase('locked')).toBe(true);
    });
  });

  describe('brainCanAccess', () => {
    it('default → Brain has free access', () => {
      expect(brainCanAccess('default')).toBe(true);
    });
    it('standard → Brain has free access', () => {
      expect(brainCanAccess('standard')).toBe(true);
    });
    it('sensitive → Brain needs approval (no free access)', () => {
      expect(brainCanAccess('sensitive')).toBe(false);
    });
    it('locked → Brain is DENIED', () => {
      expect(brainCanAccess('locked')).toBe(false);
    });
  });

  describe('agentCanAccess', () => {
    it('default → agent can access freely (no grant needed)', () => {
      expect(agentCanAccess('default', false)).toBe(true);
    });
    it('standard → agent without grant denied', () => {
      expect(agentCanAccess('standard', false)).toBe(false);
    });
    it('standard → agent with grant can access', () => {
      expect(agentCanAccess('standard', true)).toBe(true);
    });
    it('sensitive → agent without grant denied', () => {
      expect(agentCanAccess('sensitive', false)).toBe(false);
    });
    it('sensitive → agent with grant can access', () => {
      expect(agentCanAccess('sensitive', true)).toBe(true);
    });
    it('locked → agent is DENIED (even with grant)', () => {
      expect(agentCanAccess('locked', true)).toBe(false);
    });
  });
});
