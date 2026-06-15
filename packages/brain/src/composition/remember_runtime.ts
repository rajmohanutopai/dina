/**
 * Remember runtime — builds the per-item agentic pipeline the staging
 * drain runs on every `/remember`. Parallel structure to
 * `ask_runtime.ts`: one constructor that wires tools + system prompt
 * + LLM provider; one entry point (`runRememberTurn`) the drain calls
 * with the item to process.
 *
 * Output of `runRememberTurn`:
 *   - `sideEffects` — the `RememberSideEffects` collector after the
 *     loop. Drain reads `routes`, `people`, `preferences` to apply
 *     them. `reminders` is empty — `schedule_reminder` actually
 *     creates the reminder mid-loop via Core (timing is fine: a
 *     reminder doesn't depend on vault storage).
 *   - `text` — the LLM's final user-facing acknowledgement (e.g.
 *     "Saved to finance — I'll remind you a week before Emma's
 *     birthday."). May be empty.
 *   - `transcript` — full agentic-loop transcript (for diagnostics).
 *
 * Mobile and lite share this runtime in-process; only the LLM
 * provider differs.
 */

import { runAgenticTurn } from '../reasoning/agentic_loop';
import { ToolRegistry } from '../reasoning/tool_registry';
import { createScheduleReminderTool } from '../reasoning/schedule_reminder_tool';
import { createVaultSearchTool } from '../reasoning/vault_tool';
import {
  createBindPreferenceTool,
  createLinkToPersonTool,
  createRouteToPersonaTool,
  emptyRememberSideEffects,
  type RememberSideEffects,
} from '../reasoning/remember_tools';
import { REMEMBER_AGENTIC } from '../llm/prompts';

import type { LLMProvider } from '../llm/adapters/provider';

export interface RememberRuntimeInput {
  /** The LLM provider — same one the ask runtime uses. */
  llm: LLMProvider;
  /**
   * Installed personas with descriptions. Rendered into the system
   * prompt's `{{personas_list}}`. The LLM uses this to pick a
   * destination via `route_to_persona`.
   *
   * Accepts a STATIC array (tests) OR a live getter (the app). The app
   * passes a getter so a vault the user creates mid-session becomes a
   * routing target on the very next /remember — without it the list was
   * frozen at boot and a "create salon vault → remember salon hours" in
   * one session routed to the default vault instead. Mirrors
   * ask_runtime's `installedPersonas` getter.
   */
  personas:
    | readonly { name: string; description?: string }[]
    | (() => readonly { name: string; description?: string }[]);
  /** Default persona when the loop doesn't call `route_to_persona`. */
  defaultPersona?: string;
  /** Override timezone for relative-date resolution. Defaults to runtime. */
  timezone?: string;
  /** Override "today" (ISO date string). Defaults to current date. */
  today?: string;
}

export interface RememberTurnInput {
  /** The memory text the user just saved. */
  memoryText: string;
  /**
   * The staging item id this memory is being drained from. Threaded
   * into `schedule_reminder` as the reminder's `source_item_id` so the
   * chat orchestrator can find the reminder it just created and render
   * the "Reminders set" confirmation card. Omitted by callers that
   * don't have a staging id (rare).
   */
  sourceItemId?: string;
  /** Optional metadata that aids classification (source, sender, type). */
  metadata?: {
    type?: string;
    source?: string;
    sender?: string;
    subject?: string;
  };
  /**
   * Memories the inbound sender is a subject of (`vault_item_subjects`),
   * pre-resolved by the caller via `recallSenderSubjectMemories`. Rendered
   * into the prompt so the agent can enrich without name/FTS guessing —
   * the structured did→person→facts recall for D2D arrivals where the
   * message body never names the sender ("I'm coming over").
   */
  relatedMemories?: string[];
}

export interface RememberTurnResult {
  sideEffects: RememberSideEffects;
  /** LLM's user-facing acknowledgement (may be empty). */
  text: string;
  /** Tool calls the agent made, in order. */
  toolNames: string[];
}

const DEFAULT_PERSONA = 'general';

/**
 * Build the remember pipeline. Returns a `run` function the drain
 * calls per item. The tool registry is reconstructed per call because
 * each item gets its own `RememberSideEffects` collector — tools
 * close over it and tests can inspect it after the loop.
 */
