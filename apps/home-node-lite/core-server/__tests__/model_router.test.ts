/**
 * Task 5.24 — router model selection per task type tests.
 */

import { CloudGate } from '../src/brain/cloud_gate';
import {
  ModelRouter,
  type TaskRoutingPolicy,
} from '../src/brain/model_router';
import {
  loadProviderConfig,
  toCloudGateEntries,
  type ProviderConfig,
} from '../src/brain/provider_config';

function sampleConfig(): ProviderConfig {
  return loadProviderConfig({
    rawJson: JSON.stringify({
      providers: [
        {
          name: 'anthropic',
          kind: 'cloud',
          models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
          defaultModel: 'claude-sonnet-4-6',
          enabled: true,
        },
        {
          name: 'openai',
          kind: 'cloud',
          models: ['gpt-5-mini', 'gpt-5'],
          defaultModel: 'gpt-5-mini',
          enabled: true,
        },
        {
          name: 'local-llama',
          kind: 'local',
          models: ['gemma-3n'],
          defaultModel: 'gemma-3n',
          enabled: true,
        },
      ],
    }),
    env: {
      DINA_ANTHROPIC_API_KEY: 'sk-a',
      DINA_OPENAI_API_KEY: 'sk-o',
    },
  });
}

function sampleGate(config: ProviderConfig): CloudGate {
  return new CloudGate({ providers: toCloudGateEntries(config) });
}

const samplePolicy: TaskRoutingPolicy = {
  reasoning: [
    { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'openai' },
    { provider: 'local-llama' },
  ],
  summarisation: [{ provider: 'openai', model: 'gpt-5-mini' }],
  classification: [{ provider: 'local-llama' }],
  embedding: [{ provider: 'openai' }],
  chat: [
    { provider: 'anthropic' },
    { provider: 'local-llama' },
  ],
};

describe('ModelRouter (task 5.24)', () => {
  describe('construction validation', () => {
    it('rejects missing config', () => {
      expect(
        () =>
          new ModelRouter({
            config: undefined as unknown as ProviderConfig,
            gate: sampleGate(sampleConfig()),
            policy: samplePolicy,
          }),
      ).toThrow(/config is required/);
    });

    it('rejects missing gate', () => {
      const config = sampleConfig();
      expect(
        () =>
          new ModelRouter({
            config,
            gate: undefined as unknown as CloudGate,
            policy: samplePolicy,
          }),
      ).toThrow(/gate is required/);
    });

    it('rejects missing policy', () => {
      const config = sampleConfig();
      expect(
        () =>
          new ModelRouter({
            config,
            gate: sampleGate(config),
            policy: undefined as unknown as TaskRoutingPolicy,
          }),
      ).toThrow(/policy is required/);
    });
  });

  describe('route — happy path', () => {
    it('picks the first preference for default tier', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: samplePolicy,
      });
      const result = router.route('reasoning', 'default');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.selection).toEqual({
          provider: 'anthropic',
          model: 'claude-opus-4-7', // per-pref model override
          kind: 'cloud',
        });
      }
    });

    it('falls back to provider defaultModel when pref has no model', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: {
          ...samplePolicy,
          reasoning: [{ provider: 'anthropic' }], // no model override
        },
      });
      const result = router.route('reasoning', 'default');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.selection.model).toBe('claude-sonnet-4-6');
    });

    it('for sensitive tier, skips cloud preferences + picks local', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: samplePolicy,
      });
      const result = router.route('reasoning', 'sensitive');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.selection).toEqual({
          provider: 'local-llama',
          model: 'gemma-3n',
          kind: 'local',
        });
      }
    });

    it('for locked tier, same behavior as sensitive', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: samplePolicy,
      });
      expect(router.route('chat', 'locked').ok).toBe(true);
    });
  });

  describe('route — rejections', () => {
    it('taskType with empty preferences → no_preferences_for_task', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: { ...samplePolicy, reasoning: [] },
      });
      const result = router.route('reasoning', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.reason).toBe('no_preferences_for_task');
        if (result.rejection.reason === 'no_preferences_for_task') {
          expect(result.rejection.taskType).toBe('reasoning');
        }
      }
    });

    it('sensitive tier + only-cloud preferences → all_preferences_rejected with reasons', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: {
          ...samplePolicy,
          summarisation: [{ provider: 'openai' }, { provider: 'anthropic' }],
        },
      });
      const result = router.route('summarisation', 'sensitive');
      expect(result.ok).toBe(false);
      if (!result.ok && result.rejection.reason === 'all_preferences_rejected') {
        expect(result.rejection.attempts).toEqual([
          { provider: 'openai', reason: 'cloud_blocked' },
          { provider: 'anthropic', reason: 'cloud_blocked' },
        ]);
      }
    });

    it('preference referencing a disabled provider → not_available', () => {
      const config = loadProviderConfig({
        rawJson: JSON.stringify({
          providers: [
            {
              name: 'anthropic',
              kind: 'cloud',
              models: ['m'],
              defaultModel: 'm',
              enabled: false,
            },
          ],
        }),
        env: {},
      });
      const gate = new CloudGate({ providers: toCloudGateEntries(config) });
      const router = new ModelRouter({
        config,
        gate,
        policy: {
          ...samplePolicy,
          reasoning: [{ provider: 'anthropic' }],
        },
      });
      const result = router.route('reasoning', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok && result.rejection.reason === 'all_preferences_rejected') {
        expect(result.rejection.attempts).toEqual([
          { provider: 'anthropic', reason: 'not_available' },
        ]);
      }
    });

    it('preference with model NOT in provider.models → model_not_in_provider', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: {
          ...samplePolicy,
          reasoning: [{ provider: 'anthropic', model: 'nonesuch-model' }],
        },
      });
      const result = router.route('reasoning', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok && result.rejection.reason === 'all_preferences_rejected') {
        expect(result.rejection.attempts).toEqual([
          { provider: 'anthropic', reason: 'model_not_in_provider' },
        ]);
      }
    });

    it('fallback cascade: first-pref cloud-blocked, second-pref picks local', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: {
          ...samplePolicy,
          chat: [
            { provider: 'anthropic' }, // blocked for sensitive
            { provider: 'local-llama' },
          ],
        },
      });
      const result = router.route('chat', 'sensitive');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.selection.provider).toBe('local-llama');
        expect(result.selection.kind).toBe('local');
      }
    });
  });

  describe('end-to-end integration', () => {
    it('config + gate + policy → deterministic selection across task types', () => {
      const config = sampleConfig();
      const router = new ModelRouter({
        config,
        gate: sampleGate(config),
        policy: samplePolicy,
      });
      // Every task type routes somewhere for default tier.
      for (const task of [
        'reasoning',
        'summarisation',
        'classification',
        'embedding',
        'chat',
      ] as const) {
        const result = router.route(task, 'default');
        expect(result.ok).toBe(true);
      }
    });
  });
});
