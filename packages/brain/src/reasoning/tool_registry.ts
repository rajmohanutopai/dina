/**
 * Tool registry for the agentic reasoning loop.
 *
 * A Tool is a declarative function the LLM can call during a turn:
 *   - `name` / `description` / `parameters` (JSON Schema) → surfaced to
 *     the LLM via `ToolDefinition` (per-provider function-calling wire).
 *   - `execute(args)` → runs the body with validated args, returns the
 *     JSON-serialisable result.
 *
 * The registry:
 *   - Rejects duplicate registrations.
 *   - Validates args against the declared parameter schema before invoke.
 *   - Wraps every execution in a try/catch that returns
 *     `{success: false, error: ...}` — the loop never sees a thrown Error.
 *
 * Schema validation is deliberately LIGHTWEIGHT: required-field presence +
 * top-level type checks. The kernel spec (DINA_AGENT_KERNEL.md point 17)
 * calls for full JSON Schema via ajv; we defer that until a capability
 * needs deep validation and the 200 KB dependency is justified.
 *
 * Source: DINA_AGENT_KERNEL.md §D (Tool Architecture, points 15–18).
 */

import type { ToolDefinition } from '../llm/adapters/provider';

export interface AgentTool {
  /** Unique tool name; must match `^[a-z][a-z0-9_]{0,63}$` (provider-portable). */
  name: string;
  /** Human-readable description shown to the LLM. Keep under ~200 chars. */
  description: string;
  /**
   * JSON Schema for the function's input parameters. Should be a top-level
   * `{type: 'object', properties: {...}, required: [...]}`. Used by every
   * supported provider (Gemini functionDeclarations, OpenAI tools, Claude).
   */
  parameters: Record<string, unknown>;
  /**
   * The tool body. Receives validated args. Returns a JSON-serialisable
   * result (the registry will `JSON.stringify` it for the LLM round-trip).
   * Throwing is acceptable — the registry wraps exceptions into errors.
   */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export type ToolExecutionOutcome =
  | { success: true; result: unknown }
  | { success: false; error: string; code: 'unknown_tool' | 'invalid_args' | 'execution_failed' };

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (!isValidToolName(tool.name)) {
      throw new Error(
        `ToolRegistry: invalid tool name "${tool.name}" — must match ^[a-z][a-z0-9_]{0,63}$`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool "${tool.name}"`);
    }
    if (!tool.description || tool.description.length === 0) {
      throw new Error(`ToolRegistry: "${tool.name}" missing description`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Remove a registered tool. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  size(): number {
    return this.tools.size;
  }

  /** Produce the LLM-facing tool list in the shared `ToolDefinition` shape. */
  toDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Execute a tool by name. Validates args, catches throws, returns a
   * structured outcome. Never throws.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionOutcome> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { success: false, error: `unknown tool "${name}"`, code: 'unknown_tool' };
    }
    const validationError = validateArgs(args, tool.parameters);
    if (validationError !== null) {
      return { success: false, error: validationError, code: 'invalid_args' };
    }
    try {
      const result = await tool.execute(args);
      return { success: true, result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(name);
}

/**
 * Lightweight JSON-Schema-adjacent validation:
 *   - required fields must be present
 *   - when a property declares `type`, the argument's top-level type must match
 *
 * Returns null when the args pass, otherwise a short error message.
 * Does NOT traverse nested schemas; the tool body can do deeper checks.
 */
function validateArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  if (!args || typeof args !== 'object') {
    return 'args must be an object';
  }
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key === 'string' && !(key in args)) {
      return `missing required field "${key}"`;
    }
  }
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (propSchema === undefined) continue; // permissive — extra props allowed
    const expectedType = typeof propSchema.type === 'string' ? propSchema.type : null;
    if (expectedType === null) continue;
    const actualType = jsonTypeOf(value);
    if (actualType !== expectedType) {
      return `field "${key}" expected ${expectedType}, got ${actualType}`;
    }
  }
  return null;
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
