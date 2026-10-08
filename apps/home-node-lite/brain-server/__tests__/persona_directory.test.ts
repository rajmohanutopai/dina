/**
 * REAL_LIFE_FIXES §2.3 — the split-process Brain keeps a live copy of Core's
 * persona list: it retries until Core answers, follows later changes, and an
 * empty or failed read never widens what an agent may read.
 */

import { getAccessiblePersonas, setAccessiblePersonas } from '@dina/brain';
import { getPersona, resetPersonaState, type PersonaListEntry } from '@dina/core';

import { createPersonaDirectory } from '../src/persona_directory';

const quietLogger = { info: () => undefined, warn: () => undefined };

/** Timers the test drives by hand. */
function manualTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    setTimeoutFn: (fn: () => void, ms: number) => {
      pending.push({ fn, ms });
      return pending.length;
    },
    clearTimeoutFn: () => undefined,
    pending,
    async runNext(): Promise<number | undefined> {
      const next = pending.shift();
      if (next === undefined) return undefined;
      next.fn();
      await new Promise((r) => setImmediate(r));
      return next.ms;
    },
  };
}

describe('persona directory (§2.3)', () => {
  beforeEach(() => {
    resetPersonaState();
    setAccessiblePersonas([]);
  });

  it('retries with growing backoff until Core answers, then mirrors names and tiers', async () => {
    let calls = 0;
    const core = {
      personasList: async (): Promise<PersonaListEntry[]> => {
        calls++;
        if (calls < 3) throw new Error('core not up');
        return [
          { name: 'general', tier: 'default', isOpen: true },
          { name: 'health', tier: 'sensitive', isOpen: false },
        ];
      },
    };
    const timers = manualTimers();
    const dir = createPersonaDirectory({ core, logger: quietLogger, ...timers, initialBackoffMs: 100 });

    const started = dir.start();
    await new Promise((r) => setImmediate(r));
    expect(dir.isSynced()).toBe(false);
    expect(getAccessiblePersonas()).toEqual([]);

    expect(await timers.runNext()).toBe(100);
    expect(await timers.runNext()).toBe(200);
    await started;

    expect(dir.isSynced()).toBe(true);
    expect(getAccessiblePersonas()).toEqual(['general', 'health']);
    expect(getPersona('health')?.tier).toBe('sensitive');
    dir.dispose();
  });

  it('follows tier changes and locks personas Core no longer lists', async () => {
    let list: PersonaListEntry[] = [
      { name: 'general', tier: 'default', isOpen: true },
      { name: 'diary', tier: 'standard', isOpen: true },
    ];
    const core = { personasList: async () => list };
    const timers = manualTimers();
    const dir = createPersonaDirectory({ core, logger: quietLogger, ...timers });
    await dir.start();

    list = [{ name: 'general', tier: 'sensitive', isOpen: true }];
    expect(await dir.refresh()).toBe(true);

    expect(getPersona('general')?.tier).toBe('sensitive');
    expect(getAccessiblePersonas()).toEqual(['general']);
    // Dropped from the accessible list and locked, never left readable.
    expect(getPersona('diary')?.tier).toBe('locked');
    dir.dispose();
  });

  it('mirrors an unrecognised tier as locked', async () => {
    const core = {
      personasList: async () =>
        [{ name: 'vault9', tier: 'mystery', isOpen: true }] as unknown as PersonaListEntry[],
    };
    const dir = createPersonaDirectory({ core, logger: quietLogger, ...manualTimers() });
    await dir.start();
    expect(getPersona('vault9')?.tier).toBe('locked');
    dir.dispose();
  });

  it('a failed refresh keeps the last good copy', async () => {
    let fail = false;
    const core = {
      personasList: async (): Promise<PersonaListEntry[]> => {
        if (fail) throw new Error('blip');
        return [{ name: 'general', tier: 'default', isOpen: true }];
      },
    };
    const dir = createPersonaDirectory({ core, logger: quietLogger, ...manualTimers() });
    await dir.start();
    fail = true;
    expect(await dir.refresh()).toBe(false);
    expect(getAccessiblePersonas()).toEqual(['general']);
    expect(dir.isSynced()).toBe(true);
    dir.dispose();
  });

  it('descriptors prefer Core descriptions and fall back per name', async () => {
    const core = {
      personasList: async (): Promise<PersonaListEntry[]> => [
        { name: 'general', tier: 'default', isOpen: true },
        { name: 'garden', tier: 'standard', isOpen: true, description: 'Plants and plots.' },
      ],
    };
    const dir = createPersonaDirectory({
      core,
      logger: quietLogger,
      ...manualTimers(),
      fallbackDescriptions: { general: 'Everyday notes.' },
    });
    await dir.start();
    expect(dir.descriptors()).toEqual([
      { name: 'general', description: 'Everyday notes.' },
      { name: 'garden', description: 'Plants and plots.' },
    ]);
    dir.dispose();
  });
});
