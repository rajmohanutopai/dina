/**
 * Durable PeerLens review outbox (TN-MOB-007).
 *
 * When a review can't publish immediately (offline / transient PDS
 * failure), the full publishable payload (DID + rkey + attestation
 * record) is persisted to the SQLCipher-backed KV store so it SURVIVES
 * an app restart, and a drainer replays it via the real sovereign
 * publish path (`publishAttestationToPDS`) when connectivity returns.
 *
 * Two representations, kept in sync:
 *   - This durable KV store is the source of truth for "what still
 *     needs to publish" (replayable across restart).
 *   - The in-memory `outbox_store` mirrors it for the Outbox SCREEN
 *     (existing render contract / tests unchanged). `hydrate` rebuilds
 *     the mirror from durable rows on load; a successful drain removes
 *     the row from both.
 *
 * The KV value is JSON; the key is the row's `clientId` under the
 * `peerlens_outbox` namespace. We never store vault content here — only
 * the review the user chose to publish PUBLICLY.
 */

import { hydrateThread } from '@dina/brain/chat';
import { currentDataScope, isGuidedDemoScope } from '@dina/core';
import { kvSet, kvList, kvDelete, kvHas } from '@dina/core/kv';

import { getBootedNode } from '../hooks/useNodeBootstrap';

import {
  enqueueLocal,
  enqueueDeadLetteredLocal,
  dismissLocal,
  getOutboxRows,
  markDeadLetteredLocal,
  markSubmittingLocal,
  markQueuedLocal,
  type AttestationDraftBody,
} from './outbox_store';
import { publishAttestationToPDS, type PublishedAttestation } from './publish_attestation';
import { setReviewDraftStatus } from './review_draft';

import type { PDSPublisher } from '@dina/brain';


const NAMESPACE = 'peerlens_outbox';
/** Stop retrying a row after this many failed attempts (still kept for the user to dismiss). */
const MAX_ATTEMPTS = 8;

/** A review awaiting publish, durable across restart. */
export interface PendingReview {
  /** Stable client id — also the outbox-screen row key + KV key. */
  clientId: string;
  /** The owner DID the record publishes under (PDS session must match). */
  did: string;
  /** AT-Proto record key for the attestation. */
  rkey: string;
  /** The full attestation record body (no `$type` — the publisher adds it). */
  record: Record<string, unknown>;
  /** Minimal body the Outbox screen renders. */
  draft: AttestationDraftBody;
  /** Failed-attempt count (drainer gives up at MAX_ATTEMPTS). */
  attempts: number;
  /** Last error message, for display/diagnostics. */
  lastError?: string;
  /** ISO timestamp the row was first queued. */
  createdAt: string;
  /** Originating inline chat-draft card (when composed from one) so a
   *  delayed/autodrained publish can flip that card to `published`. */
  threadId?: string;
  draftId?: string;
}

function isPendingReview(v: unknown): v is PendingReview {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.clientId === 'string' &&
    typeof r.did === 'string' &&
    typeof r.rkey === 'string' &&
    typeof r.record === 'object' &&
    r.record !== null &&
    typeof r.draft === 'object' &&
    r.draft !== null &&
    // `createdAt`/`attempts` are required downstream: hydrate feeds createdAt
    // into enqueueLocal (which THROWS on a non-ISO timestamp) and compares
    // attempts against MAX_ATTEMPTS. A corrupt/older row missing or mistyping
    // either must be skipped here so it can't abort the whole hydrate.
    typeof r.createdAt === 'string' &&
    typeof r.attempts === 'number'
  );
}

/** Persist (or update) a pending review durably. */
export async function persistPendingReview(entry: PendingReview): Promise<void> {
  await kvSet(entry.clientId, JSON.stringify(entry), NAMESPACE);
}

