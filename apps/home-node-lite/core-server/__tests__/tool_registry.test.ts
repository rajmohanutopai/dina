/**
 * Task 5.26 — tool-use / function-calling tests.
 */

import {
  ToolRegistry,
  validateArgs,
  type ToolDefinition,
  type ToolSchema,
} from '../src/brain/tool_registry';

function echoTool(name = 'echo'): ToolDefinition {
  return {
    name,
    description: 'Return the input verbatim',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'text to echo' },
      },
      required: ['text'],
    },
    handler: async (args) => ({ echoed: args['text'] }),
  };
}

describe('ToolRegistry (task 5.26)', () => {
  describe('register', () => {
    it('stores + retrieves', () => {
      const reg = new ToolRegistry().register(echoTool());
      expect(reg.has('echo')).toBe(true);
      expect(reg.size()).toBe(1);
    });

    it('duplicate-register throws', () => {
      const reg = new ToolRegistry().register(echoTool());
      expect(() => reg.register(echoTool())).toThrow(/duplicate tool name/);
    });

    it('returns self for chaining', () => {
      const reg = new ToolRegistry();
      expect(reg.register(echoTool('a')).register(echoTool('b'))).toBe(reg);
    });

    it.each([
      ['empty name', { ...echoTool(), name: '' }],
      [
        'missing description',
        { ...echoTool(), description: 42 as unknown as string },
      ],
      [
        'schema.type !== object',
        {
          ...echoTool(),
          schema: {
            type: 'array',
            properties: {},
          } as unknown as ToolSchema,
        },
      ],
      ['handler not function', { ...echoTool(), handler: 'foo' as unknown as ToolDefinition['handler'] }],
    ])('rejects %s', (_label, def) => {
      const reg = new ToolRegistry();
      expect(() => reg.register(def)).toThrow();
    });
  });

  describe('replace + unregister', () => {
    it('replace returns true when prior existed, false when fresh', () => {
      const reg = new ToolRegistry();
      expect(reg.replace(echoTool())).toBe(false);
      expect(reg.replace(echoTool())).toBe(true);
    });

    it('unregister returns true on removed, false on missing', () => {
      const reg = new ToolRegistry().register(echoTool());
      expect(reg.unregister('echo')).toBe(true);
      expect(reg.unregister('echo')).toBe(false);
    });
  });

  describe('listDefinitions', () => {
    it('strips handler + sorts by name', () => {
      const reg = new ToolRegistry()
        .register(echoTool('zebra'))
        .register(echoTool('alpha'))
        .register(echoTool('mu'));
      const defs = reg.listDefinitions();
      expect(defs.map((d) => d.name)).toEqual(['alpha', 'mu', 'zebra']);
      for (const d of defs) {
        expect('handler' in d).toBe(false);
        expect(d.schema.type).toBe('object');
      }
    });

    it('returns defensive schema copies', () => {
      const reg = new ToolRegistry().register(echoTool());
      const defs = reg.listDefinitions();
      (defs[0]!.schema.properties as Record<string, unknown>)['injected'] = {};
      const fresh = reg.listDefinitions();
      expect('injected' in fresh[0]!.schema.properties).toBe(false);
    });
  });

  describe('execute — happy path', () => {
    it('returns ok + result when handler succeeds', async () => {
      const reg = new ToolRegistry().register(echoTool());
      const result = await reg.execute('echo', { text: 'hello' });
      expect(result).toEqual({ ok: true, result: { echoed: 'hello' } });
    });

    it('passes AbortSignal to handler', async () => {
      let received: AbortSignal | undefined;
      const reg = new ToolRegistry().register({
        name: 'spy',
        description: 'records signal',
        schema: { type: 'object', properties: {} },
        handler: async (_args, signal) => {
          received = signal;
          return 'ok';
        },
      });
      await reg.execute('spy', {});
      expect(received).toBeDefined();
      expect(received!.aborted).toBe(false);
    });
  });

  describe('execute — rejection paths', () => {
    it('tool_not_found for unregistered', async () => {
      const reg = new ToolRegistry();
      const result = await reg.execute('ghost', {});
      expect(result).toEqual({
        ok: false,
        reason: 'tool_not_found',
        detail: expect.stringContaining('"ghost"'),
      });
    });

    it('invalid_args when required prop missing', async () => {
      const reg = new ToolRegistry().register(echoTool());
      const result = await reg.execute('echo', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_args');
        expect(result.errors).toContain('missing required property "text"');
      }
    });

    it('invalid_args when type mismatches', async () => {
      const reg = new ToolRegistry().register(echoTool());
      const result = await reg.execute('echo', { text: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok && result.errors) {
        expect(result.errors.some((e) => /text: expected string/.test(e))).toBe(true);
      }
    });

    it('tool_threw when handler throws', async () => {
      const reg = new ToolRegistry().register({
        name: 'boom',
        description: '',
        schema: { type: 'object', properties: {} },
        handler: async () => {
          throw new Error('kaboom');
        },
      });
      const result = await reg.execute('boom', {});
      expect(result).toEqual({
        ok: false,
        reason: 'tool_threw',
        detail: 'kaboom',
      });
    });

    it('aborted when pre-aborted signal passed', async () => {
      const reg = new ToolRegistry().register(echoTool());
      const controller = new AbortController();
      controller.abort();
      const result = await reg.execute('echo', { text: 'x' }, controller.signal);
      expect(result).toEqual({ ok: false, reason: 'aborted' });
    });

    it('aborted when handler throws AFTER signal aborts during execution', async () => {
      const reg = new ToolRegistry().register({
        name: 'slow',
        description: '',
        schema: { type: 'object', properties: {} },
        handler: async (_args, signal) => {
          return new Promise<string>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('handler aborted')));
            // never resolves on its own
            void resolve;
          });
        },
      });
      const controller = new AbortController();
      const pending = reg.execute('slow', {}, controller.signal);
      controller.abort();
      const result = await pending;
      expect(result).toEqual({ ok: false, reason: 'aborted' });
    });
  });

  describe('defaultTimeoutMs', () => {
    it('aborts handler after the budget elapses', async () => {
      const reg = new ToolRegistry({ defaultTimeoutMs: 10 }).register({
        name: 'slow',
        description: '',
        schema: { type: 'object', properties: {} },
        handler: async (_args, signal) => {
          return new Promise<string>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('timeout hit')));
            // never resolves
            void resolve;
          });
        },
      });
      const result = await reg.execute('slow', {});
      expect(result).toEqual({ ok: false, reason: 'aborted' });
    });

    it('does NOT abort when handler returns faster than the budget', async () => {
      const reg = new ToolRegistry({ defaultTimeoutMs: 1000 }).register(echoTool());
      const result = await reg.execute('echo', { text: 'fast' });
      expect(result.ok).toBe(true);
    });
  });
});

