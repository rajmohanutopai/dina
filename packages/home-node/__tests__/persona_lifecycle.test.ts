/**
 * Unit tests for `openAllPersonasForInAppUser`.
 *
 * The helper sits on top of `@dina/core`'s in-memory persona registry
 * and `@dina/brain`'s `setAccessiblePersonas` / `getAccessiblePersonas`
 * pair. No SQLite needed — the tests reset the registry, seed personas
 * across all four tiers, run the helper, and assert the resulting open
 * set + accessible-personas publication.
 */

import {
  getAccessiblePersonas,
  setAccessiblePersonas,
} from '@dina/brain';
import {
  createPersona,
  getPersona,
  listPersonas,
  resetPersonaState,
} from '@dina/core';

import { openAllPersonasForInAppUser } from '../src/persona_lifecycle';

describe('openAllPersonasForInAppUser', () => {
  beforeEach(() => {
    resetPersonaState();
    setAccessiblePersonas([]);
  });

  it('opens personas across every tier and publishes them to brain', async () => {
    createPersona('general', 'default', 'general');
    createPersona('work', 'standard', 'work');
    createPersona('health', 'sensitive', 'health');
    createPersona('finance', 'sensitive', 'finance');

    // Seal the sensitive ones so we can prove the helper opens them.
    expect(getPersona('health')?.isOpen).toBe(false);
    expect(getPersona('finance')?.isOpen).toBe(false);

    const opened = await openAllPersonasForInAppUser();

    expect(opened.sort()).toEqual(['finance', 'general', 'health', 'work']);
    expect(getAccessiblePersonas().sort()).toEqual([
      'finance',
      'general',
      'health',
      'work',
    ]);
    expect(getPersona('health')?.isOpen).toBe(true);
    expect(getPersona('finance')?.isOpen).toBe(true);
  });

  it('is idempotent — already-open personas stay open, publication refreshes', async () => {
    createPersona('general', 'default', 'general');
    createPersona('work', 'standard', 'work');

    // First call opens everything + publishes.
    await openAllPersonasForInAppUser();
    expect(getAccessiblePersonas().sort()).toEqual(['general', 'work']);

    // Simulate the post-seal → re-unlock case: publication got reset
    // (e.g. by `sealVault`) but personas are still flagged open in
    // the registry. The helper should re-publish.
    setAccessiblePersonas([]);
    const reopened = await openAllPersonasForInAppUser();
    expect(reopened.sort()).toEqual(['general', 'work']);
    expect(getAccessiblePersonas().sort()).toEqual(['general', 'work']);
  });

  it('calls openVaultDB once per persona, in order, before publishing', async () => {
    createPersona('general', 'default', 'general');
    createPersona('finance', 'sensitive', 'finance');

    const opens: string[] = [];
    // Capture the accessible-personas list AT the moment openVaultDB
    // runs — must be empty until AFTER the DB opens land.
    const accessibleSnapshot: string[][] = [];

    await openAllPersonasForInAppUser({
      openVaultDB: async (persona) => {
        opens.push(persona);
        accessibleSnapshot.push(getAccessiblePersonas().slice());
      },
    });

    expect(opens.sort()).toEqual(['finance', 'general']);
    // Each snapshot taken DURING openVaultDB should pre-date the final
    // publication. Helper publishes once at the end, not per-persona.
    for (const snap of accessibleSnapshot) {
      expect(snap).toEqual([]);
    }
    expect(getAccessiblePersonas().sort()).toEqual(['finance', 'general']);
  });

  it('returns empty list when the registry is empty', async () => {
    const opened = await openAllPersonasForInAppUser();
    expect(opened).toEqual([]);
    expect(getAccessiblePersonas()).toEqual([]);
  });

  it('routes openVaultDB errors to onVaultOpenError when supplied — loop continues', async () => {
    createPersona('general', 'default', 'general');
    createPersona('work', 'standard', 'work');
    createPersona('health', 'sensitive', 'health');

    const errors: { persona: string; err: unknown }[] = [];
    const succeeded: string[] = [];

    const opened = await openAllPersonasForInAppUser({
      openVaultDB: async (persona) => {
        if (persona === 'work') {
          throw new Error(`simulated open failure for ${persona}`);
        }
        succeeded.push(persona);
      },
      onVaultOpenError: (persona, err) => {
        errors.push({ persona, err });
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.persona).toBe('work');
    expect(succeeded.sort()).toEqual(['general', 'health']);
    // Publication still fires with the full open set — even the
    // persona whose DB failed to open. Vault tools will silently
    // return [] for it; that's the right behaviour for "DB
    // unreachable" (vs. "persona locked").
    expect(opened.sort()).toEqual(['general', 'health', 'work']);
  });

  it('rethrows openVaultDB errors when no onVaultOpenError is supplied', async () => {
    createPersona('general', 'default', 'general');
    createPersona('finance', 'sensitive', 'finance');

    await expect(
      openAllPersonasForInAppUser({
        openVaultDB: async (persona) => {
          if (persona === 'finance') throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    // Publication did NOT fire — accessible-personas stays empty so
    // /ask doesn't try to read a vault we couldn't open.
    expect(getAccessiblePersonas()).toEqual([]);
  });
});