/** Load every durable pending review (malformed rows are skipped). */
export async function loadPendingReviews(): Promise<PendingReview[]> {
  const entries = await kvList(NAMESPACE);
  const out: PendingReview[] = [];
  for (const e of entries) {
    try {
      const parsed = JSON.parse(e.value) as unknown;
      if (isPendingReview(parsed)) out.push(parsed);
    } catch {
      // Skip a corrupt row rather than fail the whole drain.
    }
  }
  return out;
}

/** Remove a durable pending review (after a successful publish or dismiss). */
export async function removePendingReview(clientId: string): Promise<void> {
  await kvDelete(clientId, NAMESPACE);
}

/**
 * Rebuild the in-memory Outbox-screen mirror from durable rows. Call on
 * Outbox screen mount so a review queued before an app restart still
 * shows up. Idempotent — only enqueues rows not already in the mirror.
 *
 * When `did` is supplied, rows queued under a DIFFERENT identity are skipped:
 * after a restore / re-onboard the device boots under a new DID, and
 * `drainReviewOutbox` already refuses to publish foreign-identity rows — but
 * surfacing them would let the wrong identity dismiss them or have them occupy
 * the queue cap forever. They stay in KV for if/when that identity returns.
 * Omit `did` (tests / pre-boot) to mirror every row.
 */
export async function hydrateReviewOutbox(did?: string): Promise<void> {
  const pending = await loadPendingReviews();
  const present = new Set(getOutboxRows().map((r) => r.clientId));
  for (const p of pending) {
    if (present.has(p.clientId)) continue;
    if (did !== undefined && p.did !== did) continue; // foreign identity — not ours to show
    // Defence-in-depth: a row that passes the type guard but still carries a
    // present-but-malformed timestamp (a string that fails the ISO check) must
    // skip ITSELF, not throw out of the loop and block every other queued review
    // from hydrating/draining.
    try {
      if (p.attempts >= MAX_ATTEMPTS) {
        // Dead-lettered: insert DIRECTLY as terminal. Going through enqueueLocal
        // (as queued-offline) would be cap-rejected when the active queue is
        // full, hiding the dead-letter with no visible row to dismiss/retry.
        enqueueDeadLetteredLocal(p.draft, p.clientId, p.createdAt);
      } else {
        enqueueLocal(p.draft, p.clientId, p.createdAt);
      }
    } catch {
      continue;
    }
  }
}

/**
 * Count durable reviews still eligible to publish (not dead-lettered). The
 * authoritative queue size — the in-memory mirror may undercount if it hasn't
 * hydrated yet. Used to enforce the queue cap against the DURABLE store, not
 * just the mirror.
 *
 * When `did` is supplied, counts ONLY that identity's rows. The cap must be
 * per-identity: foreign-DID rows (after restore / re-onboard) are hidden and
 * un-dismissable, so counting them would let 50 stale rows permanently block the
 * current identity from publishing.
 */
export async function countActivePendingReviews(did?: string): Promise<number> {
  return (await loadPendingReviews()).filter(
    (r) => r.attempts < MAX_ATTEMPTS && (did === undefined || r.did === did),
  ).length;
}

/**
 * Reset a row's attempt count so a manual "Try again" re-attempts a
 * dead-lettered review on the next drain. No-op if the row is gone.
 */
export async function resetReviewAttempts(clientId: string): Promise<void> {
  const row = (await loadPendingReviews()).find((r) => r.clientId === clientId);
  if (row === undefined) return;
  await persistPendingReview({ ...row, attempts: 0, lastError: undefined });
}

/** Outcome of a drain pass. */
export interface DrainResult {
  published: number;
  failed: number;
}

/**
 * Replay every durable pending review through the real PDS publish path.
 * On success the row is removed from both the durable store and the
 * screen mirror; on failure the attempt count is bumped (and the row is
 * left for the next pass until MAX_ATTEMPTS). One row's failure never
 * stops the rest.
 *
 * No-op-safe: returns zeros when there's nothing queued.
 */
let drainInFlight: Promise<DrainResult> | null = null;

