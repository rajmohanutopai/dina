/**
 * PII redaction planner — span-based redaction decisions from
 * `sensitive_signals` output.
 *
 * Given a piece of text + a list of `SensitiveSignal`s (each with a
 * span + confidence + type), this primitive produces an ordered list
 * of redactions: non-overlapping character ranges to replace with a
 * policy-chosen token. It ALSO produces a preview of the redacted
 * text so callers can show "what would be sent" before committing.
 *
 * **Pure** — no IO, no crypto. Deterministic given inputs + policy.
 *
 * **Policy per signal type**:
 *
 *   - `redact`   — replace with the policy's mask token (default
 *                  `[REDACTED]`).
 *   - `mask`     — replace every character in the span with a mask
 *                  character (default `*`) preserving length.
 *   - `tokenize` — replace with a stable `<ENTITY:N>` token; N is
 *                  assigned deterministically per distinct matched
 *                  substring so the same value reuses the same token.
 *   - `preserve` — leave the span untouched (caller still sees the
 *                  signal for audit).
 *
 * **Overlap resolution** — when two signals overlap, the one with
 * the STRONGER policy wins (`redact` > `mask` > `tokenize` >
 * `preserve`). Ties are broken by signal confidence desc, then by
 * earlier start index.
 *
 * **Min confidence filter** — signals below `minConfidence` are
 * dropped before planning.
 */

import type {
  SensitiveSignal,
  SensitiveSignalType,
} from './sensitive_signals';

export type RedactionMode = 'redact' | 'mask' | 'tokenize' | 'preserve';

export interface RedactionPolicy {
  /** Default mode when a type isn't listed in `perType`. Default `redact`. */
  defaultMode?: RedactionMode;
  /** Per-type overrides. */
  perType?: Partial<Record<SensitiveSignalType, RedactionMode>>;
  /** Mask token for `redact` mode. Default `[REDACTED]`. */
  maskToken?: string;
  /** Mask character for `mask` mode. Default `*`. */
  maskChar?: string;
  /** Min signal confidence to plan for. Default 0. */
  minConfidence?: number;
}

export interface PlannedRedaction {
  /** Character range in the ORIGINAL text. */
  span: { start: number; end: number };
  /** Signal that triggered this redaction. */
  type: SensitiveSignalType;
  /** The mode applied. */
  mode: Exclude<RedactionMode, 'preserve'>;
  /** Replacement for this span. Empty string when mode=preserve would be filtered out. */
  replacement: string;
  /** Original matched substring — useful for audit. */
  original: string;
  /** Max confidence signal that contributed to this span. */
  confidence: number;
}

export interface RedactionPlanOutcome {
  /** Preview text after applying every planned redaction. */
  redactedText: string;
  /** Planned redactions in left-to-right order (non-overlapping). */
  redactions: PlannedRedaction[];
  /** Token → original mapping for `tokenize` mode. Empty if no tokens. */
  entityMap: Record<string, string>;
  /** Stats — useful for ops + admin UI. */
  stats: {
    signalsConsidered: number;
    signalsApplied: number;
    signalsDroppedBelowConfidence: number;
    signalsDroppedOverlap: number;
    signalsPreserved: number;
  };
}

export const DEFAULT_MASK_TOKEN = '[REDACTED]';
export const DEFAULT_MASK_CHAR = '*';

/**
 * Plan redactions for `text` given `signals` + `policy`. Pure.
 */
