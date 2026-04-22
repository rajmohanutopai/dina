/**
 * Briefing schedule — when to deliver the next Silence-First briefing.
 *
 * `briefing_orchestrator.ts` builds the content. This primitive
 * decides WHEN. The decision is data, not a timer:
 *
 *   - **Daily anchor** — local-time HH:MM the user wants their
 *     briefing (default 07:30).
 *   - **Quiet-hours skip** — if the anchor falls inside a configured
 *     quiet window, defer to the end of that window.
 *   - **On-demand trigger** — `triggerNow()` produces an "out of
 *     band" delivery; the next scheduled one still fires at its
 *     anchor.
 *   - **Last-delivered ack** — `markDelivered()` stamps the last
 *     successful delivery; `nextFireSec()` uses it to skip same-day
 *     repeat.
 *
 * **Pure-ish**: state = `{lastDeliveredSec, pendingOnDemand}`. Every
 * decision derived from state + injected clock + config. Deterministic.
 *
 * **Timezone-aware** via minutes-from-UTC offset. Day boundaries +
 * anchor computed in the user's local time.
 */

export interface BriefingScheduleConfig {
  /** Local-time anchor in minutes-since-midnight. Default 07:30 = 450. */
  anchorLocalMinutes?: number;
  /** Timezone offset from UTC, in minutes. Default 0. */
  tzOffsetMin?: number;
  /** Quiet-window start (local minutes). Optional. */
  quietStartLocalMin?: number;
  /** Quiet-window end (local minutes). Optional. */
  quietEndLocalMin?: number;
  /** Clock. Defaults to `Date.now()` / 1000. */
  nowSecFn?: () => number;
}

export interface NextBriefingDecision {
  kind: 'on_demand' | 'scheduled';
  /** Unix seconds when the next delivery should fire. */
  fireAtSec: number;
  /** Reason tag — useful for audit. */
  reason:
    | 'on_demand_requested'
    | 'first_run'
    | 'same_day_deferred_to_next_anchor'
    | 'anchor_pending'
    | 'anchor_passed_deferred_to_next_anchor'
    | 'deferred_quiet_hours';
}

export const DEFAULT_ANCHOR_LOCAL_MIN = 7 * 60 + 30; // 07:30

export class BriefingScheduleError extends Error {
  constructor(
    public readonly code:
      | 'invalid_anchor'
      | 'invalid_tz'
      | 'invalid_quiet',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BriefingScheduleError';
  }
}

/**
 * Stateful schedule: `nextFireSec()` is the single source of truth.
 * `markDelivered(nowSec)` stamps the last successful delivery;
 * `triggerNow()` requests an out-of-band delivery.
 */
export class BriefingSchedule {
  private readonly anchor: number;
  private readonly tzOffsetMin: number;
  private readonly quietStart: number | null;
  private readonly quietEnd: number | null;
  private readonly nowSecFn: () => number;
  private lastDeliveredSec: number | null = null;
  private pendingOnDemand = false;

