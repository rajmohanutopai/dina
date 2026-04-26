/**
 * ToolRegistry — declarative tool registration + execution.
 */

import {
  ApprovalRequiredError,
  ToolRegistry,
  type AgentTool,
} from '../../src/reasoning/tool_registry';

function makeTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'echo',
    description: 'Echo the input string back.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async (args) => ({ text: args.text }),
    ...overrides,
  };
}

describe('ToolRegistry — registration', () => {
  it('accepts a well-formed tool', () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    expect(r.has('echo')).toBe(true);
    expect(r.size()).toBe(1);
  });

  it('rejects duplicate names', () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    expect(() => r.register(makeTool())).toThrow(/duplicate/);
  });

  it('rejects invalid names (uppercase, spaces, special chars)', () => {
    const r = new ToolRegistry();
    expect(() => r.register(makeTool({ name: 'Echo' }))).toThrow(/invalid tool name/);
    expect(() => r.register(makeTool({ name: 'my tool' }))).toThrow(/invalid tool name/);
    expect(() => r.register(makeTool({ name: 'tool@1' }))).toThrow(/invalid tool name/);
  });

  it('rejects empty description', () => {
    const r = new ToolRegistry();
    expect(() => r.register(makeTool({ description: '' }))).toThrow(/description/);
  });

  it('unregister removes the tool', () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    expect(r.unregister('echo')).toBe(true);
    expect(r.has('echo')).toBe(false);
    expect(r.unregister('echo')).toBe(false);
  });
});

describe('ToolRegistry — toDefinitions', () => {
  it('returns the LLM-facing shape for all registered tools', () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    r.register(makeTool({ name: 'greet', description: 'Say hi.', parameters: { type: 'object' } }));
    const defs = r.toDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0]).toEqual({
      name: 'echo',
      description: 'Echo the input string back.',
      parameters: expect.objectContaining({ type: 'object' }),
    });
  });

  it('returns empty array for an empty registry', () => {
    expect(new ToolRegistry().toDefinitions()).toEqual([]);
  });
});

describe('ToolRegistry — execute', () => {
  it('dispatches to the tool body and returns success', async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    const outcome = await r.execute('echo', { text: 'hello' });
    expect(outcome.success).toBe(true);
    if (outcome.success) expect(outcome.result).toEqual({ text: 'hello' });
  });

  it('returns unknown_tool code for unregistered names', async () => {
    const r = new ToolRegistry();
    const outcome = await r.execute('nope', {});
    expect(outcome).toEqual({
      success: false,
      error: 'unknown tool "nope"',
      code: 'unknown_tool',
    });
  });

  it('returns invalid_args for missing required fields', async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    const outcome = await r.execute('echo', {});
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.code).toBe('invalid_args');
      expect(outcome.error).toContain('text');
    }
  });

  it('returns invalid_args when a top-level type is wrong', async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    const outcome = await r.execute('echo', { text: 42 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.code).toBe('invalid_args');
      expect(outcome.error).toContain('expected string');
    }
  });

  it('returns execution_failed when the tool body throws', async () => {
    const r = new ToolRegistry();
    r.register(
      makeTool({
        execute: async () => {
          throw new Error('kaboom');
        },
      }),
    );
    const outcome = await r.execute('echo', { text: 'x' });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.code).toBe('execution_failed');
      expect(outcome.error).toBe('kaboom');
    }
  });

  it('accepts extra unknown properties (permissive schema)', async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    const outcome = await r.execute('echo', { text: 'x', extra: 'ignored' });
    expect(outcome.success).toBe(true);
  });
});

describe('ApprovalRequiredError handling', () => {
  it('translates ApprovalRequiredError to an approval_required outcome', async () => {
    const r = new ToolRegistry();
    r.register(
      makeTool({
        execute: async () => {
          throw new ApprovalRequiredError('appr-xyz', 'financial');
        },
      }),
    );
    const outcome = await r.execute('echo', { text: 'x' });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.code).toBe('approval_required');
      if (outcome.code === 'approval_required') {
        expect(outcome.approvalId).toBe('appr-xyz');
        expect(outcome.persona).toBe('financial');
        expect(outcome.error).toContain('financial');
        expect(outcome.error).toContain('appr-xyz');
      }
    }
  });

  it('preserves ApprovalRequiredError as a distinct class', () => {
    const err = new ApprovalRequiredError('appr-1', 'health');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect(err.name).toBe('ApprovalRequiredError');
    expect(err.approvalId).toBe('appr-1');
    expect(err.persona).toBe('health');
  });

  it('regular Error throws still classify as execution_failed (regression guard)', async () => {
    const r = new ToolRegistry();
    r.register(
      makeTool({
        execute: async () => {
          throw new Error('regular boom');
        },
      }),
    );
    const outcome = await r.execute('echo', { text: 'x' });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.code).toBe('execution_failed');
    }
  });
});
