/**
 * §5 step 10 — write the approved bytes, and work out what happened when the
 * head write does not simply succeed.
 *
 * THIS WAS AN ANONYMOUS CLOSURE INSIDE A ROUTE, which is why three defects
 * lived in it undisturbed: the §16.2 fence was never re-asked before the
 * pointer, a successful publication was never recorded in this node's own
 * pointer store, and every failure was reported as "not a lost swap". None of
 * them was reachable from a test, because the route wires
 * `userPresent: () => false` and the suite installs no record writer, so no
 * test could ever reach the closure at all. A seam nothing can drive is a seam
 * nothing checks.
 *
 * WHAT THE THREE OUTCOMES MEAN, because they need opposite responses:
 *
 *   already published — the pointer write was ACCEPTED and this node crashed
 *                       or lost the response before recording it. Retrying
 *                       must not republish; the draft is terminal.
 *   lost swap         — another writer advanced the head first. The held bytes
 *                       are stale, so the draft goes back for a rebuild and a
 *                       fresh owner review.
 *   transient         — the write failed and the head did not move. A retry of
 *                       exactly these bytes is correct, so nothing is voided.
 *
 * The repo collapses all three into one thrown error, so this asks the head
 * itself rather than reading tea leaves in an error message. The head is the
 * only authority on which of the three happened.
 */

import { validateCatalogPointer } from '@dina/commerce-protocol';

import {
  CATALOG_POINTER_NSID,
  catalogPointerRkey,
  getCatalogRecordReader,
  publishCatalogRecords,
} from './catalog_record_writer';

import type { CatalogDraft } from './catalog_draft_store';
import type { CatalogPointer } from '@dina/commerce-protocol';

export type DraftPublishResult =
  | {
      ok: true;
      pointerCid: string;
      snapshotCid: string;
      /**
       * The pointer actually on the head, when it is NOT the one we held.
       *
       * Present only in the already-published-by-predecessor case, where the
       * chain has moved past us: the draft must record what is live rather
       * than what it was holding.
       */
      pointer?: CatalogPointer;
    }
  | { ok: false; error: string; lostSwap: boolean };

export interface DraftPublisherDeps {
  /** §16.2 — asked again between the snapshot and the head write. */
  fence: () => unknown | null;
  /** Called ONLY on the repo's acceptance, with the pointer it accepted. */
  recordPublication: (catalogId: string, pointer: CatalogPointer, pointerCid: string) => void;
}

/**
 * Read the live head, so a failed pointer write can be classified honestly.
 *
 * Returns null when there is no reader or nothing readable — in which case the
 * caller must assume the least destructive answer, which is "transient".
 */
async function readLiveHead(
  catalogId: string,
): Promise<{ pointer: Record<string, unknown>; cid: string } | null> {
  const reader = getCatalogRecordReader();
  if (reader === null) return null;
  try {
    const live = await reader({
      collection: CATALOG_POINTER_NSID,
      rkey: catalogPointerRkey(catalogId),
    });
    if (live === null || live.record === null || typeof live.record !== 'object') return null;
    return { pointer: live.record as Record<string, unknown>, cid: live.cid };
  } catch {
    // A reader that throws tells us nothing about the head, which is exactly
    // the state "we do not know" — and not knowing must not be reported as a
    // lost swap, because that voids an owner's approval on a guess.
    return null;
  }
}

