/**
 * The recovery sweep over proposals stuck mid-effect (§3.4, WS-3.4).
 *
 * `beginExecution` marks a proposal `executing` BEFORE the effect, so a crash
 * between "we are about to cause this" and "we know what happened" leaves a
 * readable row rather than a silence. `listExecuting()` was written to find
 * those rows and nothing called it — so on a real node the row stayed
 * `executing` for ever, the runner never got an answer, and the one piece of
 * evidence that an effect might have happened sat in a table nobody read.
 *
 * IT SETTLES; IT NEVER RETRIES. A row in `executing` means the effect may
 * have crossed the wire. Re-running it is how one purchase order becomes two.
 * The sweep's whole job is to convert an open question into the terminal state
 * that says so — `outcome_unknown`, which every retry path in this codebase
 * already refuses to act on.
 *
 * THE DEADLINE IS THE WHOLE DESIGN, and it costs something. A host operation
 * that is slow but alive gets swept, and its real result is then refused by
 * the broker's CAS — so the truth is lost and the owner sees an unknown for an
 * effect that was fine. The alternative is worse in both directions: no
 * deadline leaves crashed rows open for ever, and a mutable terminal state
 * would let a late settler overwrite a decision the owner has already acted
 * on. So the deadline is set far beyond any operation's honest duration, and
 * the cost is a manual check rather than a duplicate effect.
 */

import type { ExtensionOperationBroker, ExtensionProposal } from './extension_broker';

/**
 * How long a proposal may sit in `executing` before the sweep gives up on it.
 *
 * Fifteen minutes: longer than any host operation this node ships (a bounded
 * AppView search, a D2D send, a brokered connector call) by more than an order
 * of magnitude, so a sweep of a live operation means something is already
 * wrong.
 */
export const EXECUTION_DEADLINE_MS = 15 * 60 * 1000;

export interface ExtensionSweepResult {
  /** Proposals settled `outcome_unknown` this pass. */
  abandoned: string[];
  /** Still executing and still inside the deadline. */
  waiting: number;
  /**
   * Rows the sweep found expired but could NOT settle, because something
   * else settled them first. Reported rather than counted as abandoned: the
   * two mean opposite things to an operator.
   */
  raced: string[];
}

export interface ExtensionExecutionSweeperOptions {
  /**
   * Resolved per tick, never captured. Null on a node with no host-operation
   * plane, which is an ordinary quiet tick rather than a boot-order problem.
   */
  broker: () => Pick<ExtensionOperationBroker, 'listExecuting' | 'settle'> | null;
  /** How often the sweep runs. Default `60_000` ms. */
  intervalMs?: number;
  /** Override the give-up deadline. */
  deadlineMs?: number;
  now?: () => number;
  /** Fired once per proposal settled `outcome_unknown`. */
  onAbandoned?: (proposal: ExtensionProposal) => void;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class ExtensionExecutionSweeper {
  private readonly opts: ExtensionExecutionSweeperOptions;
  private readonly intervalMs: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly onAbandoned: (proposal: ExtensionProposal) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<ExtensionExecutionSweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<ExtensionExecutionSweeperOptions['clearInterval']>;

  private handle: unknown | null = null;

  constructor(options: ExtensionExecutionSweeperOptions) {
    this.opts = options;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(
        `ExtensionExecutionSweeper: intervalMs must be > 0 (got ${String(this.intervalMs)})`,
      );
    }
    this.deadlineMs = options.deadlineMs ?? EXECUTION_DEADLINE_MS;
    if (this.deadlineMs <= 0) {
      // A zero deadline would settle every proposal the instant it began
      // executing, which is the sweep destroying the lane it protects.
      throw new Error(
        `ExtensionExecutionSweeper: deadlineMs must be > 0 (got ${String(this.deadlineMs)})`,
      );
    }
    this.now = options.now ?? (() => Date.now());
    this.onAbandoned =
      options.onAbandoned ??
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
    this.runTick();
    this.handle = this.setIntervalFn(() => {
      this.runTick();
    }, this.intervalMs);
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') maybeTimeout.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** One sweep. Null when there is no host-operation plane on this node. */
  runTick(): ExtensionSweepResult | null {
    let broker: Pick<ExtensionOperationBroker, 'listExecuting' | 'settle'> | null;
    try {
      broker = this.opts.broker();
    } catch (err) {
      this.onError(err);
      return null;
    }
    if (broker === null) return null;

    let executing: ExtensionProposal[];
    try {
      executing = broker.listExecuting();
    } catch (err) {
      this.onError(err);
      return null;
    }

    const now = this.now();
    const result: ExtensionSweepResult = { abandoned: [], waiting: 0, raced: [] };
    for (const proposal of executing) {
      // `decidedAt` is when the proposal was PERMITTED, which is the closest
      // stamp to when execution began; `createdAt` would start the clock at
      // proposal time and sweep a row that waited on an owner's approval for
      // longer than the deadline before it ever ran.
      const startedAt = proposal.decidedAt ?? proposal.createdAt;
      if (now - startedAt <= this.deadlineMs) {
        result.waiting += 1;
        continue;
      }
      let settled;
      try {
        settled = broker.settle(proposal.proposalId, {
          kind: 'outcome_unknown',
          detail: `execution exceeded ${String(this.deadlineMs)}ms without settling — the effect may or may not have happened (§3.4)`,
        });
      } catch (err) {
        this.onError(err);
        continue;
      }
      if (!settled.ok) {
        // The broker's CAS refused: a real settler landed between the list
        // and the write. That is the guard working, not a fault.
        result.raced.push(proposal.proposalId);
        continue;
      }
      result.abandoned.push(proposal.proposalId);
      try {
        this.onAbandoned(proposal);
      } catch (err) {
        this.onError(err);
      }
    }
    return result;
  }
}