export function drainReviewOutbox(pds: PDSPublisher, did: string): Promise<DrainResult> {
  // Single-flight. The Outbox-screen mount, its foreground listener, the global
  // boot/foreground autodrain, and a manual "Try again" can each fire a drain —
  // but they all replay the SAME global pending store. Two overlapping passes
  // can load the same row: one publishes + removes it while the other catches a
  // transient PDS error and re-persists the now-stale row, resurrecting an
  // already-published review as queued/failed. Coalesce concurrent callers into
  // one in-flight pass so a row is only ever processed by a single drain.
  if (drainInFlight !== null) return drainInFlight;
  drainInFlight = runDrainPass(pds, did).finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

async function runDrainPass(pds: PDSPublisher, did: string): Promise<DrainResult> {
  const result: DrainResult = { published: 0, failed: 0 };
  const pending = await loadPendingReviews();
  for (const row of pending) {
    if (row.attempts >= MAX_ATTEMPTS) continue; // dead-lettered; awaits user dismiss
    // Never publish a review under a DIFFERENT identity than the one it was
    // authored for. The attestation record has no embedded author (the PDS
    // repo owner IS the author), so a row queued under DID A must not be
    // posted under the currently-booted DID B (e.g. after a restore /
    // re-onboard). Leave it for if/when A is active again.
    if (row.did !== did) continue;
    // `pending` was loaded once at the top of the pass; a row can be dismissed
    // (deleted from KV by dismissReview) while this pass is mid-flight on a slow
    // PDS write. Re-check existence right before the PUBLIC write so a cancel
    // the user just made can't get steamrolled into a published review.
    if (!(await kvHas(row.clientId, NAMESPACE))) continue;
    // Mark the VISIBLE row in-flight before the public write so the Outbox
    // screen hides its Dismiss button (Dismiss is offered only on
    // `queued-offline`). The write is on the wire and will go public, so a
    // dismiss tap must not look like it cancelled the review.
    markSubmittingLocal(row.clientId);
    // Scope the failure/retry path to JUST the public write. A throw from the
    // post-publish cleanup below (KV delete, thread hydrate, card patch) must
    // NOT be treated as a publish failure — the review is already public, so
    // re-persisting it would resurrect + re-publish a row we just removed.
    let out: PublishedAttestation;
    try {
      out = await publishAttestationToPDS(pds, did, row.record, row.rkey);
    } catch (err) {
      // Publish itself failed (transient / offline). If the user dismissed this
      // row while the write was in flight, it's already gone from KV — don't
      // resurrect it by writing the stale copy back. Only persist the failure
      // (and dead-letter) when the row still exists.
      if (await kvHas(row.clientId, NAMESPACE)) {
        result.failed++;
        const nextAttempts = row.attempts + 1;
        await persistPendingReview({
          ...row,
          attempts: nextAttempts,
          lastError: err instanceof Error ? err.message : String(err),
        });
        // Retries exhausted → dead-letter the VISIBLE row NOW; otherwise revert
        // it from in-flight back to queued so Dismiss / Try-again return.
        if (nextAttempts >= MAX_ATTEMPTS) markDeadLetteredLocal(row.clientId);
        else markQueuedLocal(row.clientId);
      }
      continue;
    }
    // Published successfully. If a guided demo STARTED while this write was in
    // flight, the boot/foreground scope guard has already passed — but the chat
    // store is now demo-scoped, so hydrating + patching the card here would
    // touch the demo thread, not the user's. DEFER: leave the durable row (a
    // later user-scope drain re-publishes idempotently via the stable rkey and
    // patches the card in the right scope) and revert the in-flight marker.
    if (isGuidedDemoScope(currentDataScope())) {
      markQueuedLocal(row.clientId);
      continue;
    }
    // Everything below is best-effort cleanup — never a failure.
    try {
      await removePendingReview(row.clientId);
      dismissLocal(row.clientId);
      // Flip the originating inline chat-draft card to `published`, so a
      // delayed (autodrained) publish can't leave a still-publishable card
      // in chat that would mint a duplicate review.
      if (
        row.threadId !== undefined &&
        row.threadId.length > 0 &&
        row.draftId !== undefined &&
        row.draftId.length > 0
      ) {
        // Post-restart the autodrain can run before the originating chat thread
        // is hydrated into the in-memory map; setReviewDraftStatus no-ops on an
        // absent thread, leaving the PERSISTED card stuck in 'publishing'.
        // Hydrate first so the status flip lands and persists.
        await hydrateThread(row.threadId);
        setReviewDraftStatus(row.threadId, row.draftId, 'published', {
          attestation: { uri: out.uri, cid: out.cid },
          content: `Published your review of ${row.draft.subjectTitle}.`,
        });
      }
    } catch {
      // Best-effort post-publish housekeeping; the review is already public.
    }
    result.published++;
  }
  return result;
}

// ── Node-aware orchestration (used by the Outbox screen + autodrain) ──────
// Thin wrappers that bind the pure primitives above to the currently-booted
// node's authed publisher, so route files don't reach into the node singleton.

/**
 * Hydrate the Outbox mirror for the CURRENTLY-booted identity. Filters out
 * reviews queued under a previous DID (after restore / re-onboard) so they
 * never show in this identity's outbox. Falls back to an unfiltered hydrate
 * when no node is booted yet.
 */
export async function hydrateBootedReviewOutbox(): Promise<void> {
  const node = getBootedNode();
  await hydrateReviewOutbox(node?.did);
}

/**
 * Drain the review outbox using the booted node's authed PDS publisher.
 * No-op when no node / no publisher is available.
 */
export async function drainBootedReviewOutbox(): Promise<void> {
  // Never drain while a guided demo is active. The demo runs under a
  // 'guided_demo:*' data scope; a boot/foreground drain would publish a real
  // user-scope review, hydrate + patch the demo-scope 'main' thread, remove the
  // durable row, and leave the actual user's draft card stuck in 'publishing'.
  // The queued review stays put and drains once the demo ends (scope → 'user').
  if (isGuidedDemoScope(currentDataScope())) return;
  const node = getBootedNode();
  if (node?.pdsPublisher !== undefined && node.did.length > 0) {
    await drainReviewOutbox(node.pdsPublisher, node.did);
  }
}

/**
 * Manual "Try again": reset a row's attempt count (so a dead-lettered review
 * re-attempts) then drain.
 */
export async function retryReview(clientId: string): Promise<void> {
  await resetReviewAttempts(clientId);
  await drainBootedReviewOutbox();
}

/**
 * Dismiss a review: delete the durable row AND remove the screen mirror row,
 * so it can't reappear on the next hydrate or be published by the drainer.
 *
 * If the review came from an inline chat-draft card, that card was flipped to
 * `publishing` when it queued — a state in which the card disables its publish
 * button while it waits for the drainer. Dismissing the queue item means the
 * drainer will never run for it, so we must also release the card from
 * `publishing` (→ `discarded`); otherwise it stays stuck, unable to publish or
 * be acted on, even though the queue entry is gone. We read the row BEFORE
 * removing it so we still have its `threadId`/`draftId`.
 */
export async function dismissReview(clientId: string): Promise<void> {
  const row = (await loadPendingReviews()).find((r) => r.clientId === clientId);
  await removePendingReview(clientId);
  dismissLocal(clientId);
  if (
    row?.threadId !== undefined &&
    row.threadId.length > 0 &&
    row.draftId !== undefined &&
    row.draftId.length > 0
  ) {
    // Same restart hazard as the drain path: if the user dismisses before
    // opening the originating chat, the in-memory thread map is empty and
    // setReviewDraftStatus no-ops, leaving the PERSISTED card stuck in
    // 'publishing'. Hydrate first so the 'discarded' flip lands and persists.
    await hydrateThread(row.threadId);
    setReviewDraftStatus(row.threadId, row.draftId, 'discarded', {
      content: `Removed your queued review of ${row.draft.subjectTitle}.`,
    });
  }
}
