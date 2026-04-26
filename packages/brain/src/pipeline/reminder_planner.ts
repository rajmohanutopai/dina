/**
 * Reminder planner — plan reminders from staging items.
 *
 * LLM-only by design (April 2026). Earlier versions ran a regex
 * `extractEvents` gate first, but real-world phrasing — "pay rent
 * tomorrow at 5 pm", "drop off the car next Tuesday" — never matched
 * the narrow keyword set, so the gate dropped events the LLM would
 * have caught. The directive was to stop hand-coding "if X do Y"
 * rules and let the model reason from context (per
 * `feedback_prompt_engineering.md` in user memory).
 *
 * Pipeline now:
 * 1. Gather vault context (FTS5 search) for the LLM prompt
 * 2. Render `REMINDER_PLAN` with subject/body/today/timezone/context
 * 3. PII-scrub before send, rehydrate after
 * 4. Parse LLM output, normalise kind, bump past birthdays forward
 * 5. Consolidate same-day events into one reminder
 * 6. Validate + create via Core reminder service
 *
 * Errors used to be swallowed in `catch{}` (line 168). They are now
 * surfaced through the registered logger so a misconfigured LLM is
 * loud, not silent. Default logger writes to `console.warn` so a
 * test or production app that forgets to register one still gets
 * the signal.
 *
 * Source: ARCHITECTURE.md Task 3.28, brain/src/service/reminder_planner.py
 */

import { isValidReminderPayload, isExtractedEventKind } from '../enrichment/event_extractor';
import type { ExtractedEvent, ExtractedEventKind } from '../enrichment/event_extractor';
import { createReminder, type Reminder } from '../../../core/src/reminders/service';
import { parseReminderPlan } from '../llm/output_parser';
import { REMINDER_PLAN } from '../llm/prompts';
import { queryVault } from '../../../core/src/vault/crud';
import { scrubPII, rehydratePII } from '../../../core/src/pii/patterns';

export interface PlannerInput {
  itemId: string;
  type: string;
  summary: string;
  body: string;
  timestamp: number;
  persona: string;
  /** User timezone (e.g., "America/New_York"). Defaults to UTC. */
  timezone?: string;
  metadata?: Record<string, unknown>;
}

export interface PlannerResult {
  eventsDetected: number;
  remindersCreated: number;
  reminders: Reminder[];
  llmRefined: boolean;
  /** Number of vault context items used to enrich the LLM prompt (0 = no context). */
  vaultContextUsed: number;
}

/** Injectable LLM planner: (system, prompt) → reminder plan JSON. */
export type ReminderLLMProvider = (system: string, prompt: string) => Promise<string>;

let llmProvider: ReminderLLMProvider | null = null;

/** Register an LLM provider for reminder planning. */
export function registerReminderLLM(provider: ReminderLLMProvider): void {
  llmProvider = provider;
}

/** Reset the provider (for testing). */
export function resetReminderLLM(): void {
  llmProvider = null;
}

/**
 * Structured logger surface — only `warn` is exercised today, but the
 * shape mirrors the rest of the codebase (`{event, ...}` records) so
 * future callers can add `info` / `error` without breaking the contract.
 */
export interface ReminderLogger {
  warn: (record: Record<string, unknown>) => void;
}

const defaultLogger: ReminderLogger = {
  // Console.warn is the floor — so a planner running in a host that
  // forgot to register a logger still surfaces failures rather than
  // dropping reminders silently (the prior `catch{}` behaviour).
  warn: (record) => {
    // eslint-disable-next-line no-console
    console.warn('[reminder_planner]', record);
  },
};

let logger: ReminderLogger = defaultLogger;

/** Register a logger for reminder-planner diagnostics. */
export function registerReminderLogger(next: ReminderLogger): void {
  logger = next;
}

/** Reset to the default console logger (for testing). */
export function resetReminderLogger(): void {
  logger = defaultLogger;
}

/**
 * Plan reminders for a staging item.
 *
 * Pipeline (LLM-only):
 * 1. Bail loudly if no LLM is registered — the planner is useless without one
 * 2. Gather vault context (FTS5 search) for the prompt
 * 3. Render `REMINDER_PLAN`, PII-scrub, call LLM, rehydrate
 * 4. Normalise kind, bump past recurring-kind dates forward
 * 5. Consolidate same-day events
 * 6. Validate + create via Core reminder service
 *
 * Every error path goes through `logger.warn` — never silenced.
 */
