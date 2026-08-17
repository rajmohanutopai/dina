/**
 * The tick that drives §12.7's buyer-side re-poll (WS-7.7).
 *
 * `askReconcilePolls` fires the questions; this runs it on a schedule. The
 * two are separate because the sweep is the domain rule and the cadence is
 * not — and because a sweep with its own timer inside would be untestable
 * without a wall clock.
 *
 * WHY TICKS DO NOT OVERLAP. Each pass sends over the network, and the
 * interval is not network-aware: a slow or backed-up transport would stack
 * passes against exactly the peer that is already struggling, and the same
 * order would be asked twice before the first question resolved. One pass in
 * flight at a time; a slow pass simply delays the next.
 *
 * Shape follows `CommerceEpochRevalidator` deliberately: injectable clock and
 * timer, idempotent start/stop, observer hooks that cannot break the loop.
 */

import { askReconcilePolls } from './reconcile_poller';

import type { ServiceQueryDispatch } from './buyer_sender';
import type { ReconcileSend, ReconcileSweepResult } from './reconcile_poller';

export interface ReconcilePollSweeperOptions {
  /**
   * Resolved per tick, never captured. Returns null on a node with no
   * outbound transport, which is an ordinary quiet tick rather than a fault.
   */
  send: () => ReconcileSend | null;
  /** How often the sweep runs. Default `60_000` ms. */
  intervalMs?: number;
  /** Bound on work per pass. */
  maxPerSweep?: number;
  now?: () => number;
  /** Fired for every pass that asked at least one question. */
  onSweep?: (result: ReconcileSweepResult) => void;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class ReconcilePollSweeper {
  private readonly opts: ReconcilePollSweeperOptions;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onSweep: (result: ReconcileSweepResult) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<ReconcilePollSweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<ReconcilePollSweeperOptions['clearInterval']>;

  private handle: unknown | null = null;
  private inFlight = false;

  constructor(options: ReconcilePollSweeperOptions) {
    this.opts = options;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(
        `ReconcilePollSweeper: intervalMs must be > 0 (got ${String(this.intervalMs)})`,
      );
    }
    this.now = options.now ?? (() => Date.now());
    this.onSweep =
      options.onSweep ??
      (() => {
        /* silenced */
      });
    this.onError =
      options.onError ??
      (() => {
        /* silenced */
      });
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.handle !== null) return;
    void this.runTick();
    this.handle = this.setIntervalFn(() => {
      void this.runTick();
    }, this.intervalMs);
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') maybeTimeout.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** One pass. Null when nothing was asked — no transport, or nothing due. */
  async runTick(): Promise<ReconcileSweepResult | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      let send: ReconcileSend | null;
      try {
        send = this.opts.send();
      } catch (err) {
        this.onError(err);
        return null;
      }
      if (send === null) return null;

      let result: ReconcileSweepResult;
      try {
        result = await askReconcilePolls({
          send,
          nowMs: this.now(),
          ...(this.opts.maxPerSweep === undefined ? {} : { maxPerSweep: this.opts.maxPerSweep }),
        });
      } catch (err) {
        this.onError(err);
        return null;
      }
      // Quiet when there was nothing to do: an operator reading a log wants
      // the passes that DID something, and a line per minute per idle node
      // buries them.
      if (result.asked + result.unsent + result.undescribable > 0) {
        try {
          this.onSweep(result);
        } catch (err) {
          this.onError(err);
        }
      }
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * The §12.7 reconcile question, sent over the SAME `service.query` egress
 * every other outbound capability uses.
 *
 * No second path: the four gates, signing and MsgBox apply because this IS
 * that path. A dedicated transport would be a second thing to keep in step
 * with them, and the one that fell behind would be the one nobody looked at.
 */
export const ORDER_RECONCILE_CAPABILITY = 'order_reconcile';
/**
 * The on-the-wire spelling (PC-9): a supplier LISTING refuses bare
 * capability keys, and the receive pipeline admits a query only for a
 * capability the listing declares. The bare name above stays the canonical
 * lane key every recognizer canonicalizes to.
 */
export const ORDER_RECONCILE_WIRE_CAPABILITY = `com.dinakernel.commerce.${ORDER_RECONCILE_CAPABILITY}`;

export function makeServiceQueryReconcileSend(deps: {
  dispatch: ServiceQueryDispatch;
  ttlSeconds?: number;
}): ReconcileSend {
  return async ({ supplierDid, serviceRkey, request }) => {
    // The purchase order id IS the correlation id, exactly as it is for the
    // submission: two dispatches about one order must not look like two
    // different questions.
    const result = await deps.dispatch({
      toDid: supplierDid,
      body: {
        query_id: request.purchase_order_id,
        capability: ORDER_RECONCILE_WIRE_CAPABILITY,
        params: request,
        ttl_seconds: deps.ttlSeconds ?? 300,
        // The listing the order went to. A supplier may offer commerce on a
        // non-default listing, and a query with no `service_uri` is checked
        // against the default one — so omitting this would be refused by
        // exactly the suppliers who run more than one.
        service_uri: `at://${supplierDid}/com.dinakernel.service.profile/${serviceRkey}`,
      },
    });
    // A gate refusal is the ONE case where nothing crossed the boundary and
    // we can say so. Everything else — including a throw, which the caller
    // catches — leaves the record parked and asks again next pass.
    return { sent: result.deniedAt === undefined };
  };
}
