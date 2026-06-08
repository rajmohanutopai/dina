/**
 * Local outbox store — in-memory pub/sub wrapper around `enqueueDraft`.
 *
 * PeerLens outbox state machine (in `outbox.ts`) is purely
 * functional: it consumes a row list + an event and produces a new row
 * list. This module owns the live `rows` array, exposes
 * `subscribe(listener)` so screens can re-render when the outbox
 * mutates, and bridges the WriteScreen "Publish" CTA to the outbox via
 * `enqueueDraft`.
 *
 * **In-memory only (V1 scope)**: state lives at module level and is
 * lost on app restart. The real persistence layer is the SQLCipher
 * repository (TN-MOB-007 final task) — when that lands, this store
 * gets swapped out for a thin facade over the repository, retaining
 * the same `subscribe` / `enqueue` surface so screens don't change.
 *
 * **Type-safe over `DraftBody`**: trust attestations + (future)
 * vouches + endorsements all flow through this store. The store
 * itself is generic; per-row schema validation is the runner's job.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md TN-MOB-007 (outbox runner).
 */

import {
  enqueueDraft,
  type EnqueueResult,
  type OutboxRow,
} from './outbox';

/**
 * The shape stored per published draft. Today we only store
 * attestation drafts (sentiment + headline + body + confidence + the
 * subject they target); other draft kinds get added as new fields if
 * we keep them in the same outbox.
 */
export interface AttestationDraftBody {
  readonly sentiment: 'positive' | 'neutral' | 'negative';
  readonly headline: string;
  readonly body: string;
  readonly confidence: 'certain' | 'high' | 'moderate' | 'speculative';
  readonly subjectTitle: string;
  readonly subjectId?: string;
}

type Listener = (rows: readonly OutboxRow<AttestationDraftBody>[]) => void;

let rows: readonly OutboxRow<AttestationDraftBody>[] = [];
const listeners = new Set<Listener>();

/**
 * Subscribe to outbox changes. Listener fires immediately with the
 * current rows (so callers don't need a separate initial-state read),
 * then re-fires on every mutation.
 *
 * Returns an idempotent unsubscribe function. Tests + screens MUST
 * call it on unmount; leaked listeners hold the screen reference and
 * keep it from being GC'd.
 */
export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  // Snapshot via Promise.resolve so the initial fire happens after the
  // subscriber's setup has returned — matches `subscribeTrust`'s read-
  // through cache pattern + avoids fire-during-render warnings.
  void Promise.resolve().then(() => {
    if (listeners.has(listener)) listener(rows);
  });
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    listeners.delete(listener);
  };
}

/**
 * Append a new draft to the outbox. Returns the same discriminated
 * `EnqueueResult` shape `enqueueDraft` exposes so callers can branch
 * on `cap_exceeded` / `duplicate_client_id` cleanly.
 *
 * On success, all subscribers are notified with the fresh row list
 * BEFORE the function returns — so a screen calling `enqueue` and
 * navigating away in the same tick still sees the new row reflected
 * by the time the navigation completes.
 */
export function enqueueLocal(
  draft: AttestationDraftBody,
  clientId: string,
  enqueuedAt: string = new Date().toISOString(),
): EnqueueResult<AttestationDraftBody> {
  const result = enqueueDraft<AttestationDraftBody>(rows, {
    clientId,
    draftBody: draft,
    enqueuedAt,
  });
  if (result.ok) {
    rows = result.rows;
    notify();
  }
  return result;
}

/**
 * Remove a row from the outbox. Used by the OutboxScreen's "Dismiss"
 * affordance on terminal rows. Idempotent — no-op when `clientId`
 * isn't found.
 */
export function dismissLocal(clientId: string): void {
  const before = rows.length;
  rows = rows.filter((r) => r.clientId !== clientId);
  if (rows.length !== before) notify();
}

