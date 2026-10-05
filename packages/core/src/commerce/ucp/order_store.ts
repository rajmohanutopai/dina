/**
 * UCP orders (UCP plan §3.14; migration 66). Synchronous SQL on the identity
 * database; the protocol work is the order service's (`orders.ts`).
 *
 * Each order has one reconciler: a holder, a lease and a fencing generation,
 * taken in one statement. Only the holder of the current generation writes,
 * and it writes the snapshot, the summary, the kept record and any notices
 * together, so an answer is applied whole or not at all.
 */

import { isPlainObject, parseStrictJson } from '@dina/a2a';
import {
  absorbOrder,
  emptyOrderRecord,
  orderRecordFromJson,
  orderRecordToJson,
  type Order,
  type OrderRecord,
} from '@dina/ucp';

import { afterPromptedRead, type ReadOutcome } from './prompts';

import type { DatabaseAdapter, DBRow } from '../../storage/db_adapter';

export type OrderState = 'open' | 'not_shared' | 'closed';
/** `owner`: a webhook-only order the owner marked done (§3.13). */
export type OrderCloseReason = 'settled' | 'not_found' | 'not_shared' | 'aged' | 'owner';

export interface OrderRow {
  merchant_origin: string;
  order_id: string;
  checkout_id: string;
  /** The local session it came from; null for one first seen by webhook. */
  session_id: string | null;
  leaf_profile_url: string;
  permalink_url: string;
  version: string;
  transport: 'mcp' | 'rest';
  state: OrderState;
  close_reason: OrderCloseReason | null;
  /** The kept record (`orderRecordToJson`): event and adjustment ids, for good. */
  record_json: string;
  /** The derived summary (`OrderSummary`); kept after close. */
  summary_json: string | null;
  /** The merchant's last answer; dropped at close. */
  snapshot_json: string | null;
  /** Interruptions not yet raised as cards (`orders.ts` raises them). */
  notices_json: string;
  /** The `purchase_decision` vault item recording this purchase; null until written. */
  decision_item_id: string | null;
  /**
   * Set while polling waits for the owner to link an account (a Bearer
   * challenge, §3.14, §3.17): the scopes the merchant asked for, as JSON.
   */
  link_scopes: string | null;
  /** What verified webhook bodies said while the order was open (`readPendingPush`); null: none. */
  pushed_json: string | null;
  polls: number;
  /** A webhook's prompt not yet answered by a successful read (`prompts.ts`). */
  prompted_at: number | null;
  last_change_at: number;
  next_poll_at: number | null;
  closed_at: number | null;
  lease_holder: string | null;
  lease_until: number | null;
  generation: number;
  created_at: number;
  updated_at: number;
}

export type NewOrder = Pick<
  OrderRow,
  | 'merchant_origin'
  | 'order_id'
  | 'checkout_id'
  | 'session_id'
  | 'leaf_profile_url'
  | 'permalink_url'
  | 'version'
  | 'transport'
  | 'record_json'
  | 'next_poll_at'
  | 'created_at'
>;

/** What one applied answer writes. */
export type OrderWrite = Partial<
  Pick<
    OrderRow,
    | 'state'
    | 'close_reason'
    | 'record_json'
    | 'summary_json'
    | 'snapshot_json'
    | 'last_change_at'
    | 'next_poll_at'
    | 'closed_at'
    | 'link_scopes'
    | 'pushed_json'
  >
> & {
  /** Notices to add to the ones not yet taken. */
  notices?: readonly unknown[];
};

/**
 * What verified webhook bodies told Dina about an open order (§3.13): every
 * event and adjustment they named, folded together (`absorbOrder` from an
 * empty record, so none is lost however many came, and an adjustment keeps
 * whether it was ever failed or completed), and the latest body alone, for
 * the summary "as sent". Merged into the order's record when the merchant
 * turns out not to share it; dropped once a Get Order begun after the latest
 * body answers.
 */
export interface PendingPush {
  record: OrderRecord;
  latest: { at: number; body: unknown };
}

/** A stored pending push; null when there is none or it does not read. */
export function readPendingPush(json: string | null): PendingPush | null {
  if (json === null) return null;
  const parsed = parseStrictJson(json);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const v = parsed.value as Record<string, unknown>;
  const record = typeof v.record === 'string' ? orderRecordFromJson(v.record) : null;
  const latest = v.latest as { at?: unknown; body?: unknown } | null | undefined;
  if (
    record === null ||
    latest === null ||
    typeof latest !== 'object' ||
    !Number.isSafeInteger(latest.at)
  )
    return null;
  return { record, latest: { at: latest.at as number, body: latest.body } };
}

