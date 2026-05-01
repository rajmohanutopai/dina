/**
 * Local outbox store — in-memory pub/sub wrapper around `enqueueDraft`.
 *
 * The Trust Network's outbox state machine (in `outbox.ts`) is purely
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
