/**
 * Task 5.41 — reminder planner.
 *
 * When the classification pipeline flags `has_event=true` (an email /
 * message / transcript mentions a dated commitment), this module
 * plans a small set of reminders with absolute trigger timestamps.
 * Mirrors the Python reference `brain/src/service/reminder_planner.py`:
 * LLM decides how many reminders, what text, what lead-time — no
 * hardcoded birthday / appointment / payment templates.
 *
 * **Separation of concerns** (why this is a primitive and NOT a
 * service that writes to Core):
 *
 *   - The planner's contract is *pure*: take content + now + an LLM
 *     call + an optional vault-context gatherer → return a
 *     `ReminderPlan` with validated items.
 *   - Writing reminders to Core is the caller's job. The caller
 *     (typically the reasoning handler behind `POST /api/v1/process`)
 *     threads persistence, idempotency keys, + per-persona scoping
 *     that the planner doesn't want to know about.
 *   - Tests can exercise planning logic without any HTTP / SQLite
 *     wiring.
 *
 * **Validation the planner enforces** (pinned by tests):
 *   - LLM must return JSON matching `{reminders: [{fire_at, message, kind?}], summary?}`.
 *     Anything else → `{ok: false, reason: 'parse_failed'}`.
 *   - Each `fire_at` must be ISO-8601 with a timezone. Naive strings
 *     are rejected (silence bugs from tz-less LLM output).
 *   - Past reminders (fire_at <= now) are dropped *silently* — they
 *     aren't errors, they're useless.
 *   - Empty-message reminders + reminders with a future fire_at but
 *     `message=''` are dropped.
 *   - `maxReminders` caps the plan — defaults to 5; overflow is
 *     dropped (keep the earliest firing times).
 *
 * **LLM call is injected** (`planCallFn`): production wires this to
 * the ModelRouter (task 5.24) → ProviderAdapter (task 5.22); tests
 * pass a scripted stub. The planner doesn't know whether the call
 * hits Anthropic or a local llama — that's the router's job.
 *
 * **Vault-context gatherer is optional.** When present, the planner
 * extracts candidate search terms from the content (proper nouns
 * first, stop-words stripped) + asks the gatherer for a small list
 * of context snippets. These feed the LLM prompt but do NOT affect
 * validation — a planner with no gatherer is fully functional.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.41.
 */

/** Allow-list of English stopwords — mirrors the Python reference. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'do', 'does', 'did', 'has', 'have', 'had', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'and', 'but', 'or', 'nor', 'not', 'no', 'so', 'if', 'then',
  'than', 'that', 'this', 'these', 'those', 'it', 'its',
  'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'from',
  'up', 'out', 'off', 'over', 'into', 'onto', 'upon',
  'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my', 'mine',
  'your', 'yours', 'his', 'her', 'our', 'their', 'them',
  'who', 'what', 'when', 'where', 'how', 'which', 'whom',
  'about', 'after', 'before', 'between', 'through', 'during',
]);

export interface PlannedReminder {
  /** Wall-clock UTC ms when the reminder should fire. */
  fireAtMs: number;
  /** Original ISO-8601 string the LLM emitted — preserved for audit. */
  fireAtIso: string;
  /** User-visible reminder text. */
  message: string;
  /** Free-form category hint (e.g. "appointment", "birthday"). Defaults to "reminder". */
  kind: string;
}

export interface ReminderPlan {
  reminders: PlannedReminder[];
  /** Human-friendly one-liner the UI renders ("2 reminders set for Thursday"). */
  summary: string;
}

/** LLM planner call. Returns the raw content string the LLM produced. */
export type LlmPlanCallFn = (
  prompt: string,
) => Promise<{ content: string }>;

/** Optional vault-context gatherer. Returns short snippets (≤5, each ≤150 chars). */
export type VaultContextGatherFn = (
  searchTerms: string[],
) => Promise<string[]>;

export type ReminderPlanRejection =
  | { ok: false; reason: 'llm_failed'; error: string }
  | { ok: false; reason: 'parse_failed'; detail: string }
  | { ok: false; reason: 'invalid_input'; detail: string };

export type PlanResult =
  | ({ ok: true } & ReminderPlan)
  | ReminderPlanRejection;

export type ReminderPlannerEvent =
  | { kind: 'plan_requested'; termCount: number }
  | { kind: 'vault_context_fetched'; itemCount: number }
  | { kind: 'plan_succeeded'; reminderCount: number; droppedPast: number; droppedOverflow: number }
  | { kind: 'plan_failed'; reason: ReminderPlanRejection['reason']; detail?: string };

