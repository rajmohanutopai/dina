import type { TxRunner } from '../run/tx';

/**
 * Where a commerce transaction begins and ends (ARCH-0b / ARCH-0c —
 * WS-0.2b, WS-0.3b).
 *
 * THE PROBLEM THIS SOLVES IS SCATTER. Before this file, thirteen separate
 * `this.deps.tx(() => …)` calls lived inside three domain classes. Each one
 * was correct; together they meant nobody could answer "what is atomic here?"
 * without reading 2,500 lines, and nothing stopped a fourteenth from being
 * added wrong.
 *
 * TWO WAYS IT GOES WRONG, AND BOTH ARE SILENT UNTIL PRODUCTION:
 *
 *   1. A NESTED transaction. op-sqlite implements transactions with a raw
 *      `BEGIN` and cannot nest, so a domain method that opens one while
 *      already inside another fails ON MOBILE ONLY — and the reentrant test
 *      runner on the server never notices. The codebase already carries two
 *      comments warning callers about this by hand, which is the shape of a
 *      rule that has no enforcement.
 *   2. A FORGOTTEN transaction. A new method that writes two rows without one
 *      leaves the second write able to fail alone, which is exactly how an
 *      acknowledgement comes to exist without its hold settlement.
 *
 * SO THE BOUNDARY BECOMES A THING WITH A NAME. `atomically` refuses a nested
 * call with a message naming BOTH operations, on every platform, in every
 * test — the failure arrives where the mistake is rather than on a phone.
 *
 * WHAT THIS IS NOT. It is not a unit of work, an identity map, or a place to
 * accumulate changes. It runs a function inside a transaction and knows
 * whether one is open. The domain classes keep their logic; what they lose is
 * the decision about where a transaction starts, which is an application
 * concern and was never theirs.
 */
export class CommerceTransaction {
  /**
   * The operation currently holding the boundary, or null.
   *
   * A NAME rather than a counter, because the useful half of a nesting error
   * is which two operations collided. "cannot start a transaction within a
   * transaction" sends a reader to the SQLite docs; "decideOrder cannot open a
   * transaction inside admitOrder" sends them to the call site.
   */
  private open: string | null = null;

  constructor(private readonly run: TxRunner) {}

  /**
   * Run `body` inside one transaction.
   *
   * `label` names the operation for the nesting message. It is required
   * rather than optional so the message can never degrade to "unknown".
   */
  atomically<T>(label: string, body: () => T): T {
    if (this.open !== null) {
      throw new Error(
        `commerce: ${label} cannot open a transaction inside ${this.open} — ` +
          'call the InTx form, which the enclosing transaction already covers',
      );
    }
    this.open = label;
    try {
      let result: T | undefined;
      // The runner's callback returns nothing, so the result travels out
      // through a closure variable. `undefined` is a legal T for some callers,
      // which is why the cast happens once here rather than each call site
      // inventing its own sentinel.
      this.run(() => {
        result = body();
      });
      return result as T;
    } finally {
      // RELEASED IN `finally`, so a throw inside the body does not leave the
      // coordinator believing a transaction is still open. Without this, one
      // failed operation would make every later one report a nesting error
      // and the node would look deadlocked.
      this.open = null;
    }
  }

  /**
   * Is a transaction open right now?
   *
   * For assertions, not for branching. A domain method that CHECKED this and
   * chose whether to open one would be back to deciding its own boundary, and
   * would behave differently depending on who called it — the exact
   * ambiguity this class exists to remove.
   */
  get isOpen(): boolean {
    return this.open !== null;
  }
}
