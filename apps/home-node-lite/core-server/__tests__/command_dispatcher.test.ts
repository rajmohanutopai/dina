/**
 * Task 5.33 — CommandDispatcher tests.
 */

import {
  CommandDispatcher,
  type CommandDefinition,
  type CommandDispatchEvent,
} from '../src/brain/command_dispatcher';

function echoCommand(overrides: Partial<CommandDefinition<{ text: string }>> = {}) {
  const base: CommandDefinition<{ text: string }> = {
    name: '/echo',
    description: 'Echo the argv',
    parse(argv) {
      if (argv.length === 0) return { ok: false, error: 'usage: /echo <text>' };
      return { ok: true, args: { text: argv.join(' ') } };
    },
    async execute(args) {
      return { ok: true, message: `echoed: ${args.text}` };
    },
  };
  return { ...base, ...overrides };
}

const userCaller = { role: 'user' as const };
const adminCaller = { role: 'admin' as const };

describe('CommandDispatcher (task 5.33)', () => {
  describe('register', () => {
    it('stores + retrieves', () => {
      const d = new CommandDispatcher().register(echoCommand());
      expect(d.has('/echo')).toBe(true);
      expect(d.size()).toBe(1);
    });

    it('duplicate-register throws', () => {
      const d = new CommandDispatcher().register(echoCommand());
      expect(() => d.register(echoCommand())).toThrow(/duplicate command/);
    });

    it('chainable', () => {
      const d = new CommandDispatcher();
      expect(
        d.register(echoCommand({ name: '/a' })).register(echoCommand({ name: '/b' })),
      ).toBe(d);
    });

    it.each([
      ['name without slash', { name: 'echo' }],
      ['empty name', { name: '' }],
      ['invalid role', { role: 'moderator' as unknown as 'admin' }],
      ['bad description type', { description: 42 as unknown as string }],
      ['non-function parse', { parse: 'x' as unknown as CommandDefinition<{ text: string }>['parse'] }],
      ['non-function execute', { execute: 'y' as unknown as CommandDefinition<{ text: string }>['execute'] }],
    ])('rejects %s', (_label, o) => {
      const d = new CommandDispatcher();
      expect(() => d.register(echoCommand(o))).toThrow();
    });
  });

  describe('dispatch happy path', () => {
    it('parses + executes + returns ok with message', async () => {
      const d = new CommandDispatcher().register(echoCommand());
      const result = await d.dispatch({
        name: '/echo',
        argv: ['hello', 'world'],
        caller: userCaller,
      });
      expect(result).toEqual({ ok: true, message: 'echoed: hello world' });
    });

    it('passes AbortSignal to execute', async () => {
      let received: AbortSignal | undefined;
      const d = new CommandDispatcher().register({
        name: '/spy',
        description: '',
        parse: () => ({ ok: true, args: {} }),
        async execute(_args, ctx) {
          received = ctx.signal;
          return { ok: true };
        },
      });
      await d.dispatch({ name: '/spy', argv: [], caller: userCaller });
      expect(received).toBeDefined();
    });

    it('event stream: dispatched + succeeded', async () => {
      const events: CommandDispatchEvent[] = [];
      const d = new CommandDispatcher({ onEvent: (e) => events.push(e) }).register(
        echoCommand(),
      );
      await d.dispatch({ name: '/echo', argv: ['x'], caller: userCaller });
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['dispatched', 'succeeded']);
    });
  });

  describe('dispatch rejections', () => {
    it('unknown_command with suggestions for typos', async () => {
      const d = new CommandDispatcher()
        .register(echoCommand({ name: '/echo' }))
        .register(echoCommand({ name: '/env' }));
      const result = await d.dispatch({
        name: '/ech',
        argv: [],
        caller: userCaller,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown_command');
        expect(result.suggestions).toContain('/echo');
      }
    });

    it('bad_name_shape when name lacks slash prefix', async () => {
      const d = new CommandDispatcher();
      const result = await d.dispatch({
        name: 'echo',
        argv: [],
        caller: userCaller,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('bad_name_shape');
    });

    it('parse_failed returns parser error detail', async () => {
      const d = new CommandDispatcher().register(echoCommand());
      const result = await d.dispatch({
        name: '/echo',
        argv: [], // parse rejects empty argv
        caller: userCaller,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('parse_failed');
        expect(result.detail).toBe('usage: /echo <text>');
      }
    });

    it('forbidden: user invoking admin-only command', async () => {
      const d = new CommandDispatcher().register(
        echoCommand({ name: '/admin-echo', role: 'admin' }),
      );
      const result = await d.dispatch({
        name: '/admin-echo',
        argv: ['x'],
        caller: userCaller,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('forbidden');
    });

    it('admin caller can invoke admin-only command', async () => {
      const d = new CommandDispatcher().register(
        echoCommand({ name: '/admin-echo', role: 'admin' }),
      );
      const result = await d.dispatch({
        name: '/admin-echo',
        argv: ['x'],
        caller: adminCaller,
      });
      expect(result.ok).toBe(true);
    });

    it('admin caller can invoke user-level commands too', async () => {
      const d = new CommandDispatcher().register(echoCommand());
      const result = await d.dispatch({
        name: '/echo',
        argv: ['x'],
        caller: adminCaller,
      });
      expect(result.ok).toBe(true);
    });

    it('threw when execute returns ok=false', async () => {
      const d = new CommandDispatcher().register({
        name: '/nope',
        description: '',
        parse: () => ({ ok: true, args: {} }),
        async execute() {
          return { ok: false, error: 'internal' };
        },
      });
      const result = await d.dispatch({
        name: '/nope',
        argv: [],
        caller: userCaller,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('threw');
        expect(result.detail).toBe('internal');
      }
    });

    it('threw when execute raises', async () => {
      const d = new CommandDispatcher().register({
        name: '/boom',
        description: '',
        parse: () => ({ ok: true, args: {} }),
        async execute() {
          throw new Error('kaboom');
        },
      });
      const result = await d.dispatch({
        name: '/boom',
        argv: [],
        caller: userCaller,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('threw');
        expect(result.detail).toBe('kaboom');
      }
    });

    it('aborted when pre-aborted signal passed', async () => {
      const d = new CommandDispatcher().register(echoCommand());
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await d.dispatch({
        name: '/echo',
        argv: ['x'],
        caller: userCaller,
        signal: ctrl.signal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('aborted');
    });
  });

  describe('unregister', () => {
    it('returns true on removed + false on missing', () => {
      const d = new CommandDispatcher().register(echoCommand());
      expect(d.unregister('/echo')).toBe(true);
      expect(d.unregister('/echo')).toBe(false);
    });

    it('unregistered command returns unknown_command on dispatch', async () => {
      const d = new CommandDispatcher().register(echoCommand());
      d.unregister('/echo');
      const result = await d.dispatch({
        name: '/echo',
        argv: ['x'],
        caller: userCaller,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unknown_command');
    });
  });

  describe('list', () => {
    it('sorts by name + includes role', () => {
      const d = new CommandDispatcher()
        .register(echoCommand({ name: '/zeta' }))
        .register(echoCommand({ name: '/alpha' }))
        .register(echoCommand({ name: '/mu', role: 'admin' }));
      const ids = d.list().map((c) => c.name);
      expect(ids).toEqual(['/alpha', '/mu', '/zeta']);
    });

    it('roleFilter=user trims admin-only commands', () => {
      const d = new CommandDispatcher()
        .register(echoCommand({ name: '/public' }))
        .register(echoCommand({ name: '/private', role: 'admin' }));
      const userView = d.list('user').map((c) => c.name);
      expect(userView).toEqual(['/public']);
    });

    it('roleFilter=admin shows all', () => {
      const d = new CommandDispatcher()
        .register(echoCommand({ name: '/public' }))
        .register(echoCommand({ name: '/private', role: 'admin' }));
      expect(d.list('admin').map((c) => c.name).sort()).toEqual([
        '/private',
        '/public',
      ]);
    });
  });

  describe('suggest', () => {
    it('returns nearest matches by Levenshtein distance', () => {
      const d = new CommandDispatcher()
        .register(echoCommand({ name: '/echo' }))
        .register(echoCommand({ name: '/env' }))
        .register(echoCommand({ name: '/lock' }));
      const suggestions = d.suggest('/ecoh');
      expect(suggestions[0]).toBe('/echo'); // closest
    });

    it('returns empty when nothing within distance 3', () => {
      const d = new CommandDispatcher().register(echoCommand({ name: '/echo' }));
      expect(d.suggest('/totallydifferentcommand')).toEqual([]);
    });

    it('returns [] for empty query', () => {
      const d = new CommandDispatcher().register(echoCommand());
      expect(d.suggest('')).toEqual([]);
    });

    it('caps at 3 matches', () => {
      const d = new CommandDispatcher();
      for (const name of ['/echo', '/ech', '/eco', '/ept', '/es']) {
        d.register(echoCommand({ name }));
      }
      expect(d.suggest('/ech')).toHaveLength(3);
    });

    it('fires suggested event', () => {
      const events: CommandDispatchEvent[] = [];
      const d = new CommandDispatcher({ onEvent: (e) => events.push(e) }).register(
        echoCommand({ name: '/echo' }),
      );
      d.suggest('/ecoh');
      expect(events.some((e) => e.kind === 'suggested')).toBe(true);
    });
  });
});