export interface ReminderPlannerOptions {
  planCallFn: LlmPlanCallFn;
  /** Optional — when present, vault snippets are threaded into the LLM prompt. */
  gatherVaultContextFn?: VaultContextGatherFn;
  /** Defaults to 5. */
  maxReminders?: number;
  /** Defaults to 5. */
  maxVaultSnippets?: number;
  /** Defaults to 5. */
  maxSearchTerms?: number;
  /** Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Used in the prompt so the LLM knows the user's timezone name.
   * Defaults to 'UTC'. Does NOT affect validation — validation works
   * on absolute UTC ms.
   */
  timezoneName?: string;
  /** Diagnostic hook. */
  onEvent?: (event: ReminderPlannerEvent) => void;
}

export const DEFAULT_MAX_REMINDERS = 5;
export const DEFAULT_MAX_VAULT_SNIPPETS = 5;
export const DEFAULT_MAX_SEARCH_TERMS = 5;

export class ReminderPlanner {
  private readonly planCallFn: LlmPlanCallFn;
  private readonly gatherVaultContextFn?: VaultContextGatherFn;
  private readonly maxReminders: number;
  private readonly maxVaultSnippets: number;
  private readonly maxSearchTerms: number;
  private readonly nowMsFn: () => number;
  private readonly timezoneName: string;
  private readonly onEvent?: (event: ReminderPlannerEvent) => void;

  constructor(opts: ReminderPlannerOptions) {
    if (typeof opts.planCallFn !== 'function') {
      throw new Error('ReminderPlanner: planCallFn is required');
    }
    this.planCallFn = opts.planCallFn;
    if (opts.gatherVaultContextFn !== undefined) {
      this.gatherVaultContextFn = opts.gatherVaultContextFn;
    }
    this.maxReminders = opts.maxReminders ?? DEFAULT_MAX_REMINDERS;
    this.maxVaultSnippets = opts.maxVaultSnippets ?? DEFAULT_MAX_VAULT_SNIPPETS;
    this.maxSearchTerms = opts.maxSearchTerms ?? DEFAULT_MAX_SEARCH_TERMS;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.timezoneName = opts.timezoneName ?? 'UTC';
    this.onEvent = opts.onEvent;
    if (this.maxReminders <= 0) {
      throw new Error('ReminderPlanner: maxReminders must be > 0');
    }
  }

  /**
   * Plan reminders for a temporal event. Returns a validated
   * `ReminderPlan` on success (possibly with zero reminders if all
   * LLM-emitted items were past or malformed) or a rejection reason.
   *
   * Never throws — all failure modes are structured so the caller
   * can decide policy (retry with a bigger model? fall back to
   * manual-entry flow? skip silently?).
   */
  async plan(input: {
    content: string;
    eventHint: string;
  }): Promise<PlanResult> {
    if (typeof input.content !== 'string' || input.content.trim() === '') {
      this.emit({ kind: 'plan_failed', reason: 'invalid_input', detail: 'content is empty' });
      return { ok: false, reason: 'invalid_input', detail: 'content is empty' };
    }
    const eventHint = typeof input.eventHint === 'string' ? input.eventHint : '';

    const terms = this.extractSearchTerms(input.content, eventHint);
    this.emit({ kind: 'plan_requested', termCount: terms.length });

    let vaultSnippets: string[] = [];
    if (this.gatherVaultContextFn && terms.length > 0) {
      try {
        const raw = await this.gatherVaultContextFn(terms);
        vaultSnippets = Array.isArray(raw)
          ? raw
              .filter((s): s is string => typeof s === 'string' && s.length > 0)
              .slice(0, this.maxVaultSnippets)
              .map((s) => s.slice(0, 150))
          : [];
        this.emit({ kind: 'vault_context_fetched', itemCount: vaultSnippets.length });
      } catch {
        // Vault gather is best-effort — never block planning on it.
        vaultSnippets = [];
      }
    }

    const nowMs = this.nowMsFn();
    const nowIso = new Date(nowMs).toISOString();
    const prompt = this.buildPrompt(input.content, vaultSnippets, nowIso);

    let rawContent: string;
    try {
      const resp = await this.planCallFn(prompt);
      rawContent = typeof resp?.content === 'string' ? resp.content : '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'plan_failed', reason: 'llm_failed', detail: msg });
      return { ok: false, reason: 'llm_failed', error: msg };
    }

    const parsed = parseLlmJson(rawContent);
    if (parsed === null) {
      this.emit({
        kind: 'plan_failed',
        reason: 'parse_failed',
        detail: rawContent.slice(0, 80),
      });
      return {
        ok: false,
        reason: 'parse_failed',
        detail: `LLM did not return valid JSON: ${rawContent.slice(0, 80)}`,
      };
    }

    const rawReminders = Array.isArray(parsed.reminders) ? parsed.reminders : [];
    const { reminders, droppedPast } = this.validateAndNormalise(rawReminders, nowMs);
    const droppedOverflow = Math.max(0, reminders.length - this.maxReminders);
    const capped = reminders.slice(0, this.maxReminders);
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.length > 0
        ? parsed.summary
        : capped.length === 0
          ? 'No reminders set.'
          : capped.length === 1
            ? '1 reminder set.'
            : `${capped.length} reminders set.`;

    this.emit({
      kind: 'plan_succeeded',
      reminderCount: capped.length,
      droppedPast,
      droppedOverflow,
    });
    return { ok: true, reminders: capped, summary };
  }

