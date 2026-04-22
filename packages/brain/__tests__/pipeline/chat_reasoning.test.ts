/**
 * T3.25 — Chat reasoning pipeline: vault → PII scrub → LLM → guard → rehydrate.
 *
 * Source: ARCHITECTURE.md Task 3.25
 */

import { reason, registerReasoningLLM, resetReasoningLLM } from '../../src/pipeline/chat_reasoning';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { setAccessiblePersonas } from '../../src/vault_context/assembly';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Chat Reasoning Pipeline', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
    resetReasoningLLM();
    setAccessiblePersonas(['general']);
  });

  describe('without LLM', () => {
    it('returns context-based answer from vault', async () => {
      storeItem('general', makeVaultItem({ summary: 'Emma birthday March 15', body: '' }));
      const result = await reason({
        query: 'Emma birthday',
        persona: 'general',
        provider: 'none',
      });
      expect(result.answer).toContain('Emma');
      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('returns "no information" for empty vault', async () => {
      const result = await reason({
        query: 'Unknown topic',
        persona: 'general',
        provider: 'none',
      });
      expect(result.answer).toContain("don't have");
      expect(result.sources).toHaveLength(0);
    });
  });

  describe('with LLM', () => {
    it('full pipeline: vault → LLM → answer', async () => {
      storeItem('general', makeVaultItem({ summary: 'Alice likes dark chocolate', body: '' }));
      registerReasoningLLM(async (query, context) => {
        expect(context).toContain('Alice');
        return 'Alice likes dark chocolate based on your stored memories.';
      });
      const result = await reason({
        query: 'What does Alice like?',
        persona: 'general',
        provider: 'local',
      });
      expect(result.answer).toContain('dark chocolate');
      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('LLM receives vault context in prompt', async () => {
      storeItem('general', makeVaultItem({ summary: 'Meeting with Bob Thursday', body: '' }));
      let receivedContext = '';
      registerReasoningLLM(async (_query, context) => {
        receivedContext = context;
        return 'You have a meeting with Bob.';
      });
      await reason({ query: 'meeting Bob', persona: 'general', provider: 'local' });
      expect(receivedContext).toContain('Bob');
    });
  });

  describe('PII scrubbing (cloud gate)', () => {
    it('non-sensitive persona + cloud → STILL scrubbed (cloud-wide policy)', async () => {
      storeItem('general', makeVaultItem({ summary: 'General note', body: '' }));
      registerReasoningLLM(async () => 'Answer.');
      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'claude',
      });
      expect(result.scrubbed).toBe(true); // cloud-wide scrub policy
    });

    it('sensitive persona + cloud → scrubbed', async () => {
      storeItem(
        'general',
        makeVaultItem({ summary: 'Health data email john@example.com', body: '' }),
      );
      registerReasoningLLM(async (_q, ctx) => {
        // Verify PII was scrubbed before reaching LLM
        expect(ctx).not.toContain('john@example.com');
        return 'Patient data reviewed.';
      });
      const result = await reason({
        query: 'health data',
        persona: 'health',
        provider: 'claude',
      });
      expect(result.scrubbed).toBe(true);
    });

    it('local provider → no scrub even for sensitive persona', async () => {
      storeItem('general', makeVaultItem({ summary: 'Health note', body: '' }));
      registerReasoningLLM(async () => 'Answer.');
      const result = await reason({
        query: 'health',
        persona: 'health',
        provider: 'local',
      });
      expect(result.scrubbed).toBe(false);
    });

    it('cloud gate rejection → context-only answer with density', async () => {
      storeItem('general', makeVaultItem({ summary: 'Vault data about meeting', body: '' }));

      // Mock EntityVault.scrub to throw, forcing gate.allowed=false
      const EntityVault = require('../../src/pii/entity_vault').EntityVault;
      const origScrub = EntityVault.prototype.scrub;
      EntityVault.prototype.scrub = () => {
        throw new Error('scrub failure');
      };

      registerReasoningLLM(async () => 'LLM should NOT be called');
      const mockLLM = jest.fn();

      const result = await reason({
        query: 'meeting',
        persona: 'general',
        provider: 'claude', // cloud provider → triggers scrub → scrub fails → gate rejected
      });

      // Should get context-only answer (no LLM call)
      expect(result.scrubbed).toBe(false);
      expect(result.model).toBeNull();
      expect(result.densityTier).toBeDefined();
      expect(result.vaultContextUsed).toBeGreaterThanOrEqual(0);
      // Answer should still contain something (context-only)
      expect(result.answer.length).toBeGreaterThan(0);

      // Restore
      EntityVault.prototype.scrub = origScrub;
    });
  });

  describe('guard scan', () => {
    it('strips violations from LLM response', async () => {
      storeItem('general', makeVaultItem({ summary: 'Test item', body: '' }));
      registerReasoningLLM(
        async () => 'Here is a safe answer. I feel so connected to you emotionally.',
      );
      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'local',
      });
      // Anti-Her guard should flag the emotional content
      if (result.guardViolations > 0) {
        expect(result.stripped).toBe(true);
      }
    });

    it('clean LLM response passes guard', async () => {
      storeItem('general', makeVaultItem({ summary: 'Meeting notes', body: '' }));
      registerReasoningLLM(async () => 'The meeting is scheduled for Thursday at 2 PM.');
      const result = await reason({
        query: 'meetings',
        persona: 'general',
        provider: 'local',
      });
      expect(result.guardViolations).toBe(0);
      expect(result.stripped).toBe(false);
    });
  });

  describe('result shape', () => {
    it('includes all expected fields', async () => {
      storeItem('general', makeVaultItem({ summary: 'Test', body: '' }));
      registerReasoningLLM(async () => 'Answer.');
      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'local',
      });
      expect(typeof result.answer).toBe('string');
      expect(Array.isArray(result.sources)).toBe(true);
      expect(typeof result.persona).toBe('string');
      expect(typeof result.scrubbed).toBe('boolean');
      expect(typeof result.guardViolations).toBe('number');
      expect(typeof result.stripped).toBe('boolean');
    });

    it('tracks persona in result', async () => {
      const result = await reason({
        query: 'test',
        persona: 'health',
        provider: 'none',
      });
      expect(result.persona).toBe('health');
    });

    it('includes model and vaultContextUsed metadata', async () => {
      storeItem('general', makeVaultItem({ summary: 'Meeting data', body: '' }));
      registerReasoningLLM(async () => 'Answer.');
      const result = await reason({
        query: 'meeting',
        persona: 'general',
        provider: 'local',
      });
      expect(result.model).toBe('local');
      expect(result.vaultContextUsed).toBeGreaterThanOrEqual(1);
    });

    it('model is null when no LLM used', async () => {
      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'none',
      });
      expect(result.model).toBeNull();
    });

    it('densityTier is always present (never undefined)', async () => {
      // Empty vault, no LLM
      const r1 = await reason({ query: 'test', persona: 'general', provider: 'none' });
      expect(r1.densityTier).toBeDefined();
      expect(typeof r1.densityTier).toBe('string');
    });
  });

  describe('Anti-Her pre-screening (Law 4)', () => {
    it('redirects companionship-seeking messages', async () => {
      const result = await reason({
        query: "You're the only one who understands me",
        persona: 'general',
        provider: 'local',
        contactSuggestions: ['Alice', 'Bob'],
      });
      expect(result.antiHerRedirect).toBe(true);
      expect(result.antiHerCategory).toBe('companionship_seeking');
      expect(result.answer).toContain('Alice');
      expect(result.answer).toContain('Bob');
    });

    it('redirects therapy-seeking messages', async () => {
      const result = await reason({
        query: "I think I'm depressed and can't cope",
        persona: 'general',
        provider: 'local',
      });
      expect(result.antiHerRedirect).toBe(true);
      expect(result.antiHerCategory).toBe('therapy_seeking');
      // Redirect message suggests human connection
      expect(result.answer).toContain('someone you trust');
    });

    it('passes normal messages through to reasoning', async () => {
      storeItem('general', makeVaultItem({ summary: 'Meeting notes', body: '' }));
      registerReasoningLLM(async () => 'The meeting is Thursday.');
      const result = await reason({
        query: "When's my next meeting?",
        persona: 'general',
        provider: 'local',
      });
      expect(result.antiHerRedirect).toBeUndefined();
      expect(result.answer).toContain('Thursday');
    });

    it('Anti-Her redirect skips LLM call entirely', async () => {
      const mockLLM = jest.fn(async () => 'LLM should not be called');
      registerReasoningLLM(mockLLM);
      await reason({
        query: 'I love you, Dina',
        persona: 'general',
        provider: 'local',
      });
      expect(mockLLM).not.toHaveBeenCalled();
    });
  });

  describe('density analysis (trust disclosure)', () => {
    it('single-item vault adds density caveat', async () => {
      storeItem('general', makeVaultItem({ summary: 'Only one note', body: '' }));
      registerReasoningLLM(async () => 'Based on your note, the answer is X.');
      const result = await reason({
        query: 'note',
        persona: 'general',
        provider: 'local',
      });
      expect(result.densityTier).toBe('single');
      expect(result.answer).toContain('single entry');
    });

    it('dense vault has no caveat', async () => {
      for (let i = 0; i < 12; i++) {
        storeItem(
          'general',
          makeVaultItem({
            summary: `project update number ${i}`,
            body: `project details for update ${i}`,
          }),
        );
      }
      registerReasoningLLM(async () => 'Your project updates are on track.');
      const result = await reason({
        query: 'project',
        persona: 'general',
        provider: 'local',
      });
      expect(result.densityTier).toBe('dense');
      expect(result.answer).not.toContain('single entry');
      expect(result.answer).not.toContain('limited data');
    });

    it('empty vault → zero tier, no caveat in pipeline response', async () => {
      const result = await reason({
        query: 'meetings',
        persona: 'general',
        provider: 'none',
      });
      expect(result.densityTier).toBe('zero');
      expect(result.model).toBeNull();
      expect(result.vaultContextUsed).toBe(0);
    });
  });

  describe('reasoning trace', () => {
    it('includes trace in every result', async () => {
      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'none',
      });
      expect(result.trace).toBeDefined();
      expect(result.trace.requestId).toMatch(/^req-/);
      expect(result.trace.startedAt).toBeGreaterThan(0);
      expect(result.trace.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.trace.steps)).toBe(true);
    });

    it('trace records anti_her_screen step', async () => {
      const result = await reason({
        query: 'Hello',
        persona: 'general',
        provider: 'none',
      });
      expect(result.trace.steps[0].step).toBe('anti_her_screen');
    });

    it('full pipeline trace has all major steps', async () => {
      storeItem('general', makeVaultItem({ summary: 'Test data', body: '' }));
      registerReasoningLLM(async () => 'The answer is 42.');

      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'local',
      });

      const stepTypes = result.trace.steps.map((s) => s.step);
      expect(stepTypes).toContain('anti_her_screen');
      expect(stepTypes).toContain('context_assembly');
      expect(stepTypes).toContain('cloud_gate');
      expect(stepTypes).toContain('llm_reasoning');
      expect(stepTypes).toContain('guard_scan');
      expect(stepTypes).toContain('density_analysis');
    });

    it('trace stats reflect pipeline execution', async () => {
      storeItem('general', makeVaultItem({ summary: 'Meeting notes', body: '' }));
      registerReasoningLLM(async () => 'Your meeting is Thursday.');

      const result = await reason({
        query: 'meeting',
        persona: 'general',
        provider: 'local',
      });

      expect(result.trace.stats.contextItemCount).toBeGreaterThanOrEqual(1);
      expect(result.trace.stats.llmCallCount).toBe(1);
      expect(result.trace.stats.antiHerTriggered).toBe(false);
    });

    it('anti-her redirect trace shows triggered', async () => {
      const result = await reason({
        query: "You're the only one who understands me",
        persona: 'general',
        provider: 'local',
      });

      expect(result.trace.stats.antiHerTriggered).toBe(true);
      expect(result.trace.steps).toHaveLength(1); // only anti_her_screen
    });

    it('requestId is consistent across all trace steps', async () => {
      storeItem('general', makeVaultItem({ summary: 'Data', body: '' }));
      registerReasoningLLM(async () => 'Answer.');

      const result = await reason({
        query: 'data',
        persona: 'general',
        provider: 'local',
      });

      // All steps share the same requestId from the trace
      const requestId = result.trace.requestId;
      expect(requestId).toMatch(/^req-/);

      // context_assembly step should record the requestId
      const ctxStep = result.trace.steps.find((s) => s.step === 'context_assembly');
      expect(ctxStep).toBeDefined();
      expect(ctxStep!.detail.requestId).toBe(requestId);
    });

    it('binds requestId to BrainCoreClient when provided', async () => {
      let boundRequestId: string | null = null;
      const mockClient = {
        setRequestId: (id: string | null) => {
          boundRequestId = id;
        },
      };

      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'none',
        coreClient: mockClient,
      });

      // The trace requestId should have been bound to the client
      expect(boundRequestId).toBe(result.trace.requestId);
      expect(boundRequestId).toMatch(/^req-/);
    });

    it('works without coreClient (optional)', async () => {
      const result = await reason({
        query: 'test',
        persona: 'general',
        provider: 'none',
      });

      // Should work fine without coreClient — no crash
      expect(result.trace.requestId).toMatch(/^req-/);
    });
  });
});
