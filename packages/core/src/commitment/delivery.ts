/**
 * Delivery to people who are often offline (COMMITMENT_KERNEL §10, "Delivery:
 * outbox, receipts, holds") — the rules today's term engine applies, moved
 * into the kernel unchanged.
 *
 *   - EVERY SEND HAS A DURABLE INTENT. A document is stored with its outbox
 *     row in one transaction; the first send is tried once the transaction
 *     commits, and the sweep resends until a final receipt or the stop point.
 *   - RECEIPTS. The other side answers each document `stored`, `held` or
 *     `refused`. `stored` and `refused` are final and never replaced; `held`
 *     may move to a final answer. While held, the sender checks once a day.
 *   - EFFECTS AFTER COMMIT. A send, a receipt or an owner card raised inside
 *     a transaction waits until it commits, so a rolled-back act never told
 *     anyone about rows that do not exist.
 *
 * The outbox and the answer book are ports: each engine keeps its own
 * tables, and this module holds only the rules over them.
 */

const HOUR_MS = 60 * 60 * 1000;

export const DELIVERY_TIMINGS = {
  /** Resend every 6 hours until a final receipt. */
  resendEveryMs: 6 * HOUR_MS,
  /**
   * The first resend comes at 6 hours or at half the time left before the
   * document's stop point, whichever is sooner, but no sooner than this — so a
   * document with a near deadline is not given up having been sent once.
   */
  firstResendFloorMs: 5 * 60 * 1000,
  /** A send that failed outright (no sender yet, relay down) is tried again this soon. */
  failedSendRetryMs: 60 * 1000,
  /** Once the other side answers `held`, check once a day. */
  heldResendEveryMs: 24 * HOUR_MS,
} as const;

export type ReceiptOutcome = 'stored' | 'held' | 'refused';

/** When the first resend falls due for a document sent at `nowMs`. */
export function firstResendAt(nowMs: number, stopAtMs: number): number {
  return (
    nowMs +
    Math.min(
      DELIVERY_TIMINGS.resendEveryMs,
      Math.max(DELIVERY_TIMINGS.firstResendFloorMs, Math.floor((stopAtMs - nowMs) / 2)),
    )
  );
}

/** How long until the next resend, given the latest receipt. */
export function resendInterval(receipt: ReceiptOutcome | null): number {
  return receipt === 'held' ? DELIVERY_TIMINGS.heldResendEveryMs : DELIVERY_TIMINGS.resendEveryMs;
}

/**
 * Where a document this node sent stands: sent and not yet answered; held by
 * the other side ("waiting on the other side"); delivered; refused; or not
 * delivered once resends ran out without a final receipt.
 */
export type DeliveryState = 'sent' | 'waiting' | 'delivered' | 'refused' | 'not_delivered';

export function deliveryState(
  row: { receiptOutcome: ReceiptOutcome | null; gaveUpAt: number | null } | null,
): DeliveryState | null {
  if (row === null) return null;
  if (row.receiptOutcome === 'stored') return 'delivered';
  if (row.receiptOutcome === 'refused') return 'refused';
  if (row.gaveUpAt !== null) return 'not_delivered';
  return row.receiptOutcome === 'held' ? 'waiting' : 'sent';
}

/** One send intent, as the outbox keeps it. */
export interface OutboxRow {
  recordDigest: string;
  toDid: string;
  kind: string;
  documentJson: string;
  createdAt: number;
  nextAttemptAt: number;
  stopAt: number;
  attempts: number;
  receiptOutcome: ReceiptOutcome | null;
  receiptAt: number | null;
  gaveUpAt: number | null;
}

/** The outbox an engine keeps. Every write is idempotent on the digest. */
export interface OutboxPort {
  putOutbox(
    row: Omit<OutboxRow, 'attempts' | 'receiptOutcome' | 'receiptAt' | 'gaveUpAt'>,
  ): boolean;
  getOutbox(recordDigest: string): OutboxRow | null;
  /** Intents due for a send: no final receipt, not given up, due now. */
  dueOutbox(nowMs: number, limit: number): OutboxRow[];
  /** Bring the next attempt forward after a first send that failed outright. */
  pullAttemptForward(recordDigest: string, at: number): void;
  markAttempt(recordDigest: string, nextAttemptAt: number): void;
  /**
   * Record a receipt. `stored` and `refused` are final: the port must never
   * replace one (the store's conditional UPDATE). Returns the row as stored.
   */
  recordReceipt(
    recordDigest: string,
    outcome: ReceiptOutcome,
    nowMs: number,
    nextAttemptAt: number,
  ): OutboxRow | null;
  giveUp(recordDigest: string, nowMs: number): void;
}

/** The engine's one transaction coordinator. */
export interface CommitTransaction {
  atomically<T>(label: string, body: () => T): T;
}

/**
 * Transactions whose outside effects wait for the commit. Called inside
 * another act, `atomically` joins that act's transaction: the outer act
 * commits both or neither, and runs the effects of both once it does.
 */
export class AfterCommit {
  private pending: (() => void)[] | null = null;

  constructor(
    private readonly transaction: CommitTransaction,
    private readonly prefix: string,
  ) {}