  /**
   * Extract a de-duplicated, proper-noun-prioritised list of search
   * terms from `content + eventHint`. Exposed for tests + debug
   * tooling — not part of the main `plan()` contract.
   */
  extractSearchTerms(content: string, eventHint: string): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    const text = `${eventHint} ${content}`;
    for (const raw of text.split(/\s+/)) {
      let word = raw.replace(/^[.,!?;:'"()[\]{}#@]+|[.,!?;:'"()[\]{}#@]+$/g, '');
      // Strip ASCII + Unicode possessives.
      if (word.endsWith("'s") || word.endsWith('’s')) {
        word = word.slice(0, -2);
      }
      if (word.length <= 2) continue;
      if (STOP_WORDS.has(word.toLowerCase())) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      ordered.push(word);
    }
    // Stable sort: proper nouns (uppercase-first) before lowercase.
    ordered.sort((a, b) => {
      const aUpper = a[0]! === a[0]!.toUpperCase();
      const bUpper = b[0]! === b[0]!.toUpperCase();
      if (aUpper === bUpper) return 0;
      return aUpper ? -1 : 1;
    });
    return ordered.slice(0, this.maxSearchTerms);
  }

  private buildPrompt(
    content: string,
    vaultSnippets: string[],
    nowIso: string,
  ): string {
    const vaultBlock =
      vaultSnippets.length > 0
        ? `Relevant context from the user's vault:\n${vaultSnippets.map((s) => `- ${s}`).join('\n')}`
        : 'No additional vault context available.';
    return [
      `You are a personal reminder planner. Current time (UTC): ${nowIso}. User timezone: ${this.timezoneName}.`,
      `Plan up to ${this.maxReminders} reminders for the event described below.`,
      'Respond with JSON ONLY in the shape {"reminders":[{"fire_at":"<ISO-8601 with TZ>","message":"<short>","kind":"<category>"}],"summary":"<one-line>"}.',
      `Message:\n${content}`,
      vaultBlock,
    ].join('\n\n');
  }

  private validateAndNormalise(
    rawReminders: unknown[],
    nowMs: number,
  ): { reminders: PlannedReminder[]; droppedPast: number } {
    const out: PlannedReminder[] = [];
    let droppedPast = 0;
    for (const item of rawReminders) {
      if (item === null || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const fireAtIso = typeof rec['fire_at'] === 'string' ? rec['fire_at'].trim() : '';
      const message =
        typeof rec['message'] === 'string' ? rec['message'].trim() : '';
      const kind =
        typeof rec['kind'] === 'string' && rec['kind'].trim().length > 0
          ? rec['kind'].trim()
          : 'reminder';
      if (fireAtIso === '' || message === '') continue;
      if (!hasTimezoneSuffix(fireAtIso)) continue;
      const parsedMs = Date.parse(fireAtIso);
      if (Number.isNaN(parsedMs)) continue;
      if (parsedMs <= nowMs) {
        droppedPast += 1;
        continue;
      }
      out.push({ fireAtMs: parsedMs, fireAtIso, message, kind });
    }
    // Sort earliest-first so the overflow-cap drops the LATEST items.
    out.sort((a, b) => a.fireAtMs - b.fireAtMs);
    return { reminders: out, droppedPast };
  }

  private emit(event: ReminderPlannerEvent): void {
    this.onEvent?.(event);
  }
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * ISO-8601 strings without a timezone (e.g. "2026-04-22T15:30:00")
 * are ambiguous — we reject them rather than assume a tz. Accept
 * either `Z` or a `±HH:MM` / `±HHMM` suffix.
 */
function hasTimezoneSuffix(iso: string): boolean {
  if (iso.endsWith('Z')) return true;
  return /[+-]\d{2}:?\d{2}$/.test(iso);
}

/**
 * Strip ```json fences and parse. Returns `null` on malformed input.
 */
function parseLlmJson(raw: string): { reminders?: unknown; summary?: unknown } | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.startsWith('```')) {
    const afterOpen = text.indexOf('\n');
    if (afterOpen === -1) return null;
    text = text.slice(afterOpen + 1);
    const closeIdx = text.lastIndexOf('```');
    if (closeIdx !== -1) text = text.slice(0, closeIdx);
    text = text.trim();
  }
  try {
    const parsed = JSON.parse(text);
    // Must be a plain object — arrays + primitives aren't the schema
    // we asked the LLM for, so treat them as parse failures rather
    // than silently returning zero reminders.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as { reminders?: unknown; summary?: unknown };
  } catch {
    return null;
  }
}
