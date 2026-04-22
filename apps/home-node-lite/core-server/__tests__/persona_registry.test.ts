/**
 * Task 5.44 — PersonaRegistry tests.
 */

import {
  FALLBACK_PERSONAS,
  PersonaRegistry,
  type PersonaFetchFn,
  type PersonaRegistryEvent,
  type RawPersonaDetail,
} from '../src/brain/persona_registry';

function rawPersonas(): RawPersonaDetail[] {
  return [
    { id: 'persona-general', name: 'general', tier: 'default', locked: false, description: 'everyday' },
    { id: 'persona-work', name: 'work', tier: 'standard', locked: false, description: 'professional' },
    { id: 'persona-health', name: 'health', tier: 'sensitive', locked: true },
  ];
}

describe('PersonaRegistry (task 5.44)', () => {
  describe('construction', () => {
    it('throws on missing fetchFn', () => {
      expect(
        () =>
          new PersonaRegistry({ fetchFn: undefined as unknown as PersonaFetchFn }),
      ).toThrow(/fetchFn/);
    });
  });

  describe('load — happy path', () => {
    it('loads personas + fires loaded event', async () => {
      const events: PersonaRegistryEvent[] = [];
      const reg = new PersonaRegistry({
        fetchFn: async () => rawPersonas(),
        onEvent: (e) => events.push(e),
      });
      await reg.load();
      expect(reg.allNames().sort()).toEqual(['general', 'health', 'work']);
      expect(reg.isLoaded()).toBe(true);
      const loaded = events.find((e) => e.kind === 'loaded') as Extract<
        PersonaRegistryEvent,
        { kind: 'loaded' }
      >;
      expect(loaded.count).toBe(3);
    });

    it('strips "persona-" prefix + exposes canonical names', async () => {
      const reg = new PersonaRegistry({
        fetchFn: async () => [{ id: 'persona-general', tier: 'default' }],
      });
      await reg.load();
      expect(reg.allNames()).toEqual(['general']);
      expect(reg.exists('general')).toBe(true);
      expect(reg.exists('persona-general')).toBe(true); // both forms work
    });

    it('tier / locked / description accessors', async () => {
      const reg = new PersonaRegistry({ fetchFn: async () => rawPersonas() });
      await reg.load();
      expect(reg.tier('health')).toBe('sensitive');
      expect(reg.locked('health')).toBe(true);
      expect(reg.description('general')).toBe('everyday');
      expect(reg.tier('nonexistent')).toBeNull();
      expect(reg.locked('nonexistent')).toBeNull();
      expect(reg.description('nonexistent')).toBe('');
    });

    it('invalid tier strings collapse to "default"', async () => {
      const reg = new PersonaRegistry({
        fetchFn: async () => [{ name: 'x', tier: 'weird' }],
      });
      await reg.load();
      expect(reg.tier('x')).toBe('default');
    });

    it('entry without name or id is skipped', async () => {
      const reg = new PersonaRegistry({
        fetchFn: async () => [
          { name: 'good' },
          {} as RawPersonaDetail, // empty
        ],
      });
      await reg.load();
      expect(reg.allNames()).toEqual(['good']);
    });
  });

  describe('first-load failure', () => {
    it('falls back to FALLBACK_PERSONAS + fires fallback_used', async () => {
      const events: PersonaRegistryEvent[] = [];
      const reg = new PersonaRegistry({
        fetchFn: async () => {
          throw new Error('Core unreachable');
        },
        onEvent: (e) => events.push(e),
      });
      await reg.load();
      expect(reg.allNames().sort()).toEqual(['finance', 'general', 'health', 'work']);
      expect(reg.isLoaded()).toBe(false);
      const fb = events.find((e) => e.kind === 'fallback_used') as Extract<
        PersonaRegistryEvent,
        { kind: 'fallback_used' }
      >;
      expect(fb.error).toMatch(/Core unreachable/);
    });

    it('FALLBACK_PERSONAS matches Core bootstrap shape', () => {
      expect(FALLBACK_PERSONAS.map((p) => p.name).sort()).toEqual([
        'finance',
        'general',
        'health',
        'work',
      ]);
    });
  });

  describe('refresh — transient failure keeps cache', () => {
    it('after successful load, failing refresh keeps last known good', async () => {
      let succeed = true;
      const events: PersonaRegistryEvent[] = [];
      const reg = new PersonaRegistry({
        fetchFn: async () => {
          if (succeed) return rawPersonas();
          throw new Error('timeout');
        },
        onEvent: (e) => events.push(e),
      });
      await reg.load();
      const initial = reg.allNames().sort();
      succeed = false;
      await reg.refresh();
      expect(reg.allNames().sort()).toEqual(initial); // unchanged
      const keep = events.find((e) => e.kind === 'refresh_failed_kept_cache') as Extract<
        PersonaRegistryEvent,
        { kind: 'refresh_failed_kept_cache' }
      >;
      expect(keep.cachedCount).toBe(3);
    });

    it('isLoaded flips back to false on refresh failure (signals stale)', async () => {
      let succeed = true;
      const reg = new PersonaRegistry({
        fetchFn: async () => {
          if (succeed) return rawPersonas();
          throw new Error('x');
        },
      });
      await reg.load();
      expect(reg.isLoaded()).toBe(true);
      succeed = false;
      await reg.refresh();
      expect(reg.isLoaded()).toBe(false);
    });
  });

  describe('concurrent load coalescing', () => {
    it('parallel load calls share one fetch', async () => {
      let calls = 0;
      const reg = new PersonaRegistry({
        fetchFn: async () => {
          calls++;
          // Let both awaiters join before we resolve.
          await new Promise((r) => setImmediate(r));
          return rawPersonas();
        },
      });
      await Promise.all([reg.load(), reg.load(), reg.refresh()]);
      expect(calls).toBe(1);
      expect(reg.isLoaded()).toBe(true);
    });
  });

  describe('updateLocked', () => {
    it('flips a persona\'s locked flag + fires event', async () => {
      const events: PersonaRegistryEvent[] = [];
      const reg = new PersonaRegistry({
        fetchFn: async () => rawPersonas(),
        onEvent: (e) => events.push(e),
      });
      await reg.load();
      expect(reg.locked('work')).toBe(false);
      reg.updateLocked('work', true);
      expect(reg.locked('work')).toBe(true);
      const ev = events.find((e) => e.kind === 'lock_state_changed') as Extract<
        PersonaRegistryEvent,
        { kind: 'lock_state_changed' }
      >;
      expect(ev.name).toBe('work');
      expect(ev.locked).toBe(true);
    });

    it('noop for unknown persona', async () => {
      const reg = new PersonaRegistry({ fetchFn: async () => rawPersonas() });
      await reg.load();
      reg.updateLocked('nonexistent', true); // should not throw
    });

    it('accepts prefixed name', async () => {
      const reg = new PersonaRegistry({ fetchFn: async () => rawPersonas() });
      await reg.load();
      reg.updateLocked('persona-work', true);
      expect(reg.locked('work')).toBe(true);
    });
  });

  describe('snapshot', () => {
    it('returns copies — mutation does not affect cache', async () => {
      const reg = new PersonaRegistry({ fetchFn: async () => rawPersonas() });
      await reg.load();
      const snap = reg.snapshot();
      snap[0]!.locked = true;
      expect(reg.locked(snap[0]!.name)).toBe(false);
    });
  });

  describe('normalize', () => {
    const reg = new PersonaRegistry({ fetchFn: async () => [] });
    it('strips persona- prefix', () => {
      expect(reg.normalize('persona-work')).toBe('work');
    });
    it('passthrough when no prefix', () => {
      expect(reg.normalize('general')).toBe('general');
    });
    it('non-string → empty string', () => {
      expect(reg.normalize(42 as unknown as string)).toBe('');
    });
  });
});
