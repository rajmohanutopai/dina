/**
 * Nudge dedupe — prevents repeat-nudge spam.
 *
 * Silence-First promises "speak only when silence causes harm".
 * That principle is undermined when Brain fires the same nudge
 * three times over an hour because three ingest events flagged
 * the same topic. This primitive is the last-line defence: it
 * records every delivered nudge keyed by `(persona, topic,
 * subject)` and suppresses repeats within a TTL window.
 *
 * **Key composition**:
 *
 *   `persona:topic:subject` (lowercased, trimmed)
 *
 *   `subject` defaults to `"self"` when absent — the empty-subject
 *   case should still dedupe against itself.
 *
 * **Priority-aware TTL**:
 *
 *   - `fiduciary`  — never suppress. Silence would cause harm.
 *   - `solicited`  — 10-minute default TTL.
 *   - `engagement` — 4-hour default TTL.
 *
 * Defaults overridable via `ttlByPriority`.
 *
 * **Inject the clock + wake-ups are clock-driven** — no timers;
 * every `check()` sweeps expired entries from the top.
 *
 * **Event stream** — `onEvent` fires on each decision so ops
 * dashboards can render "5 nudges suppressed in the last hour".
 *
 * **Stateful + in-memory** — wrap with a KV-backed restore if
 * persistence across restart matters.
 */

import type { NotifyPriority } from './priority';

export interface NudgeKey {
  persona: string;
  topic: string;
  subject?: string;
}

export interface NudgeCheckInput extends NudgeKey {
  priority: NotifyPriority;
}

export type NudgeCheckResult =
  | { action: 'deliver'; key: string }
  | { action: 'suppress'; key: string; reason: 'within_ttl'; firstSeenMs: number; ttlExpiresAtMs: number };

export type NudgeDedupeEvent =
  | { kind: 'recorded'; key: string; priority: NotifyPriority; expiresAtMs: number }
  | { kind: 'suppressed'; key: string; firstSeenMs: number; ttlExpiresAtMs: number }
  | { kind: 'fiduciary_bypassed'; key: string };

export interface NudgeDedupeOptions {
  /** Per-priority TTL in ms. Defaults: fiduciary=never, solicited=10min, engagement=4h. */
  ttlByPriority?: Partial<Record<NotifyPriority, number>>;
  /** Max entries retained. Default 10_000. */
  maxEntries?: number;
  nowMsFn?: () => number;
  onEvent?: (event: NudgeDedupeEvent) => void;
}

export const DEFAULT_TTL_SOLICITED_MS = 10 * 60 * 1000;
export const DEFAULT_TTL_ENGAGEMENT_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 10_000;

interface Entry {
  firstSeenMs: number;
  priority: NotifyPriority;
  ttlExpiresAtMs: number;
}

/**
 * Stateful dedupe store. `check(input)` returns the action + updates
 * the entry on `deliver`.
 */
export class NudgeDedupe {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlByPriority: Record<NotifyPriority, number | null>;
  private readonly maxEntries: number;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: NudgeDedupeEvent) => void;

  constructor(opts: NudgeDedupeOptions = {}) {
    const overrides = opts.ttlByPriority ?? {};
    this.ttlByPriority = {
      fiduciary: overrides.fiduciary ?? null,
      solicited:
        overrides.solicited !== undefined ? overrides.solicited : DEFAULT_TTL_SOLICITED_MS,
      engagement:
        overrides.engagement !== undefined ? overrides.engagement : DEFAULT_TTL_ENGAGEMENT_MS,
    };
    for (const [k, v] of Object.entries(this.ttlByPriority)) {
      if (v !== null && (!Number.isFinite(v as number) || (v as number) <= 0)) {
        throw new RangeError(`ttlByPriority.${k} must be > 0 or null`);
      }
    }
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  size(): number {
    this.sweepExpired();
    return this.entries.size;
  }

  /**
   * Decide whether to deliver this nudge. Records delivery on `deliver`.
   */
  check(input: NudgeCheckInput): NudgeCheckResult {
    validate(input);
    this.sweepExpired();
    const key = keyOf(input);

    // Fiduciary always delivers (no TTL entry kept).
    if (input.priority === 'fiduciary' && this.ttlByPriority.fiduciary === null) {
      this.onEvent?.({ kind: 'fiduciary_bypassed', key });
      return { action: 'deliver', key };
    }

    const existing = this.entries.get(key);
    const now = this.nowMsFn();
    if (existing && existing.ttlExpiresAtMs > now) {
      this.onEvent?.({
        kind: 'suppressed',
        key,
        firstSeenMs: existing.firstSeenMs,
        ttlExpiresAtMs: existing.ttlExpiresAtMs,
      });
      return {
        action: 'suppress',
        key,
        reason: 'within_ttl',
        firstSeenMs: existing.firstSeenMs,
        ttlExpiresAtMs: existing.ttlExpiresAtMs,
      };
    }

    // Record + deliver.
    const ttl = this.ttlByPriority[input.priority];
    if (ttl === null) {
      // No TTL configured for this priority — deliver without recording.
      this.onEvent?.({ kind: 'fiduciary_bypassed', key });
      return { action: 'deliver', key };
    }
    const ttlExpiresAtMs = now + ttl;
    this.entries.set(key, {
      firstSeenMs: now,
      priority: input.priority,
      ttlExpiresAtMs,
    });
    this.evictIfOverflowing();
    this.onEvent?.({
      kind: 'recorded',
      key,
      priority: input.priority,
      expiresAtMs: ttlExpiresAtMs,
    });
    return { action: 'deliver', key };
  }

  /** Drop an entry so the next `check` delivers again. */
  forget(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Compute the canonical key for a NudgeKey — exposed for tests + admin UI. */
  static keyFor(key: NudgeKey): string {
    return keyOf(key);
  }

  // ── Internals ────────────────────────────────────────────────────────

  private sweepExpired(): void {
    const now = this.nowMsFn();
    for (const [k, v] of this.entries) {
      if (v.ttlExpiresAtMs <= now) this.entries.delete(k);
    }
  }

  private evictIfOverflowing(): void {
    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next();
      if (firstKey.done) break;
      this.entries.delete(firstKey.value);
    }
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(input: NudgeCheckInput): void {
  if (!input || typeof input !== 'object') {
    throw new TypeError('NudgeDedupe.check: input required');
  }
  if (typeof input.persona !== 'string' || input.persona.trim() === '') {
    throw new TypeError('NudgeDedupe.check: persona required');
  }
  if (typeof input.topic !== 'string' || input.topic.trim() === '') {
    throw new TypeError('NudgeDedupe.check: topic required');
  }
  if (input.subject !== undefined && typeof input.subject !== 'string') {
    throw new TypeError('NudgeDedupe.check: subject must be a string');
  }
  if (
    input.priority !== 'fiduciary' &&
    input.priority !== 'solicited' &&
    input.priority !== 'engagement'
  ) {
    throw new TypeError('NudgeDedupe.check: invalid priority');
  }
}

function keyOf(key: NudgeKey): string {
  const persona = key.persona.trim().toLowerCase();
  const topic = key.topic.trim().toLowerCase();
  const subject = (key.subject ?? 'self').trim().toLowerCase() || 'self';
  return `${persona}:${topic}:${subject}`;
}
