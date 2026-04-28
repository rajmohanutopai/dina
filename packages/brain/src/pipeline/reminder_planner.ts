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

import {
  getPeopleRepository,
  RepositoryPersonResolver,
  type PersonResolver,
  type ResolvedPerson,
} from '@dina/core';

import { scrubPII, rehydratePII } from '../../../core/src/pii/patterns';
import { createReminder, type Reminder } from '../../../core/src/reminders/service';
import { queryVault } from '../../../core/src/vault/crud';
import { isValidReminderPayload, isExtractedEventKind } from '../enrichment/event_extractor';
import { parseReminderPlan } from '../llm/output_parser';
import { REMINDER_PLAN } from '../llm/prompts';

import type { ExtractedEvent, ExtractedEventKind } from '../enrichment/event_extractor';

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
  /**
   * D2D sender DID. When set AND a people-graph repo is registered,
   * the planner resolves the sender to a `Person` record and injects
   * their display name + relationship hint + confirmed surfaces into
   * the LLM prompt context. The reminder reads "Sancho is arriving"
   * instead of "Someone is arriving"; vault facts stored under any
   * confirmed alias (canonical name, nickname, role phrase) get
   * pulled in via FTS keyword expansion.
   *
   * Fail-soft — when the DID isn't bound to a person, or the repo
   * isn't registered, the planner falls back to keyword extraction
   * over the item text exactly as before.
   */
  senderDid?: string;
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

// ---------------------------------------------------------------
// Internal: vault context gathering
// ---------------------------------------------------------------

/** Per-item summary truncation cap. Long summaries (full email
 *  bodies, multi-paragraph notes) would otherwise blow the prompt
 *  budget on a single item. */
const VAULT_CONTEXT_LINE_MAX_CHARS = 150;

/** Total context-item cap. The engine's rank order is the selection
 *  criterion; we just truncate the head. */
const VAULT_CONTEXT_MAX_ITEMS = 5;

/** Vault context search runs against the always-open `general`
 *  persona. Personal facts about people the user knows ("Emma likes
 *  dinosaurs") get classified into `general` even when the reminder
 *  itself is for `work` or `health` — querying the input persona
 *  would miss those facts whenever the reminder isn't itself in
 *  `general`. */
const VAULT_CONTEXT_PERSONA = 'general';

/**
 * Gather related vault items for context enrichment.
 *
 * Hands the user's `summary + body` straight to FTS5 — the engine
 * owns tokenization (`unicode61`) and ranking; we don't preprocess
 * user text in JavaScript.
 *
 * When `senderDid` resolves to a known person:
 *   - prepends a `Sender: <name> (<relationship>)` line so the LLM
 *     can use the right name in the reminder message
 *   - appends the person's confirmed surfaces (canonical name +
 *     nicknames + role phrases) to the FTS query so vault facts
 *     stored under any alias still surface (notes saved against
 *     "Sanch" still match a search for "Sancho Garcia").
 *
 * Returns the formatted context text plus the count of vault items
 * actually retrieved (the sender hint line doesn't count — it isn't
 * a vault item).
 */

