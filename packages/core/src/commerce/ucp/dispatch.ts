/**
 * Sending a UCP state change (UCP plan §3.7, §3.10): one mutation at a time
 * per session or cart, journaled with its exact bytes before it leaves, and
 * resent with the same bytes and key until it has a definite answer or its
 * retry deadline passes.
 *
 * A mutation runs only under the owner's dispatch slot (`UcpCheckoutStore`):
 *  1. Take the slot. Another holder's live lease: `busy`.
 *  2. An earlier request still open (a crash after send, a lost answer):
 *     nothing is sent (`earlier`). The caller resumes it under that
 *     request's own gate (`resume`), and tries again once it settles.
 *  3. Build the body now, under the slot, from the owner's row as it stands
 *     (`build`); then, in one transaction, pass the gate (`admitFirst`, which
 *     may move the owner, e.g. to `creating`) and write the journal row.
 *  4. Mark the row as possibly sent (`in_doubt`) before the bytes go, so a
 *     crash mid-send reads as "may have reached the merchant". A resend
 *     first checks the deadline, the merchant's Retry-After (`not_before`),
 *     then the gate (`admitResend`).
 *  5. Write what came back under the slot's generation: a late answer to a
 *     holder whose slot was taken is not written (`lost`).
 *
 * Which answers are definite: a resource, a UCP `error_response`, and a
 * refusal the merchant decided (4xx other than 409 and 429; an MCP error
 * other than an internal one or one naming a retry). Not definite: no
 * answer, 429 and 5xx (resent after Retry-After), an answer Dina cannot read
 * or verify. A 409 to bytes never sent before means Dina broke its own key
 * rule: the row is abandoned as a defect, never resent, and the caller
 * reconciles. A 409 to resent bytes (the merchant still running the first)
 * is waited out three times at most (§3.7's barrier), then given up.
 *
 * Whenever a row is abandoned (deadline, gate closed, conflict), the owner is
 * told in the same transaction (`Gate.abandon`), saying whether the request
 * may have reached the merchant, so a session or cart never waits on a row
 * that will not settle. Settled and abandoned rows go 48 hours after they
 * end, on every use.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { UCP_FETCH_LIMITS } from '@dina/net-policy';

import { REQUEST_RETENTION_MS } from './checkout_store';

import type { OwnerKind, RequestRow, RequestState, Slot, UcpCheckoutStore } from './checkout_store';
import type { CallResult, MerchantConnection } from './merchant_client';
import type { PreparedCall } from './transport';
import type { JsonObject } from '@dina/a2a';
import type { OperationName } from '@dina/ucp';

/**
 * How long a slot is held for one send: the transport's worst case (an MCP
 * session begun, the call, a 404 and all of it again, a profile refresh for an
 * unknown key) and room to write.
 */
export const SLOT_LEASE_MS =
  2 * (2 * UCP_FETCH_LIMITS.profile.timeoutMs + UCP_FETCH_LIMITS.checkout.timeoutMs) +
  UCP_FETCH_LIMITS.profile.timeoutMs +
  30_000;

/** How long a 409 to resent bytes is waited out when the merchant names no Retry-After. */
export const CONFLICT_WAIT_MS = 30_000;
/** How long a resend the merchant refused before reaching the key waits, when it names no Retry-After. */
export const REFUSED_RESEND_WAIT_MS = 60_000;
/** 409s to the same resent bytes waited out before giving up (§3.7). */
export const CONFLICT_LIMIT = 3;

export interface Owner {
  kind: OwnerKind;
  id: string;
}

export type AbandonReason = 'deadline' | 'gate_closed' | 'conflict_defect' | 'conflict_limit';

