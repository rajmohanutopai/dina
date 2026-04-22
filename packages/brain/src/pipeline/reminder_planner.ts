/**
 * Reminder planner — plan reminders from staging items with temporal events.
 *
 * When a staging item has detected events (birthdays, deadlines, appointments):
 * 1. Extract events via event_extractor (deterministic regex)
 * 2. Optionally refine via LLM with vault context + timezone (adds context, multi-reminder)
 * 3. Create reminders via Core reminder service
 *
 * The planner runs as part of the post-publish pipeline,
 * after classification and L0/L1 generation.
 *
 * Source: ARCHITECTURE.md Task 3.28, brain/src/service/reminder_planner.py
 */

import { extractEvents, isValidReminderPayload } from '../enrichment/event_extractor';
import type { ExtractionInput, ExtractedEvent } from '../enrichment/event_extractor';
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
 * Plan reminders for a staging item.
 *
 * Pipeline:
 * 1. Extract events (deterministic regex)
 * 2. Gather vault context for enrichment (search for related items)
 * 3. If LLM available → call with prompt template + vault context + timezone
 * 4. Merge LLM results with deterministic, dedup by (time, kind)
 * 5. Filter past dates, validate, create reminders
 */
export async function planReminders(input: PlannerInput): Promise<PlannerResult> {
  const extractionInput: ExtractionInput = {
    item_id: input.itemId,
    type: input.type,
    summary: input.summary,
    body: input.body,
    timestamp: input.timestamp,
    metadata: input.metadata,
  };

  // 1. Deterministic extraction
  const events = extractEvents(extractionInput);
  let allEvents = [...events];
  let llmRefined = false;
  let vaultContextUsed = 0;

  // 2 + 3. LLM refinement with vault context + timezone
  if (llmProvider) {
    try {
      // Gather vault context: search for items related to the people/topics in this item
      const { text: vaultContext, itemCount } = gatherVaultContext(input);
      vaultContextUsed = itemCount;

      // PII scrub before sending to cloud LLM — vault context and item body
      // may contain emails, phone numbers, etc. Names pass through (by design).
      const prompt = renderReminderPrompt(input, vaultContext);
      const { scrubbed: scrubbedPrompt, entities: piiEntities } = scrubPII(prompt);

      const rawOutput = await llmProvider('', scrubbedPrompt);

      // Rehydrate PII tokens in the response so reminder messages contain original values
      const rehydrated = piiEntities.length > 0 ? rehydratePII(rawOutput, piiEntities) : rawOutput;
      const llmPlan = parseReminderPlan(rehydrated);

      for (const llmReminder of llmPlan.reminders) {
        // Dedup: don't duplicate events already found by regex (within 1 day, same kind)
        const isDuplicate = allEvents.some(
          (e) =>
            Math.abs(new Date(e.fire_at).getTime() - llmReminder.due_at) < 86_400_000 &&
            e.kind === llmReminder.kind,
        );

        if (!isDuplicate) {
          allEvents.push({
            fire_at: new Date(llmReminder.due_at).toISOString(),
            message: llmReminder.message,
            kind: llmReminder.kind as ExtractedEvent['kind'],
            source_item_id: input.itemId,
          });
        }
      }

      if (llmPlan.reminders.length > 0) llmRefined = true;
    } catch {
      // LLM failure — proceed with regex-only events
    }
  }

  // 4. Consolidate overlapping events (same day → merge into one reminder)
  allEvents = consolidateReminders(allEvents);

  // 5 + 6. Validate and create reminders
  const created: Reminder[] = [];

  for (const event of allEvents) {
    if (!isValidReminderPayload(event)) continue;

    const dueAt = new Date(event.fire_at).getTime();
    if (isNaN(dueAt) || dueAt <= 0) continue;
    // Skip past events — don't create reminders for dates already passed
    if (dueAt < Date.now()) continue;

    try {
      const reminder = createReminder({
        message: event.message,
        due_at: dueAt,
        persona: input.persona,
        kind: event.kind,
        source_item_id: event.source_item_id,
        source: 'reminder_planner',
        timezone: input.timezone,
      });
      created.push(reminder);
    } catch {
      // Dedup rejection or other error — skip
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
  } catch {
    // Vault search failed — proceed without context
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
 */
function renderReminderPrompt(input: PlannerInput, vaultContext: string): string {
  return REMINDER_PLAN.replace('{{subject}}', input.summary)
    .replace('{{body}}', input.body.slice(0, 4000))
    .replace(
      '{{event_date}}',
      input.timestamp ? new Date(input.timestamp).toISOString() : 'unknown',
    )
    .replace('{{timezone}}', input.timezone ?? 'UTC')
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
