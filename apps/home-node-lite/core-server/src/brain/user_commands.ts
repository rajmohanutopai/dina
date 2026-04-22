/**
 * User-commands registry (GAP.md row #29 closure — M1 blocker).
 *
 * Ports the user-facing command DEFINITIONS from the Python Brain's
 * `service/user_commands.py` onto TS `CommandDefinition` shapes
 * ready to register on a `CommandDispatcher` (task 5.33).
 *
 * **Split of concerns**:
 *   - `CommandDispatcher` (5.33) = infrastructure — registration,
 *     role gating, dispatch, suggestions.
 *   - `user_commands.ts` (this file) = policy — which commands exist,
 *     what they do, what they return.
 *
 * Each command is a minimal self-contained handler: parse argv, do
 * something, return structured data. Heavy commands (e.g. `/search`)
 * receive their dependencies (CoreClient, persona registry, etc.)
 * via a `UserCommandContext` object passed into the FACTORY — the
 * factory closes over that context + returns the `CommandDefinition`.
 * Keeps definitions testable without a DI framework.
 *
 * **Current command set** (user-facing, no admin surface):
 *
 *   - `/help`         — list registered commands + short descriptions.
 *   - `/status`       — show boot-state summary (persona count, key fingerprint, uptime).
 *   - `/personas`     — list personas with tier + lock state.
 *   - `/unlock`       — unlock a locked persona with passphrase.
 *   - `/search`       — run a vault search against the active persona.
 *   - `/whoami`       — echo caller role + DID.
 *
 * **Design posture**: every handler returns `{ok: true, data}` on
 * success with data-shaped payload (NOT a pre-rendered string) so
 * the caller picks the rendering — CLI, Telegram, admin UI.
 *
 * Source: GAP.md (task 5.46 follow-up) — M1 command surface gate.
 */

import type {
  CommandDefinition,
  CommandExecuteResult,
} from './command_dispatcher';
import type { CoreClient, PersonaDetail } from './core_client';

/**
 * Dependencies every user-command has access to. Pass this into the
 * factory; the factory closes over it + returns the command set.
 * Every field is optional — commands that don't have what they need
 * return `not_available` gracefully rather than crashing.
 */
export interface UserCommandContext {
  core?: CoreClient;
  /** Unix ms when the brain booted — `/status` surfaces uptime. */
  bootStartedMsFn?: () => number;
  /** Short fingerprint of the service key — `/status` echoes it. */
  serviceKeyFingerprint?: string;
  /** Callback: return the dispatcher's known command list for `/help`. */
  listCommandsFn?: () => Array<{ name: string; description: string }>;
}

/**
 * Build the canonical user-command set bound to a given context.
 * Callers invoke `for (const c of buildUserCommands(ctx)) dispatcher.register(c)`.
 *
 * The return type widens every command to `CommandDefinition<unknown>`
 * so typed arg factories (SearchArgs, UnlockArgs) can coexist in one
 * array — `CommandDispatcher.register<T>` narrows at registration.
 */
export function buildUserCommands(
  ctx: UserCommandContext = {},
): Array<CommandDefinition<unknown>> {
  return [
    helpCommand(ctx),
    statusCommand(ctx),
    personasCommand(ctx),
    unlockCommand(ctx),
    searchCommand(ctx),
    whoamiCommand(),
  ] as Array<CommandDefinition<unknown>>;
}

// ── Individual commands ────────────────────────────────────────────────

function helpCommand(ctx: UserCommandContext): CommandDefinition<Record<string, never>> {
  return {
    name: '/help',
    description: 'List available commands.',
    parse: () => ({ ok: true, args: {} }),
    execute: async (): Promise<CommandExecuteResult> => {
      const commands = ctx.listCommandsFn
        ? ctx.listCommandsFn()
        : [];
      return { ok: true, data: { commands } };
    },
  };
}

