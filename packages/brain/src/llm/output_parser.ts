/**
 * Structured output parser — validate LLM JSON against known schemas.
 *
 * LLMs sometimes return malformed JSON, markdown-fenced output, trailing
 * text, or partial structures. This parser handles all of those cases
 * and returns type-safe results with fallback defaults.
 *
 * Supported schemas:
 *   - classification: { persona, confidence, reason }
 *   - enrichment: { content_l1, tags, has_event }
 *   - reminder_plan: { reminders: [{ message, due_at, kind }] }
 *   - silence: { priority, reason, confidence }
 *
 * Source: ARCHITECTURE.md Task 3.9
 */

// ---------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------

export interface ClassificationOutput {
  persona: string;
  confidence: number;
  reason: string;
}

export interface EnrichmentOutput {
  content_l1: string;
  tags: string[];
  has_event: boolean;
}

export interface ReminderPlanOutput {
  reminders: Array<{
    message: string;
    due_at: number;
    kind: string;
  }>;
}

export interface SilenceOutput {
  priority: 1 | 2 | 3;
  reason: string;
  confidence: number;
}

// ---------------------------------------------------------------
// Defaults for each schema (used when fields are missing)
// ---------------------------------------------------------------

const CLASSIFICATION_DEFAULT: ClassificationOutput = {
  persona: 'general',
  confidence: 0,
  reason: 'parse_fallback',
};

const ENRICHMENT_DEFAULT: EnrichmentOutput = {
  content_l1: '',
  tags: [],
  has_event: false,
};

const REMINDER_PLAN_DEFAULT: ReminderPlanOutput = {
  reminders: [],
};

const SILENCE_DEFAULT: SilenceOutput = {
  priority: 3,
  reason: 'parse_fallback',
  confidence: 0,
};

// ---------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------

/**
 * Extract JSON from LLM output.
 *
 * Handles: raw JSON, markdown-fenced (```json ... ```),
 * JSON embedded in surrounding text, and trailing garbage.
 */
export function extractJSON(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return null;

  let text = raw.trim();

  // Strip markdown fences
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?\s*```\s*$/, '')
      .trim();
  }

  // Try direct parse first
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* fall through to extraction */
  }

  // Try to find JSON object in the text
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const extracted = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(extracted);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      /* no valid JSON found */
    }
  }

  return null;
}

/**
 * Clean a free-form list of string items returned by an LLM. Used by
 * `topic_extractor` and `intent_classifier` (shared helper per the
 * Python port's `_sanitise_list`).
 *
 * Rules (matching Python):
 *   - Drop non-strings.
 *   - Trim whitespace; drop empties.
 *   - Drop items longer than 80 chars (defensive against LLM spam).
 *   - Dedup case-insensitively, preserving first-seen casing.
 *   - Cap at `max` items after dedup.
 */
export function sanitiseList(items: unknown, max: number): string[] {
  if (!Array.isArray(items) || max <= 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (v === '' || v.length > 80) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------
// Schema-specific parsers
// ---------------------------------------------------------------

/** Parse classification output. Returns default on failure. */
export function parseClassification(raw: string): ClassificationOutput {
  const obj = extractJSON(raw);
  if (!obj) return { ...CLASSIFICATION_DEFAULT };

  return {
    persona:
      typeof obj.persona === 'string' && obj.persona.length > 0
        ? obj.persona
        : CLASSIFICATION_DEFAULT.persona,
    confidence:
      typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : CLASSIFICATION_DEFAULT.confidence,
    reason: typeof obj.reason === 'string' ? obj.reason : CLASSIFICATION_DEFAULT.reason,
  };
}

/** Parse enrichment output. Returns default on failure. */
export function parseEnrichment(raw: string): EnrichmentOutput {
  const obj = extractJSON(raw);
  if (!obj) return { ...ENRICHMENT_DEFAULT };

  return {
    content_l1: typeof obj.content_l1 === 'string' ? obj.content_l1 : ENRICHMENT_DEFAULT.content_l1,
    tags:
      Array.isArray(obj.tags) && obj.tags.every((t: unknown) => typeof t === 'string')
        ? (obj.tags as string[])
        : ENRICHMENT_DEFAULT.tags,
    has_event: typeof obj.has_event === 'boolean' ? obj.has_event : ENRICHMENT_DEFAULT.has_event,
  };
}

/** Parse reminder plan output. Returns default on failure. */
export function parseReminderPlan(raw: string): ReminderPlanOutput {
  const obj = extractJSON(raw);
  if (!obj) return { ...REMINDER_PLAN_DEFAULT };

  if (!Array.isArray(obj.reminders)) return { ...REMINDER_PLAN_DEFAULT };

  // Accept both parser schema (due_at, kind) and prompt schema (due_relative, priority)
  // Fix: Codex #11 — prompt and parser used different field names
  const reminders = (obj.reminders as Array<Record<string, unknown>>)
    .filter((r) => typeof r === 'object' && r !== null)
    .map((r) => ({
      message: typeof r.message === 'string' ? r.message : '',
      due_at: typeof r.due_at === 'number' ? r.due_at : 0,
      kind:
        typeof r.kind === 'string'
          ? r.kind
          : typeof r.priority === 'string'
            ? r.priority
            : 'manual',
    }))
    .filter((r) => r.message.length > 0);

  return { reminders };
}

/** Parse silence classification output. Returns default on failure. */
export function parseSilence(raw: string): SilenceOutput {
  const obj = extractJSON(raw);
  if (!obj) return { ...SILENCE_DEFAULT };

  const priority =
    typeof obj.priority === 'number' && [1, 2, 3].includes(obj.priority)
      ? (obj.priority as 1 | 2 | 3)
      : SILENCE_DEFAULT.priority;

  return {
    priority,
    reason: typeof obj.reason === 'string' ? obj.reason : SILENCE_DEFAULT.reason,
    confidence:
      typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : SILENCE_DEFAULT.confidence,
  };
}