function gatherVaultContext(input: PlannerInput): { text: string; itemCount: number } {
  const senderHint = resolveSenderHint(input.senderDid);

  // Hand the user's text straight to FTS5 — no JS-side keyword
  // extraction, stop-word lists, or proper-noun regex. SQLite FTS5
  // owns tokenization (`unicode61`) and ranking. `sanitizeFTSMatch`
  // escapes operators and joins terms with OR, so the engine scores
  // by how many tokens hit + their column weights, which is the
  // semantically-correct behaviour for natural-language input.
  //
  // When a sender is bound to a known person, append the confirmed
  // surfaces (canonical name + nicknames + role phrases). Vault facts
  // stored under any alias still surface even when the inbound D2D
  // body never says the canonical name — e.g. notes saved against
  // "Sanch" still match a search for "Sancho Garcia".
  const queryParts = [input.summary, input.body];
  if (senderHint !== null) {
    queryParts.push(...senderHint.surfaces);
  }
  const queryText = queryParts.filter((s) => s.length > 0).join(' ');

  const contextItems: string[] = [];

  if (queryText.length > 0) {
    try {
      // One FTS5 pass against the user's combined text. Limit pulls
      // up to VAULT_CONTEXT_MAX_ITEMS rows directly — the engine's
      // rank order is the selection criterion, not anything we
      // compute on the JS side.
      const results = queryVault(VAULT_CONTEXT_PERSONA, {
        mode: 'fts5',
        text: queryText,
        limit: VAULT_CONTEXT_MAX_ITEMS,
      });
      for (const item of results) {
        if (contextItems.length >= VAULT_CONTEXT_MAX_ITEMS) break;
        const raw = item.content_l0 || item.summary || '';
        if (raw === '') continue;
        // Truncate to match Python's 150-char per-item cap. Long
        // summaries (full email bodies, multi-paragraph notes)
        // would otherwise blow the prompt budget on a single item.
        const line = raw.slice(0, VAULT_CONTEXT_LINE_MAX_CHARS);
        if (!contextItems.includes(line)) {
          contextItems.push(line);
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
  }

  // No sender hint AND no vault context → preserve the legacy
  // sentinel string so callers/tests detecting "no context" still
  // see it.
  if (senderHint === null && contextItems.length === 0) {
    return { text: '(no related context found)', itemCount: 0 };
  }

  const lines: string[] = [];
  if (senderHint !== null) {
    const relationshipSuffix =
      senderHint.relationshipHint !== '' ? ` (${senderHint.relationshipHint})` : '';
    lines.push(`Sender: ${senderHint.displayName}${relationshipSuffix}`);
  }
  for (const c of contextItems) {
    lines.push(`- ${c}`);
  }
  return { text: lines.join('\n'), itemCount: contextItems.length };
}

interface SenderHint {
  displayName: string;
  relationshipHint: string;
  /** Confirmed surface forms (name + nicknames + role phrases),
   *  whitespace-trimmed. Used as keyword expansions for the FTS
   *  search — NOT for prompt rendering. */
  surfaces: string[];
}

/**
 * Resolve the inbound sender DID to a `SenderHint` for the prompt
 * + keyword expansion. Returns `null` when:
 *   - no `senderDid` was supplied,
 *   - the people-graph repo isn't registered (mobile boot path that
 *     hasn't wired one yet — fail-soft, planner runs as before),
 *   - the DID isn't bound to a person yet,
 *   - or the resolver couldn't compute a usable display name (every
 *     surface is suggested + canonical_name is empty).
 *
 * Constructs a fresh `RepositoryPersonResolver` per call. The
 * resolver is stateless — it only wraps the repo's read methods —
 * so caching it would just keep a stale repo handle alive across
 * tests that swap the singleton.
 */
function resolveSenderHint(senderDid?: string): SenderHint | null {
  if (typeof senderDid !== 'string' || senderDid === '') return null;
  const repo = getPeopleRepository();
  if (repo === null) return null;
  const resolver: PersonResolver = new RepositoryPersonResolver(repo);
  const person: ResolvedPerson | null = resolver.resolveByDID(senderDid);
  if (person === null) return null;
  const displayName = resolver.displayName(senderDid);
  if (displayName === null) return null;
  const surfaces: string[] = [];
  for (const s of person.surfaces) {
    const trimmed = s.surface.trim();
    if (trimmed === '') continue;
    if (!surfaces.includes(trimmed)) surfaces.push(trimmed);
  }
  return {
    displayName,
    relationshipHint: person.relationshipHint,
    surfaces,
  };
}


/**
 * Render the REMINDER_PLAN prompt template with all variables.
 *
 * The LLM receives **two** representations of "now":
 *   - `{{now_local}}` — wall-clock string in the user's timezone
 *     ("Tuesday, April 28, 2026 at 12:35 PM IST"). Human-readable so
 *     the model can reason about "today / tomorrow / tonight" without
 *     timezone math.
 *   - `{{now_ms}}` — Unix milliseconds. Used for offset arithmetic
 *     ("in 15 minutes" → due_at = {{now_ms}} + 15 * 60000) and as
 *     the strict-ordering reference for the past-event filter.
 *
 * Earlier versions passed only `{{today}}` as a UTC ISO string. The
 * model conflated "after today" with "after today's date" and rolled
 * "in 15 minutes" forward by a full day — see April 2026 simulator
 * regression where the Sancho-arrival e2e produced a Tomorrow-noon
 * reminder. Forcing the LLM to compute against `{{now_ms}}` rather
 * than parse a date-string moved the bug surface from "model timezone
 * math" to "deterministic JS arithmetic" (which we already trust).
 */
function renderReminderPrompt(
  input: PlannerInput,
  vaultContext: string,
  resolvedTimezone: string,
): string {
  const nowMs = Date.now();
  const nowLocal = formatNowInTimezone(nowMs, resolvedTimezone);
  // The now_ms value goes into the prompt with underscore separators
  // (e.g. `1_745_837_100_000`) for two reasons:
  //   1. The PII scrubber's phone regexes match long bare digit runs
  //      and would assign `[PHONE_1]` to the timestamp, pushing the
  //      user's actual phone to `[PHONE_2]` — which broke
  //      reminder-planner's PII rehydration test on the simulator
  //      (`Call [PHONE_1] …` came back resolved against the timestamp,
  //      not against `555-444-3333`). Underscores break the digit run
  //      and the regexes never match.
  //   2. Most LLMs handle `1_745_837_100_000` and `1745837100000`
  //      interchangeably (Python-style numeric literal). The prompt
  //      tells the model to strip underscores before arithmetic, so
  //      `due_at = NOW_MS + N * 60000` still resolves to a clean
  //      number even when the model echoes the underscored form.
  const nowMsGrouped = groupDigitsForPrompt(nowMs);
  // `{{now_ms_grouped}}` and `{{timezone}}` appear multiple times in
  // the prompt — `replaceAll` ensures every occurrence is substituted.
  // Single-occurrence placeholders (`{{subject}}`, `{{body}}`,
  // `{{now_local}}`, `{{vault_context}}`) stay on `replace` so a
  // stray `{{` inside user input can't trigger surprise expansion.
  return REMINDER_PLAN.replace('{{subject}}', input.summary)
    .replace('{{body}}', input.body.slice(0, 4000))
    .replace('{{now_local}}', nowLocal)
    .replaceAll('{{now_ms_grouped}}', nowMsGrouped)
    .replaceAll('{{timezone}}', resolvedTimezone)
    .replace('{{vault_context}}', vaultContext);
}

/**
 * Group a positive integer into `1_234_567` form. Used to keep long
 * Unix-ms values in the prompt out of the PII phone-number regex's
 * jaws — see comment on the call site for the failure mode this
 * fixes. We use underscores (Python / JavaScript numeric-literal
 * style) instead of commas so the LLM's "strip underscores before
 * arithmetic" hint doesn't conflict with anything else.
 */
function groupDigitsForPrompt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

/**
 * Format "now" as a human-readable wall-clock string in the user's
 * timezone, e.g. "Tuesday, April 28, 2026 at 12:35 PM IST". Falls
 * back to ISO when `Intl.DateTimeFormat` rejects the timezone (zero
 * recovery cost — every modern runtime ships Intl, but the fallback
 * keeps us correct on a stripped-down environment rather than throwing).
 */
function formatNowInTimezone(nowMs: number, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: tz,
    });
    return fmt.format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString();
  }
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