export async function planReminders(input: PlannerInput): Promise<PlannerResult> {
  // Resolve the user's timezone once. If the caller passes one, honor it.
  // Otherwise fall back to the device/runtime IANA zone — both Node and
  // Hermes ship Intl. We previously hard-coded `'UTC'` here, which told
  // the LLM "the user is in UTC" even on a phone in IST → due_at came
  // back in UTC, the UI rendered it in local tz, and reminders drifted
  // by the local UTC offset (e.g. May 5 3pm IST → stored as 3pm UTC →
  // shown as May 5 8:30 PM IST).
  const resolvedTimezone =
    input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

  let allEvents: ExtractedEvent[] = [];
  let llmRefined = false;
  let vaultContextUsed = 0;

  // 1. LLM gate. Without a provider we have no way to find events —
  //    return an empty result and log loudly so a misconfigured boot
  //    surfaces during the first /remember rather than silently
  //    swallowing reminders forever.
  if (!llmProvider) {
    logger.warn({
      event: 'reminder_planner.no_llm_provider',
      itemId: input.itemId,
      reason:
        'No LLM provider registered. Call registerReminderLLM() during boot — the planner is LLM-only and cannot create reminders without it.',
    });
    return {
      eventsDetected: 0,
      remindersCreated: 0,
      reminders: [],
      llmRefined: false,
      vaultContextUsed: 0,
    };
  }

  // 2 + 3. LLM call with vault context + PII scrub.
  try {
    const { text: vaultContext, itemCount } = gatherVaultContext(input);
    vaultContextUsed = itemCount;

    // PII scrub before sending to cloud LLM — vault context and item body
    // may contain emails, phone numbers, etc. Names pass through (by design).
    const prompt = renderReminderPrompt(input, vaultContext, resolvedTimezone);
    const { scrubbed: scrubbedPrompt, entities: piiEntities } = scrubPII(prompt);

    const rawOutput = await llmProvider('', scrubbedPrompt);

    // Rehydrate PII tokens in the response so reminder messages contain original values
    const rehydrated = piiEntities.length > 0 ? rehydratePII(rawOutput, piiEntities) : rawOutput;
    const llmPlan = parseReminderPlan(rehydrated);

    for (const llmReminder of llmPlan.reminders) {
      // Validate kind at the LLM trust boundary. The output parser
      // accepts arbitrary `kind: string` (parser is intentionally
      // tolerant); this is the *consumer* side, where unknown kinds
      // would silently flow into prioritizeKind / consolidateReminders
      // / UI rendering and produce undefined behavior. Anything not
      // in the canonical set folds back to 'custom' so we keep the
      // reminder rather than dropping it — reminders are user-visible,
      // dropping silently is worse than rendering as the generic
      // bucket.
      const rawKind = llmReminder.kind;
      const kind: ExtractedEventKind = isExtractedEventKind(rawKind) ? rawKind : 'custom';

      // Safety net: some LLMs ignore the "use next occurrence" prompt
      // rule and commit past dates for recurring events. Bump the year
      // forward until the timestamp is in the future. Applies ONLY to
      // recurring kinds (birthday / anniversary) where shifting year
      // is semantically correct — one-off events (appointment /
      // payment_due / deadline) that landed in the past stay past and
      // get dropped by the filter at step 5 (correct: don't fabricate
      // a future appointment that wasn't scheduled).
      let dueAt = llmReminder.due_at;
      if (kind === 'birthday' && dueAt <= Date.now()) {
        const d = new Date(dueAt);
        while (d.getTime() <= Date.now()) {
          d.setUTCFullYear(d.getUTCFullYear() + 1);
        }
        dueAt = d.getTime();
      }

      // Cross-emit dedup: if the LLM emits two reminders for the same
      // kind within a day of each other, drop the duplicate. Keeps
      // consolidation cheap and avoids "Pay rent" landing twice when
      // the model echoes itself.
      const isDuplicate = allEvents.some(
        (e) => Math.abs(new Date(e.fire_at).getTime() - dueAt) < 86_400_000 && e.kind === kind,
      );

      if (!isDuplicate) {
        allEvents.push({
          fire_at: new Date(dueAt).toISOString(),
          message: llmReminder.message,
          kind,
          source_item_id: input.itemId,
        });
      }
    }

    if (llmPlan.reminders.length > 0) llmRefined = true;
  } catch (err) {
    // The previous version swallowed this entirely. Surface it — a
    // bad LLM call (network, quota, malformed JSON) used to look
    // identical to "no events found" and cost us a real bug on
    // simulator validation.
    logger.warn({
      event: 'reminder_planner.llm_error',
      itemId: input.itemId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
    });
  }

  // 4. Consolidate overlapping events (same day → merge into one reminder)
  allEvents = consolidateReminders(allEvents);

  // 5 + 6. Validate and create reminders
  const created: Reminder[] = [];

  for (const event of allEvents) {
    if (!isValidReminderPayload(event)) {
      logger.warn({
        event: 'reminder_planner.invalid_payload',
        itemId: input.itemId,
        eventKind: event.kind,
        fire_at: event.fire_at,
      });
      continue;
    }

    const dueAt = new Date(event.fire_at).getTime();
    if (isNaN(dueAt) || dueAt <= 0) {
      logger.warn({
        event: 'reminder_planner.invalid_due_at',
        itemId: input.itemId,
        fire_at: event.fire_at,
      });
      continue;
    }
    // Skip past events — don't create reminders for dates already
    // passed. Common LLM failure: model says "today at 5pm" or
    // miscomputes from `{{today}}` and emits a timestamp in the
    // past. Surface this so a fix (better prompt, higher tier
    // model, timezone hint) is visible rather than silently dropped.
    if (dueAt < Date.now()) {
      logger.warn({
        event: 'reminder_planner.past_due_at',
        itemId: input.itemId,
        eventKind: event.kind,
        message: event.message,
        fire_at: event.fire_at,
        due_at_ms: dueAt,
        now_ms: Date.now(),
      });
      continue;
    }

    try {
      const reminder = createReminder({
        message: event.message,
        due_at: dueAt,
        persona: input.persona,
        kind: event.kind,
        source_item_id: event.source_item_id,
        source: 'reminder_planner',
        timezone: resolvedTimezone,
      });
      created.push(reminder);
    } catch (err) {
      logger.warn({
        event: 'reminder_planner.create_error',
        itemId: input.itemId,
        eventKind: event.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    eventsDetected: allEvents.length,
    remindersCreated: created.length,
    reminders: created,
    llmRefined,
    vaultContextUsed,
  };
}

/**
 * Check if a staging item has potential events worth planning.
 */
export function hasEventSignals(summary: string, body: string): boolean {
  const text = `${summary} ${body}`.toLowerCase();
  return /\b(january|february|march|april|may|june|july|august|september|october|november|december|due|deadline|birthday|appointment|meeting|remind)\b/i.test(
    text,
  );
}

// ---------------------------------------------------------------
// Internal: vault context gathering
// ---------------------------------------------------------------

/**
 * Gather related vault items for context enrichment.
 *
 * Extracts keywords (proper nouns, event-related terms) from the item
 * and searches the vault for related items. Returns formatted context.
 */
function gatherVaultContext(input: PlannerInput): { text: string; itemCount: number } {
  const keywords = extractKeywords(input.summary, input.body);
  if (keywords.length === 0) return { text: '(no related context found)', itemCount: 0 };

  const contextItems: string[] = [];

  try {
    for (const keyword of keywords.slice(0, 3)) {
      const results = queryVault(input.persona, {
        mode: 'fts5',
        text: keyword,
        limit: 3,
      });
      for (const item of results) {
        const line = item.content_l0 || item.summary || '';
        if (line && !contextItems.includes(line)) {
          contextItems.push(line);
        }
      }
    }
  } catch (err) {
    // Vault search failed — proceed without context, but log so a
    // misconfigured vault (closed persona, missing FTS5) doesn't
    // silently degrade the prompt quality.
    logger.warn({
      event: 'reminder_planner.vault_context_error',
      itemId: input.itemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (contextItems.length === 0) return { text: '(no related context found)', itemCount: 0 };
  return { text: contextItems.map((c) => `- ${c}`).join('\n'), itemCount: contextItems.length };
}

/**
 * Extract searchable keywords from item text.
 *
 * Finds proper nouns (capitalized words), event-related terms,
 * and strips stop words. Returns up to 5 keywords.
 */
function extractKeywords(summary: string, body: string): string[] {
  const text = `${summary} ${body}`;
  const words = new Set<string>();

  // Proper nouns (capitalized, not sentence-start)
  const properNounRe = /(?<=\s)([A-Z][a-z]{2,})/g;
  let match: RegExpExecArray | null;
  while ((match = properNounRe.exec(text)) !== null) {
    words.add(match[1]);
  }

  // Event-related terms
  const eventTerms = text.match(
    /\b(birthday|appointment|meeting|deadline|payment|dentist|doctor|school|flight)\b/gi,
  );
  if (eventTerms) {
    for (const term of eventTerms) {
      words.add(term.toLowerCase());
    }
  }

  return [...words].slice(0, 5);
}

/**
 * Render the REMINDER_PLAN prompt template with all variables.
 *
 * Python parity (`PROMPT_REMINDER_PLANNER_SYSTEM`, `brain/src/prompts.py:141`):
 * the LLM receives `{{today}}` (current date/time) so it can infer
 * next-occurrence for recurring events stated without a year (birthdays,
 * anniversaries). TS previously passed `{{event_date}}` (the ingest
 * timestamp), which didn't tell the LLM what "now" was and let year-less
 * dates silently default to the current year — blocking "/remember
 * Emma's birthday is March 15th" any time we're past March 15.
 */
function renderReminderPrompt(
  input: PlannerInput,
  vaultContext: string,
  resolvedTimezone: string,
): string {
  return REMINDER_PLAN.replace('{{subject}}', input.summary)
    .replace('{{body}}', input.body.slice(0, 4000))
    .replace('{{today}}', new Date().toISOString())
    .replace('{{timezone}}', resolvedTimezone)
    .replace('{{vault_context}}', vaultContext);
}

// ---------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------

/** Time window for consolidation: events within 2 hours are merged. */
const CONSOLIDATION_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Consolidate overlapping events into combined reminders.
 *
 * When multiple events fall within the same time window (2 hours),
 * they are merged into a single reminder with all messages combined.
 * This prevents notification spam (e.g., "birthday + dinner at 7pm"
 * on the same day produces one reminder, not two).
 *
 * Matching Python's consolidation rule: "when someone is arriving,
 * create ONE reminder with ALL context."
 */
export function consolidateReminders(events: ExtractedEvent[]): ExtractedEvent[] {
  if (events.length <= 1) return events;

  // Sort by fire_at ascending
  const sorted = [...events].sort((a, b) => {
    const aTime = new Date(a.fire_at).getTime();
    const bTime = new Date(b.fire_at).getTime();
    return aTime - bTime;
  });

  const consolidated: ExtractedEvent[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const currentTime = new Date(current.fire_at).getTime();
    const nextTime = new Date(next.fire_at).getTime();

    if (Math.abs(nextTime - currentTime) <= CONSOLIDATION_WINDOW_MS) {
      // Merge: combine messages, keep the earlier time, use the higher-priority kind
      current = {
        fire_at: current.fire_at, // keep earlier time
        message: `${current.message} — also: ${next.message}`,
        kind: prioritizeKind(current.kind, next.kind),
        source_item_id: current.source_item_id,
      };
    } else {
      consolidated.push(current);
      current = next;
    }
  }

  consolidated.push(current);
  return consolidated;
}

/** Pick the higher-priority kind when merging. */
function prioritizeKind(a: string, b: string): ExtractedEvent['kind'] {
  const priority: Record<string, number> = {
    arrival: 5,
    appointment: 4,
    payment_due: 3,
    deadline: 2,
    birthday: 1,
    reminder: 0,
  };
  const aP = priority[a] ?? 0;
  const bP = priority[b] ?? 0;
  return (aP >= bP ? a : b) as ExtractedEvent['kind'];
}
