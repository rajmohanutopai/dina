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
   * destination via `route_to_persona`. Updated when the user
   * installs / removes a persona; the drain re-resolves per item.
   */
  personas: Array<{ name: string; description?: string }>;
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
  const personasList = input.personas
    .map((p) =>
      p.description !== undefined && p.description.trim() !== ''
        ? `${p.name} — ${p.description}`
        : p.name,
    )
    .join(', ');
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

  const systemPrompt = REMEMBER_AGENTIC.replace('{{personas_list}}', personasList)
    .replace('{{today}}', today)
    .replace('{{timezone}}', timezone);

  return {
    async run(turn: RememberTurnInput): Promise<RememberTurnResult> {
      const collect = emptyRememberSideEffects();

      const tools = new ToolRegistry();
      tools.register(createRouteToPersonaTool({ collect }));
      tools.register(createLinkToPersonTool({ collect }));
      tools.register(createBindPreferenceTool({ collect }));
      tools.register(
        createScheduleReminderTool({
          defaultPersona,
          defaultTimezone: timezone,
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
