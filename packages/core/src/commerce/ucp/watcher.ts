/**
 * After the hand-off (UCP plan §3.12, U3.1): Dina never completes a
 * checkout, so it never receives the completed checkout that names the
 * order. The watcher reads the session back with Get Checkout and settles it
 * from what the merchant says.
 *
 *  - Schedule: at the hand-off + 2 minutes, + 10, + 30, then hourly (phones:
 *    while the app is open, since the sweep runs only then). Only a hand-off
 *    to the session itself (`continue_url`) is watched: a permalink opens a
 *    new cart Dina cannot follow, a home page nothing at all.
 *  - `completed`: the order's id and permalink are recorded (U3.2 makes the
 *    order row). `canceled`: recorded. `not_found` before any terminal
 *    answer: `unknown` ("check your email from them").
 *  - Still `complete_in_progress` at the session's effective expiry:
 *    `unknown`, and that session is never asked again (the spec forbids it,
 *    `checkout/index.md:444-450`). Any other status still open an hour past
 *    the expiry: `not_completed`. A read that does not come back by then
 *    leaves `unknown`.
 *  - The deadlines end automatic polling, not recovery: when the app reopens
 *    (or the owner opens the purchase) within 7 days of the hand-off, one Get
 *    Checkout is made for each session still unsettled, except one last seen
 *    `complete_in_progress` past its expiry. A terminal answer settles it;
 *    anything else leaves it as it was.
 *  - Wording never claims the purchase did not happen: the owner may have
 *    paid on another session the merchant made.
 */

import { readCheckout } from '@dina/ucp';

import type { CheckoutRow, CheckoutState, UcpCheckoutStore } from './checkout_store';
import type { CallResult, MerchantConnection, UcpMerchantClient } from './merchant_client';

/** The reads after the hand-off: + 2, + 10, + 30 minutes, then hourly. */
const FIRST_READS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];
const HOURLY_MS = 60 * 60_000;
/** How long past the effective expiry a session that is not completing is still read. */
export const AFTER_EXPIRY_MS = 60 * 60_000;
/** How long after the hand-off a reopened app reads an unsettled session once more. */
export const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** How often a look by the owner may read one session. */
export const LOOK_EVERY_MS = 60_000;

/** States a watched session settles from. */
const WATCHED: readonly CheckoutState[] = ['handed_off', 'not_completed', 'unknown'];

export interface WatcherDeps {
  store: UcpCheckoutStore;
  client: Pick<UcpMerchantClient, 'open' | 'notReady'>;
  nowMs: () => number;
  /**
   * A session completed at the merchant: its order to follow (U3.2). Runs in
   * the transaction that records the completion, so the two land together.
   */
  onCompleted?: (row: CheckoutRow, now: number) => void;
}

/** When the `reads`-th read after a hand-off at `handedOffAt` falls (0 = the first). */
export function watchReadAt(handedOffAt: number, reads: number): number {
  const first = FIRST_READS_MS[reads];
  if (first !== undefined) return handedOffAt + first;
  const last = FIRST_READS_MS[FIRST_READS_MS.length - 1] as number;
  return handedOffAt + last + (reads - FIRST_READS_MS.length + 1) * HOURLY_MS;
}

/**
 * The first scheduled read strictly after `now`, by the clock: +2, +10, +30
 * minutes, then each hour after. A watcher that slept through reads (a phone
 * closed) takes the next slot, never a burst to catch a count up.
 */
export function nextWatchAfter(handedOffAt: number, now: number): number {
  for (const ms of FIRST_READS_MS) if (handedOffAt + ms > now) return handedOffAt + ms;
  const last = handedOffAt + (FIRST_READS_MS[FIRST_READS_MS.length - 1] as number);
  return last + (Math.floor((now - last) / HOURLY_MS) + 1) * HOURLY_MS;
}

const isNotFound = (answer: CallResult): boolean =>
  !answer.ok &&
  answer.kind === 'error_response' &&
  answer.messages.messages.some((m) => m.type === 'error' && m.code === 'not_found');

export class UcpHandoffWatcher {
  constructor(private readonly deps: WatcherDeps) {}

  /** Read every handed-off session that is due. */
  async sweep(): Promise<void> {
    if (this.deps.client.notReady() !== null) return;
    for (const row of this.deps.store.dueWatches(this.deps.nowMs())) {
      const startedAt = this.deps.nowMs();
      let ok = false;
      try {
        ok = await this.watch(row);
      } catch {
        /* one session's fault never holds up the others */
      }
      this.deps.store.afterWatchRead(row.session_id, { startedAt, ok }, this.deps.nowMs());
    }
  }

  /**
   * The app reopened (or the owner opened a purchase): one more read of each
   * session handed off in the last 7 days whose outcome is still unknown.
   */
  async recover(): Promise<void> {
    if (this.deps.client.notReady() !== null) return;
    const now = this.deps.nowMs();
    for (const row of this.deps.store.unsettledSince(now - RECOVERY_WINDOW_MS)) {
      // A session still on the watcher's schedule is read there.
      if (row.state === 'handed_off' && row.watch_next_at !== null) continue;
      const startedAt = this.deps.nowMs();
      let ok = false;
      try {
        ok = await this.readOnce(row);
      } catch {
        /* the next reopen tries again */
      }
      this.deps.store.afterWatchRead(row.session_id, { startedAt, ok }, this.deps.nowMs());
    }
  }