export async function publishHeldDraft(
  deps: DraftPublisherDeps,
  draft: CatalogDraft,
): Promise<DraftPublishResult> {
  if (draft.held === null) return { ok: false, error: 'no held snapshot', lostSwap: false };
  const held = draft.held;

  const outcome = await publishCatalogRecords({
    // The pointer as BUILT. `previous_snapshot_digest` and `service_rkey` live
    // only here, so reassembling one from the snapshot drops the chain link
    // and the listing binding.
    pointer: held.pointer,
    snapshot: held.snapshot,
    pages: held.pages,
    expectedPointerCid: held.expectedPointerCid === '' ? null : held.expectedPointerCid,
    // Between the snapshot and the head, after the snapshot's awaited round
    // trip — the window a fence checked only at request start cannot see, and
    // the longest one in the lane because an owner review sits in front of it.
    beforePointer: deps.fence,
  });

  if (outcome.ok) {
    // On the repo's acceptance, never before it. A head remembered for a write
    // that failed hands the NEXT publication a swap value the repo never
    // issued, turning one lost race into a permanent one.
    deps.recordPublication(draft.catalogId, held.pointer, outcome.pointerCid);
    return { ok: true, pointerCid: outcome.pointerCid, snapshotCid: outcome.snapshotCid ?? '' };
  }

  // A fence refusal is not a failed write and not a lost race: this node was
  // superseded and must not publish at all. The snapshot is durable and
  // content-addressed, so abandoning here costs nothing a retry cannot redo.
  if (outcome.refusal !== 'pointer_write_failed') {
    return { ok: false, error: outcome.error, lostSwap: false };
  }

  const live = await readLiveHead(draft.catalogId);
  if (live === null) return { ok: false, error: outcome.error, lostSwap: false };

  // ALREADY PUBLISHED — EXACTLY TWO COMPARISONS, which is the limit §5 step 10
  // states rather than an approximation of a longer walk. There is ONE pointer
  // record per catalog, rewritten in place, holding ONE
  // `previous_snapshot_digest`, and `CatalogSnapshot` carries no predecessor
  // link at all: a walk back through history terminates after one hop, always.
  //
  //   current  — the write was accepted and only the answer was lost;
  //   previous — accepted, and ONE further publication has happened since.
  //
  // Either way this draft is on the wire, and reporting success is what makes
  // the retry idempotent instead of a second publication of the same catalog.
  const ours = held.snapshot.snapshot_digest;
  if (live.pointer.snapshot_digest === ours || live.pointer.previous_snapshot_digest === ours) {
    // RECORD THE LIVE POINTER, NOT THE HELD ONE. In the predecessor case the
    // head has already moved on: the held pointer is sequence N and the CID is
    // sequence N+1's. Storing them together gives this node a head that never
    // existed — the next `prepare` would derive its sequence and predecessor
    // from the stale pointer while CASing against the successor's CID, and
    // overwrite the live head with a duplicate sequence.
    const validated = validateCatalogPointer(live.pointer);
    if (validated !== null) {
      // We know our bytes are out there and cannot say from what: the same
      // position as an unreadable head, so it is transient rather than a race.
      return { ok: false, error: `${outcome.error} — the live head is unreadable: ${validated}`, lostSwap: false };
    }
    const livePointer = live.pointer as unknown as CatalogPointer;
    deps.recordPublication(draft.catalogId, livePointer, live.cid);
    return { ok: true, pointerCid: live.cid, snapshotCid: '', pointer: livePointer };
  }

  const expected = held.expectedPointerCid;
  if (expected !== '' && live.cid === expected) {
    // The head never moved. The write failed and nothing raced us, so a retry
    // of exactly these bytes is right and the approval stands.
    return { ok: false, error: outcome.error, lostSwap: false };
  }

  // INCONCLUSIVE, and named as such. The head moved and neither of the two
  // digests it carries is ours, so whether this draft ever reached the wire is
  // not answerable from the records — the normal outcome once two more
  // publications have happened, not a rare one. §5 step 10: an inconclusive
  // answer must not silently republish, so this goes back for a rebuild and a
  // FRESH OWNER REVIEW rather than being retried behind the owner's back.
  return {
    ok: false,
    error: `${outcome.error} — the head has moved and carries neither this snapshot nor it as its predecessor, so whether this draft was published cannot be determined from the records (§5 step 10)`,
    lostSwap: true,
  };
}