export interface Gate {
  /**
   * A first send, in the transaction that writes its journal row: whether it
   * may go, moving the owner if it must (a create moves a session to
   * `creating`). False refuses it; nothing is written.
   */
  admitFirst(): boolean;
  /** Whether the owner's state still admits a resend of `row`. */
  admitResend(row: RequestRow): boolean;
  /** Apply a definite answer, in the transaction that settles its row. */
  apply(row: RequestRow, result: CallResult): void;
  /**
   * The row will not settle, in the transaction that abandons it: move the
   * owner. `sent`: it may have reached the merchant (reconcile, or call it
   * unknown); false: it certainly did not.
   */
  abandon(row: RequestRow, reason: AbandonReason, sent: boolean): void;
  /**
   * The linked account the owner approved these sends under (a checkout,
   * §3.7), checked at the moment each one goes (first send and resend);
   * null: none. Absent: the owner's sends are not bound to one.
   */
  credential?(): { ref: string; revision: number } | null;
}

export interface Mutation {
  operation: OperationName;
  /**
   * The resource id and body, built under the slot from the owner's row as it
   * stands then (so a full replacement starts from the latest answer); null
   * when the owner no longer admits the change.
   */
  build(): { id?: string; payload?: JsonObject } | null;
  /** The latest moment it may be resent (§3.10, §3.7). */
  retryDeadline: number;
}

export type Outcome =
  /** A definite answer, applied. */
  | { kind: 'answered'; request: RequestRow; result: CallResult }
  /** It may have reached the merchant and its answer is not known yet; resend later, not before `retryAfterMs`. */
  | {
      kind: 'in_doubt';
      request: RequestRow;
      why: 'lost' | 'conflict' | 'retry_later' | 'unreadable';
      retryAfterMs?: number;
    }
  /** Not resent yet: the merchant asked Dina to wait (Retry-After). */
  | { kind: 'wait'; request: RequestRow; retryAfterMs: number }
  /** Nothing left this node (no identity, or the connection never opened); it stays to be sent. */
  | { kind: 'not_left'; request: RequestRow }
  /** Abandoned, the owner told: past its deadline, its gate closed, or a 409 (defect or limit). */
  | { kind: 'abandoned'; request: RequestRow; reason: AbandonReason; sent: boolean }
  /** The slot was taken by another holder while this one sent: its answer was not written. */
  | { kind: 'lost' };

export type MutateResult =
  | Outcome
  /** Another holder has the slot. */
  | { kind: 'busy' }
  /** An earlier request is still open: resume it under its own gate first. Nothing was sent. */
  | { kind: 'earlier'; request: RequestRow }
  /** The owner no longer admits the change (the build or the gate refused it). */
  | { kind: 'not_admitted' }
  /** The merchant client refused to build it (identity, capability, request schema). */
  | { kind: 'not_sent'; reason: string };

/** How an answer is written to the journal. */
type Verdict = 'definite' | 'lost' | 'conflict' | 'retry_later' | 'unreadable' | 'not_left';

/**
 * How an answer is written. `maybeSent`: an earlier attempt of these bytes may
 * have reached the merchant. Then only the operation's own answer (a resource
 * or an `error_response`) settles it: a refusal the merchant raises before it
 * looks at the key (its reading of Dina's profile, the signature) says
 * nothing of the earlier attempt, which may have run (`overview/index.md`
 * "negotiation errors", `signatures.md`).
 */
