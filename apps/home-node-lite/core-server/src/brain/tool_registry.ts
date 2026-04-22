/**
 * Task 5.26 — tool-use / function-calling.
 *
 * Brain exposes server-side tools to LLMs (search vault, look up a
 * contact, query the trust network, send a notification). A tool
 * has:
 *
 *   - a stable name the LLM references
 *   - a JSON-Schema-shaped parameter contract
 *   - an async implementation
 *
 * This module is the in-process registry + validator. Provider
 * adapters (task 5.22) translate `ToolRegistry.listDefinitions()` to
 * whatever wire format the LLM wants (Anthropic `tools`, OpenAI
 * `functions`, etc.) and feed the LLM's tool-call requests back
 * through `ToolRegistry.execute(name, args)`.
 *
 * **Argument validation**: every tool declares a minimal JSON
 * Schema-style shape (`{type: 'object', required?, properties}`).
 * We validate the LLM's args against it before calling the
 * implementation — catches malformed tool calls BEFORE the handler
 * sees them, so the handler can assume typed inputs. LLMs do
 * occasionally hallucinate parameters; this is the first defence.
 *
 * **Typed execution result**: `execute(name, args)` returns
 * `{ok: true, result} | {ok: false, reason, detail?}` with
 * distinguishable rejection reasons so the LLM loop can:
 *   - retry with corrected args (`invalid_args`)
 *   - skip silently (`tool_not_found` — LLM hallucinated a tool)
 *   - surface to the user (`tool_threw` — implementation bug)
 *
 * **No implicit timeouts** here — each tool is expected to honour an
 * `AbortSignal` passed as the second arg. The LLM cancel registry
 * (task 5.21) plumbs the signal through.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5d task 5.26.
 */

/** Minimal JSON-Schema subset for tool argument shapes. */
export interface ToolSchema {
  type: 'object';
  /** Property definitions keyed by name. Values use a small schema language. */
  properties: Record<string, ToolParamSchema>;
  /** Required property names. Everything else is optional. */
  required?: string[];
  /** When false, reject args carrying unknown properties. Default true (lenient). */
  additionalProperties?: boolean;
}

export type ToolParamSchema =
  | { type: 'string'; enum?: string[]; description?: string }
  | { type: 'number'; description?: string }
  | { type: 'integer'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: ToolParamSchema; description?: string }
  | { type: 'object'; properties?: Record<string, ToolParamSchema>; description?: string };

export type ToolHandler = (
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: ToolHandler;
}

/** Definition in the shape a provider adapter can forward to the LLM. */
export interface ExposedToolDefinition {
  name: string;
  description: string;
  schema: ToolSchema;
}

export type ExecutionRejection =
  | 'tool_not_found'
  | 'invalid_args'
  | 'tool_threw'
  | 'aborted';

export type ExecutionResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      reason: ExecutionRejection;
      detail?: string;
      errors?: string[];
    };

export interface ToolRegistryOptions {
  /**
   * Forced-execution budget in ms. Ignored per-tool when the tool's
   * handler itself honours the signal. Default `undefined` (no
   * enforced timeout here; upstream 5.21 manages).
   */
  defaultTimeoutMs?: number;
  /** Injected timer — tests pass a mock scheduler. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly defaultTimeoutMs?: number;
  private readonly setTimerFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;

  constructor(opts: ToolRegistryOptions = {}) {
    if (opts.defaultTimeoutMs !== undefined) {
      this.defaultTimeoutMs = opts.defaultTimeoutMs;
    }
    this.setTimerFn = opts.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn = opts.clearTimerFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Register a tool. Duplicate name throws. */
  register(def: ToolDefinition): this {
    validateToolDefinition(def);
    if (this.tools.has(def.name)) {
      throw new Error(`ToolRegistry.register: duplicate tool name ${JSON.stringify(def.name)}`);
    }
    this.tools.set(def.name, def);
    return this;
  }

  /** Overwrite a registration. Returns true when a prior def was replaced. */
  replace(def: ToolDefinition): boolean {
    validateToolDefinition(def);
    const existed = this.tools.has(def.name);
    this.tools.set(def.name, def);
    return existed;
  }

