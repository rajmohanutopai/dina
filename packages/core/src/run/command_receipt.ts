/**
 * Durable per-command idempotency receipts (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §12.5). `start` keys on `(owner_principal, route, idempotency_key)` and stores
 * the resulting `run_id`; other commands key on `(owner_principal, run_id, route,
 * idempotency_key)`. Receipts store the request hash + the committed response, so
 * a REPLAYED old command returns the stored response WITHOUT re-executing — a
 * replayed old `resume` can never undo a newer `pause`, across restart.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { DatabaseAdapter } from '../storage/db_adapter';

export interface CommandReceiptRecord {
  receipt_key: string; // owner|run|route|idem (run empty for start)
  owner_principal: string;
  run_id: string;
  route: string;
  idempotency_key: string;
  request_hash: string;
  response_json: string;
  created_at: number;
}

export interface CommandReceiptRepository {
  get(receiptKey: string): CommandReceiptRecord | null;
  put(record: CommandReceiptRecord): void;
  size(): number;
}

export class SQLiteCommandReceiptRepository implements CommandReceiptRepository {
  constructor(private readonly db: DatabaseAdapter) {}
  get(receiptKey: string): CommandReceiptRecord | null {
    const rows = this.db.query('SELECT * FROM run_command_receipts WHERE receipt_key = ? LIMIT 1', [
      receiptKey,
    ]);
    const r = rows[0];
    if (r === undefined) return null;
    return {
      receipt_key: String(r.receipt_key),
      owner_principal: String(r.owner_principal),
      run_id: String(r.run_id),
      route: String(r.route),
      idempotency_key: String(r.idempotency_key),
      request_hash: String(r.request_hash),
      response_json: String(r.response_json),
      created_at: Number(r.created_at),
    };
  }
  put(record: CommandReceiptRecord): void {
    // First-writer-wins: a concurrent duplicate is ignored (the winner's
    // response is authoritative).
    this.db.run(
      `INSERT INTO run_command_receipts
         (receipt_key, owner_principal, run_id, route, idempotency_key, request_hash, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(receipt_key) DO NOTHING`,
      [
        record.receipt_key,
        record.owner_principal,
        record.run_id,
        record.route,
        record.idempotency_key,
        record.request_hash,
        record.response_json,
        record.created_at,
      ],
    );
  }
  size(): number {
    const rows = this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM run_command_receipts');
    return rows[0]?.n ?? 0;
  }
}

export class InMemoryCommandReceiptRepository implements CommandReceiptRepository {
  private readonly rows = new Map<string, CommandReceiptRecord>();
  get(receiptKey: string): CommandReceiptRecord | null {
    const r = this.rows.get(receiptKey);
    return r ? { ...r } : null;
  }
  put(record: CommandReceiptRecord): void {
    if (!this.rows.has(record.receipt_key)) this.rows.set(record.receipt_key, { ...record });
  }
  size(): number {
    return this.rows.size;
  }
}

let repo: CommandReceiptRepository | null = null;
export function setCommandReceiptRepository(r: CommandReceiptRepository | null): void {
  repo = r;
}
export function getCommandReceiptRepository(): CommandReceiptRepository | null {
  return repo;
}

/**
 * The Tier-0 transaction runner used to make the command mutation + its receipt
 * write ONE atomic commit (§5 "All authoritative changes run in one per-run Core
 * transaction", §12.5). Without it, a crash between the mutation's commit and the
 * receipt's commit loses the receipt, so a replayed old command re-executes — a
 * replayed old `resume` could undo a newer `pause` across restart. Boot wires the
 * SQLite `db.transaction`; the default passthrough (dev/test, in-memory repos)
 * keeps the correct result, only without crash-atomicity.
 */
let txRunner: ((fn: () => void) => void) | null = null;
export function setCommandTxRunner(fn: ((fn: () => void) => void) | null): void {
  txRunner = fn;
}

/** Build the receipt key. `start` passes an empty runId. */
export function commandReceiptKey(
  ownerPrincipal: string,
  runId: string,
  route: string,
  idempotencyKey: string,
): string {
  return `${ownerPrincipal}\u0000${runId}\u0000${route}\u0000${idempotencyKey}`;
}

export function hashRequest(body: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(body ?? null))));
}

/** A replay carried the SAME idempotency key but a DIFFERENT request body — a
 *  client bug or a replay attack. Routes map this to a 409 (never a 500). */
export class CommandIdempotencyConflictError extends Error {
  constructor() {
    super('command idempotency key reused with a different request body');
    this.name = 'CommandIdempotencyConflictError';
  }
}

export interface RecordOrReplayInput<T> {
  ownerPrincipal: string;
  runId: string; // '' for start
  route: string;
  idempotencyKey: string;
  requestBody: unknown;
  compute: () => T;
}

export interface RecordOrReplayResult<T> {
  response: T;
  replayed: boolean;
}

/**
 * Durable command idempotency (§12.5). If a receipt exists for the key, return
 * the stored response WITHOUT re-executing `compute` (so a replayed command has
 * no side effect); otherwise run `compute`, persist the receipt, and return.
 * Throws if a replay carries a different request body (a client bug / attack).
 */
export function recordOrReplayCommand<T>(input: RecordOrReplayInput<T>): RecordOrReplayResult<T> {
  const store = repo;
  if (store === null) {
    // No durable store wired — execute without idempotency (dev/test fallback).
    return { response: input.compute(), replayed: false };
  }
  const key = commandReceiptKey(
    input.ownerPrincipal,
    input.runId,
    input.route,
    input.idempotencyKey,
  );
  const reqHash = hashRequest(input.requestBody);
  const existing = store.get(key);
  if (existing !== null) {
    if (existing.request_hash !== reqHash) {
      throw new CommandIdempotencyConflictError();
    }
    return { response: JSON.parse(existing.response_json) as T, replayed: true };
  }
  // The mutation + the receipt write commit as ONE transaction (§5/§12.5): a
  // crash can never leave the state changed but the receipt missing (which would
  // let a replayed old command re-execute — e.g. an old `resume` undoing a newer
  // `pause` across restart). The stored response is replayed verbatim, so a replay
  // is byte-idempotent regardless of the original status.
  const runTx = txRunner ?? ((fn) => fn());
  let response!: T;
  runTx(() => {
    response = input.compute();
    store.put({
      receipt_key: key,
      owner_principal: input.ownerPrincipal,
      run_id: input.runId,
      route: input.route,
      idempotency_key: input.idempotencyKey,
      request_hash: reqHash,
      response_json: JSON.stringify(response),
      created_at: Date.now(),
    });
  });
  return { response, replayed: false };
}
