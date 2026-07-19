/**
 * ISVC-10 (E76-02) — the ONE re-entrant Tier-0 transaction coordinator shared by
 * every run-subsystem writer: the command-receipt runner (`setCommandTxRunner`),
 * the owner-facing `RunService`, and the run plane's internal services.
 *
 * Why a single shared instance (not one per component): `better-sqlite3` supports
 * nested `SAVEPOINT`s, but `op-sqlite` (mobile) issues a raw `BEGIN` and a nested
 * `BEGIN` throws "cannot start a transaction within a transaction". If the
 * command-receipt runner opens a transaction and, inside `compute()`, a
 * `RunService`/plane operation opens a SECOND transaction through a DIFFERENT
 * depth counter, op-sqlite crashes and rolls the owner command back. Sharing ONE
 * counter makes the outermost call open the real Tier-0 transaction and every
 * nested call join it inline — one atomic unit (§2.1/§10/§12.5). A nested throw
 * still propagates to the outer `db.transaction`, rolling the whole unit back.
 *
 * Boots MUST construct exactly one runner per Tier-0 db and pass the SAME
 * instance to `setCommandTxRunner`, `new RunService({ tx })`, and
 * `wireRunPlaneNode({ tx })`.
 */

/** A synchronous transaction runner: `fn` executes atomically (all-or-nothing). */
export type TxRunner = (fn: () => void) => void;

/** Minimal Tier-0 db surface a transaction runner needs. */
export interface TxCapableDb {
  transaction: (fn: () => void) => void;
}

/**
 * Build a re-entrant transaction runner over `db`. The returned runner keeps a
 * private depth counter: the outermost call opens `db.transaction`; any call
 * made while a transaction is already open runs `fn` inline (no nested `BEGIN`).
 * Share ONE returned instance across every run-subsystem writer bound to `db`.
 */
export function makeReentrantTxRunner(db: TxCapableDb): TxRunner {
  let depth = 0;
  return (fn: () => void): void => {
    if (depth > 0) {
      fn();
      return;
    }
    depth += 1;
    try {
      db.transaction(fn);
    } finally {
      depth -= 1;
    }
  };
}