export function planPiiRedactions(
  text: string,
  signals: ReadonlyArray<SensitiveSignal>,
  policy: RedactionPolicy = {},
): RedactionPlanOutcome {
  if (typeof text !== 'string') {
    throw new TypeError('planPiiRedactions: text must be a string');
  }

  const defaultMode: RedactionMode = policy.defaultMode ?? 'redact';
  const maskToken = policy.maskToken ?? DEFAULT_MASK_TOKEN;
  const maskChar = policy.maskChar ?? DEFAULT_MASK_CHAR;
  const minConfidence = policy.minConfidence ?? 0;
  const perType = policy.perType ?? {};

  const signalsConsidered = signals.length;
  let signalsDroppedBelowConfidence = 0;

  const filtered = signals.filter((s) => {
    if (!s.span) return false;
    if (s.confidence < minConfidence) {
      signalsDroppedBelowConfidence += 1;
      return false;
    }
    return true;
  });

  // Resolve overlaps: for each signal, pick the stronger mode among
  // overlapping signals. Walk sorted-by-start; merge/skip as needed.
  const sorted = [...filtered].sort(spanSortKey);

  const planned: PlannedRedaction[] = [];
  const entityMap: Record<string, string> = {};
  const tokenByOriginal = new Map<string, string>();
  let signalsDroppedOverlap = 0;
  let signalsPreserved = 0;

  for (const signal of sorted) {
    const span = signal.span!;
    const mode: RedactionMode = perType[signal.type] ?? defaultMode;
    if (mode === 'preserve') {
      signalsPreserved += 1;
      continue;
    }

    // Check overlap with the last accepted plan.
    const tail = planned[planned.length - 1];
    if (tail && span.start < tail.span.end) {
      // Overlap — UNION the spans so every flagged byte stays covered.
      // Stronger mode + higher confidence win for the merged span.
      signalsDroppedOverlap += 1;
      const tailPrecedence = modePrecedence(tail.mode);
      const candPrecedence = modePrecedence(mode);
      const useCandMode =
        candPrecedence > tailPrecedence ||
        (candPrecedence === tailPrecedence && signal.confidence > tail.confidence);
      const chosenMode = useCandMode ? mode : tail.mode;
      const chosenType = useCandMode ? signal.type : tail.type;
      const chosenConfidence = Math.max(tail.confidence, signal.confidence);
      const mergedSpan = {
        start: Math.min(tail.span.start, span.start),
        end: Math.max(tail.span.end, span.end),
      };
      // Replace tail with the merged redaction.
      planned.pop();
      const mergedOriginal = text.slice(mergedSpan.start, mergedSpan.end);
      const mergedReplacement = computeReplacement(
        chosenMode,
        mergedOriginal,
        maskToken,
        maskChar,
        entityMap,
        tokenByOriginal,
        chosenType,
      );
      planned.push({
        span: mergedSpan,
        type: chosenType,
        mode: chosenMode,
        replacement: mergedReplacement,
        original: mergedOriginal,
        confidence: chosenConfidence,
      });
      continue;
    }

    const original = text.slice(span.start, span.end);
    const replacement = computeReplacement(
      mode,
      original,
      maskToken,
      maskChar,
      entityMap,
      tokenByOriginal,
      signal.type,
    );
    planned.push({
      span,
      type: signal.type,
      mode,
      replacement,
      original,
      confidence: signal.confidence,
    });
  }

  // Apply redactions left-to-right to produce the preview.
  const redactedText = applyRedactions(text, planned);

  return {
    redactedText,
    redactions: planned,
    entityMap,
    stats: {
      signalsConsidered,
      signalsApplied: planned.length,
      signalsDroppedBelowConfidence,
      signalsDroppedOverlap,
      signalsPreserved,
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function modePrecedence(mode: RedactionMode): number {
  switch (mode) {
    case 'redact':   return 3;
    case 'mask':     return 2;
    case 'tokenize': return 1;
    case 'preserve': return 0;
  }
}

function spanSortKey(a: SensitiveSignal, b: SensitiveSignal): number {
  const aStart = a.span?.start ?? 0;
  const bStart = b.span?.start ?? 0;
  if (aStart !== bStart) return aStart - bStart;
  // Earlier end first — keeps overlap resolution predictable.
  const aEnd = a.span?.end ?? 0;
  const bEnd = b.span?.end ?? 0;
  if (aEnd !== bEnd) return aEnd - bEnd;
  // Stable tiebreak by confidence desc.
  return b.confidence - a.confidence;
}

function computeReplacement(
  mode: Exclude<RedactionMode, 'preserve'>,
  original: string,
  maskToken: string,
  maskChar: string,
  entityMap: Record<string, string>,
  tokenByOriginal: Map<string, string>,
  type: SensitiveSignalType,
): string {
  if (mode === 'redact') return maskToken;
  if (mode === 'mask') return maskChar.repeat(original.length);
  // mode === 'tokenize'
  const existing = tokenByOriginal.get(original);
  if (existing !== undefined) return existing;
  const idx = tokenByOriginal.size;
  const token = `<ENTITY:${type.toUpperCase()}:${idx}>`;
  tokenByOriginal.set(original, token);
  entityMap[token] = original;
  return token;
}

function applyRedactions(
  text: string,
  planned: ReadonlyArray<PlannedRedaction>,
): string {
  if (planned.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const r of planned) {
    if (r.span.start > cursor) parts.push(text.slice(cursor, r.span.start));
    parts.push(r.replacement);
    cursor = r.span.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join('');
}
