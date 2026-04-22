/**
 * Silence-First classifier — pure priority decision per the Four Laws.
 *
 * The First Law: **Silence First**. Dina never pushes content — she
 * speaks only when asked OR when silence causes harm. This primitive
 * is the decision point: incoming item → priority tier.
 *
 *   - `fiduciary`  — silence would cause harm. INTERRUPT NOW.
 *   - `solicited`  — user asked about this; deliver without delay but
 *                    respect DND.
 *   - `engagement` — notable but silence-safe. Buffer for briefing.
 *
 * **Input signal surface** (all optional; any subset may drive the
 * decision):
 *
 *   - `solicited` — explicit flag from a handler that knows "the user
 *     asked for this". Highest-confidence solicited signal.
 *   - `ring` — sender trust ring (1 close / 2 verified / 3
 *     unverified). Ring-1 senders can escalate to solicited without
 *     the explicit flag; ring-3 never escalates above engagement.
 *   - `keywords` — an array of detected signal words (`urgent`,
 *     `deadline`, `emergency`, etc.). Fiduciary-category words override
 *     most other rules.
 *   - `deadline` — unix seconds; if within `fiduciaryWindowSec` it's
 *     fiduciary.
 *   - `healthSignal` — from `sensitive_signals` detector; any
 *     high-confidence health signal that ALSO has an urgency keyword
 *     is fiduciary (health + urgency is a mandatory escalation).
 *   - `explicitPriority` — caller forces a priority. Overrides every rule.
 *
 * **Rule order** (first match wins):
 *
 *   1. `explicitPriority` — caller override.
 *   2. Fiduciary keywords present → `fiduciary`.
 *   3. `deadline` within window → `fiduciary`.
 *   4. Health + urgency keyword → `fiduciary`.
 *   5. `solicited` flag OR ring-1 sender → `solicited`.
 *   6. default → `engagement`.
 *
 * **Pure** — no IO, no state, no clock reads beyond the injected
 * `nowSec`. Tests pin the full rule matrix.
 *
 * Mirrors the Python brain's `guardian.py` classification step at the
 * primitive level; callers like `guardian_loop.ts` can reuse this
 * primitive to avoid re-implementing the tier rules.
 */

import type { NotifyPriority } from './priority';

/** Sender trust ring — 1 (close) / 2 (verified) / 3 (unverified). */
export type SenderRing = 1 | 2 | 3;

export interface SilenceClassifyInput {
  /** Unix seconds — anchor for deadline checks. */
  nowSec: number;
  /** Raw text — used for signal extraction when keywords aren't supplied. */
  text?: string;
  /** Pre-computed keyword hits (optional). Saves re-scanning text. */
  keywords?: ReadonlyArray<string>;
  /** Unix seconds deadline; within `fiduciaryWindowSec` → fiduciary. */
  deadlineSec?: number;
  /** Sender trust ring. */
  ring?: SenderRing;
  /** True when the user explicitly asked about this. */
  solicited?: boolean;
  /** True when the signal set includes a strong health match. */
  healthSignal?: boolean;
  /** Caller override — wins over every rule. */
  explicitPriority?: NotifyPriority;
}

export interface SilenceClassifyOptions {
  /** Seconds until deadline counts as fiduciary. Default 6h. */
  fiduciaryWindowSec?: number;
  /** Override the built-in fiduciary keyword list. */
  fiduciaryKeywords?: ReadonlyArray<string>;
  /** Override the built-in urgency keyword list used for health escalation. */
  urgencyKeywords?: ReadonlyArray<string>;
}

export interface SilenceClassifyResult {
  priority: NotifyPriority;
  /** Machine-readable reason the rule fired. */
  reason: SilenceClassifyReason;
  /** Signals that contributed to the decision — useful for audit. */
  triggers: SilenceTrigger[];
}

export type SilenceClassifyReason =
  | 'explicit_priority'
  | 'fiduciary_keyword'
  | 'deadline_within_window'
  | 'health_and_urgency'
  | 'solicited_flag'
  | 'ring_1_sender'
  | 'default_engagement';

export type SilenceTrigger =
  | { kind: 'keyword'; value: string; category: 'fiduciary' | 'urgency' }
  | { kind: 'deadline'; secondsUntil: number }
  | { kind: 'ring'; ring: SenderRing }
  | { kind: 'solicited_flag' }
  | { kind: 'health_signal' }
  | { kind: 'explicit'; value: NotifyPriority };

export const DEFAULT_FIDUCIARY_WINDOW_SEC = 6 * 60 * 60;

export const DEFAULT_FIDUCIARY_KEYWORDS: ReadonlyArray<string> = [
  'emergency',
  'immediately',
  'asap',
  'call 911',
  'hospital',
  'ambulance',
  'fire',
  'break-in',
  'fraud alert',
  'security alert',
  'account locked',
  'overdue',
  'final notice',
];

