/**
 * Task 5.25 — cloud gate tests.
 */

import { CloudGate, type ProviderEntry } from '../src/brain/cloud_gate';

function sampleProviders(): ProviderEntry[] {
  return [
    { name: 'anthropic', kind: 'cloud' },
    { name: 'openai', kind: 'cloud' },
    { name: 'google', kind: 'cloud' },
    { name: 'local-llama', kind: 'local' },
    { name: 'openrouter', kind: 'cloud' },
  ];
}

describe('CloudGate (task 5.25)', () => {
  describe('construction', () => {
    it('loads an iterable of providers', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      expect(gate.size()).toBe(5);
    });

    it('rejects missing providers option', () => {
      expect(
        () =>
          new CloudGate({
            providers: undefined as unknown as ProviderEntry[],
          }),
      ).toThrow(/providers is required/);
    });

    it('rejects empty provider name', () => {
      expect(
        () =>
          new CloudGate({
            providers: [{ name: '', kind: 'cloud' }],
          }),
      ).toThrow(/provider name is required/);
    });

    it('rejects invalid kind', () => {
      expect(
        () =>
          new CloudGate({
            providers: [
              {
                name: 'x',
                kind: 'hybrid' as unknown as 'cloud' | 'local',
              },
            ],
          }),
      ).toThrow(/kind must be "cloud" or "local"/);
    });
  });

  describe('check — allowed cases', () => {
    it('cloud provider + default tier → ok', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      expect(gate.check('anthropic', 'default')).toEqual({
        ok: true,
        kind: 'cloud',
      });
    });

    it('cloud provider + standard tier → ok', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      expect(gate.check('openai', 'standard')).toEqual({ ok: true, kind: 'cloud' });
    });

    it('local provider + any tier → ok', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      for (const tier of ['default', 'standard', 'sensitive', 'locked'] as const) {
        expect(gate.check('local-llama', tier)).toEqual({
          ok: true,
          kind: 'local',
        });
      }
    });
  });

  describe('check — cloud-blocked cases', () => {
    it.each(['anthropic', 'openai', 'google', 'openrouter'])(
      'cloud provider %s + sensitive tier → cloud_blocked_for_persona_tier',
      (provider) => {
        const gate = new CloudGate({ providers: sampleProviders() });
        const result = gate.check(provider, 'sensitive');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('cloud_blocked_for_persona_tier');
          expect(result.detail).toContain('sensitive');
        }
      },
    );

    it('cloud provider + locked tier → cloud_blocked_for_persona_tier', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      const result = gate.check('anthropic', 'locked');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('cloud_blocked_for_persona_tier');
    });
  });

  describe('check — unknown provider', () => {
    it('returns unknown_provider', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      const result = gate.check('nonesuch', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown_provider');
        expect(result.detail).toContain('nonesuch');
      }
    });
  });

  describe('filterAllowed', () => {
    it('removes cloud providers for sensitive tier, preserves order', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      const pref = ['anthropic', 'openai', 'local-llama', 'google'];
      expect(gate.filterAllowed(pref, 'sensitive')).toEqual(['local-llama']);
    });

    it('preserves all for default tier', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      const pref = ['anthropic', 'openai', 'local-llama'];
      expect(gate.filterAllowed(pref, 'default')).toEqual(pref);
    });

    it('drops unknown providers', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      expect(
        gate.filterAllowed(['anthropic', 'nonesuch', 'local-llama'], 'default'),
      ).toEqual(['anthropic', 'local-llama']);
    });

    it('returns a new array (caller can mutate safely)', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      const pref = ['anthropic'];
      const out = gate.filterAllowed(pref, 'default');
      out.push('mutated');
      expect(pref).toEqual(['anthropic']);
    });
  });

  describe('register (post-construction)', () => {
    it('adds a new provider', () => {
      const gate = new CloudGate({ providers: [] });
      gate.register({ name: 'local-x', kind: 'local' });
      expect(gate.has('local-x')).toBe(true);
    });

    it('replaces an existing provider', () => {
      const gate = new CloudGate({ providers: [{ name: 'x', kind: 'cloud' }] });
      gate.register({ name: 'x', kind: 'local' });
      expect(gate.check('x', 'locked')).toEqual({ ok: true, kind: 'local' });
    });

    it('returns self for chaining', () => {
      const gate = new CloudGate({ providers: [] });
      const out = gate
        .register({ name: 'a', kind: 'cloud' })
        .register({ name: 'b', kind: 'local' });
      expect(out).toBe(gate);
      expect(gate.size()).toBe(2);
    });
  });

  describe('list + has + size', () => {
    it('list returns sorted entries', () => {
      const gate = new CloudGate({
        providers: [
          { name: 'zeta', kind: 'cloud' },
          { name: 'alpha', kind: 'cloud' },
          { name: 'mu', kind: 'local' },
        ],
      });
      expect(gate.list()).toEqual([
        { name: 'alpha', kind: 'cloud' },
        { name: 'mu', kind: 'local' },
        { name: 'zeta', kind: 'cloud' },
      ]);
    });

    it('has returns truthy for known, falsy for unknown', () => {
      const gate = new CloudGate({ providers: sampleProviders() });
      expect(gate.has('anthropic')).toBe(true);
      expect(gate.has('ghost')).toBe(false);
    });
  });
});