export interface OrderKey {
  merchant_origin: string;
  order_id: string;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function orderRow(r: DBRow): OrderRow {
  return {
    merchant_origin: String(r.merchant_origin),
    order_id: String(r.order_id),
    checkout_id: String(r.checkout_id),
    session_id: str(r.session_id),
    leaf_profile_url: String(r.leaf_profile_url),
    permalink_url: String(r.permalink_url),
    version: String(r.version),
    transport: String(r.transport) as OrderRow['transport'],
    state: String(r.state) as OrderState,
    close_reason: str(r.close_reason) as OrderCloseReason | null,
    record_json: String(r.record_json),
    summary_json: str(r.summary_json),
    snapshot_json: str(r.snapshot_json),
    notices_json: String(r.notices_json ?? '[]'),
    decision_item_id: str(r.decision_item_id),
    link_scopes: str(r.link_scopes),
    pushed_json: str(r.pushed_json),
    polls: Number(r.polls ?? 0),
    prompted_at: num(r.prompted_at),
    last_change_at: Number(r.last_change_at),
    next_poll_at: num(r.next_poll_at),
    closed_at: num(r.closed_at),
    lease_holder: str(r.lease_holder),
    lease_until: num(r.lease_until),
    generation: Number(r.generation ?? 0),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

/** The notices kept on a row, each re-checked; one that does not read is dropped, never shown half-read. */
export function storedNotices(text: string): Record<string, unknown>[] {
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const n of parsed.value as unknown[])
    if (isPlainObject(n) && typeof n.kind === 'string' && typeof n.id === 'string') out.push(n);
  return out;
}

const KEY = `merchant_origin = ? AND order_id = ?`;
const keyOf = (k: OrderKey) => [k.merchant_origin, k.order_id];

export class UcpOrderStore {
  constructor(private readonly db: DatabaseAdapter) {}

  transaction<T>(fn: () => T): T {
    let out: T | undefined;
    this.db.transaction(() => {
      out = fn();
    });
    return out as T;
  }

  /** Start following an order; false when it is followed already. */
  insert(row: NewOrder): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO ucp_orders (merchant_origin, order_id, checkout_id, session_id,
           leaf_profile_url, permalink_url, version, transport, state, record_json, last_change_at,
           next_poll_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        [
          row.merchant_origin,
          row.order_id,
          row.checkout_id,
          row.session_id,
          row.leaf_profile_url,
          row.permalink_url,
          row.version,
          row.transport,
          row.record_json,
          row.created_at,
          row.next_poll_at,
          row.created_at,
          row.created_at,
        ],
      ) > 0
    );
  }

  get(key: OrderKey): OrderRow | null {
    const rows = this.db.query(`SELECT * FROM ucp_orders WHERE ${KEY}`, keyOf(key));
    return rows.length === 0 ? null : orderRow(rows[0] as DBRow);
  }

  bySession(sessionId: string): OrderRow | null {
    const rows = this.db.query(`SELECT * FROM ucp_orders WHERE session_id = ?`, [sessionId]);
    return rows.length === 0 ? null : orderRow(rows[0] as DBRow);
  }

