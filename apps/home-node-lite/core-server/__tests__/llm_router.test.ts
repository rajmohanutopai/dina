/**
 * Task 5.43 — LlmRouter tests.
 */

import {
  LlmRouter,
  type LlmRouterEvent,
  type ProviderDescriptor,
  type RouteRequest,
  type RoutingDecision,
} from '../src/brain/llm_router';

const LOCAL: ProviderDescriptor = { id: 'local', isLocal: true };
const ANTHROPIC: ProviderDescriptor = { id: 'anthropic', isLocal: false };
const GEMINI: ProviderDescriptor = { id: 'gemini', isLocal: false };

function req(partial: Partial<RouteRequest>): RouteRequest {
  return {
    taskType: 'multi_step',
    personaTier: 'default',
    providers: [LOCAL, ANTHROPIC],
    userConsent: true,
    ...partial,
  };
}

describe('LlmRouter (task 5.43)', () => {
  describe('FTS-only short circuit', () => {
    it.each(['fts_lookup', 'keyword_search'] as const)(
      '%s → fts_only',
      (taskType) => {
        const r = new LlmRouter();
        const d = r.route(req({ taskType }));
        expect(d.action).toBe('fts_only');
      },
    );

    it('fts_only fires when providers array is empty', () => {
      const r = new LlmRouter();
      const d = r.route(req({ taskType: 'fts_lookup', providers: [] }));
      expect(d.action).toBe('fts_only');
    });
  });

  describe('no providers → refuse', () => {
    it('non-FTS task with zero providers → refuse', () => {
      const r = new LlmRouter();
      const d = r.route(req({ providers: [] }));
      expect(d.action).toBe('refuse');
      if (d.action === 'refuse') expect(d.reason).toBe('no_providers');
    });
  });

  describe('locked persona', () => {
    it('locked + local available → local', () => {
      const r = new LlmRouter();
      const d = r.route(req({ personaTier: 'locked' }));
      expect(d.action).toBe('local');
      if (d.action === 'local') expect(d.providerId).toBe('local');
    });

    it('locked + cloud-only → REFUSE (cloud forbidden for locked)', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({
          personaTier: 'locked',
          providers: [ANTHROPIC, GEMINI],
        }),
      );
      expect(d.action).toBe('refuse');
      if (d.action === 'refuse') {
        expect(d.reason).toBe('locked_persona_cloud_only');
      }
    });
  });

  describe('sensitive persona', () => {
    it('sensitive + local available → local (preferred regardless of consent)', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({ personaTier: 'sensitive', userConsent: false }),
      );
      expect(d.action).toBe('local');
    });

    it('sensitive + cloud-only + consent=true → cloud with scrubbing', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({
          personaTier: 'sensitive',
          providers: [ANTHROPIC],
          userConsent: true,
        }),
      );
      expect(d.action).toBe('cloud');
      if (d.action === 'cloud') {
        expect(d.providerId).toBe('anthropic');
        expect(d.requiresScrubbing).toBe(true);
      }
    });

    it('sensitive + cloud-only + consent=false → REFUSE', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({
          personaTier: 'sensitive',
          providers: [ANTHROPIC],
          userConsent: false,
        }),
      );
      expect(d.action).toBe('refuse');
      if (d.action === 'refuse') {
        expect(d.reason).toBe('sensitive_persona_no_consent');
      }
    });
  });

  describe('lightweight tasks', () => {
    it.each([
      'intent_classification',
      'domain_classification',
      'summarize',
      'guard_scan',
      'silence_classify',
      'multi_step',
    ] as const)('%s prefers local when available', (taskType) => {
      const r = new LlmRouter();
      const d = r.route(req({ taskType }));
      expect(d.action).toBe('local');
    });

    it('lightweight + only cloud → cloud', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({
          taskType: 'intent_classification',
          providers: [ANTHROPIC],
        }),
      );
      expect(d.action).toBe('cloud');
      if (d.action === 'cloud') {
        expect(d.providerId).toBe('anthropic');
        expect(d.requiresScrubbing).toBe(true);
      }
    });
  });

  describe('complex tasks', () => {
    it.each(['complex_reasoning', 'deep_analysis', 'video_analysis'] as const)(
      '%s prefers cloud when available',
      (taskType) => {
        const r = new LlmRouter();
        const d = r.route(req({ taskType }));
        expect(d.action).toBe('cloud');
      },
    );

    it('complex + cloud-only → cloud', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({ taskType: 'deep_analysis', providers: [ANTHROPIC] }),
      );
      expect(d.action).toBe('cloud');
    });

    it('complex + local-only → local (graceful degradation)', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({ taskType: 'deep_analysis', providers: [LOCAL] }),
      );
      expect(d.action).toBe('local');
    });
  });

  describe('preferredProvider honouring', () => {
    it('preferred cloud wins among multiple clouds', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({
          taskType: 'deep_analysis',
          providers: [LOCAL, ANTHROPIC, GEMINI],
          preferredProvider: 'gemini',
        }),
      );
      expect(d.action).toBe('cloud');
      if (d.action === 'cloud') expect(d.providerId).toBe('gemini');
    });

    it('default-tier preferred-cloud pick respects preference', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({
          taskType: 'complex_reasoning',
          providers: [LOCAL, ANTHROPIC, GEMINI],
          preferredProvider: 'gemini',
        }),
      );
      if (d.action === 'cloud') expect(d.providerId).toBe('gemini');
    });

    it('preferred that is not in the available list falls back to first cloud', () => {
      const r = new LlmRouter();
      const d = r.route(
        req({
          taskType: 'deep_analysis',
          providers: [LOCAL, ANTHROPIC],
          preferredProvider: 'gemini',
        }),
      );
      if (d.action === 'cloud') expect(d.providerId).toBe('anthropic');
    });

    it('complex tasks ignore preferred=local and route to cloud', () => {
      // preferredProvider only influences which *cloud* a complex
      // task picks — it can't override the complex→cloud direction.
      // This pins that contract.
      const r = new LlmRouter();
      const d = r.route(
        req({
          taskType: 'complex_reasoning' as const,
          providers: [LOCAL, ANTHROPIC],
          preferredProvider: 'local',
        }),
      );
      expect(d.action).toBe('cloud');
    });
  });

  describe('default-tier fall-through', () => {
    it('default tier + local → local', () => {
      const r = new LlmRouter();
      const d = r.route(req({ taskType: 'multi_step', providers: [LOCAL] }));
      expect(d.action).toBe('local');
    });

    it('default tier + cloud only → cloud', () => {
      const r = new LlmRouter();
      const d = r.route(req({ providers: [ANTHROPIC] }));
      expect(d.action).toBe('cloud');
    });
  });

  describe('events', () => {
    it('fires routed event with action + providerId', () => {
      const events: LlmRouterEvent[] = [];
      const r = new LlmRouter({ onEvent: (e) => events.push(e) });
      r.route(req({}));
      const ev = events.find((e) => e.kind === 'routed') as Extract<
        LlmRouterEvent,
        { kind: 'routed' }
      >;
      expect(ev.action).toBe('local');
    });

    it('fires refused event with reason', () => {
      const events: LlmRouterEvent[] = [];
      const r = new LlmRouter({ onEvent: (e) => events.push(e) });
      r.route(req({ providers: [] }));
      const ev = events.find((e) => e.kind === 'refused') as Extract<
        LlmRouterEvent,
        { kind: 'refused' }
      >;
      expect(ev.reason).toBe('no_providers');
    });
  });

  describe('purity', () => {
    it('same request → same decision (deterministic)', () => {
      const r = new LlmRouter();
      const request = req({ preferredProvider: 'gemini', taskType: 'deep_analysis' });
      const d1 = r.route(request);
      const d2 = r.route(request);
      expect(d1).toEqual(d2);
    });
  });

  describe('realistic scenarios', () => {
    it('home-node-lite happy path: default persona, local available, intent classification', () => {
      const r = new LlmRouter();
      const d: RoutingDecision = r.route({
        taskType: 'intent_classification',
        personaTier: 'default',
        providers: [LOCAL, ANTHROPIC],
        userConsent: true,
      });
      expect(d.action).toBe('local');
    });

    it('health persona (sensitive) + deep analysis + consented cloud → cloud with scrubbing', () => {
      const r = new LlmRouter();
      const d = r.route({
        taskType: 'deep_analysis',
        personaTier: 'sensitive',
        providers: [ANTHROPIC],
        userConsent: true,
      });
      expect(d.action).toBe('cloud');
      if (d.action === 'cloud') {
        expect(d.requiresScrubbing).toBe(true);
      }
    });

    it('financial persona (locked) cloud-only setup → refuse', () => {
      const r = new LlmRouter();
      const d = r.route({
        taskType: 'summarize',
        personaTier: 'locked',
        providers: [ANTHROPIC, GEMINI],
        userConsent: true,
      });
      expect(d.action).toBe('refuse');
    });
  });
});