  atomically<T>(label: string, body: () => T): T {
    if (this.pending !== null) return body();
    this.pending = [];
    let result: T;
    try {
      result = this.transaction.atomically(`${this.prefix}:${label}`, body);
    } catch (err) {
      this.pending = null;
      throw err;
    }
    const effects = this.pending;
    this.pending = null;
    for (const effect of effects) effect();
    return result;
  }

  /** Run an outside effect now, or after the open transaction commits. */
  run(effect: () => void): void {
    if (this.pending === null) effect();
    else this.pending.push(effect);
  }
}

export type SendFn = (toDid: string, kind: string, document: unknown) => Promise<boolean>;

/**
 * The outbox's acts: record an intent and try it once, resend, take a
 * receipt, and the resend half of the sweep. Effects go through `effects`,
 * so each runs only after the transaction that recorded it commits.
 */
export class Outbox {
  constructor(
    private readonly deps: {
      outbox: OutboxPort;
      effects: AfterCommit;
      send: SendFn;
      now: () => number;
    },
  ) {}

  /**
   * Record a send intent and try once now. The document is already retained
   * by the caller; a send that fails un-authors nothing — the sweep resends
   * until a final receipt or the stop point.
   */
  enqueue(args: {
    toDid: string;
    kind: string;
    digest: string;
    document: unknown;
    stopAtMs: number;
  }): void {
    const nowMs = this.deps.now();
    const firstResend = firstResendAt(nowMs, args.stopAtMs);
    this.deps.outbox.putOutbox({
      recordDigest: args.digest,
      toDid: args.toDid,
      kind: args.kind,
      documentJson: JSON.stringify(args.document),
      createdAt: nowMs,
      nextAttemptAt: firstResend,
      stopAt: args.stopAtMs,
    });
    this.deps.outbox.markAttempt(args.digest, firstResend);
    this.deps.effects.run(() => this.sendNow(args.toDid, args.kind, args.document, args.digest));
  }

  /**
   * Send again a document this node already holds (a resend, or the current
   * head answering a stale counter). Best effort, after any open transaction.
   */
  resend(toDid: string, kind: string, document: unknown, digest?: string): void {
    this.deps.effects.run(() => this.sendNow(toDid, kind, document, digest));
  }

  /** Best effort, after any open transaction; nothing records or retries it. */
  sendOnce(toDid: string, kind: string, document: unknown): void {
    this.deps.effects.run(() => {
      void this.deps.send(toDid, kind, document).catch(() => false);
    });
  }

  /** One best-effort send; one that fails outright brings its next attempt forward. */
  private sendNow(toDid: string, kind: string, document: unknown, digest?: string): void {
    void this.deps
      .send(toDid, kind, document)
      .catch(() => false)
      .then((sent) => {
        if (!sent && digest !== undefined)
          this.deps.outbox.pullAttemptForward(
            digest,
            this.deps.now() + DELIVERY_TIMINGS.failedSendRetryMs,
          );
      })
      // The store may be closed by a shutdown while a send was in flight.
      .catch(() => undefined);
  }

  /**
   * Take a receipt from `senderDid`. Null when it answers nothing this node
   * sent that peer; otherwise the outbox row as stored, inside the caller's
   * transaction so what a refusal closes lands with it.
   */
  takeReceipt(args: {
    senderDid: string;
    ofDigest: string;
    outcome: ReceiptOutcome;
  }): OutboxRow | null | 'unknown' {
    const sent = this.deps.outbox.getOutbox(args.ofDigest);
    if (sent === null || sent.toDid !== args.senderDid) return 'unknown';
    const nowMs = this.deps.now();
    const next =
      args.outcome === 'held' ? nowMs + DELIVERY_TIMINGS.heldResendEveryMs : sent.nextAttemptAt;
    return this.deps.outbox.recordReceipt(args.ofDigest, args.outcome, nowMs, next);
  }

  /**
   * The resend half of the sweep. A row past its stop point is given up
   * (`onGiveUp` runs in the same transaction); a row whose stored body no
   * longer reads (`readable` is false) is given up quietly, never resent.
   */
  sweep(args: {
    limit: number;
    readable: (row: OutboxRow) => unknown;
    onGiveUp: (row: OutboxRow) => void;
  }): { resent: number; gaveUp: number } {
    const nowMs = this.deps.now();
    let resent = 0;
    let gaveUp = 0;
    for (const row of this.deps.outbox.dueOutbox(nowMs, args.limit)) {
      if (nowMs > row.stopAt) {
        this.deps.effects.atomically('give_up', () => {
          this.deps.outbox.giveUp(row.recordDigest, nowMs);
          args.onGiveUp(row);
        });
        gaveUp += 1;
        continue;
      }
      const document = args.readable(row);
      if (document === undefined) {
        this.deps.outbox.giveUp(row.recordDigest, nowMs);
        continue;
      }
      this.deps.outbox.markAttempt(row.recordDigest, nowMs + resendInterval(row.receiptOutcome));
      this.resend(row.toDid, row.kind, document, row.recordDigest);
      resent += 1;
    }
    return { resent, gaveUp };
  }
}
