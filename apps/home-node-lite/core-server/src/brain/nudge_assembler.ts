/**
 * Task 5.39 — nudge assembly.
 *
 * When the user opens a conversation with a contact, the nudge
 * assembler pulls relevant context from the vault + asks the LLM to
 * summarise it into a one-shot "here's what you should remember"
 * card. Zero relevant context → zero nudge (Silence First: never
 * interrupt without value).
 *
 * **Inputs** (pluggable — pure primitive):
 *   - `contactDid` — who the user is about to talk to.
 *   - `contextGatherFn` — fetches structured context snippets from
 *     the vault (recent messages, relationship notes, open promises,
 *     upcoming calendar events). Caller wires to Core's search API.
 *   - `llmSummariseFn` — takes the gathered context + returns a
 *     short summary string. Caller wires to ModelRouter.
 *
 * **Outputs**: `NudgeResult` with `message` + `kind` + `priority` +
 * `sourceItemIds`. Priority is `solicited` by default (the user
 * initiated the conversation) and upgrades to `fiduciary` when a
 * pending promise is detected with an explicit deadline mentioned.
 *
 * **Pending-promise detection** — regex over message text. Common
 * phrasings: "I'll send the PDF", "I'll share the deck tomorrow",
 * "let me forward you the link", "remind me to send". Catches the
 * obvious cases + feeds them into the summary as a high-salience
 * signal.
 *
 * **Pure + synchronous over the context gather + LLM steps**. The
 * assembler is stateless — same contactDid + same context → same
 * nudge.
 *
 * **Persona-safety**: the `contextGatherFn` is responsible for
 * honouring persona boundaries. The assembler doesn't reach across
 * compartments itself; it just consumes what the gatherer yields.
 * Locked personas' data is simply absent from the gathered context.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.39.
 */

import type { NotifyPriority } from './priority';

/**
 * Nudge priorities unify with `NotifyPriority` (task 5.48). The
 * nudge assembler classifies the nudge so the downstream dispatcher
 * knows how to deliver it; the classification scheme is identical
 * to the notify dispatcher's, so we alias rather than duplicate.
 */
export type NudgePriority = NotifyPriority;
export type NudgeKind =
  | 'no_context'
  | 'recent_chat'
  | 'pending_promise'
  | 'upcoming_event';

export interface ContextSnippet {
  /** Short text snippet (≤ 200 chars typical). */
  text: string;
  /** Vault item id the snippet came from (for source attribution). */
  itemId?: string;
  /** Timestamp (ms) of the vault item — newer first when pre-sorted. */
  capturedAtMs?: number;
  /** Optional hint: `message` / `note` / `event` / `contact_card`. */
  category?: 'message' | 'note' | 'event' | 'contact_card';
  /** Optional persona the item was captured into. */
  persona?: string;
}

export interface NudgeResult {
  /** Short human-readable summary, ready to show in the UI. */
  message: string;
  kind: NudgeKind;
  priority: NudgePriority;
  /** Vault item ids that fed the summary — for audit + deep-linking. */
  sourceItemIds: string[];
  /**
   * True when the assembler found a pending promise in the context.
   * Promotes priority to `fiduciary` (silence would cause harm).
   */
  hasPendingPromise: boolean;
}

export type ContextGatherFn = (
  contactDid: string,
) => Promise<ContextSnippet[]>;

export type LlmSummariseFn = (prompt: string) => Promise<{ content: string }>;

export interface NudgeAssemblerOptions {
  contextGatherFn: ContextGatherFn;
  llmSummariseFn: LlmSummariseFn;
  /** Cap on snippets handed to the LLM. Defaults to 8. */
  maxSnippets?: number;
  /** Max length of the assembled nudge message. Defaults to 280 chars. */
  maxMessageLength?: number;
  /** Diagnostic hook. */
  onEvent?: (event: NudgeAssemblerEvent) => void;
}

export type NudgeAssemblerEvent =
  | { kind: 'gather_failed'; error: string }
  | { kind: 'no_context'; contactDid: string }
  | { kind: 'llm_failed'; error: string }
  | { kind: 'summary_empty' }
  | { kind: 'assembled'; priority: NudgePriority; snippetCount: number; hasPendingPromise: boolean };

export const DEFAULT_MAX_SNIPPETS = 8;
export const DEFAULT_MAX_MESSAGE_LENGTH = 280;

/**
 * Matches "I'll send", "I will share", "I'll forward", "I'll get
 * back", "let me send", "remind me to send". Keep this pattern
 * conservative — false positives yield spurious fiduciary nudges
 * that the user must actively dismiss.
 */
