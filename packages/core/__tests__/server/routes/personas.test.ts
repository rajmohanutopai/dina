/**
 * GET /v1/personas — read-only persona registry surface for
 * out-of-process Brain. Exercises `makePersonasHandlers` directly so
 * the test covers payload shape + sort order without running the
 * router's signed-auth pipeline (the allowlist for `/v1/personas`
 * already exists at `auth/authz.ts:46`).
 */

import { makePersonasHandlers } from '../../../src/server/routes/personas';

import type { PersonaState } from '../../../src/persona/service';

function persona(name: string, tier: PersonaState['tier'], isOpen: boolean): PersonaState {
  return {
    name,
    tier,
    isOpen,
    description: '',
    createdAt: 0,
  };
}

describe('GET /v1/personas', () => {
  it('returns the persona registry sorted alphabetically', async () => {
    const { list } = makePersonasHandlers({
      resolveList: () => [
        persona('work', 'standard', true),
        persona('finance', 'locked', false),
        persona('general', 'default', true),
        persona('health', 'sensitive', false),
      ],
    });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      personas: [
        { name: 'finance', tier: 'locked', isOpen: false },
        { name: 'general', tier: 'default', isOpen: true },
        { name: 'health', tier: 'sensitive', isOpen: false },
        { name: 'work', tier: 'standard', isOpen: true },
      ],
    });
  });

  it('returns an empty array when the registry is empty', async () => {
    const { list } = makePersonasHandlers({ resolveList: () => [] });
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ personas: [] });
  });

  it('falls back to the live `listPersonas()` when no resolver is injected', async () => {
    // Smoke check — the handler defaults the resolver and returns the
    // shape we documented (regardless of what the live registry holds).
    const { list } = makePersonasHandlers();
    const res = await list();
    expect(res.status).toBe(200);
    const body = res.body as { personas: { name: string; tier: string; isOpen: boolean }[] };
    expect(Array.isArray(body.personas)).toBe(true);
    // Sort invariant holds for whatever happened to be in the registry.
    const names = body.personas.map((p) => p.name);
    expect([...names].sort()).toEqual(names);
  });
});
