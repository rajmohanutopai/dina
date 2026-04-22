/**
 * user_commands tests (GAP.md #29 closure).
 */

import { CommandDispatcher } from '../src/brain/command_dispatcher';
import { NullCoreClient } from '../src/brain/core_client';
import { buildUserCommands, type UserCommandContext } from '../src/brain/user_commands';

function dispatcherWith(ctx: UserCommandContext = {}): CommandDispatcher {
  const d = new CommandDispatcher();
  for (const c of buildUserCommands(ctx)) d.register(c);
  return d;
}

describe('buildUserCommands — registration', () => {
  it('returns the canonical command set', () => {
    const names = buildUserCommands().map((c) => c.name).sort();
    expect(names).toEqual([
      '/help',
      '/personas',
      '/search',
      '/status',
      '/unlock',
      '/whoami',
    ]);
  });

  it('every command has a non-empty description + parse + execute', () => {
    for (const c of buildUserCommands()) {
      expect(typeof c.description).toBe('string');
      expect(c.description.length).toBeGreaterThan(0);
      expect(typeof c.parse).toBe('function');
      expect(typeof c.execute).toBe('function');
    }
  });

  it('all register cleanly on a fresh dispatcher', () => {
    const d = dispatcherWith();
    expect(d.size()).toBe(6);
  });
});

describe('/help', () => {
  it('returns the listCommandsFn output', async () => {
    const commands = [
      { name: '/a', description: 'first' },
      { name: '/b', description: 'second' },
    ];
    const d = dispatcherWith({ listCommandsFn: () => commands });
    const r = await d.dispatch({
      name: '/help',
      argv: [],
      caller: { role: 'user' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ commands });
  });

  it('empty list when no callback provided', async () => {
    const d = dispatcherWith();
    const r = await d.dispatch({ name: '/help', argv: [], caller: { role: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { commands: unknown[] }).commands).toEqual([]);
  });
});

describe('/status', () => {
  it('returns uptime + persona count + fingerprint', async () => {
    const core = new NullCoreClient({
      defaultPersonas: [
        { id: 'p1', name: 'general', tier: 'default', locked: false },
        { id: 'p2', name: 'work', tier: 'standard', locked: false },
      ],
    });
    const d = dispatcherWith({
      core,
      bootStartedMsFn: () => Date.now() - 5_000,
      serviceKeyFingerprint: 'abc123def456',
    });
    const r = await d.dispatch({ name: '/status', argv: [], caller: { role: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { uptimeMs: number; personaCount: number | null; keyFingerprint: string | null };
      expect(data.uptimeMs).toBeGreaterThanOrEqual(5_000);
      expect(data.personaCount).toBe(2);
      expect(data.keyFingerprint).toBe('abc123def456');
    }
  });

  it('falls back gracefully when core is absent', async () => {
    const d = dispatcherWith();
    const r = await d.dispatch({ name: '/status', argv: [], caller: { role: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { personaCount: number | null; keyFingerprint: string | null };
      expect(data.personaCount).toBeNull();
      expect(data.keyFingerprint).toBeNull();
    }
  });
});

describe('/personas', () => {
  it('lists personas from the core client', async () => {
    const core = new NullCoreClient({
      defaultPersonas: [
        { id: 'p-general', name: 'general', tier: 'default', locked: false },
        { id: 'p-health', name: 'health', tier: 'sensitive', locked: true },
      ],
    });
    const d = dispatcherWith({ core });
    const r = await d.dispatch({
      name: '/personas',
      argv: [],
      caller: { role: 'user' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { personas: Array<{ id: string; tier: string; locked: boolean }> };
      expect(data.personas).toHaveLength(2);
      expect(data.personas[1]).toMatchObject({ id: 'p-health', tier: 'sensitive', locked: true });
    }
  });

  it('errors when core is absent', async () => {
    const d = dispatcherWith();
    const r = await d.dispatch({ name: '/personas', argv: [], caller: { role: 'user' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('threw');
  });
});

describe('/unlock', () => {
  it.each([
    [[], /usage/],
    [['persona-only'], /usage/],
  ] as const)('rejects malformed argv %j', async (argv, regex) => {
    const d = dispatcherWith();
    const r = await d.dispatch({
      name: '/unlock',
      argv: [...argv],
      caller: { role: 'user' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('parse_failed');
      expect(r.detail).toMatch(regex);
    }
  });

  it('accepts persona + passphrase + concatenates multi-token passphrases', async () => {
    const d = dispatcherWith();
    const r = await d.dispatch({
      name: '/unlock',
      argv: ['health', 'my', 'long', 'phrase'],
      caller: { role: 'user' },
    });
    // Parse succeeds; execute stubs out with not_implemented error.
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('threw');
      expect(r.detail).toContain('health');
    }
  });
});

describe('/search', () => {
  it('rejects empty query', async () => {
    const d = dispatcherWith({ core: new NullCoreClient() });
    const r = await d.dispatch({
      name: '/search',
      argv: [],
      caller: { role: 'user' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('parse_failed');
    }
  });

  it('parses --persona + --max flags + positional query', async () => {
    const core = new NullCoreClient({ recordCalls: true });
    const d = dispatcherWith({ core });
    const r = await d.dispatch({
      name: '/search',
      argv: ['--persona', 'work', '--max', '5', 'project', 'update'],
      caller: { role: 'user' },
    });
    expect(r.ok).toBe(true);
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]!.method).toBe('queryVault');
    expect(core.calls[0]!.input).toEqual({
      persona: 'work',
      query: 'project update',
      maxItems: 5,
    });
  });

  it('rejects non-positive --max', async () => {
    const d = dispatcherWith({ core: new NullCoreClient() });
    const r = await d.dispatch({
      name: '/search',
      argv: ['--max', '0', 'q'],
      caller: { role: 'user' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('parse_failed');
  });

  it('defaults persona to "general" + max to 20', async () => {
    const core = new NullCoreClient({ recordCalls: true });
    const d = dispatcherWith({ core });
    await d.dispatch({
      name: '/search',
      argv: ['hello', 'world'],
      caller: { role: 'user' },
    });
    expect(core.calls[0]!.input).toEqual({
      persona: 'general',
      query: 'hello world',
      maxItems: 20,
    });
  });

  it('errors when core is absent', async () => {
    const d = dispatcherWith();
    const r = await d.dispatch({
      name: '/search',
      argv: ['anything'],
      caller: { role: 'user' },
    });
    expect(r.ok).toBe(false);
  });
});

describe('/whoami', () => {
  it('echoes caller role + DID', async () => {
    const d = dispatcherWith();
    const r = await d.dispatch({
      name: '/whoami',
      argv: [],
      caller: { role: 'user', did: 'did:plc:alice' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ role: 'user', did: 'did:plc:alice' });
  });

  it('null DID when absent', async () => {
    const d = dispatcherWith();
    const r = await d.dispatch({
      name: '/whoami',
      argv: [],
      caller: { role: 'admin' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ role: 'admin', did: null });
  });
});

describe('wiring with command dispatcher', () => {
  it('help can read back the full registered command list when wired', async () => {
    const d = new CommandDispatcher();
    for (const c of buildUserCommands({ listCommandsFn: () => d.list('user') })) {
      d.register(c);
    }
    const r = await d.dispatch({ name: '/help', argv: [], caller: { role: 'user' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const commands = (r.data as { commands: Array<{ name: string }> }).commands;
      expect(commands.length).toBe(6);
    }
  });
});
