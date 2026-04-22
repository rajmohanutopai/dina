/**
 * Task 5.33 — command dispatcher.
 *
 * User commands (slash commands from CLI / mobile, admin-UI buttons,
 * automations) flow through a name-routed dispatcher. Each command
 * declares `{name, description, parse, execute}`:
 *
 *   name     — canonical slash-command identifier (`/notify`, `/lock`)
 *   parse    — maps raw argv / payload into a typed args object;
 *              returns structured result so the caller can render a
 *              usage error without catching
 *   execute  — the async implementation
 *
 * **Distinct from `ToolRegistry` (5.26)**: tools are LLM-facing
 * (LLM decides when to call); commands are user-facing (human
 * decides). Tools have JSON-schema params because the LLM generates
 * them; commands have parse functions because humans type argv
 * strings that need regex / flag / positional handling.
 *
 * **Unknown-command behaviour**: structured `{ok: false, reason:
 * 'unknown_command'}` rather than throwing — CLI renders "command
 * not found; did you mean X?" using the exported `suggest(name)`
 * helper.
 *
 * **Admin-only commands**: each command has an optional `role` flag.
 * `dispatch({name, argv, caller})` where `caller.role` is `'user' |
 * 'admin'` rejects `admin`-only commands when caller is `'user'`
 * with `reason: 'forbidden'`. Central check so every admin handler
 * doesn't repeat the same guard.
 *
 * **Cancellation**: caller supplies `AbortSignal` flowing to the
 * command's `execute` — long-running commands honour it.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.33.
 */

export type CallerRole = 'user' | 'admin';

export interface CommandCaller {
  role: CallerRole;
  /** Optional caller DID for audit logging. */
  did?: string;
}

export type ParseResult<T> =
  | { ok: true; args: T }
  | { ok: false; error: string };

export type CommandExecuteResult =
  | { ok: true; message?: string; data?: unknown }
  | { ok: false; error: string };

export interface CommandDefinition<T = Record<string, unknown>> {
  /** Canonical slash name including leading `/`. */
  name: string;
  /** Short help text. */
  description: string;
  /** Role required to invoke. Default `'user'`. */
  role?: CallerRole;
  /**
   * Argv → typed args. Returns `{ok, error}` — `error` populated on
   * parse failure includes the usage string.
   */
  parse(argv: string[]): ParseResult<T>;
  /**
   * The handler. Called after parse succeeds + role check passes.
   * Gets the typed args + caller info + AbortSignal.
   */
  execute(
    args: T,
    ctx: { caller: CommandCaller; signal: AbortSignal },
  ): Promise<CommandExecuteResult>;
}

export type DispatchRejection =
  | 'unknown_command'
  | 'bad_name_shape'
  | 'parse_failed'
  | 'forbidden'
  | 'threw'
  | 'aborted';

export type DispatchResult =
  | { ok: true; message?: string; data?: unknown }
  | {
      ok: false;
      reason: DispatchRejection;
      detail?: string;
      suggestions?: string[];
    };

export interface CommandDispatcherOptions {
  /** Diagnostic hook. Fires on every dispatch + every suggestion. */
  onEvent?: (event: CommandDispatchEvent) => void;
}

export type CommandDispatchEvent =
  | { kind: 'dispatched'; name: string; role: CallerRole }
  | { kind: 'succeeded'; name: string; durationMs: number }
  | { kind: 'rejected'; name: string; reason: DispatchRejection }
  | { kind: 'suggested'; query: string; matches: string[] };

export interface DispatchInput {
  name: string;
  argv: string[];
  caller: CommandCaller;
  signal?: AbortSignal;
}

export class CommandDispatcher {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly onEvent?: (event: CommandDispatchEvent) => void;

  constructor(opts: CommandDispatcherOptions = {}) {
    this.onEvent = opts.onEvent;
  }

  /** Register a command. Duplicate name throws. */
  register<T>(def: CommandDefinition<T>): this {
    validateCommandDefinition(def);
    if (this.commands.has(def.name)) {
      throw new Error(
        `CommandDispatcher.register: duplicate command ${JSON.stringify(def.name)}`,
      );
    }
    this.commands.set(def.name, def as CommandDefinition);
    return this;
  }

