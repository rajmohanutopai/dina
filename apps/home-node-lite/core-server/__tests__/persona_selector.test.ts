/**
 * Task 5.44 — PersonaSelector tests.
 */

import {
  PersonaRegistry,
  type RawPersonaDetail,
} from '../src/brain/persona_registry';
import {
  PersonaSelector,
  type PersonaLlmResponse,
  type PersonaLlmSelectFn,
  type PersonaSelectorEvent,
} from '../src/brain/persona_selector';

async function readyRegistry(): Promise<PersonaRegistry> {
  const reg = new PersonaRegistry({
    fetchFn: async (): Promise<RawPersonaDetail[]> => [
      { id: 'persona-general', name: 'general', tier: 'default', description: 'everyday' },
      { id: 'persona-work', name: 'work', tier: 'standard', description: 'professional' },
      { id: 'persona-health', name: 'health', tier: 'sensitive', locked: true, description: 'health-related' },
    ],
  });
  await reg.load();
  return reg;
}

describe('PersonaSelector (task 5.44)', () => {
  describe('construction', () => {
    it('throws on missing registry', () => {
      expect(
        () =>
          new PersonaSelector({
            registry: undefined as unknown as PersonaRegistry,
          }),
      ).toThrow(/registry/);
    });
  });

  describe('explicit hint path', () => {
    it('valid hint returns SelectionResult with confidence=1', async () => {
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg });
      const r = await sel.select({ summary: 'x' }, 'work');
      expect(r).not.toBeNull();
      expect(r!.primary).toBe('work');
      expect(r!.confidence).toBe(1.0);
      expect(r!.reason).toBe('explicit persona hint');
    });

    it('prefixed hint ("persona-work") resolves to "work"', async () => {
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg });
      const r = await sel.select({ summary: 'x' }, 'persona-work');
      expect(r!.primary).toBe('work');
    });

    it('unknown hint falls through to LLM', async () => {
      let calls = 0;
      const llmSelectFn: PersonaLlmSelectFn = async () => {
        calls++;
        return { primary: 'work', confidence: 0.7 };
      };
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg, llmSelectFn });
      const r = await sel.select({ summary: 'x' }, 'unknown-persona');
      expect(calls).toBe(1);
      expect(r!.primary).toBe('work');
    });

    it('no LLM + unknown hint → null', async () => {
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg });
      const r = await sel.select({ summary: 'x' }, 'unknown');
      expect(r).toBeNull();
    });
  });

  describe('LLM selection — happy path', () => {
    it('returns a valid SelectionResult', async () => {
      const llmSelectFn: PersonaLlmSelectFn = async () => ({
        primary: 'health',
        secondary: ['general'],
        confidence: 0.85,
        reason: 'Medical content',
        has_event: true,
        event_hint: 'dentist appointment',
      });
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg, llmSelectFn });
      const r = await sel.select({ summary: 'I have a dentist appointment' });
      expect(r!.primary).toBe('health');
      expect(r!.secondary).toEqual(['general']);
      expect(r!.confidence).toBe(0.85);
      expect(r!.hasEvent).toBe(true);
      expect(r!.eventHint).toBe('dentist appointment');
    });

    it('fires llm_selected event', async () => {
      const events: PersonaSelectorEvent[] = [];
      const llmSelectFn: PersonaLlmSelectFn = async () => ({
        primary: 'work',
        confidence: 0.7,
      });
      const reg = await readyRegistry();
      const sel = new PersonaSelector({
        registry: reg,
        llmSelectFn,
        onEvent: (e) => events.push(e),
      });
      await sel.select({ summary: 'x' });
      expect(events.some((e) => e.kind === 'llm_selected')).toBe(true);
    });

    it('passes availablePersonas + trimmed item to LLM', async () => {
      let seen: unknown = null;
      const llmSelectFn: PersonaLlmSelectFn = async (ctx) => {
        seen = ctx;
        return { primary: 'work', confidence: 0.7 };
      };
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg, llmSelectFn });
      await sel.select({
        summary: 'x'.repeat(500),
        body: 'y'.repeat(500),
        type: 'email',
      });
      const ctx = seen as {
        availablePersonas: Array<{ name: string; tier: string; description?: string }>;
        item: { summary?: string; body?: string; type?: string };
      };
      expect(ctx.availablePersonas.map((p) => p.name).sort()).toEqual([
        'general',
        'health',
        'work',
      ]);
      // Trimmed to 200 / 300.
      expect(ctx.item.summary?.length).toBe(200);
      expect(ctx.item.body?.length).toBe(300);
      expect(ctx.item.type).toBe('email');
    });

    it('drops secondary entries that are invalid or duplicate primary', async () => {
      const llmSelectFn: PersonaLlmSelectFn = async () => ({
        primary: 'health',
        secondary: ['work', 'invalid', 'health', 'general'],
        confidence: 0.9,
      });
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg, llmSelectFn });
      const r = await sel.select({ summary: 'x' });
      expect(r!.secondary).toEqual(['work', 'general']);
    });

    it('clamps confidence to [0, 1]', async () => {
      const cases: Array<[number, number]> = [
        [-1, 0],
        [5, 1],
        [0.5, 0.5],
      ];
      for (const [input, expected] of cases) {
        const llmSelectFn: PersonaLlmSelectFn = async () => ({
          primary: 'work',
          confidence: input,
        });
        const reg = await readyRegistry();
        const sel = new PersonaSelector({ registry: reg, llmSelectFn });
        const r = await sel.select({ summary: 'x' });
        expect(r!.confidence).toBe(expected);
      }
    });
  });

  describe('LLM selection — failure paths', () => {
    it('LLM throws → null + fires llm_failed', async () => {
      const events: PersonaSelectorEvent[] = [];
      const llmSelectFn: PersonaLlmSelectFn = async () => {
        throw new Error('provider down');
      };
      const reg = await readyRegistry();
      const sel = new PersonaSelector({
        registry: reg,
        llmSelectFn,
        onEvent: (e) => events.push(e),
      });
      const r = await sel.select({ summary: 'x' });
      expect(r).toBeNull();
      const ev = events.find((e) => e.kind === 'llm_failed') as Extract<
        PersonaSelectorEvent,
        { kind: 'llm_failed' }
      >;
      expect(ev.error).toMatch(/provider down/);
    });

    it('LLM returns primary not in registry → null + fires invalid_primary', async () => {
      const events: PersonaSelectorEvent[] = [];
      const llmSelectFn: PersonaLlmSelectFn = async () => ({
        primary: 'made-up-persona',
        confidence: 0.95,
      });
      const reg = await readyRegistry();
      const sel = new PersonaSelector({
        registry: reg,
        llmSelectFn,
        onEvent: (e) => events.push(e),
      });
      const r = await sel.select({ summary: 'x' });
      expect(r).toBeNull();
      expect(events.some((e) => e.kind === 'invalid_primary')).toBe(true);
    });

    it('LLM returns empty primary → null', async () => {
      const llmSelectFn: PersonaLlmSelectFn = async () => ({
        primary: '',
        confidence: 0.9,
      });
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg, llmSelectFn });
      const r = await sel.select({ summary: 'x' });
      expect(r).toBeNull();
    });

    it('LLM returns non-object garbage → null', async () => {
      const llmSelectFn: PersonaLlmSelectFn = async () =>
        'not-an-object' as unknown as PersonaLlmResponse;
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg, llmSelectFn });
      const r = await sel.select({ summary: 'x' });
      expect(r).toBeNull();
    });

    it('empty registry → null', async () => {
      const reg = new PersonaRegistry({
        fetchFn: async () => [] as RawPersonaDetail[],
      });
      await reg.load();
      const llmSelectFn: PersonaLlmSelectFn = async () => ({
        primary: 'anything',
        confidence: 1,
      });
      const sel = new PersonaSelector({ registry: reg, llmSelectFn });
      const r = await sel.select({ summary: 'x' });
      expect(r).toBeNull();
    });
  });

  describe('no hint + no LLM', () => {
    it('returns null', async () => {
      const reg = await readyRegistry();
      const sel = new PersonaSelector({ registry: reg });
      const r = await sel.select({ summary: 'x' });
      expect(r).toBeNull();
    });
  });

  describe('registry integration', () => {
    it('after registry refresh, new personas become selectable', async () => {
      let second = false;
      const reg = new PersonaRegistry({
        fetchFn: async () =>
          second
            ? ([
                { name: 'general', tier: 'default' },
                { name: 'hobbies', tier: 'default' },
              ] as RawPersonaDetail[])
            : ([{ name: 'general', tier: 'default' }] as RawPersonaDetail[]),
      });
      await reg.load();
      const sel = new PersonaSelector({
        registry: reg,
        llmSelectFn: async () => ({ primary: 'hobbies', confidence: 0.8 }),
      });
      const beforeRefresh = await sel.select({ summary: 'x' });
      expect(beforeRefresh).toBeNull(); // hobbies not yet in registry
      second = true;
      await reg.refresh();
      const afterRefresh = await sel.select({ summary: 'x' });
      expect(afterRefresh!.primary).toBe('hobbies');
    });
  });
});