  /**
   * The owner looks at a purchase (Brain reads it for them, §3.12 "or the
   * owner opens the purchase"): one read now for a session handed off to its
   * own page within 7 days whose outcome is not yet known, at most once a
   * minute. One on the schedule is read early (its schedule goes on); one
   * already settled without an outcome gets the one-off recovery read.
   */
  async look(sessionId: string): Promise<void> {
    const row = this.deps.store.getCheckout(sessionId);
    if (row === null || this.deps.client.notReady() !== null) return;
    if (!WATCHED.includes(row.state) || row.handoff_source !== 'continue_url') return;
    const now = this.deps.nowMs();
    if (row.handed_off_at === null || now - row.handed_off_at > RECOVERY_WINDOW_MS) return;
    if (now - row.updated_at < LOOK_EVERY_MS) return;
    const startedAt = now;
    let ok = false;
    try {
      ok =
        row.state === 'handed_off' && row.watch_next_at !== null
          ? await this.watch(row)
          : await this.readOnce(row);
    } catch {
      /* the schedule, or the next look, tries again */
    }
    this.deps.store.afterWatchRead(sessionId, { startedAt, ok }, this.deps.nowMs());
  }

  /**
   * One read of a session off the schedule (a reopen, or a webhook's prompt
   * on one already settled without an outcome): a terminal answer settles
   * it; anything else leaves it as it was. True when the merchant answered,
   * or when the session may not be asked at all.
   */
  private async readOnce(row: CheckoutRow): Promise<boolean> {
    const now = this.deps.nowMs();
    // The spec forbids asking again about one still completing past its expiry.
    if (row.last_status === 'complete_in_progress' && now >= expiryOf(row)) {
      if (row.watch_next_at !== null) this.deps.store.recordWatch(row.session_id, null, null, now);
      return true;
    }
    const asked = await this.read(row);
    if (asked !== null && this.settleIfTerminal(row, asked)) return true;
    // What it saw is kept even off the schedule: a session seen completing past its expiry is
    // then never asked again, on any later reopen either.
    this.deps.store.recordWatch(
      row.session_id,
      asked?.kind === 'status' ? asked.status : null,
      null,
      now,
    );
    return asked !== null;
  }

  /** One scheduled read; true when the merchant answered, or when it may not be asked. */
  private async watch(row: CheckoutRow): Promise<boolean> {
    // Prompted after the schedule ended: one read, no new schedule.
    if (row.state !== 'handed_off') return this.readOnce(row);
    const now = this.deps.nowMs();
    const expiry = expiryOf(row);
    // Last seen completing and its expiry reached: unknown, without asking. The platform
    // MUST stop repeated requests at `expires_at` (checkout/index.md:450).
    if (row.last_status === 'complete_in_progress' && now >= expiry) {
      this.settle(row, 'unknown', null);
      return true;
    }
    const answer = await this.read(row);
    if (answer !== null && this.settleIfTerminal(row, answer)) return true;
    const status = answer?.kind === 'status' ? answer.status : null;
    const completing = (status ?? row.last_status) === 'complete_in_progress';
    if (completing && now >= expiry) {
      this.settle(row, 'unknown', status);
      return true;
    }
    // Completing: the last wake is the expiry itself, which settles without a read (above).
    const deadline = completing ? expiry : expiry + AFTER_EXPIRY_MS;
    if (!completing && now >= deadline) {
      // Past the last read: still open there is not completed; no answer at all, not known.
      this.settle(row, answer === null ? 'unknown' : 'not_completed', status);
      return answer !== null;
    }
    const next = Math.min(nextWatchAfter(row.handed_off_at ?? now, now), deadline);
    this.deps.store.recordWatch(row.session_id, status, Math.max(next, now + 1), now);
    return answer !== null;
  }

  /** The checkout as the merchant holds it now; null when it could not be read. */
  private async read(
    row: CheckoutRow,
  ): Promise<
    | { kind: 'not_found' }
    | { kind: 'status'; status: string; order?: { id: string; permalinkUrl: string } }
    | null
  > {
    if (row.merchant_checkout_id === null) return null;
    const opened = await this.deps.client.open(row.merchant_origin);
    if (!opened.ok) return null;
    const connection: MerchantConnection = opened.connection;
    const answer = await connection.call('get_checkout', { id: row.merchant_checkout_id });
    if (isNotFound(answer)) return { kind: 'not_found' };
    const read = answer.ok ? readCheckout(answer.value) : null;
    // An answer about another checkout is not this session's (as an order's, `orders.ts`).
    if (read?.ok !== true || read.value.id !== row.merchant_checkout_id) return null;
    const { status, order } = read.value;
    return {
      kind: 'status',
      status: typeof status === 'string' ? status : 'unknown',
      ...(order !== undefined ? { order: { id: order.id, permalinkUrl: order.permalinkUrl } } : {}),
    };
  }

  /** A terminal answer settles the session; true when it did. */
  private settleIfTerminal(
    row: CheckoutRow,
    answer:
      | { kind: 'not_found' }
      | { kind: 'status'; status: string; order?: { id: string; permalinkUrl: string } },
  ): boolean {
    if (answer.kind === 'not_found') {
      this.settle(row, 'unknown', null);
      return true;
    }
    if (answer.status === 'canceled') {
      this.settle(row, 'canceled', 'canceled');
      return true;
    }
    if (answer.status === 'completed' && answer.order !== undefined) {
      const now = this.deps.nowMs();
      this.deps.store.completeCheckout(row.session_id, WATCHED, answer.order, now, (done) =>
        this.deps.onCompleted?.(done, now),
      );
      return true;
    }
    return false;
  }

  private settle(row: CheckoutRow, to: CheckoutState, status: string | null): void {
    this.deps.store.moveCheckout(row.session_id, WATCHED, to, this.deps.nowMs(), {
      watch_next_at: null,
      ...(status !== null ? { last_status: status } : {}),
    });
  }
}

/** The session's effective expiry (§3.12); its creation + 6 hours when unknown. */
function expiryOf(row: CheckoutRow): number {
  return row.effective_expires_at ?? row.created_at + 6 * 60 * 60_000;
}