/**
 * Mark a row as a terminal failure — used when the durable drainer has
 * exhausted its retries (dead-letter). Reuses `stuck-offline` (the existing
 * terminal "couldn't publish" status) so the Outbox screen surfaces it as a
 * failure with retry / dismiss, instead of a perpetual "will publish when
 * back online". No-op when the row is absent or already terminal.
 */
export function markDeadLetteredLocal(clientId: string, atMs: number = Date.now()): void {
  let changed = false;
  rows = rows.map((r) => {
    if (r.clientId !== clientId || r.status === 'stuck-offline') return r;
    changed = true;
    return { ...r, status: 'stuck-offline', stuckAt: new Date(atMs).toISOString() };
  });
  if (changed) notify();
}

/**
 * Mark a queued row as IN-FLIGHT (`submitted-pending`) right before the drainer
 * starts its public PDS write. While in-flight the row drops out of the
 * dismissable `queued-offline` list (the Outbox screen offers Dismiss only on
 * `queued-offline`), so a user can't "cancel" a review whose write is already
 * on the wire and will go public regardless. It still counts toward the
 * "N queued" banner. No-op unless the row is currently dismissable —
 * `queued-offline` (the normal flush) OR `stuck-offline` (a dead-letter the user
 * just hit "Try again" on; it must leave the failure state BEFORE the write so a
 * "Remove" tap can't drop a review whose publish is already on the wire).
 */
export function markSubmittingLocal(clientId: string, atMs: number = Date.now()): void {
  let changed = false;
  rows = rows.map((r) => {
    if (r.clientId !== clientId || (r.status !== 'queued-offline' && r.status !== 'stuck-offline')) {
      return r;
    }
    changed = true;
    return {
      ...r,
      status: 'submitted-pending',
      submittedAt: new Date(atMs).toISOString(),
      stuckAt: undefined,
    };
  });
  if (changed) notify();
}

/**
 * Revert an in-flight row back to `queued-offline` — used when the public write
 * FAILED (transient) and the row will be retried, so the user regains the
 * Dismiss/Try-again affordances. No-op unless the row is currently in-flight.
 */
export function markQueuedLocal(clientId: string): void {
  let changed = false;
  rows = rows.map((r) => {
    if (r.clientId !== clientId || r.status !== 'submitted-pending') return r;
    changed = true;
    return { ...r, status: 'queued-offline', submittedAt: undefined };
  });
  if (changed) notify();
}

/**
 * Insert a row DIRECTLY in the terminal `stuck-offline` state, bypassing the
 * active-queue cap (terminal rows don't consume capacity). Used when HYDRATING a
 * durable row that already exhausted its retries: routing it through
 * `enqueueLocal` (as `queued-offline`) would be cap-rejected when the active
 * queue is full, leaving the dead-letter hidden in KV with no visible row to
 * dismiss or retry. Idempotent — no-op when the row already exists.
 */
export function enqueueDeadLetteredLocal(
  draft: AttestationDraftBody,
  clientId: string,
  enqueuedAt: string,
  atMs: number = Date.now(),
): void {
  if (rows.some((r) => r.clientId === clientId)) return;
  rows = [
    ...rows,
    {
      clientId,
      draftBody: draft,
      status: 'stuck-offline',
      enqueuedAt,
      stuckAt: new Date(atMs).toISOString(),
    },
  ];
  notify();
}

/**
 * Snapshot the current outbox rows. Mostly for tests + the rare
 * imperative read; screens should `subscribeOutbox` instead.
 */
export function getOutboxRows(): readonly OutboxRow<AttestationDraftBody>[] {
  return rows;
}

/** Test-only: reset the store to empty. */
export function resetOutboxStore(): void {
  rows = [];
  listeners.clear();
}

function notify(): void {
  // Snapshot so a listener that unsubscribes itself mid-iteration
  // doesn't mutate the live set we're walking.
  for (const l of [...listeners]) l(rows);
}
