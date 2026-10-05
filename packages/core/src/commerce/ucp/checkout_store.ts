/**
 * UCP checkout sessions, carts and the request journal (UCP plan §3.7, §3.10,
 * §3.12; migration 65). Synchronous SQL on the identity database; the
 * protocol work is the dispatcher's (`dispatch.ts`).
 *
 * Each session and cart has one dispatch slot: a holder, a lease and a
 * fencing generation, taken in a transaction. A mutation is sent only by the
 * holder; a late answer is written only while its generation is current.
 *
 * The journal keeps every state change Dina sends, written before its first
 * send: the idempotency key, the exact bytes (for MCP the whole JSON-RPC
 * envelope), their SHA-256, and a retry deadline. Its states:
 *  - `prepared`: written; no byte of it has left (or every attempt failed
 *    before any could);
 *  - `in_doubt`: it may have reached the merchant. Set durably before the
 *    bytes go, so a crash mid-send reads as "may have been sent"; put back
 *    to `prepared` only when the transport proves nothing left;
 *  - `settled`: a definite answer is recorded;
 *  - `abandoned`: past its deadline or its gate unsettled; never sent again.
 * Settled and abandoned rows go 48 hours after they end.
 */

import { afterPromptedRead, type ReadOutcome } from './prompts';

import type { DatabaseAdapter, DBRow } from '../../storage/db_adapter';

export type CheckoutState =
  | 'awaiting_approval'
  | 'creating'
  | 'open'
  | 'handed_off'
  | 'completed'
  | 'canceled'
  | 'not_completed'
  | 'unknown'
  | 'declined'
  | 'create_unknown'
  | 'unsettled'
  | 'create_failed'
  /** The merchant's negotiation changed after the yes and before the create: asked again. */
  | 'stale'
  /** The permit ran out before the create was sent: nothing reached the merchant. */
  | 'lapsed';

export type CartState = 'creating' | 'open' | 'gone';

export type OwnerKind = 'checkout' | 'cart';

/** What a slot and its row have in common. */
interface Slotted {
  slot_holder: string | null;
  slot_lease_until: number | null;
  slot_generation: number;
}

export interface CheckoutRow extends Slotted {
  session_id: string;
  conversation: string;
  merchant_origin: string;
  leaf_profile_url: string;
  version: string;
  transport: 'mcp' | 'rest';
  endpoint: string;
  capabilities_hash: string;
  profile_hash: string;
  intent_json: string;
  intent_hash: string;
  /** The `ucp_checkout_start` card's task id. */
  review_id: string;
  /** The start permit the owner's approval minted (§3.7); null until then. */
  permit_id: string | null;
  /** The permit's own end: minted + 6 hours. */
  permit_expires_at: number | null;
  /** Why the permit ended early (terminal state, hand-off, a lost create); null while it may still be used. */
  permit_void_reason: string | null;
  merchant_checkout_id: string | null;
  state: CheckoutState;
  effective_expires_at: number | null;
  last_answer_json: string | null;
  /**
   * Where the hand-off sent the owner (§3.8): `continue_url` is this session, which the
   * watcher follows (U3); a permalink or a home page is not.
   */
  handoff_source: string | null;
  /** When the hand-off card was raised (the watcher's schedule counts from it). */
  handed_off_at: number | null;
  /** The watcher's next Get Checkout; null when it watches no more. */
  watch_next_at: number | null;
  /** Get Checkouts the watcher has made. */
  watch_reads: number;
  /** A webhook's prompt not yet answered by a successful read (`prompts.ts`). */
  prompted_at: number | null;
  /** When the owner was told this session ended unconfirmed (§3.7: once). */
  told_at: number | null;
  /** The checkout status last read (`complete_in_progress` past expiry is never asked again). */
  last_status: string | null;
  /** The order the completed checkout named (§3.12), and its permalink. */
  order_id: string | null;
  order_permalink_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface CartRow extends Slotted {
  cart_id: string;
  conversation: string;
  merchant_origin: string;
  version: string;
  transport: 'mcp' | 'rest';
  endpoint: string;
  merchant_cart_id: string | null;
  state: CartState;
  expires_at: number | null;
  last_answer_json: string | null;
  created_at: number;
  updated_at: number;
}

export type RequestState = 'prepared' | 'in_doubt' | 'settled' | 'abandoned';

export interface RequestRow {
  idempotency_key: string;
  owner_kind: OwnerKind;
  owner_id: string;
  operation: string;
  merchant_origin: string;
  transport: 'mcp' | 'rest';
  endpoint: string;
  /** The merchant's resource id the request names (update, cancel), when it names one. */
  target_id: string | null;
  /** The JSON-RPC id inside an MCP envelope (the answer is read by it); null over REST. */
  rpc_id: string | null;
  request_bytes: Uint8Array;
  request_sha256: string;
  state: RequestState;
  first_sent_at: number | null;
  retry_deadline: number;
  /** 409s to these identical bytes during the hand-off barrier (§3.7): at most three are waited out. */
  conflicts: number;
  /** Not to be sent again before this (the merchant's Retry-After). */
  not_before: number | null;
  outcome_json: string | null;
  created_at: number;
  settled_at: number | null;
}

/** A held slot: the generation that fences its writes. */
export interface Slot {
  ownerKind: OwnerKind;
  ownerId: string;
  holder: string;
  generation: number;
}

/** Settled and abandoned journal rows are kept this long (§3.10). */
export const REQUEST_RETENTION_MS = 48 * 60 * 60_000;

const TABLE: Record<OwnerKind, { table: string; key: string }> = {
  checkout: { table: 'ucp_checkouts', key: 'session_id' },
  cart: { table: 'ucp_carts', key: 'cart_id' },
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === 'string') return new TextEncoder().encode(v);
  throw new Error('ucp_requests: request_bytes is not a blob');
}