  constructor(config: BriefingScheduleConfig = {}) {
    const anchor = config.anchorLocalMinutes ?? DEFAULT_ANCHOR_LOCAL_MIN;
    if (!Number.isInteger(anchor) || anchor < 0 || anchor >= 24 * 60) {
      throw new BriefingScheduleError('invalid_anchor', 'anchorLocalMinutes in [0, 1440)');
    }
    this.anchor = anchor;

    const tz = config.tzOffsetMin ?? 0;
    if (!Number.isFinite(tz) || Math.abs(tz) > 24 * 60) {
      throw new BriefingScheduleError('invalid_tz', 'tzOffsetMin within ±1440');
    }
    this.tzOffsetMin = tz;

    const qs = config.quietStartLocalMin;
    const qe = config.quietEndLocalMin;
    if ((qs !== undefined) !== (qe !== undefined)) {
      throw new BriefingScheduleError('invalid_quiet', 'quiet start + end must both be set or omitted');
    }
    if (qs !== undefined && qe !== undefined) {
      if (
        !Number.isInteger(qs) || qs < 0 || qs >= 24 * 60 ||
        !Number.isInteger(qe) || qe < 0 || qe >= 24 * 60
      ) {
        throw new BriefingScheduleError('invalid_quiet', 'quiet bounds in [0, 1440)');
      }
      this.quietStart = qs;
      this.quietEnd = qe;
    } else {
      this.quietStart = null;
      this.quietEnd = null;
    }

    this.nowSecFn = config.nowSecFn ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Request an immediate delivery at the next call to `nextFireSec`. */
  triggerNow(): void {
    this.pendingOnDemand = true;
  }

  /** Stamp a successful delivery. */
  markDelivered(atSec?: number): void {
    const t = atSec ?? this.nowSecFn();
    if (!Number.isFinite(t)) return;
    this.lastDeliveredSec = t;
    // An on-demand trigger clears once delivered.
    this.pendingOnDemand = false;
  }

  /** Timestamp of the last delivery, or null if never delivered. */
  lastDelivered(): number | null {
    return this.lastDeliveredSec;
  }

  /** Whether an on-demand delivery is queued. */
  hasPendingOnDemand(): boolean {
    return this.pendingOnDemand;
  }

  /**
   * Compute the next fire timestamp (unix seconds). Always returns
   * the current decision — idempotent; doesn't mutate state.
   */
  nextFireSec(): NextBriefingDecision {
    const now = this.nowSecFn();
    if (this.pendingOnDemand) {
      return {
        kind: 'on_demand',
        fireAtSec: now,
        reason: 'on_demand_requested',
      };
    }

    // Compute today's anchor in UTC seconds.
    const todayAnchor = this.anchorUtcSecForDay(now, 0);

    if (this.lastDeliveredSec === null) {
      // First run: use today's anchor if still ahead, else tomorrow.
      const target = todayAnchor > now ? todayAnchor : this.anchorUtcSecForDay(now, 1);
      return this.adjustForQuiet(target, 'first_run');
    }

    // Already delivered today's anchor? Defer to tomorrow.
    if (this.isSameLocalDay(this.lastDeliveredSec, now)) {
      const tomorrow = this.anchorUtcSecForDay(now, 1);
      return this.adjustForQuiet(tomorrow, 'same_day_deferred_to_next_anchor');
    }

    if (todayAnchor > now) {
      // Previous delivery was yesterday or earlier; today's anchor is
      // still ahead → fire then.
      return this.adjustForQuiet(todayAnchor, 'anchor_pending');
    }

    // Today's anchor already passed but we didn't deliver yet → fire
    // immediately (user missed the anchor due to downtime).
    if (now >= todayAnchor && !this.isSameLocalDay(this.lastDeliveredSec, now)) {
      return this.adjustForQuiet(now, 'anchor_passed_deferred_to_next_anchor');
    }

    // Fallback — should not hit.
    return this.adjustForQuiet(this.anchorUtcSecForDay(now, 1), 'anchor_pending');
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Unix seconds of the anchor for the local-day `now` belongs to,
   * offset by `dayDelta` (0 = today, 1 = tomorrow).
   */
  private anchorUtcSecForDay(nowSec: number, dayDelta: number): number {
    const tzSec = this.tzOffsetMin * 60;
    const localSec = nowSec + tzSec;
    const localDayStart = Math.floor(localSec / 86400) * 86400;
    const localAnchor = localDayStart + this.anchor * 60 + dayDelta * 86400;
    return localAnchor - tzSec;
  }

  private isSameLocalDay(aSec: number, bSec: number): boolean {
    const tzSec = this.tzOffsetMin * 60;
    const aDay = Math.floor((aSec + tzSec) / 86400);
    const bDay = Math.floor((bSec + tzSec) / 86400);
    return aDay === bDay;
  }

  private adjustForQuiet(
    targetSec: number,
    reason: NextBriefingDecision['reason'],
  ): NextBriefingDecision {
    if (this.quietStart === null || this.quietEnd === null) {
      return { kind: 'scheduled', fireAtSec: targetSec, reason };
    }
    const localMin = this.localMinuteOf(targetSec);
    if (!this.isQuietMinute(localMin)) {
      return { kind: 'scheduled', fireAtSec: targetSec, reason };
    }
    // Target falls in quiet window — defer to quiet end.
    const deferred = this.deferToQuietEnd(targetSec);
    return { kind: 'scheduled', fireAtSec: deferred, reason: 'deferred_quiet_hours' };
  }

  private localMinuteOf(unixSec: number): number {
    const local = unixSec + this.tzOffsetMin * 60;
    const dayStart = Math.floor(local / 86400) * 86400;
    const min = Math.floor((local - dayStart) / 60);
    return ((min % 1440) + 1440) % 1440;
  }

  private isQuietMinute(minute: number): boolean {
    if (this.quietStart === null || this.quietEnd === null) return false;
    if (this.quietStart === this.quietEnd) return false; // zero-length
    if (this.quietStart < this.quietEnd) {
      return minute >= this.quietStart && minute < this.quietEnd;
    }
    // Cross-midnight window
    return minute >= this.quietStart || minute < this.quietEnd;
  }

  private deferToQuietEnd(targetSec: number): number {
    const localMin = this.localMinuteOf(targetSec);
    const secOfMin = targetSec - Math.floor(targetSec / 60) * 60;
    // Normal window.
    if (this.quietStart! < this.quietEnd!) {
      const minsUntilEnd = this.quietEnd! - localMin;
      return targetSec + minsUntilEnd * 60 - secOfMin;
    }
    // Cross-midnight window, still before midnight local.
    if (localMin >= this.quietStart!) {
      const minsUntilEnd = 1440 - localMin + this.quietEnd!;
      return targetSec + minsUntilEnd * 60 - secOfMin;
    }
    // Cross-midnight window, already past midnight (tail of window).
    const minsUntilEnd = this.quietEnd! - localMin;
    return targetSec + minsUntilEnd * 60 - secOfMin;
  }
}