const PROMISE_RE =
  /\b(?:I(?:['’]ll|\s+will)\s+(?:send|share|forward|get\s+back)|let\s+me\s+(?:send|share|forward)|remind\s+me\s+to\s+(?:send|share|forward))\b/i;

/** Detects a rough deadline hint ("tomorrow", "tonight", "this week"). */
const DEADLINE_RE =
  /\b(?:tomorrow|tonight|this\s+(?:week|evening|afternoon|morning)|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by\s+(?:tomorrow|monday|tuesday|wednesday|thursday|friday|eod|end\s+of\s+day))\b/i;

export class NudgeAssembler {
  private readonly contextGatherFn: ContextGatherFn;
  private readonly llmSummariseFn: LlmSummariseFn;
  private readonly maxSnippets: number;
  private readonly maxMessageLength: number;
  private readonly onEvent?: (event: NudgeAssemblerEvent) => void;

  constructor(opts: NudgeAssemblerOptions) {
    if (typeof opts.contextGatherFn !== 'function') {
      throw new TypeError('NudgeAssembler: contextGatherFn is required');
    }
    if (typeof opts.llmSummariseFn !== 'function') {
      throw new TypeError('NudgeAssembler: llmSummariseFn is required');
    }
    this.contextGatherFn = opts.contextGatherFn;
    this.llmSummariseFn = opts.llmSummariseFn;
    this.maxSnippets = opts.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
    this.maxMessageLength = opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    this.onEvent = opts.onEvent;
  }

  /**
   * Assemble a nudge for `contactDid`. Returns `null` when no
   * usable context exists — the caller should NOT push an empty
   * nudge to the user (Silence First).
   */
  async assemble(contactDid: string): Promise<NudgeResult | null> {
    if (typeof contactDid !== 'string' || contactDid === '') {
      return null;
    }

    let snippets: ContextSnippet[];
    try {
      snippets = (await this.contextGatherFn(contactDid)) ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'gather_failed', error: msg });
      return null;
    }

    // Filter out empty / malformed snippets + cap to maxSnippets.
    const usable: ContextSnippet[] = [];
    for (const s of snippets) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.text !== 'string' || s.text.trim() === '') continue;
      usable.push(s);
      if (usable.length >= this.maxSnippets) break;
    }

    if (usable.length === 0) {
      this.emit({ kind: 'no_context', contactDid });
      return null;
    }

    const hasPendingPromise = usable.some((s) => PROMISE_RE.test(s.text));
    const promiseHasDeadline = usable.some(
      (s) => PROMISE_RE.test(s.text) && DEADLINE_RE.test(s.text),
    );
    const hasUpcomingEvent = usable.some((s) => s.category === 'event');

    const prompt = buildPrompt(contactDid, usable);
    let rawContent: string;
    try {
      const resp = await this.llmSummariseFn(prompt);
      rawContent = typeof resp?.content === 'string' ? resp.content : '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'llm_failed', error: msg });
      return null;
    }
    const message = rawContent.trim().slice(0, this.maxMessageLength);
    if (message === '') {
      this.emit({ kind: 'summary_empty' });
      return null;
    }

    const kind: NudgeKind = hasPendingPromise
      ? 'pending_promise'
      : hasUpcomingEvent
        ? 'upcoming_event'
        : 'recent_chat';
    // Pending promise WITH an explicit deadline is fiduciary (likely
    // to cause harm if missed). A promise without a deadline is
    // still solicited — user-initiated conversation.
    const priority: NudgePriority = promiseHasDeadline ? 'fiduciary' : 'solicited';
    const sourceItemIds = usable
      .map((s) => s.itemId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const result: NudgeResult = {
      message,
      kind,
      priority,
      sourceItemIds,
      hasPendingPromise,
    };
    this.emit({
      kind: 'assembled',
      priority,
      snippetCount: usable.length,
      hasPendingPromise,
    });
    return result;
  }

  private emit(event: NudgeAssemblerEvent): void {
    this.onEvent?.(event);
  }
}

function buildPrompt(contactDid: string, snippets: ContextSnippet[]): string {
  const lines: string[] = [
    'Summarise the following context into a one-line nudge for the',
    `user who is about to message ${contactDid}. Mention any pending`,
    'promises or upcoming events. Be concise — under 200 characters.',
    '',
    'Context:',
  ];
  for (const s of snippets) {
    const cat = s.category ?? 'note';
    lines.push(`- [${cat}] ${s.text.slice(0, 200)}`);
  }
  lines.push('');
  lines.push('Nudge:');
  return lines.join('\n');
}