  /** Remove a tool. Returns true when removed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  size(): number {
    return this.tools.size;
  }

  /**
   * Render the definitions in the LLM-facing shape — name +
   * description + schema only, handler stripped. Provider adapters
   * consume this + translate to Anthropic / OpenAI / etc. Sorted by
   * name for deterministic wire output.
   */
  listDefinitions(): ExposedToolDefinition[] {
    return Array.from(this.tools.values(), (t) => ({
      name: t.name,
      description: t.description,
      schema: cloneSchema(t.schema),
    })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Execute a tool call with argument validation. Returns structured
   * result — the LLM loop pattern-matches on `.ok` + reason.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const def = this.tools.get(name);
    if (def === undefined) {
      return {
        ok: false,
        reason: 'tool_not_found',
        detail: `no tool registered under name ${JSON.stringify(name)}`,
      };
    }

    const validation = validateArgs(args, def.schema);
    if (!validation.ok) {
      return {
        ok: false,
        reason: 'invalid_args',
        detail: `tool ${JSON.stringify(name)} rejected args`,
        errors: validation.errors,
      };
    }

    // If caller didn't supply an AbortSignal, synthesize one so the
    // handler always has something to pass to `fetch({signal})`.
    const controller = new AbortController();
    const effectiveSignal = signal ?? controller.signal;

    if (effectiveSignal.aborted) {
      return { ok: false, reason: 'aborted' };
    }

    let timeoutHandle: unknown = null;
    if (this.defaultTimeoutMs !== undefined && !signal?.aborted) {
      timeoutHandle = this.setTimerFn(() => {
        controller.abort();
      }, this.defaultTimeoutMs);
    }

    try {
      const result = await def.handler(args, effectiveSignal);
      return { ok: true, result };
    } catch (err) {
      if (effectiveSignal.aborted) {
        return { ok: false, reason: 'aborted' };
      }
      return {
        ok: false,
        reason: 'tool_threw',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timeoutHandle !== null) this.clearTimerFn(timeoutHandle);
    }
  }
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate `args` against `schema`. Minimal JSON-Schema subset:
 * required props, primitive type checks, string enum, nested object
 * properties, array item schema. Returns `{ok, errors}` with one
 * error string per violated rule.
 *
 * Exported so adapters that want to pre-validate before calling
 * `execute` (e.g. to surface "fix your args" to the LLM in a dry-run)
 * can do so.
 */
export function validateArgs(
  args: Record<string, unknown>,
  schema: ToolSchema,
): ValidationResult {
  const errors: string[] = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    errors.push('args must be an object');
    return { ok: false, errors };
  }

  const required = schema.required ?? [];
  for (const name of required) {
    if (!(name in args)) errors.push(`missing required property "${name}"`);
  }

  for (const [name, value] of Object.entries(args)) {
    const propSchema = schema.properties[name];
    if (propSchema === undefined) {
      if (schema.additionalProperties === false) {
        errors.push(`unknown property "${name}"`);
      }
      continue;
    }
    validateParam(value, propSchema, name, errors);
  }

  return { ok: errors.length === 0, errors };
}

function validateParam(
  value: unknown,
  schema: ToolParamSchema,
  path: string,
  errors: string[],
): void {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string (got ${typeOf(value)})`);
        return;
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        errors.push(
          `${path}: must be one of ${JSON.stringify(schema.enum)} (got ${JSON.stringify(value)})`,
        );
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: expected finite number (got ${typeOf(value)})`);
      }
      return;
    case 'integer':
      if (!Number.isInteger(value)) {
        errors.push(`${path}: expected integer (got ${typeOf(value)})`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${path}: expected boolean (got ${typeOf(value)})`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array (got ${typeOf(value)})`);
        return;
      }
      for (let i = 0; i < value.length; i++) {
        validateParam(value[i], schema.items, `${path}[${i}]`, errors);
      }
      return;
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object (got ${typeOf(value)})`);
        return;
      }
      if (schema.properties !== undefined) {
        for (const [k, sub] of Object.entries(schema.properties)) {
          if (k in (value as Record<string, unknown>)) {
            validateParam(
              (value as Record<string, unknown>)[k],
              sub,
              `${path}.${k}`,
              errors,
            );
          }
        }
      }
      return;
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateToolDefinition(def: ToolDefinition): void {
  if (!def.name || def.name.length === 0) {
    throw new Error('ToolRegistry: tool name is required');
  }
  if (typeof def.description !== 'string') {
    throw new Error(`ToolRegistry: tool ${def.name} description must be a string`);
  }
  if (!def.schema || def.schema.type !== 'object') {
    throw new Error(`ToolRegistry: tool ${def.name} schema.type must be "object"`);
  }
  if (typeof def.handler !== 'function') {
    throw new Error(`ToolRegistry: tool ${def.name} handler must be a function`);
  }
}

function cloneSchema(schema: ToolSchema): ToolSchema {
  const out: ToolSchema = {
    type: 'object',
    properties: { ...schema.properties },
  };
  if (schema.required !== undefined) out.required = [...schema.required];
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  return out;
}