export function buildRememberRuntime(input: RememberRuntimeInput): {
  run: (turn: RememberTurnInput) => Promise<RememberTurnResult>;
} {
  const defaultPersona = input.defaultPersona ?? DEFAULT_PERSONA;
  // Resolve personas LIVE per run (not once at construction) so a vault the
  // user just created is an eligible routing target immediately. Static
  // arrays are wrapped in a constant getter for backward compatibility.
  const personasInput = input.personas;
  const resolvePersonas: () => readonly { name: string; description?: string }[] =
    typeof personasInput === 'function' ? personasInput : () => personasInput;
  const today =
    input.today ??
    new Date().toISOString().slice(0, 10);
  const timezone =
    input.timezone ??
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })();

  function buildSystemPrompt(): string {
    const personasList = resolvePersonas()
      .map((p) =>
        p.description !== undefined && p.description.trim() !== ''
          ? `${p.name} — ${p.description}`
          : p.name,
      )
      .join(', ');
    return REMEMBER_AGENTIC.replace('{{personas_list}}', personasList)
      .replace('{{today}}', today)
      .replace('{{timezone}}', timezone);
  }

  return {
    async run(turn: RememberTurnInput): Promise<RememberTurnResult> {
      const collect = emptyRememberSideEffects();
      // Built per-run so a persona created since construction is included.
      const systemPrompt = buildSystemPrompt();

      const tools = new ToolRegistry();
      tools.register(createRouteToPersonaTool({ collect }));
      tools.register(createLinkToPersonTool({ collect }));
      tools.register(createBindPreferenceTool({ collect }));
      // Recall tool — lets the loop look up what the user has ALREADY
      // saved about the people / topics in this memory and enrich its
      // reminders + acknowledgement ("Emma's birthday" + a prior "Emma
      // loves dinosaurs" → suggest a dinosaur gift). No personaGuard:
      // this is the OWNER processing their own /remember, so it reads
      // across every unlocked persona, exactly like the in-app user.
      // The prior item(s) are already drained/stored by the time this
      // one runs, so the search finds them.
      tools.register(createVaultSearchTool());
      tools.register(
        createScheduleReminderTool({
          defaultPersona,
          defaultTimezone: timezone,
          // Link the reminder back to the staged item so the chat reply
          // can surface a "Reminders set" card for it.
          sourceItemId: turn.sourceItemId,
          // When the LLM omits an explicit persona on schedule_reminder,
          // pin the reminder to the persona the item was just routed to
          // (the most recent `route_to_persona` call) instead of the
          // static default — keeps reminder + item in the same vault.
          resolvePersona: () => collect.routes[collect.routes.length - 1]?.primary,
        }),
      );

      // Hand the memory body to the loop. `metadata` is informational
      // only — the LLM mostly reasons about the text content.
      const userMessage = renderUserMessage(turn);
      const result = await runAgenticTurn({
        provider: input.llm,
        tools,
        systemPrompt,
        userMessage,
      });

      return {
        sideEffects: collect,
        text: result.answer ?? '',
        toolNames: result.toolCalls.map((c) => c.name),
      };
    },
  };
}

function renderUserMessage(turn: RememberTurnInput): string {
  const m = turn.metadata;
  // Plain text content first, then a small metadata trailer if any
  // field is meaningful. The LLM mostly reads the body; the trailer
  // helps disambiguate (e.g. type='email_thread' vs 'note').
  const lines: string[] = [turn.memoryText];
  const meta: string[] = [];
  if (m?.type !== undefined && m.type !== '' && m.type !== 'note') {
    meta.push(`type=${m.type}`);
  }
  if (m?.source !== undefined && m.source !== '') {
    meta.push(`source=${m.source}`);
  }
  if (m?.sender !== undefined && m.sender !== '') {
    meta.push(`sender=${m.sender}`);
  }
  if (m?.subject !== undefined && m.subject !== '') {
    meta.push(`subject="${m.subject}"`);
  }
  if (meta.length > 0) {
    lines.push('', `[metadata: ${meta.join(', ')}]`);
  }
  // Structured recall: what we already know about the sender (from the
  // people graph's subject links). Lets the agent enrich a terse arrival
  // ("I'm coming over") with the sender's remembered preferences.
  const related = (turn.relatedMemories ?? []).filter((s) => s.trim() !== '');
  if (related.length > 0) {
    lines.push('', 'Known facts about the sender:');
    for (const r of related) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}
