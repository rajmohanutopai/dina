/**
 * T3.19 — Cloud LLM gate: mandatory PII scrub for sensitive persona + cloud.
 *
 * Source: ARCHITECTURE.md Task 3.19
 */

import { checkCloudGate, rehydrateResponse, needsScrub } from '../../src/llm/cloud_gate';

describe('Cloud LLM Gate', () => {
  describe('checkCloudGate', () => {
    it('local provider → always allowed, no scrub', async () => {
      const result = await checkCloudGate('Health data with john@example.com', 'health', 'local');
      expect(result.allowed).toBe(true);
      expect(result.scrubbed).toBe(false);
      expect(result.scrubbedText).toContain('john@example.com'); // NOT scrubbed
    });

    it('none provider → always allowed, no scrub', async () => {
      const result = await checkCloudGate('Data', 'health', 'none');
      expect(result.allowed).toBe(true);
      expect(result.scrubbed).toBe(false);
    });

    it('non-sensitive persona + cloud → allowed WITH scrub (cloud-wide policy)', async () => {
      const result = await checkCloudGate('Meeting notes with alice@work.com', 'general', 'claude');
      expect(result.allowed).toBe(true);
      expect(result.scrubbed).toBe(true); // cloud-wide scrub
      expect(result.scrubbedText).not.toContain('alice@work.com');
    });

    it('sensitive persona + cloud → scrubbed', async () => {
      const result = await checkCloudGate('Patient john@example.com has lab results', 'health', 'claude');
      expect(result.allowed).toBe(true);
      expect(result.scrubbed).toBe(true);
      expect(result.scrubbedText).not.toContain('john@example.com');
      expect(result.scrubbedText).toContain('[EMAIL_1]');
      expect(result.vault).toBeDefined();
    });

    it('financial persona + cloud → scrubbed', async () => {
      const result = await checkCloudGate('Transfer to account 555-123-4567', 'financial', 'openai');
      expect(result.allowed).toBe(true);
      expect(result.scrubbed).toBe(true);
    });

    it('custom sensitive personas list', async () => {
      const result = await checkCloudGate('Secret data with email test@secret.com', 'secret', 'claude', [
        'secret',
        'classified',
      ]);
      expect(result.allowed).toBe(true);
      expect(result.scrubbed).toBe(true);
    });

    it('text without PII still passes (scrub succeeds trivially)', async () => {
      const result = await checkCloudGate(
        'No personal data here, just medical terminology',
        'health',
        'claude',
      );
      expect(result.allowed).toBe(true);
      expect(result.scrubbed).toBe(true); // scrub was attempted
    });
  });

  describe('rehydrateResponse', () => {
    it('restores PII in LLM response', async () => {
      const gateResult = await checkCloudGate(
        'Email john@example.com about the lab results',
        'health',
        'claude',
      );
      expect(gateResult.vault).toBeDefined();

      // Simulate LLM response with tokens
      const llmResponse = 'The patient at [EMAIL_1] should schedule a follow-up.';
      const rehydrated = rehydrateResponse(llmResponse, gateResult.vault!);
      expect(rehydrated).toContain('john@example.com');
      expect(rehydrated).not.toContain('[EMAIL_1]');
    });
  });

  describe('gate rejection (scrub failure)', () => {
    it('refuses cloud when scrub throws', async () => {
      // Mock EntityVault to throw during scrub — simulates catastrophic scrub failure
      const origScrub = require('../../src/pii/entity_vault').EntityVault.prototype.scrub;
      require('../../src/pii/entity_vault').EntityVault.prototype.scrub = () => {
        throw new Error('scrub catastrophe');
      };

      const result = await checkCloudGate('Sensitive data', 'health', 'claude');
      expect(result.allowed).toBe(false);
      expect(result.scrubbed).toBe(false);
      expect(result.fallback).toBe('local');
      expect(result.reason).toContain('Scrub failed');

      // Restore
      require('../../src/pii/entity_vault').EntityVault.prototype.scrub = origScrub;
    });
  });

  describe('needsScrub', () => {
    it('health + cloud → true', async () => {
      expect(needsScrub('health', 'claude')).toBe(true);
    });

    it('financial + cloud → true', async () => {
      expect(needsScrub('financial', 'openai')).toBe(true);
    });

    it('general + cloud → true (cloud-wide scrub policy)', async () => {
      expect(needsScrub('general', 'claude')).toBe(true);
    });

    it('health + local → false', async () => {
      expect(needsScrub('health', 'local')).toBe(false);
    });

    it('any + none → false', async () => {
      expect(needsScrub('health', 'none')).toBe(false);
    });
  });
});
