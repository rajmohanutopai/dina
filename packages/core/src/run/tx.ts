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

/**
 * The ONE re-entrant runner for a given Tier-0 db.
 *
 * "Boots MUST construct exactly one runner per db and pass the SAME instance
 * everywhere" was a rule stated in a comment and enforced by nothing, and the
 * boots did not follow it: each passed a raw `(fn) => db.transaction(fn)` to
 * `setCommandTxRunner`, and the run plane later built a second runner and
 * overwrote the registration. Two depth counters over one db is precisely the
 * nested-`BEGIN` crash the counter exists to prevent — it stayed invisible only
 * because nothing yet nested across the two.
 *
 * Commerce makes that luck run out: its engines write to the same Tier-0 db,
 * and they are composed at storage-init time, long before the run plane exists.
 * So the identity of the runner is derived from the db rather than remembered
 * by each caller. Ask for the runner for a db and you get the same one, whoever
 * you are and whenever you ask.
 */
const TIER0_RUNNERS = new WeakMap<TxCapableDb, TxRunner>();

export function tier0TxRunner(db: TxCapableDb): TxRunner {
  const existing = TIER0_RUNNERS.get(db);
  if (existing !== undefined) return existing;
  const runner = makeReentrantTxRunner(db);
  TIER0_RUNNERS.set(db, runner);
  return runner;
}