  unregister(name: string): boolean {
    return this.commands.delete(name);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  size(): number {
    return this.commands.size;
  }

  /**
   * Enumerate registered commands — sorted by name. Admin UI renders
   * this as the help list; the optional `roleFilter` trims to what a
   * given caller can actually invoke.
   */
  list(roleFilter?: CallerRole): Array<{ name: string; description: string; role: CallerRole }> {
    const out: Array<{ name: string; description: string; role: CallerRole }> = [];
    for (const def of this.commands.values()) {
      const role: CallerRole = def.role ?? 'user';
      if (roleFilter === 'user' && role === 'admin') continue;
      out.push({ name: def.name, description: def.description, role });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * Suggest commands similar to `query` — useful for "command not
   * found; did you mean X?" UX. Returns up to 3 matches by Levenshtein
   * distance, nearest first. Empty array when nothing within distance 3.
   */
  suggest(query: string): string[] {
    if (!query || query.length === 0) return [];
    const candidates: Array<{ name: string; d: number }> = [];
    for (const name of this.commands.keys()) {
      const d = levenshtein(query, name);
      if (d <= 3) candidates.push({ name, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    const matches = candidates.slice(0, 3).map((c) => c.name);
    this.onEvent?.({ kind: 'suggested', query, matches });
    return matches;
  }

  /** Dispatch one command invocation. Never throws. */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    if (!input.name || !input.name.startsWith('/')) {
      this.onEvent?.({
        kind: 'rejected',
        name: input.name ?? '',
        reason: 'bad_name_shape',
      });
      return {
        ok: false,
        reason: 'bad_name_shape',
        detail: `command name must start with "/" (got ${JSON.stringify(input.name)})`,
      };
    }
    const def = this.commands.get(input.name);
    if (def === undefined) {
      const suggestions = this.suggest(input.name);
      this.onEvent?.({
        kind: 'rejected',
        name: input.name,
        reason: 'unknown_command',
      });
      const result: DispatchResult = {
        ok: false,
        reason: 'unknown_command',
        detail: `no command registered under ${JSON.stringify(input.name)}`,
      };
      if (suggestions.length > 0) result.suggestions = suggestions;
      return result;
    }

    const requiredRole: CallerRole = def.role ?? 'user';
    if (requiredRole === 'admin' && input.caller.role !== 'admin') {
      this.onEvent?.({ kind: 'rejected', name: def.name, reason: 'forbidden' });
      return {
        ok: false,
        reason: 'forbidden',
        detail: `${def.name} requires admin role`,
      };
    }

    const parse = def.parse(input.argv);
    if (!parse.ok) {
      this.onEvent?.({ kind: 'rejected', name: def.name, reason: 'parse_failed' });
      return { ok: false, reason: 'parse_failed', detail: parse.error };
    }

    const signal = input.signal ?? new AbortController().signal;
    if (signal.aborted) {
      this.onEvent?.({ kind: 'rejected', name: def.name, reason: 'aborted' });
      return { ok: false, reason: 'aborted' };
    }

    this.onEvent?.({ kind: 'dispatched', name: def.name, role: requiredRole });
    const start = Date.now();
    try {
      const result = await def.execute(parse.args, {
        caller: input.caller,
        signal,
      });
      if (!result.ok) {
        this.onEvent?.({ kind: 'rejected', name: def.name, reason: 'threw' });
        return { ok: false, reason: 'threw', detail: result.error };
      }
      this.onEvent?.({
        kind: 'succeeded',
        name: def.name,
        durationMs: Date.now() - start,
      });
      const out: DispatchResult = { ok: true };
      if (result.message !== undefined) out.message = result.message;
      if (result.data !== undefined) out.data = result.data;
      return out;
    } catch (err) {
      this.onEvent?.({ kind: 'rejected', name: def.name, reason: 'threw' });
      return {
        ok: false,
        reason: 'threw',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateCommandDefinition<T>(def: CommandDefinition<T>): void {
  if (!def.name || !def.name.startsWith('/')) {
    throw new Error(
      `CommandDispatcher: command name must start with "/" (got ${JSON.stringify(def.name)})`,
    );
  }
  if (typeof def.description !== 'string') {
    throw new Error(`CommandDispatcher: ${def.name} description must be a string`);
  }
  if (typeof def.parse !== 'function') {
    throw new Error(`CommandDispatcher: ${def.name} parse must be a function`);
  }
  if (typeof def.execute !== 'function') {
    throw new Error(`CommandDispatcher: ${def.name} execute must be a function`);
  }
  if (def.role !== undefined && def.role !== 'user' && def.role !== 'admin') {
    throw new Error(
      `CommandDispatcher: ${def.name} role must be "user" or "admin" (got ${JSON.stringify(def.role)})`,
    );
  }
}

/** Levenshtein distance — O(|a|*|b|) DP. Used by `suggest`. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  // Single-row DP.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
