/**
 * The quote-attempt window `admitQuoteRequest` needs (§14.3, §20.10, WS-2.11).
 *
 * `admitQuoteRequest` is pure and takes its history as an argument, on the
 * stated grounds that the CALLER should own retention: "a supplier should not
 * accumulate a permanent log of who asked what, which would be its own privacy
 * problem". This is that caller, and forgetting is its main job.
 *
 * IN MEMORY, AND DELIBERATELY. A durable table would be exactly the permanent
 * log the pure function's comment warns against, and it would survive a
 * restore — so a node that came back would still be refusing a customer whose
 * budget was spent in a window that has since passed. Losing the window on
 * restart costs one window of protection against a prober patient enough to
 * wait for a reboot they cannot observe; keeping it durably costs a real
 * customer a refusal they cannot understand. The first is the cheaper mistake.
 *
 * IT FORGETS ON EVERY READ, not on a timer. A sweeper would be a second thing
 * to wire and a second thing to forget to wire — and this codebase's most
 * common defect is precisely the thing nobody wired. Pruning where the data is
 * already being touched needs no scheduler and cannot drift.
 */

import type { QuoteAttempt } from './probing_resistance';

/**
 * A hard ceiling on retained attempts per counterparty, independent of the
 * window.
 *
 * Without it a peer that sends ten thousand requests inside one window makes
 * this node hold ten thousand timestamps for them — the refusal would be
 * correct and the memory would not. The cap is far above any real budget, so
 * dropping the OLDEST entries can never make a refusal into an admission: the
 * count is already past every budget by then.
 */
export const MAX_RETAINED_ATTEMPTS_PER_PEER = 512;

export class QuoteAttemptLedger {
  private readonly byPeer = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  /**
   * The attempts inside the window for one counterparty, pruning as it reads.
   *
   * Returns the shape `admitQuoteRequest` wants rather than raw timestamps, so
   * the two cannot drift over what an "attempt" is.
   */
  recent(fromDid: string, nowMs: number): QuoteAttempt[] {
    const kept = this.prune(fromDid, nowMs);
    return kept.map((atMs) => ({ fromDid, atMs }));
  }

  /**
   * Record an attempt. Called only when the request is ADMITTED: a refused
   * request must not spend budget, or a peer past their limit could never
   * recover — every refusal would extend the window that caused it.
   */
  record(fromDid: string, nowMs: number): void {
    const kept = this.prune(fromDid, nowMs);
    kept.push(nowMs);
    if (kept.length > MAX_RETAINED_ATTEMPTS_PER_PEER) {
      kept.splice(0, kept.length - MAX_RETAINED_ATTEMPTS_PER_PEER);
    }
    this.byPeer.set(fromDid, kept);
  }

  /** Drop what has aged out, and drop the peer entirely once nothing is left. */
  private prune(fromDid: string, nowMs: number): number[] {
    const since = nowMs - this.windowMs;
    const kept = (this.byPeer.get(fromDid) ?? []).filter((atMs) => atMs > since);
    if (kept.length === 0) {
      // Not merely empty — REMOVED. An empty array per peer that ever asked is
      // still a list of everyone who ever asked, which is the log this is
      // supposed not to keep.
      this.byPeer.delete(fromDid);
    } else {
      this.byPeer.set(fromDid, kept);
    }
    return kept;
  }

  /** Peers currently inside the window. For tests and operator counts only. */
  peerCount(nowMs: number): number {
    for (const fromDid of [...this.byPeer.keys()]) this.prune(fromDid, nowMs);
    return this.byPeer.size;
  }
}

let ledger: QuoteAttemptLedger | null = null;

/** Install at boot, alongside the commerce runtime. Null on shutdown. */
export function installQuoteAttemptLedger(value: QuoteAttemptLedger | null): void {
  ledger = value;
}

/**
 * Null until commerce is composed.
 *
 * A caller that finds null must NOT fall through to "admit": an unwired
 * probing defence that silently permits is the state this whole item exists to
 * leave behind.
 */
export function getQuoteAttemptLedger(): QuoteAttemptLedger | null {
  return ledger;
}