  /** Orders whose next poll (or, webhook-only, whose close) is due, oldest first. */
  due(now: number, limit: number): OrderRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_orders WHERE state IN ('open', 'not_shared') AND next_poll_at IS NOT NULL
          AND next_poll_at <= ? ORDER BY next_poll_at LIMIT ?`,
        [now, limit],
      )
      .map((r) => orderRow(r as DBRow));
  }

  /** The newest orders, for My Orders. */
  recent(limit: number): OrderRow[] {
    return this.db
      .query(`SELECT * FROM ucp_orders ORDER BY created_at DESC LIMIT ?`, [limit])
      .map((r) => orderRow(r as DBRow));
  }

  /**
   * Take the order's reconciler: the generation now held, or null while
   * another holder's lease runs. A lease past its end is taken over, and the
   * generation moves on, so the old holder can no longer write.
   */
  takeLease(key: OrderKey, holder: string, now: number, leaseMs: number): number | null {
    const taken = this.db.run(
      `UPDATE ucp_orders SET lease_holder = ?, lease_until = ?, generation = generation + 1,
         updated_at = ? WHERE ${KEY} AND (lease_holder IS NULL OR lease_until <= ?)`,
      [holder, now + leaseMs, now, ...keyOf(key), now],
    );
    if (taken === 0) return null;
    return this.get(key)?.generation ?? null;
  }

  /** Give the reconciler back; nothing when the generation moved on. */
  releaseLease(key: OrderKey, holder: string, generation: number): void {
    this.db.run(
      `UPDATE ucp_orders SET lease_holder = NULL, lease_until = NULL
        WHERE ${KEY} AND lease_holder = ? AND generation = ?`,
      [...keyOf(key), holder, generation],
    );
  }

  /**
   * Write what an answer changed, only while `generation` is current: false
   * when a newer holder took the order over (the answer is dropped whole).
   * `read`: how the read behind it ended, which answers (or keeps) a
   * webhook's prompt; an order no longer polled drops its prompt.
   */
  apply(
    key: OrderKey,
    holder: string,
    generation: number,
    write: OrderWrite,
    now: number,
    read?: ReadOutcome,
  ): boolean {
    return this.transaction(() => {
      const row = this.get(key);
      if (row === null || row.lease_holder !== holder || row.generation !== generation)
        return false;
      const { notices, ...fields } = write;
      const set: Record<string, unknown> = { ...fields, polls: row.polls + 1, updated_at: now };
      if (row.prompted_at !== null) {
        if ((write.state ?? row.state) !== 'open') set.prompted_at = null;
        else if (read !== undefined) {
          const chosen = 'next_poll_at' in write ? (write.next_poll_at ?? null) : row.next_poll_at;
          const after = afterPromptedRead(row.prompted_at, chosen, read, now);
          set.next_poll_at = after.next;
          if (after.clear) set.prompted_at = null;
        }
      }
      if (notices !== undefined && notices.length > 0)
        set.notices_json = JSON.stringify([...storedNotices(row.notices_json), ...notices]);
      const entries = Object.entries(set);
      this.db.run(
        `UPDATE ucp_orders SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE ${KEY}`,
        [...entries.map(([, v]) => v), ...keyOf(key)],
      );
      return true;
    });
  }

  /**
   * A webhook's prompt: poll as soon as the sweep can, and keep asking until a
   * read that began after it succeeds (`prompts.ts`).
   */
  /**
   * Fold a verified webhook body into the open order's pending push (§3.13):
   * its events and adjustments join the record kept so far, and it becomes
   * the latest body. Nothing is dropped, however many arrive.
   */
  holdPushed(key: OrderKey, order: Order, body: unknown, now: number): void {
    this.transaction(() => {
      const row = this.get(key);
      if (row === null || row.state !== 'open') return;
      const before = readPendingPush(row.pushed_json);
      const { record } = absorbOrder(before?.record ?? emptyOrderRecord(), order);
      const next = { record: orderRecordToJson(record), latest: { at: now, body } };
      this.db.run(`UPDATE ucp_orders SET pushed_json = ? WHERE ${KEY}`, [
        JSON.stringify(next),
        ...keyOf(key),
      ]);
    });
  }

  requestPoll(key: OrderKey, now: number): void {
    this.db.run(
      `UPDATE ucp_orders SET next_poll_at = ?, prompted_at = ?, updated_at = ?
        WHERE ${KEY} AND state = 'open'`,
      [now, now, now, ...keyOf(key)],
    );
  }

  /** Orders with interruptions not yet raised as cards. */
  withNotices(limit: number): OrderRow[] {
    return this.db
      .query(`SELECT * FROM ucp_orders WHERE notices_json != '[]' ORDER BY updated_at LIMIT ?`, [
        limit,
      ])
      .map((r) => orderRow(r as DBRow));
  }

  /** Clear the notices just raised; false when more arrived meanwhile (they are raised next pass). */
  takeNotices(key: OrderKey, seen: string): boolean {
    return (
      this.db.run(`UPDATE ucp_orders SET notices_json = '[]' WHERE ${KEY} AND notices_json = ?`, [
        ...keyOf(key),
        seen,
      ]) > 0
    );
  }

  /**
   * Orders whose purchase is not yet recorded in the vault, once there is
   * something to record: the order has been read (or a body sent), or it
   * closed without either (recorded then with what Dina knows).
   */
  decisionsDue(limit: number): OrderRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_orders WHERE decision_item_id IS NULL
          AND (summary_json IS NOT NULL OR state = 'closed') ORDER BY created_at LIMIT ?`,
        [limit],
      )
      .map((r) => orderRow(r as DBRow));
  }

  setDecisionItem(key: OrderKey, itemId: string): void {
    this.db.run(`UPDATE ucp_orders SET decision_item_id = ? WHERE ${KEY}`, [itemId, ...keyOf(key)]);
  }

  /**
   * The owner marks a webhook-only order done (§3.13): closed, its snapshot
   * dropped. False for any other order, which closes by Dina's own rule.
   */
  closeByOwner(key: OrderKey, now: number): boolean {
    return (
      this.db.run(
        `UPDATE ucp_orders SET state = 'closed', close_reason = 'owner', closed_at = ?,
           snapshot_json = NULL, pushed_json = NULL, next_poll_at = NULL, prompted_at = NULL,
           updated_at = ?
          WHERE ${KEY} AND state = 'not_shared'`,
        [now, now, ...keyOf(key)],
      ) > 0
    );
  }

  /** The owner linked an account at this merchant: its orders waiting for that are polled now. */
  resumeAfterLink(origin: string, now: number): number {
    return this.db.run(
      `UPDATE ucp_orders SET link_scopes = NULL, next_poll_at = ?, updated_at = ?
        WHERE merchant_origin = ? AND state = 'open' AND link_scopes IS NOT NULL`,
      [now, now, origin],
    );
  }

  /** Webhook-only orders made due now: the node stopped taking webhooks, so they close. */
  wakeNotShared(now: number): void {
    this.db.run(
      `UPDATE ucp_orders SET next_poll_at = ? WHERE state = 'not_shared' AND next_poll_at > ?`,
      [now, now],
    );
  }
}