function verdictOf(
  result: CallResult,
  maybeSent: boolean,
): { verdict: Verdict; retryAfterMs?: number } {
  if (result.ok || result.kind === 'error_response') return { verdict: 'definite' };
  if (result.kind === 'not_sent') return { verdict: 'not_left' };
  if (result.kind === 'network') return { verdict: result.sent ? 'lost' : 'not_left' };
  if (result.kind === 'malformed' || result.kind === 'answer_invalid')
    return { verdict: 'unreadable' };
  const { code, retryAfter, status } = result.error;
  const retryAfterMs = retryAfter !== undefined ? retryAfter * 1000 : undefined;
  const wait = retryAfterMs !== undefined ? { retryAfterMs } : {};
  // The HTTP status: carried beside an MCP error, or the REST status itself.
  const httpStatus =
    result.error.httpStatus ?? (status >= 100 && status < 600 ? status : undefined);
  // A 409 is an idempotency conflict only when it says so (or says nothing): a merchant may
  // answer a state conflict (`invalid_state`, a session it already ended) with 409 too, and
  // that is its definite refusal (plan §3.6 step 7: keyed on the code, never the status alone).
  if (httpStatus === 409 && isKeyConflict(code)) return { verdict: 'conflict', ...wait };
  if (
    code === 'rate_limited' ||
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500)
  )
    return { verdict: 'retry_later', ...wait };
  // An MCP error sent with HTTP 200 (servers outside Streamable HTTP's rule): an internal
  // error, or one naming a retry, may have run; resend it.
  if (status < 0 && (status === -32603 || retryAfter !== undefined))
    return { verdict: 'retry_later', ...wait };
  if (maybeSent)
    return { verdict: 'retry_later', retryAfterMs: retryAfterMs ?? REFUSED_RESEND_WAIT_MS };
  return { verdict: 'definite' };
}

/** Codes that name an idempotency conflict, or none at all (`unknown`). */
function isKeyConflict(code: string): boolean {
  return code === 'unknown' || code === 'conflict' || code.includes('idempotency');
}

export interface DispatcherDeps {
  store: UcpCheckoutStore;
  nowMs: () => number;
  /** A fresh 128-bit idempotency key (UUID v4). */
  newKey: () => string;
  /** This process's holder id, written on the slot. */
  holder: string;
}

