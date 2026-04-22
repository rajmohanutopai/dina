/**
 * Task 5.44 — persona selector.
 *
 * Decides which persona(s) a captured item belongs to. Never invents
 * persona names — the LLM is given the actual installed set (from
 * PersonaRegistry) and told to pick among those.
 *
 * **Resolution order**:
 *   1. Explicit valid `personaHint` → use directly (confidence=1.0).
 *   2. LLM selection — constrained to installed personas.
 *   3. Validate — drop anything not in registry.
 *   4. Return `null` if no confident answer — caller uses its
 *      deterministic fallback (typically "default persona").
 *
 * **Never throws**: every failure path produces a structured result
 * or `null`. LLM errors are swallowed + logged via `onEvent`.
 *
 * **Pluggable LLM**: the selector takes an `llmSelectFn` — the
 * caller wires this to ModelRouter with the constrained-JSON schema
 * from `prompts/persona_classify`. Tests pass scripted stubs.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.44.
 */

import type { PersonaRegistry } from './persona_registry';

export interface SelectableItem {
  type?: string;
  source?: string;
  sender?: string;
  summary?: string;
  body?: string;
  mentionedContacts?: string[];
  attributionCandidates?: unknown;
}

export interface SelectionResult {
  primary: string | null;
  secondary: string[];
  /** 0..1 — how confident the selector is. 1.0 for explicit hints. */
  confidence: number;
  reason: string;
  hasEvent: boolean;
  eventHint: string;
}

/**
 * Raw LLM response shape. Caller validates each field; `null` or
 * garbage collapses to "no confident answer".
 */
export interface PersonaLlmResponse {
  primary?: string;
  secondary?: string[];
  confidence?: number;
  reason?: string;
  has_event?: boolean;
  event_hint?: string;
}

/**
 * LLM call. Takes an item-context payload + the list of valid
 * persona names + tiers. Returns a structured response or throws.
 */
export type PersonaLlmSelectFn = (ctx: {
  availablePersonas: Array<{ name: string; tier: string; description?: string }>;
  item: SelectableItem;
}) => Promise<PersonaLlmResponse>;

export type PersonaSelectorEvent =
  | { kind: 'explicit_hint'; persona: string }
  | { kind: 'llm_selected'; primary: string; secondary: string[]; confidence: number }
  | { kind: 'llm_failed'; error: string }
  | { kind: 'invalid_primary'; primary: string; available: string[] }
  | { kind: 'no_confident_answer' };

export interface PersonaSelectorOptions {
  registry: PersonaRegistry;
  /** Optional LLM. When absent, only the explicit-hint path runs. */
  llmSelectFn?: PersonaLlmSelectFn;
  /** Diagnostic hook. */
  onEvent?: (event: PersonaSelectorEvent) => void;
}

export class PersonaSelector {
  private readonly registry: PersonaRegistry;
  private readonly llmSelectFn?: PersonaLlmSelectFn;
  private readonly onEvent?: (event: PersonaSelectorEvent) => void;

  constructor(opts: PersonaSelectorOptions) {
    if (!opts.registry) {
      throw new TypeError('PersonaSelector: registry is required');
    }
    this.registry = opts.registry;
    if (opts.llmSelectFn) this.llmSelectFn = opts.llmSelectFn;
    this.onEvent = opts.onEvent;
  }

  /**
   * Select a persona for `item`. Returns `null` when no confident
   * answer is available — the caller then falls back to the default
   * persona (usually "general").
   */
  async select(
    item: SelectableItem,
    personaHint?: string | null,
  ): Promise<SelectionResult | null> {
    // 1. Explicit valid hint wins.
    if (typeof personaHint === 'string' && personaHint.length > 0) {
      const normalised = this.registry.normalize(personaHint);
      if (this.registry.exists(normalised)) {
        this.emit({ kind: 'explicit_hint', persona: normalised });
        return {
          primary: normalised,
          secondary: [],
          confidence: 1.0,
          reason: 'explicit persona hint',
          hasEvent: false,
          eventHint: '',
        };
      }
    }

    // 2. LLM selection.
    if (!this.llmSelectFn) {
      this.emit({ kind: 'no_confident_answer' });
      return null;
    }

    const names = this.registry.allNames();
    if (names.length === 0) {
      this.emit({ kind: 'no_confident_answer' });
      return null;
    }

    const availablePersonas = names.map((name) => {
      const description = this.registry.description(name);
      const entry: { name: string; tier: string; description?: string } = {
        name,
        tier: this.registry.tier(name) ?? 'default',
      };
      if (description.length > 0) entry.description = description;
      return entry;
    });

    let raw: PersonaLlmResponse;
    try {
      raw = await this.llmSelectFn({ availablePersonas, item: trimItem(item) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'llm_failed', error: msg });
      return null;
    }

    return this.validateResponse(raw);
  }

  private validateResponse(raw: PersonaLlmResponse): SelectionResult | null {
    if (!raw || typeof raw !== 'object') {
      this.emit({ kind: 'no_confident_answer' });
      return null;
    }
    const primaryRaw = typeof raw.primary === 'string' ? raw.primary.trim() : '';
    if (primaryRaw === '') {
      this.emit({ kind: 'no_confident_answer' });
      return null;
    }
    const primary = this.registry.normalize(primaryRaw);
    if (!this.registry.exists(primary)) {
      this.emit({
        kind: 'invalid_primary',
        primary: primaryRaw,
        available: this.registry.allNames(),
      });
      return null;
    }

    const secondaryIn = Array.isArray(raw.secondary) ? raw.secondary : [];
    const secondary: string[] = [];
    const seen = new Set<string>([primary]);
    for (const s of secondaryIn) {
      if (typeof s !== 'string') continue;
      const norm = this.registry.normalize(s.trim());
      if (norm === '' || seen.has(norm)) continue;
      if (!this.registry.exists(norm)) continue;
      secondary.push(norm);
      seen.add(norm);
    }

    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? clamp01(raw.confidence)
        : 0;
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    const hasEvent = raw.has_event === true;
    const eventHint = typeof raw.event_hint === 'string' ? raw.event_hint : '';

    this.emit({
      kind: 'llm_selected',
      primary,
      secondary,
      confidence,
    });
    return { primary, secondary, confidence, reason, hasEvent, eventHint };
  }

  private emit(event: PersonaSelectorEvent): void {
    this.onEvent?.(event);
  }
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Trim `item` to its LLM-relevant essentials — keeps the prompt
 * short + prevents accidentally spilling long body content through
 * the selector. Body + summary are truncated to Python-reference
 * sizes (200/300 chars).
 */
function trimItem(item: SelectableItem): SelectableItem {
  const out: SelectableItem = {};
  if (item.type) out.type = item.type;
  if (item.source) out.source = item.source;
  if (item.sender) out.sender = item.sender;
  if (typeof item.summary === 'string' && item.summary.length > 0) {
    out.summary = item.summary.slice(0, 200);
  }
  if (typeof item.body === 'string' && item.body.length > 0) {
    out.body = item.body.slice(0, 300);
  }
  if (Array.isArray(item.mentionedContacts) && item.mentionedContacts.length > 0) {
    out.mentionedContacts = [...item.mentionedContacts];
  }
  if (item.attributionCandidates !== undefined) {
    out.attributionCandidates = item.attributionCandidates;
  }
  return out;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