export const DEFAULT_URGENCY_KEYWORDS: ReadonlyArray<string> = [
  'urgent',
  'critical',
  'important',
  'asap',
  'today',
  'now',
  'immediately',
];

/**
 * Classify an incoming item. Pure; deterministic.
 */
export function classifySilence(
  input: SilenceClassifyInput,
  opts: SilenceClassifyOptions = {},
): SilenceClassifyResult {
  const validation = validate(input);
  if (validation !== null) {
    return {
      priority: 'engagement',
      reason: 'default_engagement',
      triggers: [{ kind: 'explicit', value: 'engagement' }],
    };
  }

  // 1. Explicit override.
  if (input.explicitPriority) {
    return {
      priority: input.explicitPriority,
      reason: 'explicit_priority',
      triggers: [{ kind: 'explicit', value: input.explicitPriority }],
    };
  }

  const fiduciaryKeywords = new Set(
    (opts.fiduciaryKeywords ?? DEFAULT_FIDUCIARY_KEYWORDS).map((k) =>
      k.toLowerCase(),
    ),
  );
  const urgencyKeywords = new Set(
    (opts.urgencyKeywords ?? DEFAULT_URGENCY_KEYWORDS).map((k) =>
      k.toLowerCase(),
    ),
  );

  const foundKeywords = collectKeywords(input, fiduciaryKeywords, urgencyKeywords);

  // 2. Fiduciary keyword.
  const fiduciaryHit = foundKeywords.find((k) => k.category === 'fiduciary');
  if (fiduciaryHit) {
    return {
      priority: 'fiduciary',
      reason: 'fiduciary_keyword',
      triggers: [{ kind: 'keyword', value: fiduciaryHit.value, category: 'fiduciary' }],
    };
  }

  // 3. Deadline within fiduciary window.
  const fiduciaryWindowSec = opts.fiduciaryWindowSec ?? DEFAULT_FIDUCIARY_WINDOW_SEC;
  if (input.deadlineSec !== undefined) {
    const secondsUntil = input.deadlineSec - input.nowSec;
    if (secondsUntil >= 0 && secondsUntil <= fiduciaryWindowSec) {
      return {
        priority: 'fiduciary',
        reason: 'deadline_within_window',
        triggers: [{ kind: 'deadline', secondsUntil }],
      };
    }
  }

  // 4. Health + urgency.
  const urgencyHit = foundKeywords.find((k) => k.category === 'urgency');
  if (input.healthSignal && urgencyHit) {
    return {
      priority: 'fiduciary',
      reason: 'health_and_urgency',
      triggers: [
        { kind: 'health_signal' },
        { kind: 'keyword', value: urgencyHit.value, category: 'urgency' },
      ],
    };
  }

  // 5. Solicited or ring-1 sender.
  if (input.solicited) {
    return {
      priority: 'solicited',
      reason: 'solicited_flag',
      triggers: [{ kind: 'solicited_flag' }],
    };
  }
  if (input.ring === 1) {
    return {
      priority: 'solicited',
      reason: 'ring_1_sender',
      triggers: [{ kind: 'ring', ring: 1 }],
    };
  }

  // 6. Default.
  return {
    priority: 'engagement',
    reason: 'default_engagement',
    triggers: [],
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(input: SilenceClassifyInput): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (!Number.isFinite(input.nowSec)) return 'nowSec must be finite';
  if (input.ring !== undefined && input.ring !== 1 && input.ring !== 2 && input.ring !== 3) {
    return 'ring must be 1 | 2 | 3';
  }
  return null;
}

function collectKeywords(
  input: SilenceClassifyInput,
  fiduciary: ReadonlySet<string>,
  urgency: ReadonlySet<string>,
): Array<{ value: string; category: 'fiduciary' | 'urgency' }> {
  const out: Array<{ value: string; category: 'fiduciary' | 'urgency' }> = [];
  // Pre-supplied keywords.
  if (input.keywords) {
    for (const raw of input.keywords) {
      const k = raw.toLowerCase();
      if (fiduciary.has(k)) out.push({ value: k, category: 'fiduciary' });
      else if (urgency.has(k)) out.push({ value: k, category: 'urgency' });
    }
  }
  // Scan text (cheap contains — not regex — since keywords are short).
  if (input.text) {
    const lower = input.text.toLowerCase();
    for (const k of fiduciary) {
      if (lower.includes(k)) out.push({ value: k, category: 'fiduciary' });
    }
    for (const k of urgency) {
      if (lower.includes(k)) out.push({ value: k, category: 'urgency' });
    }
  }
  return out;
}