function statusCommand(ctx: UserCommandContext): CommandDefinition<Record<string, never>> {
  return {
    name: '/status',
    description: 'Show brain-server status (uptime + persona count + key fingerprint).',
    parse: () => ({ ok: true, args: {} }),
    execute: async (): Promise<CommandExecuteResult> => {
      const now = Date.now();
      const bootMs = ctx.bootStartedMsFn?.() ?? now;
      const uptimeMs = Math.max(0, now - bootMs);
      let personaCount: number | null = null;
      if (ctx.core) {
        const result = await ctx.core.listPersonas();
        if (result.ok) personaCount = result.value.length;
      }
      return {
        ok: true,
        data: {
          uptimeMs,
          personaCount,
          keyFingerprint: ctx.serviceKeyFingerprint ?? null,
        },
      };
    },
  };
}

function personasCommand(ctx: UserCommandContext): CommandDefinition<Record<string, never>> {
  return {
    name: '/personas',
    description: 'List installed personas with tier + lock state.',
    parse: () => ({ ok: true, args: {} }),
    execute: async (): Promise<CommandExecuteResult> => {
      if (!ctx.core) return { ok: false, error: 'core client not available' };
      const result = await ctx.core.listPersonas();
      if (!result.ok) {
        return { ok: false, error: `listPersonas failed: ${result.error.message}` };
      }
      const rendered: Array<Pick<PersonaDetail, 'id' | 'name' | 'tier' | 'locked'>> =
        result.value.map((p) => ({
          id: p.id,
          name: p.name,
          tier: p.tier,
          locked: p.locked,
        }));
      return { ok: true, data: { personas: rendered } };
    },
  };
}

interface UnlockArgs { persona: string; passphrase: string }

function unlockCommand(_ctx: UserCommandContext): CommandDefinition<UnlockArgs> {
  return {
    name: '/unlock',
    description: 'Unlock a locked persona — usage: /unlock <persona> <passphrase>',
    parse: (argv) => {
      if (argv.length < 2) {
        return { ok: false, error: 'usage: /unlock <persona> <passphrase>' };
      }
      const [persona, ...rest] = argv;
      if (!persona || persona === '') {
        return { ok: false, error: 'persona argument required' };
      }
      const passphrase = rest.join(' ');
      if (passphrase === '') {
        return { ok: false, error: 'passphrase argument required' };
      }
      return { ok: true, args: { persona, passphrase } };
    },
    execute: async (args) => {
      // Unlock is routed through Core via a dedicated endpoint (not
      // exposed on CoreClient today). The contract here is
      // intentionally `not_implemented` until that surface lands.
      return {
        ok: false,
        error: `persona unlock surface not yet wired (persona=${args.persona})`,
      };
    },
  };
}

interface SearchArgs { query: string; persona: string; maxItems: number }

function searchCommand(ctx: UserCommandContext): CommandDefinition<SearchArgs> {
  return {
    name: '/search',
    description:
      'Search the active vault — usage: /search --persona <name> [--max N] <query...>',
    parse: (argv) => {
      if (argv.length === 0) {
        return { ok: false, error: 'usage: /search [--persona <name>] [--max N] <query>' };
      }
      let persona = 'general';
      let maxItems = 20;
      const queryParts: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        const tok = argv[i]!;
        if (tok === '--persona' && argv[i + 1] !== undefined) {
          persona = argv[++i]!;
        } else if (tok === '--max' && argv[i + 1] !== undefined) {
          const n = Number.parseInt(argv[++i]!, 10);
          if (!Number.isInteger(n) || n <= 0) {
            return { ok: false, error: '--max must be a positive integer' };
          }
          maxItems = n;
        } else {
          queryParts.push(tok);
        }
      }
      const query = queryParts.join(' ').trim();
      if (query === '') {
        return { ok: false, error: 'query string required' };
      }
      return { ok: true, args: { query, persona, maxItems } };
    },
    execute: async (args) => {
      if (!ctx.core) return { ok: false, error: 'core client not available' };
      const result = await ctx.core.queryVault({
        persona: args.persona,
        query: args.query,
        maxItems: args.maxItems,
      });
      if (!result.ok) {
        return { ok: false, error: `vault query failed: ${result.error.message}` };
      }
      return { ok: true, data: { items: result.value, count: result.value.length } };
    },
  };
}

function whoamiCommand(): CommandDefinition<Record<string, never>> {
  return {
    name: '/whoami',
    description: 'Echo the caller role + DID.',
    parse: () => ({ ok: true, args: {} }),
    execute: async (_args, { caller }) => ({
      ok: true,
      data: { role: caller.role, did: caller.did ?? null },
    }),
  };
}