function checkoutRow(r: DBRow): CheckoutRow {
  return {
    session_id: String(r.session_id),
    conversation: String(r.conversation),
    merchant_origin: String(r.merchant_origin),
    leaf_profile_url: String(r.leaf_profile_url),
    version: String(r.version),
    transport: r.transport === 'rest' ? 'rest' : 'mcp',
    endpoint: String(r.endpoint),
    capabilities_hash: String(r.capabilities_hash),
    profile_hash: String(r.profile_hash),
    intent_json: String(r.intent_json),
    intent_hash: String(r.intent_hash),
    review_id: String(r.review_id),
    permit_id: str(r.permit_id),
    permit_expires_at: num(r.permit_expires_at),
    permit_void_reason: str(r.permit_void_reason),
    merchant_checkout_id: str(r.merchant_checkout_id),
    state: String(r.state) as CheckoutState,
    effective_expires_at: num(r.effective_expires_at),
    last_answer_json: str(r.last_answer_json),
    handoff_source: str(r.handoff_source),
    handed_off_at: num(r.handed_off_at),
    watch_next_at: num(r.watch_next_at),
    watch_reads: Number(r.watch_reads ?? 0),
    prompted_at: num(r.prompted_at),
    told_at: num(r.told_at),
    last_status: str(r.last_status),
    order_id: str(r.order_id),
    order_permalink_url: str(r.order_permalink_url),
    slot_holder: str(r.slot_holder),
    slot_lease_until: num(r.slot_lease_until),
    slot_generation: Number(r.slot_generation),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function cartRow(r: DBRow): CartRow {
  return {
    cart_id: String(r.cart_id),
    conversation: String(r.conversation),
    merchant_origin: String(r.merchant_origin),
    version: String(r.version),
    transport: r.transport === 'rest' ? 'rest' : 'mcp',
    endpoint: String(r.endpoint),
    merchant_cart_id: str(r.merchant_cart_id),
    state: String(r.state) as CartState,
    expires_at: num(r.expires_at),
    last_answer_json: str(r.last_answer_json),
    slot_holder: str(r.slot_holder),
    slot_lease_until: num(r.slot_lease_until),
    slot_generation: Number(r.slot_generation),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function requestRow(r: DBRow): RequestRow {
  return {
    idempotency_key: String(r.idempotency_key),
    owner_kind: r.owner_kind === 'cart' ? 'cart' : 'checkout',
    owner_id: String(r.owner_id),
    operation: String(r.operation),
    merchant_origin: String(r.merchant_origin),
    transport: r.transport === 'rest' ? 'rest' : 'mcp',
    endpoint: String(r.endpoint),
    target_id: str(r.target_id),
    rpc_id: str(r.rpc_id),
    request_bytes: bytesOf(r.request_bytes),
    request_sha256: String(r.request_sha256),
    state: String(r.state) as RequestState,
    first_sent_at: num(r.first_sent_at),
    retry_deadline: Number(r.retry_deadline),
    conflicts: Number(r.conflicts),
    not_before: num(r.not_before),
    outcome_json: str(r.outcome_json),
    created_at: Number(r.created_at),
    settled_at: num(r.settled_at),
  };
}

export type NewCheckout = Omit<
  CheckoutRow,
  | 'permit_id'
  | 'permit_expires_at'
  | 'permit_void_reason'
  | 'merchant_checkout_id'
  | 'effective_expires_at'
  | 'last_answer_json'
  | 'handoff_source'
  | 'handed_off_at'
  | 'watch_next_at'
  | 'watch_reads'
  | 'prompted_at'
  | 'told_at'
  | 'last_status'
  | 'order_id'
  | 'order_permalink_url'
  | 'slot_holder'
  | 'slot_lease_until'
  | 'slot_generation'
  | 'updated_at'
>;

export type NewCart = Omit<
  CartRow,
  | 'merchant_cart_id'
  | 'expires_at'
  | 'last_answer_json'
  | 'slot_holder'
  | 'slot_lease_until'
  | 'slot_generation'
  | 'updated_at'
>;

export type NewRequest = Omit<
  RequestRow,
  'state' | 'first_sent_at' | 'conflicts' | 'not_before' | 'outcome_json' | 'settled_at'
>;

export class UcpCheckoutStore {
  constructor(private readonly db: DatabaseAdapter) {}

  transaction<T>(fn: () => T): T {
    let out: T | undefined;
    this.db.transaction(() => {
      out = fn();
    });
    return out as T;
  }

  // ------------------------------------------------------------ sessions

  insertCheckout(row: NewCheckout): void {
    this.db.run(
      `INSERT INTO ucp_checkouts (session_id, conversation, merchant_origin, leaf_profile_url, version,
         transport, endpoint, capabilities_hash, profile_hash, intent_json, intent_hash, review_id, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.session_id,
        row.conversation,
        row.merchant_origin,
        row.leaf_profile_url,
        row.version,
        row.transport,
        row.endpoint,
        row.capabilities_hash,
        row.profile_hash,
        row.intent_json,
        row.intent_hash,
        row.review_id,
        row.state,
        row.created_at,
        row.created_at,
      ],
    );
  }

  getCheckout(sessionId: string): CheckoutRow | null {
    const rows = this.db.query(`SELECT * FROM ucp_checkouts WHERE session_id = ?`, [sessionId]);
    return rows.length === 0 ? null : checkoutRow(rows[0] as DBRow);
  }

  checkoutByReview(reviewId: string): CheckoutRow | null {
    const rows = this.db.query(`SELECT * FROM ucp_checkouts WHERE review_id = ?`, [reviewId]);
    return rows.length === 0 ? null : checkoutRow(rows[0] as DBRow);
  }

  /** Move a session from one state to another; false when it was not in `from`. */
  moveCheckout(
    sessionId: string,
    from: readonly CheckoutState[],
    to: CheckoutState,
    now: number,
    set: Partial<
      Pick<
        CheckoutRow,
        | 'permit_void_reason'
        | 'merchant_checkout_id'
        | 'effective_expires_at'
        | 'last_answer_json'
        | 'handoff_source'
        | 'handed_off_at'
        | 'watch_next_at'
        | 'last_status'
        | 'order_id'
        | 'order_permalink_url'
      >
    > = {},
  ): boolean {
    const fields = Object.entries(set);
    const assignments = fields.map(([k]) => `, ${k} = ?`).join('');
    const changed = this.db.run(
      `UPDATE ucp_checkouts SET state = ?, updated_at = ?${assignments}
        WHERE session_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
      [to, now, ...fields.map(([, v]) => v), sessionId, ...from],
    );
    return changed > 0;
  }

  /**
   * Mint the start permit for a session waiting on its card: false when one
   * was minted already (one approval mints at most one permit, ever) or the
   * session moved on.
   */
  mintPermit(sessionId: string, permitId: string, expiresAt: number, now: number): boolean {
    return (
      this.db.run(
        `UPDATE ucp_checkouts SET permit_id = ?, permit_expires_at = ?, updated_at = ?
          WHERE session_id = ? AND state = 'awaiting_approval' AND permit_id IS NULL`,
        [permitId, expiresAt, now, sessionId],
      ) > 0
    );
  }

  /** End a session's permit early; the first reason stands. */
  voidPermit(sessionId: string, reason: string, now: number): void {
    this.db.run(
      `UPDATE ucp_checkouts SET permit_void_reason = ?, updated_at = ?
        WHERE session_id = ? AND permit_id IS NOT NULL AND permit_void_reason IS NULL`,
      [reason, now, sessionId],
    );
  }

  /**
   * Sessions whose next watch read is due: handed off and on the watcher's
   * schedule, or settled without an outcome and prompted by a webhook.
   */
  dueWatches(now: number): CheckoutRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_checkouts WHERE state IN ('handed_off', 'not_completed', 'unknown')
          AND watch_next_at IS NOT NULL AND watch_next_at <= ? ORDER BY watch_next_at`,
        [now],
      )
      .map((r) => checkoutRow(r as DBRow));
  }

  /**
   * Record a session the merchant reports completed (§3.12), from whichever
   * read saw it: the state, the order it names (id and permalink) and its
   * permit voided, with `then` (the order row) in the same transaction, so a
   * completed session never lacks its order. False when it was not in `from`.
   */
  completeCheckout(
    sessionId: string,
    from: readonly CheckoutState[],
    order: { id: string; permalinkUrl: string } | undefined,
    now: number,
    then?: (row: CheckoutRow) => void,
  ): boolean {
    return this.transaction(() => {
      const moved = this.moveCheckout(sessionId, from, 'completed', now, {
        last_status: 'completed',
        watch_next_at: null,
        ...(order !== undefined
          ? { order_id: order.id, order_permalink_url: order.permalinkUrl }
          : {}),
      });
      if (!moved) return false;
      this.voidPermit(sessionId, 'completed', now);
      const done = this.getCheckout(sessionId);
      if (done !== null && done.order_id !== null) then?.(done);
      return true;
    });
  }

  /**
   * After a watcher read (or a read it may not make): a webhook's prompt the
   * read began before keeps the session due at once; one it answered goes; a
   * failed read of an older prompt is tried again soon (`prompts.ts`). Only
   * while the session is one the watcher settles from.
   */
  afterWatchRead(sessionId: string, read: ReadOutcome, now: number): void {
    this.transaction(() => {
      const row = this.getCheckout(sessionId);
      if (row === null || row.prompted_at === null) return;
      const watched =
        row.state === 'handed_off' || row.state === 'not_completed' || row.state === 'unknown';
      const after = afterPromptedRead(row.prompted_at, row.watch_next_at, read, now);
      this.db.run(
        `UPDATE ucp_checkouts SET watch_next_at = ?, prompted_at = ? WHERE session_id = ?`,
        [
          watched ? after.next : row.watch_next_at,
          after.clear || !watched ? null : row.prompted_at,
          sessionId,
        ],
      );
    });
  }

  /**
   * Sessions that ended without Dina knowing what the merchant holds
   * (`create_unknown`, `unsettled`) and whose owner is not yet told (§3.7).
   */
  untold(limit: number): CheckoutRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_checkouts WHERE state IN ('create_unknown', 'unsettled') AND told_at IS NULL
          ORDER BY updated_at LIMIT ?`,
        [limit],
      )
      .map((r) => checkoutRow(r as DBRow));
  }

  /** The owner was told; false when already told. */
  markTold(sessionId: string, now: number): boolean {
    return (
      this.db.run(`UPDATE ucp_checkouts SET told_at = ? WHERE session_id = ? AND told_at IS NULL`, [
        now,
        sessionId,
      ]) > 0
    );
  }

  /** The session a merchant's checkout id names, at that merchant. */
  byMerchantCheckout(merchantOrigin: string, merchantCheckoutId: string): CheckoutRow | null {
    const rows = this.db.query(
      `SELECT * FROM ucp_checkouts WHERE merchant_origin = ? AND merchant_checkout_id = ?`,
      [merchantOrigin, merchantCheckoutId],
    );
    return rows.length === 0 ? null : checkoutRow(rows[0] as DBRow);
  }

  /**
   * A verified webhook about a handed-off session (§3.13): read it at once.
   * False when the session is not one the watcher settles from.
   */
  promptWatch(sessionId: string, now: number): boolean {
    return (
      this.db.run(
        `UPDATE ucp_checkouts SET watch_next_at = ?, prompted_at = ?, updated_at = ?
          WHERE session_id = ? AND state IN ('handed_off', 'not_completed', 'unknown')
            AND handoff_source = 'continue_url'`,
        [now, now, now, sessionId],
      ) > 0
    );
  }

  /**
   * Sessions handed off to their own page since `since` whose outcome is still
   * not known (the reopen recovery). A permalink or home-page hand-off is
   * never watched: Dina cannot follow it.
   */
  unsettledSince(since: number): CheckoutRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_checkouts WHERE state IN ('handed_off', 'not_completed', 'unknown')
          AND handoff_source = 'continue_url' AND handed_off_at >= ? ORDER BY handed_off_at`,
        [since],
      )
      .map((r) => checkoutRow(r as DBRow));
  }

  /** Record a watch read: the status seen, the next read (null: no more), the count. */
  recordWatch(sessionId: string, status: string | null, next: number | null, now: number): void {
    this.db.run(
      `UPDATE ucp_checkouts SET last_status = COALESCE(?, last_status), watch_next_at = ?,
        watch_reads = watch_reads + 1, updated_at = ? WHERE session_id = ?`,
      [status, next, now, sessionId],
    );
  }

  /** A conversation's sessions, newest first. */
  checkoutsOf(conversation: string): CheckoutRow[] {
    return this.db
      .query(`SELECT * FROM ucp_checkouts WHERE conversation = ? ORDER BY created_at DESC`, [
        conversation,
      ])
      .map((r) => checkoutRow(r as DBRow));
  }

  /** Sessions a sweep may have work for: waiting on a card, sending a create, or open. */
  activeCheckouts(): CheckoutRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_checkouts WHERE state IN ('awaiting_approval', 'creating', 'open')
          ORDER BY created_at`,
      )
      .map((r) => checkoutRow(r as DBRow));
  }

  /**
   * Record a read's answer for an open session only if no other answer was
   * stored since the read began (`seen`): an older answer never overwrites a
   * newer update's. False when one was.
   */
  setCheckoutAnswerIfUnchanged(
    sessionId: string,
    seen: string | null,
    now: number,
    set: Pick<CheckoutRow, 'effective_expires_at' | 'last_answer_json'>,
    states: readonly CheckoutState[] = ['open'],
  ): boolean {
    return (
      this.db.run(
        `UPDATE ucp_checkouts SET effective_expires_at = ?, last_answer_json = ?, updated_at = ?
          WHERE session_id = ? AND state IN (${states.map(() => '?').join(', ')})
            AND last_answer_json IS ?`,
        [set.effective_expires_at, set.last_answer_json, now, sessionId, ...states, seen],
      ) > 0
    );
  }

  // ------------------------------------------------------------ carts

  insertCart(row: NewCart): void {
    this.db.run(
      `INSERT INTO ucp_carts (cart_id, conversation, merchant_origin, version, transport, endpoint, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.cart_id,
        row.conversation,
        row.merchant_origin,
        row.version,
        row.transport,
        row.endpoint,
        row.state,
        row.created_at,
        row.created_at,
      ],
    );
  }

  getCart(cartId: string): CartRow | null {
    const rows = this.db.query(`SELECT * FROM ucp_carts WHERE cart_id = ?`, [cartId]);
    return rows.length === 0 ? null : cartRow(rows[0] as DBRow);
  }

  moveCart(
    cartId: string,
    from: readonly CartState[],
    to: CartState,
    now: number,
    set: Partial<Pick<CartRow, 'merchant_cart_id' | 'expires_at' | 'last_answer_json'>> = {},
  ): boolean {
    const fields = Object.entries(set);
    const assignments = fields.map(([k]) => `, ${k} = ?`).join('');
    const changed = this.db.run(
      `UPDATE ucp_carts SET state = ?, updated_at = ?${assignments}
        WHERE cart_id = ? AND state IN (${from.map(() => '?').join(', ')})`,
      [to, now, ...fields.map(([, v]) => v), cartId, ...from],
    );
    return changed > 0;
  }

  /**
   * Record a read's answer for an open cart only if no other answer was
   * stored since the read began (`seen`, the answer it started from): an
   * older answer never overwrites a newer update's. False when one was.
   */
  setCartAnswerIfUnchanged(
    cartId: string,
    seen: string | null,
    now: number,
    set: Pick<CartRow, 'expires_at' | 'last_answer_json'>,
  ): boolean {
    return (
      this.db.run(
        `UPDATE ucp_carts SET expires_at = ?, last_answer_json = ?, updated_at = ?
          WHERE cart_id = ? AND state = 'open' AND last_answer_json IS ?`,
        [set.expires_at, set.last_answer_json, now, cartId, seen],
      ) > 0
    );
  }

  // ------------------------------------------------------------ the slot

  /**
   * Take the owner's dispatch slot for `holder`, for `leaseMs`: when it is
   * free or its lease has run out (a holder that crashed). Taking it bumps
   * the generation, which fences every write of an earlier holder. Null when
   * another holder's lease is live.
   */
  takeSlot(
    kind: OwnerKind,
    ownerId: string,
    holder: string,
    now: number,
    leaseMs: number,
  ): Slot | null {
    const { table, key } = TABLE[kind];
    return this.transaction(() => {
      const changed = this.db.run(
        `UPDATE ${table}
            SET slot_holder = ?, slot_lease_until = ?, slot_generation = slot_generation + 1
          WHERE ${key} = ? AND (slot_holder IS NULL OR slot_lease_until IS NULL OR slot_lease_until <= ?)`,
        [holder, now + leaseMs, ownerId, now],
      );
      if (changed === 0) return null;
      const rows = this.db.query(`SELECT slot_generation FROM ${table} WHERE ${key} = ?`, [
        ownerId,
      ]);
      return {
        ownerKind: kind,
        ownerId,
        holder,
        generation: Number((rows[0] as DBRow).slot_generation),
      };
    });
  }

  /** Whether `slot` is still the current one (no later holder has taken it). */
  holds(slot: Slot): boolean {
    const { table, key } = TABLE[slot.ownerKind];
    const rows = this.db.query(
      `SELECT 1 FROM ${table} WHERE ${key} = ? AND slot_holder = ? AND slot_generation = ?`,
      [slot.ownerId, slot.holder, slot.generation],
    );
    return rows.length > 0;
  }

  /** Extend a held slot's lease (a long send); false when the slot was lost. */
  extendSlot(slot: Slot, now: number, leaseMs: number): boolean {
    const { table, key } = TABLE[slot.ownerKind];
    return (
      this.db.run(
        `UPDATE ${table} SET slot_lease_until = ? WHERE ${key} = ? AND slot_holder = ? AND slot_generation = ?`,
        [now + leaseMs, slot.ownerId, slot.holder, slot.generation],
      ) > 0
    );
  }

  /** Free a held slot; nothing when a later holder has it. */
  releaseSlot(slot: Slot): void {
    const { table, key } = TABLE[slot.ownerKind];
    this.db.run(
      `UPDATE ${table} SET slot_holder = NULL, slot_lease_until = NULL
        WHERE ${key} = ? AND slot_holder = ? AND slot_generation = ?`,
      [slot.ownerId, slot.holder, slot.generation],
    );
  }

  // ------------------------------------------------------------ the journal

  insertRequest(row: NewRequest): void {
    this.db.run(
      `INSERT INTO ucp_requests (idempotency_key, owner_kind, owner_id, operation, merchant_origin, transport,
         endpoint, target_id, rpc_id, request_bytes, request_sha256, state, retry_deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      [
        row.idempotency_key,
        row.owner_kind,
        row.owner_id,
        row.operation,
        row.merchant_origin,
        row.transport,
        row.endpoint,
        row.target_id,
        row.rpc_id,
        row.request_bytes,
        row.request_sha256,
        row.retry_deadline,
        row.created_at,
      ],
    );
  }

  getRequest(key: string): RequestRow | null {
    const rows = this.db.query(`SELECT * FROM ucp_requests WHERE idempotency_key = ?`, [key]);
    return rows.length === 0 ? null : requestRow(rows[0] as DBRow);
  }

  /** The owner's request not yet settled or abandoned (at most one: one mutation at a time). */
  openRequest(kind: OwnerKind, ownerId: string): RequestRow | null {
    const rows = this.db.query(
      `SELECT * FROM ucp_requests WHERE owner_kind = ? AND owner_id = ? AND state IN ('prepared', 'in_doubt')
        ORDER BY created_at LIMIT 1`,
      [kind, ownerId],
    );
    return rows.length === 0 ? null : requestRow(rows[0] as DBRow);
  }

  /** Every request of an owner, oldest first. */
  requests(kind: OwnerKind, ownerId: string): RequestRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_requests WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at`,
        [kind, ownerId],
      )
      .map((r) => requestRow(r as DBRow));
  }

  /**
   * About to send: the row may have reached the merchant from now on
   * (`in_doubt`), and its first send time is kept. Returns the state it had,
   * to put back if nothing left.
   */
  markMaybeSent(key: string, now: number): RequestState | null {
    const row = this.getRequest(key);
    if (row === null || (row.state !== 'prepared' && row.state !== 'in_doubt')) return null;
    this.db.run(
      `UPDATE ucp_requests SET state = 'in_doubt', first_sent_at = COALESCE(first_sent_at, ?)
        WHERE idempotency_key = ?`,
      [now, key],
    );
    return row.state;
  }

  /**
   * Nothing left this time: back to what it was before the attempt, its
   * first-sent time included (a row whose bytes never left was never sent).
   */
  restoreState(key: string, state: 'prepared' | 'in_doubt', firstSentAt: number | null): void {
    this.db.run(
      `UPDATE ucp_requests SET state = ?, first_sent_at = ?
        WHERE idempotency_key = ? AND state IN ('prepared', 'in_doubt')`,
      [state, firstSentAt, key],
    );
  }

  /** Hold the next resend until `at` (Retry-After). */
  setNotBefore(key: string, at: number | null): void {
    this.db.run(`UPDATE ucp_requests SET not_before = ? WHERE idempotency_key = ?`, [at, key]);
  }

  /** Count one more 409 to these exact bytes; the new count. */
  countConflict(key: string): number {
    this.db.run(`UPDATE ucp_requests SET conflicts = conflicts + 1 WHERE idempotency_key = ?`, [
      key,
    ]);
    return this.getRequest(key)?.conflicts ?? 0;
  }

  settleRequest(key: string, outcomeJson: string, now: number): boolean {
    return (
      this.db.run(
        `UPDATE ucp_requests SET state = 'settled', outcome_json = ?, settled_at = ?
          WHERE idempotency_key = ? AND state IN ('prepared', 'in_doubt')`,
        [outcomeJson, now, key],
      ) > 0
    );
  }

  abandonRequest(key: string, reason: string, now: number): boolean {
    return (
      this.db.run(
        `UPDATE ucp_requests SET state = 'abandoned', outcome_json = ?, settled_at = ?
          WHERE idempotency_key = ? AND state IN ('prepared', 'in_doubt')`,
        [JSON.stringify({ abandoned: reason }), now, key],
      ) > 0
    );
  }

  /** Open rows of one kind of owner past their retry deadline: they can only be abandoned now. */
  staleOpenRequests(kind: OwnerKind, now: number): RequestRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_requests WHERE owner_kind = ? AND state IN ('prepared', 'in_doubt')
          AND retry_deadline <= ?`,
        [kind, now],
      )
      .map((r) => requestRow(r as DBRow));
  }

  /** Delete settled and abandoned rows that ended before `cutoff`. */
  purgeRequests(cutoff: number): void {
    this.db.run(
      `DELETE FROM ucp_requests WHERE state IN ('settled', 'abandoned') AND settled_at < ?`,
      [cutoff],
    );
  }
}