describe('validateArgs (task 5.26 validator)', () => {
  it('accepts a matching object', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    expect(validateArgs({ name: 'alice' }, schema)).toEqual({ ok: true, errors: [] });
  });

  it('reports all errors, not just the first', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name', 'age'],
    };
    const result = validateArgs({ name: 42, age: 3.14 }, schema);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces string enum', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } },
      required: ['color'],
    };
    expect(validateArgs({ color: 'red' }, schema).ok).toBe(true);
    expect(validateArgs({ color: 'purple' }, schema).ok).toBe(false);
  });

  it('recurses into nested objects', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: {
        person: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    };
    expect(validateArgs({ person: { name: 'x' } }, schema).ok).toBe(true);
    expect(
      validateArgs({ person: { name: 42 } }, schema).errors.some((e) =>
        /person\.name: expected string/.test(e),
      ),
    ).toBe(true);
  });

  it('validates array item types', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
    expect(validateArgs({ tags: ['a', 'b'] }, schema).ok).toBe(true);
    const result = validateArgs({ tags: ['a', 42] }, schema);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /tags\[1\]: expected string/.test(e))).toBe(true);
  });

  it.each([
    ['number', { type: 'number' as const }, 3.14, true],
    ['number-NaN', { type: 'number' as const }, NaN, false],
    ['integer', { type: 'integer' as const }, 42, true],
    ['integer-fractional', { type: 'integer' as const }, 3.14, false],
    ['boolean', { type: 'boolean' as const }, true, true],
    ['boolean-string', { type: 'boolean' as const }, 'true', false],
  ])('primitive type %s accepts %p → %p', (_label, propSchema, value, expected) => {
    const schema: ToolSchema = {
      type: 'object',
      properties: { v: propSchema },
      required: ['v'],
    };
    expect(validateArgs({ v: value }, schema).ok).toBe(expected);
  });

  it('additionalProperties=false rejects unknown keys', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: { known: { type: 'string' } },
      additionalProperties: false,
    };
    const result = validateArgs({ known: 'x', injected: true }, schema);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /unknown property "injected"/.test(e))).toBe(true);
  });

  it('additionalProperties=true (default) allows unknown keys', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: { known: { type: 'string' } },
    };
    expect(validateArgs({ known: 'x', extra: 1 }, schema).ok).toBe(true);
  });

  it('rejects non-object args', () => {
    const schema: ToolSchema = { type: 'object', properties: {} };
    expect(validateArgs([] as unknown as Record<string, unknown>, schema).ok).toBe(false);
    expect(validateArgs(null as unknown as Record<string, unknown>, schema).ok).toBe(false);
  });
});