export class UcpDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /** Send one mutation for `owner` through `connection` (see the module comment). */
  async mutate(
    owner: Owner,
    connection: MerchantConnection,
    mutation: Mutation,
    gate: Gate,
  ): Promise<MutateResult> {
    const { store } = this.deps;
    store.purgeRequests(this.deps.nowMs() - REQUEST_RETENTION_MS);
    const slot = store.takeSlot(
      owner.kind,
      owner.id,
      this.deps.holder,
      this.deps.nowMs(),
      SLOT_LEASE_MS,
    );
    if (slot === null) return { kind: 'busy' };
    try {
      const earlier = store.openRequest(owner.kind, owner.id);
      if (earlier !== null) return { kind: 'earlier', request: earlier };
      const built = mutation.build();
      if (built === null) return { kind: 'not_admitted' };
      const key = this.deps.newKey();
      const prepared = connection.prepare(mutation.operation, { ...built, idempotencyKey: key });
      if (!prepared.ok) return { kind: 'not_sent', reason: prepared.reason };
      const bytes = prepared.call.bytes ?? new Uint8Array();
      const now = this.deps.nowMs();
      const admitted = store.transaction(() => {
        if (!store.holds(slot) || !gate.admitFirst()) return false;
        store.insertRequest({
          idempotency_key: key,
          owner_kind: owner.kind,
          owner_id: owner.id,
          operation: mutation.operation,
          merchant_origin: connection.merchant.origin,
          transport: prepared.call.transport,
          endpoint: prepared.call.endpoint,
          target_id: built.id ?? null,
          rpc_id: prepared.call.rpcId ?? null,
          request_bytes: bytes,
          request_sha256: bytesToHex(sha256(bytes)),
          retry_deadline: mutation.retryDeadline,
          created_at: now,
        });
        return true;
      });
      if (!admitted) return { kind: 'not_admitted' };
      const row = store.getRequest(key) as RequestRow;
      return await this.sendRow(slot, row, connection, gate, prepared.call);
    } finally {
      store.releaseSlot(slot);
    }
  }

  /**
   * Resend the owner's open request, if it has one (an earlier change, after a
   * restart, or for the hand-off barrier), under that request's own gate.
   * Null when nothing is open; `busy` when another holder has the slot.
   */
  async resume(
    owner: Owner,
    connection: MerchantConnection,
    gate: Gate,
  ): Promise<Outcome | { kind: 'busy' } | null> {
    const { store } = this.deps;
    store.purgeRequests(this.deps.nowMs() - REQUEST_RETENTION_MS);
    if (store.openRequest(owner.kind, owner.id) === null) return null;
    const slot = store.takeSlot(
      owner.kind,
      owner.id,
      this.deps.holder,
      this.deps.nowMs(),
      SLOT_LEASE_MS,
    );
    if (slot === null) return { kind: 'busy' };
    try {
      const row = store.openRequest(owner.kind, owner.id);
      return row === null ? null : await this.sendRow(slot, row, connection, gate);
    } finally {
      store.releaseSlot(slot);
    }
  }

  /**
   * Run `fn` in one transaction while holding the owner's slot and with no
   * request open: the hand-off barrier (§3.7) raises its card and fences the
   * session this way, so no mutation can be admitted between the check and
   * the move. `busy` while another holder has the slot; `open` with the
   * request that has not settled.
   */
  exclusive<T>(
    owner: Owner,
    fn: () => T,
  ): { kind: 'done'; value: T } | { kind: 'busy' } | { kind: 'open'; request: RequestRow } {
    const { store } = this.deps;
    const slot = store.takeSlot(
      owner.kind,
      owner.id,
      this.deps.holder,
      this.deps.nowMs(),
      SLOT_LEASE_MS,
    );
    if (slot === null) return { kind: 'busy' };
    try {
      return store.transaction(() => {
        if (!store.holds(slot)) return { kind: 'busy' as const };
        const open = store.openRequest(owner.kind, owner.id);
        if (open !== null) return { kind: 'open' as const, request: open };
        return { kind: 'done' as const, value: fn() };
      });
    } finally {
      store.releaseSlot(slot);
    }
  }

  /**
   * End an owner's open request without sending it (the owner moved on: an
   * expired session, a hand-off): abandoned under its gate, in one step.
   */
  abandonOpen(owner: Owner, gate: Gate, reason: AbandonReason): Outcome | { kind: 'busy' } | null {
    const { store } = this.deps;
    if (store.openRequest(owner.kind, owner.id) === null) return null;
    // Under the slot, so a holder mid-send cannot write its answer after this (its
    // generation is no longer current).
    const slot = store.takeSlot(
      owner.kind,
      owner.id,
      this.deps.holder,
      this.deps.nowMs(),
      SLOT_LEASE_MS,
    );
    if (slot === null) return { kind: 'busy' };
    try {
      return store.transaction(() => {
        const row = store.openRequest(owner.kind, owner.id);
        return row === null || !store.holds(slot) ? null : this.abandon(row, gate, reason);
      });
    } finally {
      store.releaseSlot(slot);
    }
  }

  /** Abandon a row and tell its owner, in the caller's transaction. */
  private abandon(row: RequestRow, gate: Gate, reason: AbandonReason): Outcome {
    const { store } = this.deps;
    const sent = row.state === 'in_doubt';
    store.abandonRequest(row.idempotency_key, reason, this.deps.nowMs());
    gate.abandon(row, reason, sent);
    return {
      kind: 'abandoned',
      request: store.getRequest(row.idempotency_key) as RequestRow,
      reason,
      sent,
    };
  }

  /** Send (or resend) one journaled request and write what came back under the slot. */
  private async sendRow(
    slot: Slot,
    row: RequestRow,
    connection: MerchantConnection,
    gate: Gate,
    first?: PreparedCall,
  ): Promise<Outcome> {
    const { store } = this.deps;
    const now = this.deps.nowMs();
    if (first === undefined) {
      // A resend: its deadline, the merchant's wait, then its gate, before any byte goes again.
      if (now >= row.retry_deadline)
        return store.transaction(() => this.abandon(row, gate, 'deadline'));
      if (row.not_before !== null && now < row.not_before)
        return { kind: 'wait', request: row, retryAfterMs: row.not_before - now };
      if (!gate.admitResend(row))
        return store.transaction(() => this.abandon(row, gate, 'gate_closed'));
    }
    // A first send: no byte of these has gone before (a 409 to them is Dina's own fault).
    const neverSent = row.first_sent_at === null && row.state === 'prepared';
    const before = store.transaction((): RequestState | null =>
      store.holds(slot) ? store.markMaybeSent(row.idempotency_key, now) : null,
    );
    if (before !== 'prepared' && before !== 'in_doubt') return { kind: 'lost' };
    const base = first ?? storedCall(row, connection);
    const bound = gate.credential?.();
    const call = bound === undefined ? base : { ...base, credential: bound };
    const result = await connection.send(call);
    const { verdict, retryAfterMs } = verdictOf(result, before === 'in_doubt');
    const written = store.transaction((): Outcome | null => {
      if (!store.holds(slot)) return null;
      const at = this.deps.nowMs();
      const current = () => store.getRequest(row.idempotency_key) as RequestRow;
      const open = current().state;
      if (open !== 'prepared' && open !== 'in_doubt') return null;
      switch (verdict) {
        case 'definite':
          // A row ended meanwhile (abandoned for its owner) takes no answer.
          if (!store.settleRequest(row.idempotency_key, JSON.stringify(outcomeRecord(result)), at))
            return null;
          gate.apply(current(), result);
          return { kind: 'answered', request: current(), result };
        case 'not_left':
          // Nothing left this time: as it was before the attempt.
          store.restoreState(row.idempotency_key, before, row.first_sent_at);
          return { kind: 'not_left', request: current() };
        case 'conflict': {
          if (neverSent) return this.abandon(current(), gate, 'conflict_defect');
          if (store.countConflict(row.idempotency_key) > CONFLICT_LIMIT)
            return this.abandon(current(), gate, 'conflict_limit');
          const wait = retryAfterMs ?? CONFLICT_WAIT_MS;
          store.setNotBefore(row.idempotency_key, at + wait);
          return { kind: 'in_doubt', request: current(), why: 'conflict', retryAfterMs: wait };
        }
        case 'retry_later':
          store.setNotBefore(
            row.idempotency_key,
            retryAfterMs !== undefined ? at + retryAfterMs : null,
          );
          return {
            kind: 'in_doubt',
            request: current(),
            why: 'retry_later',
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          };
        case 'lost':
        case 'unreadable':
          return { kind: 'in_doubt', request: current(), why: verdict };
      }
    });
    return written ?? { kind: 'lost' };
  }
}

/** A journaled request as the transport sends it: its stored bytes, to its stored endpoint. */
function storedCall(row: RequestRow, connection: MerchantConnection): PreparedCall {
  return {
    transport: row.transport,
    endpoint: row.endpoint,
    profileUrl: connection.profileUrl(),
    operation: row.operation as OperationName,
    ...(row.target_id !== null ? { id: row.target_id } : {}),
    idempotencyKey: row.idempotency_key,
    // Over MCP the answer is read by the JSON-RPC id inside the stored envelope.
    ...(row.rpc_id !== null ? { rpcId: row.rpc_id } : {}),
    ...(row.request_bytes.length > 0 ? { bytes: row.request_bytes } : {}),
  };
}

/** What the journal keeps of a definite answer: its kind and status, never the merchant's text. */
function outcomeRecord(result: CallResult): JsonObject {
  if (result.ok) return { kind: 'ok' };
  if (result.kind === 'error_response') return { kind: 'error_response' };
  if (result.kind === 'transport')
    return {
      kind: 'transport',
      code: result.error.code,
      ...(result.error.httpStatus !== undefined ? { status: result.error.httpStatus } : {}),
    };
  return { kind: result.kind };
}
