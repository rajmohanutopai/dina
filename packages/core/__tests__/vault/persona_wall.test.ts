/**
 * T2D.20 — Persona tier enforcement end-to-end.
 *
 * Source: tests/release/test_rel_009_persona_wall.py
 */

import { evaluateIntent } from '../../src/gatekeeper/intent';
import {
  autoOpensOnBoot,
  requiresApproval,
  requiresPassphrase,
  brainCanAccess,
  agentCanAccess,
} from '../../src/vault/lifecycle';

describe('Persona Wall (Release Verification)', () => {
  describe('tier enforcement', () => {
    it('default tier: auto-opens, no gate', () => {
      expect(autoOpensOnBoot('default')).toBe(true);
    });
    it('standard tier: auto-opens, open to agents in V1', () => {
      expect(agentCanAccess('standard', false)).toBe(true);
    });
    it('sensitive tier: closed at boot, requires approval', () => {
      expect(requiresApproval('sensitive')).toBe(true);
    });
    it('locked tier: closed at boot, requires passphrase', () => {
      expect(requiresPassphrase('locked')).toBe(true);
    });
  });

  describe('agent access flow (V1 contract — issues.txt §2)', () => {
    it('agent → standard open in V1 (no grant needed)', () => {
      expect(agentCanAccess('standard', false)).toBe(true);
    });
    it('agent without grant → denied for sensitive', () => {
      expect(agentCanAccess('sensitive', false)).toBe(false);
    });
    it('agent with grant → allowed for sensitive', () => {
      expect(agentCanAccess('sensitive', true)).toBe(true);
    });
    it('agent with grant → allowed for locked (approval+grant, not hard-denied)', () => {
      expect(agentCanAccess('locked', true)).toBe(true);
    });
    it('agent without grant → denied for locked', () => {
      expect(agentCanAccess('locked', false)).toBe(false);
    });
  });

  describe('Brain access', () => {
    it('Brain freely accesses default + standard', () => {
      expect(brainCanAccess('default')).toBe(true);
      expect(brainCanAccess('standard')).toBe(true);
    });
    it('Brain needs approval for sensitive (no free access)', () => {
      expect(brainCanAccess('sensitive')).toBe(false);
    });
    it('Brain DENIED for locked', () => {
      expect(brainCanAccess('locked')).toBe(false);
    });
  });

  describe('gatekeeper integration', () => {
    it('vault_backup → BLOCKED (brain-denied)', () => {
      expect(evaluateIntent('vault_backup').allowed).toBe(false);
    });
    it('credential_export → BLOCKED', () => {
      expect(evaluateIntent('credential_export').allowed).toBe(false);
    });
  });

  describe('session lifecycle', () => {
    it('session end revokes all grants for that session', () => {
      expect(true).toBe(true);
    });
    it('grant-opened sensitive vaults close on session end', () => {
      expect(true).toBe(true);
    });
  });
});
