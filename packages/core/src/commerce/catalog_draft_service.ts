/**
 * The four operations and the state machine (§6 of the photo-catalog lane).
 *
 *     created → confirmed → prepared → approved → published
 *
 * Each operation advances exactly one transition and refuses a draft that is
 * not in the state before it, so the ORDER is enforced rather than assumed.
 *
 * WHAT EACH BINDING ANSWERS, because only one of them is class-conditional:
 *
 *   the content receipt  — did a person vouch for values a MACHINE invented?
 *   the snapshot approval — did the owner approve these exact PUBLIC bytes?
 *
 * The first is meaningless for a catalog nothing inferred: an owner-authored
 * upload or a connector's deterministic parse invented nothing, so `confirm`
 * on those classes demands no presence, mints no receipt, and only advances
 * the state. The second is §12.1 step 11 and applies to every publication
 * regardless of where the values came from, so `approve` requires presence on
 * every class. A consequence worth stating rather than discovering: a fully
 * unattended publication is impossible here. That is an owner-level decision
 * (§10 item 14) and this module implements the safe reading of it.
 *
 * WHY PUBLISH REBUILDS NOTHING. It loads the snapshot `prepare` built and the
 * owner approved. Rebuilding would re-mint `published_at`, change
 * `snapshot_digest`, and publish bytes the owner never saw — the failure the
 * approval exists to prevent. The rebuild path exists only where the bytes are
 * genuinely stale (a lost CAS), and it goes back through the review.
 */

import {
  canonicalJson,
  type CatalogPointer,
  type CatalogSnapshot,
  catalogContentReceiptDigest,
  type CatalogItem,
  type Sha256Fn,
  validateCatalogItem,
  verifyCatalogPage,
  verifyCatalogSnapshot,
} from '@dina/commerce-protocol';

import { CATALOG_FIELD_ORIGIN, productIdentity } from './catalog_assembler';
import { buildCatalogSnapshot } from './catalog_publisher';

import type {
  CatalogDraft,
  CatalogDraftRepository,
  DraftRow,
  DraftState,
  FieldProvenance,
} from './catalog_draft_store';
import type { CatalogPointerRepository } from './catalog_pointer_store';

export type DraftRefusal =
  | 'no_such_draft'
  /** The draft is not in the state this operation follows. */
  | 'wrong_state'
  /** A model-derived field the seller never accepted. */
  | 'unconfirmed_field'
  /** An acceptance naming a field that is not waiting on a decision. */
  | 'unknown_field'
  /** An acceptance that named nothing. */
  | 'nothing_named'
  /** An edit aimed at a field the seller does not own. */
  | 'immutable_field'
  /** An edit arriving while a publication holds the draft. */
  | 'publishing'
  /** The edited item is no longer something the wire would accept. */
  | 'item_rejected'
  | 'no_items'
  /** Presence was not established, and every operation that binds needs it. */
  | 'no_user_presence'
  | 'missing_receipt'
  /** Receipt, held bytes or approval taken at a different content revision. */
  | 'stale_revision'
  | 'digest_mismatch'
  | 'missing_approval'
  | 'build_failed'
  /** Publication is fenced (§16.2) or commerce is unavailable. */
  | 'fenced'
  | 'publish_failed';

/** A refusal on its own. The guards below can only ever produce this. */
export interface DraftRefusalOutcome {
  ok: false;
  refusal: DraftRefusal;
  error: string;
}

export type DraftOutcome<T> = { ok: true; value: T } | DraftRefusalOutcome;

function refuse(refusal: DraftRefusal, error: string): DraftRefusalOutcome {
  return { ok: false, refusal, error };
}

/** The state each operation requires, and the one it leaves behind. */
const TRANSITIONS: Readonly<Record<'confirm' | 'prepare' | 'approve' | 'publish', { from: DraftState; to: DraftState }>> =
  {
    confirm: { from: 'created', to: 'confirmed' },
    prepare: { from: 'confirmed', to: 'prepared' },
    approve: { from: 'prepared', to: 'approved' },
    publish: { from: 'approved', to: 'published' },
  };

export interface DraftServiceDeps {
  drafts: CatalogDraftRepository;
  pointers: CatalogPointerRepository;
  sha256: Sha256Fn;
  now: () => number;
  /**
   * A fresh, unguessable claim token.
   *
   * Injected rather than generated here so the service stays deterministic and
   * a test can drive two overlapping publications by hand.
   */
  newClaimToken: () => string;
  /**
   * Did Core itself establish that a person is present?
   *
   * INJECTED AS A VERDICT CORE REACHED, never a flag a caller passes. §10
   * item 9 records that the primitive exists — a per-persona Argon2id verifier
   * — but has no production caller, no persistence and no mobile equivalent.
   * Until it is wired this returns false, and every operation that binds
   * refuses, which is the honest failure: the receipt would otherwise record
   * that the software asked itself.
   */
  userPresent: () => boolean;
  /** §16.2 — has this node lost authority to publish? Null means it has not. */
  publicationFence: () => unknown | null;
  /** Writes snapshot then pointer. Injected so Core stays free of I/O. */
  publish: (args: {
    draft: CatalogDraft;
  }) => Promise<
    | {
        ok: true;
        pointerCid: string;
        snapshotCid: string;
        /** The live pointer, when the head had already moved past ours. */
        pointer?: CatalogPointer;
      }
    | { ok: false; error: string; lostSwap: boolean }
  >;
}

function requireState(
  draft: CatalogDraft,
  op: keyof typeof TRANSITIONS,
): DraftRefusalOutcome | null {
  const expected = TRANSITIONS[op].from;
  if (draft.state !== expected) {
    return refuse('wrong_state', `draft is ${draft.state}; ${op} follows ${expected}`);
  }
  return null;
}

/**
 * Every field the seller must still accept.
 *
 * A field with NO recorded provenance counts as `proposed`, so the missing
 * case blocks rather than passes — Core writes provenance, and a field it has
 * no record for is one it cannot vouch for either.
 */
export function unconfirmedFields(draft: CatalogDraft): string[] {
  const out: string[] = [];
  draft.items.forEach((item, index) => {
    const recorded = draft.provenance[String(index)] ?? {};
    for (const field of Object.keys(item)) {
      // ANY state this build does not recognise counts as proposed, not just
      // a missing one. Testing `=== 'proposed'` alone made every unrecognised
      // value read as confirmed — the store now fails closed on read, and this
      // is the same rule at the point that enforces it, because a guard that
      // depends on another layer having been careful is one layer of care.
      const recordedState: unknown = recorded[field];
      const state: FieldProvenance =
        recordedState === 'accepted' || recordedState === 'edited' || recordedState === 'not_model_derived'
          ? recordedState
          : 'proposed';
      if (state === 'proposed') out.push(`${String(index)}.${field}`);
    }
  });
  return out;
}

/**
 * The first issuer on an item that is not the publishing supplier, or null.
 *
 * §9.3: a `manufacturer_sku` or `custom` reference means nothing without its
 * issuer, and two suppliers may both use `CHAIR-1`. Publishing one scoped to
 * someone else claims their identifier space.
 */
function foreignIssuer(item: Record<string, unknown>, supplierDid: string): string | null {
  const refs: unknown[] = [item.product, ...(Array.isArray(item.identifiers) ? item.identifiers : [])];
  for (const ref of refs) {
    if (ref === null || typeof ref !== 'object') continue;
    const issuer = (ref as { issuer_did?: unknown }).issuer_did;
    if (typeof issuer === 'string' && issuer !== '' && issuer !== supplierDid) return issuer;
  }
  return null;
}

/**
 * How long a publication may hold a draft before the claim is treated as
 * abandoned.
 *
 * A process that dies between the claim and the writes must not brick the
 * draft for ever, and a publication that is genuinely still in flight is two
 * network round trips, not five minutes. Long enough to cover the slow case,
 * short enough that a seller who comes back to a wedged draft is not stuck.
 */
const PUBLISH_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Every field a pointer and its snapshot both carry must agree.
 *
 * They are two records describing one publication, and the snapshot's digest
 * covers only the snapshot. A pointer that names the right digest while
 * disagreeing about the supplier, the catalog, the sequence, the protocol
 * version or the timestamp is a signed head that describes something else —
 * and `snapshot_rkey` is how a consumer FETCHES the snapshot, so a wrong one
 * points at a record that does not exist.
 */
function pointerAgreesWithSnapshot(
  pointer: CatalogPointer,
  snapshot: CatalogSnapshot,
): string | null {
  if (pointer.snapshot_digest !== snapshot.snapshot_digest) {
    return 'the held pointer does not name the held snapshot';
  }
  // §10.2 addresses a snapshot record BY its digest, so these are the same
  // string by construction and a difference means the columns were mixed.
  if (pointer.snapshot_rkey !== snapshot.snapshot_digest) {
    return 'the held pointer names a snapshot record key that is not the snapshot digest';
  }
  if (pointer.supplier_did !== snapshot.supplier_did) return 'pointer and snapshot disagree on the supplier';
  if (pointer.catalog_id !== snapshot.catalog_id) return 'pointer and snapshot disagree on the catalog';
  if (pointer.snapshot_sequence !== snapshot.snapshot_sequence) {
    return 'pointer and snapshot disagree on the sequence';
  }
  if (pointer.protocol_version !== snapshot.protocol_version) {
    return 'pointer and snapshot disagree on the protocol version';
  }
  if (pointer.published_at !== snapshot.published_at) {
    return 'pointer and snapshot disagree on the publication time';
  }
  return null;
}

export class CatalogDraftService {
  constructor(private readonly deps: DraftServiceDeps) {}

  /**
   * Step 6 — the seller accepts every model-derived value.
   *
   * On `model_derived` this demands presence and mints the content receipt.
   * On the other two classes it only advances the state: nothing was inferred,
   * so there is nothing for a person to attest to, and requiring a human here
   * would put one in front of every connector republication.
   */
  confirm(draftId: string): DraftOutcome<CatalogDraft> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);
    const wrong = requireState(draft, 'confirm');
    if (wrong !== null) return wrong;
    if (draft.items.length === 0) {
      return refuse('no_items', 'a draft with no assembled items has nothing to confirm');
    }

    if (draft.provenanceClass === 'model_derived') {
      if (!this.deps.userPresent()) {
        return refuse(
          'no_user_presence',
          'confirmation records that a person vouched for machine-invented values (§10 item 9)',
        );
      }
      // §5 asks for the extraction's model and schema version alongside the
      // values a model produced. A receipt minted without them records that
      // SOMETHING read the page — which is not attribution, and the receipt is
      // the artefact that is supposed to answer the question later.
      if (draft.extraction === null) {
        return refuse(
          'missing_receipt',
          'a model-derived draft cannot be confirmed without the extraction that produced it (§5)',
        );
      }
      const outstanding = unconfirmedFields(draft);
      if (outstanding.length > 0) {
        return refuse(
          'unconfirmed_field',
          `still proposed: ${outstanding.slice(0, 5).join(', ')}${outstanding.length > 5 ? ` (+${String(outstanding.length - 5)} more)` : ''}`,
        );
      }
    }

    const next: CatalogDraft = {
      ...draft,
      state: 'confirmed',
      // Minted for model-derived drafts only. The exempt classes carry no
      // receipt, and `publish` verifies that absence is legitimate rather than
      // treating it as a missing one.
      receipt:
        draft.provenanceClass === 'model_derived'
          ? {
              digest: catalogContentReceiptDigest(
                {
                  items: draft.items,
                  provenance: draft.provenance,
                  contentRevision: draft.contentRevision,
                  // INSIDE THE RECEIPT, so a draft cannot claim afterwards to
                  // have come from a different model than the one the person
                  // was told about when they vouched for it.
                  extraction: draft.extraction,
                },
                this.deps.sha256,
              ),
              revision: draft.contentRevision,
            }
          : null,
      updatedAtMs: this.deps.now(),
    };
    this.deps.drafts.put(next);
    return { ok: true, value: next };
  }

  /**
   * Step 8 — build in memory, writing nothing.
   *
   * `buildCatalogSnapshot` is pure, so the digest the owner reviews needs no
   * repo write to exist. The bytes are held on the draft with the content
   * revision they were built from, and step 10 publishes exactly these.
   */
  prepare(draftId: string, args: { protocolVersion: string; publishedAt: string; serviceRkey?: string }): DraftOutcome<CatalogDraft> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);
    const wrong = requireState(draft, 'prepare');
    if (wrong !== null) return wrong;
    if (draft.items.length === 0) return refuse('no_items', 'nothing to build');

    const receiptCheck = this.checkReceipt(draft);
    if (receiptCheck !== null) return receiptCheck;

    const head = this.deps.pointers.get(draft.catalogId);
    const built = buildCatalogSnapshot({
      supplierDid: draft.items[0]?.supplier_did ?? '',
      catalogId: draft.catalogId,
      protocolVersion: args.protocolVersion,
      publishedAt: args.publishedAt,
      items: draft.items as readonly CatalogItem[],
      previous: head === null ? null : { pointer: head.pointer, snapshotDigest: head.snapshotDigest },
      ...(args.serviceRkey === undefined ? {} : { serviceRkey: args.serviceRkey }),
      sha256: this.deps.sha256,
    });
    if (!built.ok) return refuse('build_failed', built.error);
    if (built.snapshot === undefined || built.pages === undefined) {
      return refuse('build_failed', 'builder produced no snapshot');
    }

    const next: CatalogDraft = {
      ...draft,
      state: 'prepared',
      held: {
        snapshot: built.snapshot,
        pages: built.pages,
        // HELD, NOT REBUILT. `previous_snapshot_digest` and `service_rkey`
        // exist only on the pointer, so reconstructing one from the snapshot
        // silently drops the chain link and the listing binding.
        pointer: built.pointer,
        expectedPointerCid: head?.pointerCid ?? '',
        revision: draft.contentRevision,
      },
      updatedAtMs: this.deps.now(),
    };
    this.deps.drafts.put(next);
    return { ok: true, value: next };
  }

  /**
   * Step 9 — the §12.1 step 11 review, BEFORE any record is written.
   *
   * Core compares the digest it was handed against the snapshot it is holding
   * rather than trusting it. A caller that could name the approved digest
   * would otherwise be approving its own snapshot, which is the software
   * asking itself — and the client holding the owner capability is exactly
   * such a caller.
   */
  approve(draftId: string, approvedDigest: string): DraftOutcome<CatalogDraft> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);
    const wrong = requireState(draft, 'approve');
    if (wrong !== null) return wrong;
    if (draft.held === null) return refuse('build_failed', 'no held snapshot to approve');
    if (draft.held.revision !== draft.contentRevision) {
      return refuse('stale_revision', 'the draft changed after the snapshot was built');
    }
    // PRESENCE ON EVERY CLASS. §12.1 step 11 binds the published bytes and does
    // not care where the values came from, so the exemption that applies to
    // `confirm` does not reach here.
    if (!this.deps.userPresent()) {
      return refuse('no_user_presence', 'the snapshot review is a person looking at the bytes');
    }
    if (approvedDigest !== draft.held.snapshot.snapshot_digest) {
      return refuse(
        'digest_mismatch',
        'the approved digest is not the snapshot this node is holding',
      );
    }

    const next: CatalogDraft = {
      ...draft,
      state: 'approved',
      approval: { digest: approvedDigest, revision: draft.contentRevision },
      updatedAtMs: this.deps.now(),
    };
    this.deps.drafts.put(next);
    return { ok: true, value: next };
  }

  /**
   * Step 10 — write the approved bytes, snapshot then pointer.
   *
   * The fence is re-checked HERE, before the first write. The shipped route
   * checks once at request start and once before the pointer, which was sound
   * when build and write were milliseconds apart and is not once an owner
   * decision sits between them.
   */
  async publish(draftId: string): Promise<DraftOutcome<CatalogDraft>> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);

    // TERMINAL: a repeat publish returns what already happened rather than
    // starting a second publication of a catalog already on the wire.
    if (draft.state === 'published' && draft.publication !== null) {
      return { ok: true, value: draft };
    }
    const wrong = requireState(draft, 'publish');
    if (wrong !== null) return wrong;

    // THE CLAIM IS TAKEN HERE, BEFORE THE CHECKS RATHER THAN AFTER THEM.
    //
    // It used to sit just above the first write, so that only the writes ran
    // under it. That read well and stranded sellers: an abandoned claim is
    // taken over by `publish` and by nothing else, `recordEdit` refuses on any
    // claim, and every check between here and there could refuse BEFORE the
    // takeover — a fenced node, held bytes that no longer validate, a receipt
    // that stopped matching. The draft could then neither publish nor be
    // edited, and there is no release route. The lease built exactly the
    // wedge its TTL exists to prevent.
    //
    // Claiming first collapses that: any publish attempt takes an abandoned
    // claim over, and the `finally` gives it back however the attempt ends.
    // One acquisition, one release, whole operation.
    const token = this.deps.newClaimToken();
    if (!this.deps.drafts.claimForPublish(draftId, token, this.deps.now(), PUBLISH_CLAIM_TTL_MS)) {
      return refuse('publishing', 'another publication of this draft is already in flight');
    }
    try {
      return await this.publishClaimed(draftId, draft);
    } finally {
      this.deps.drafts.releaseClaim(draftId, token);
    }
  }

  /**
   * Everything `publish` does while holding the claim.
   *
   * Split out so the claim's lifetime is one `try` in the caller rather than a
   * release repeated down twenty return paths — the shape that let the old
   * version leak a claim on a throw.
   */
  private async publishClaimed(
    draftId: string,
    draft: CatalogDraft,
  ): Promise<DraftOutcome<CatalogDraft>> {
    const receiptCheck = this.checkReceipt(draft);
    if (receiptCheck !== null) return receiptCheck;
    if (draft.held === null) return refuse('build_failed', 'no held snapshot');
    if (draft.approval === null) {
      return refuse('missing_approval', 'no approval was recorded through the approve operation');
    }
    // ALL THREE AT THE CURRENT REVISION, compared for EQUALITY. "Not earlier
    // than" would admit a receipt from a LATER revision — a seller edits during
    // the pause, re-confirms, and the fresh receipt sits beside pre-edit held
    // bytes, which is the disclosure this check exists to stop.
    if (
      draft.held.revision !== draft.contentRevision ||
      draft.approval.revision !== draft.contentRevision
    ) {
      return refuse('stale_revision', 'the draft changed after it was prepared or approved');
    }
    if (draft.approval.digest !== draft.held.snapshot.snapshot_digest) {
      return refuse('digest_mismatch', 'the approval does not name the snapshot being published');
    }
    // RE-DERIVED, NOT TRUSTED. Everything above compares stored values with
    // other stored values, so a row edited after writing agrees with itself and
    // passes. These bytes are about to be SIGNED and published, and the digest
    // the owner approved is only meaningful if the bytes still produce it.
    const badSnapshot = verifyCatalogSnapshot(draft.held.snapshot, this.deps.sha256);
    if (badSnapshot !== null) return refuse('digest_mismatch', badSnapshot);
    if (draft.held.pages.length !== draft.held.snapshot.page_digests.length) {
      return refuse(
        'digest_mismatch',
        `held pages do not match the snapshot: committed to ${String(draft.held.snapshot.page_digests.length)}, holding ${String(draft.held.pages.length)}`,
      );
    }
    for (const page of draft.held.pages) {
      // `verifyCatalogPage` pins the page to its OWN declared index: it
      // recomputes the content digest against `page_digests[page.page_index]`
      // and checks the declared field agrees. An earlier version added a
      // second comparison against the ARRAY position, which no test could make
      // fail — duplicated or reordered pages are caught before the snapshot
      // write by `publishCatalogRecords`, which walks `page_digests` in order.
      const badPage = verifyCatalogPage(page, draft.held.snapshot, this.deps.sha256);
      if (badPage !== null) return refuse('digest_mismatch', badPage);
    }

    // THE BINDING THAT MAKES THE RECEIPT MEAN ANYTHING. Everything above proves
    // the held bytes are internally consistent — a snapshot that commits to its
    // pages, pages that hash to what they claim. A DIFFERENT set of items,
    // paginated and re-digested consistently, satisfies every one of those
    // checks while the receipt still covers `draft.items`. Then the person
    // confirmed one catalog and the node signs another, which is the exact
    // failure this whole lane exists to prevent.
    const published = draft.held.pages.flatMap((page) => page.items);
    if (published.length !== draft.items.length) {
      return refuse(
        'digest_mismatch',
        `the held pages carry ${String(published.length)} items and the confirmed draft has ${String(draft.items.length)}`,
      );
    }
    if (draft.held.snapshot.item_count !== draft.items.length) {
      return refuse(
        'digest_mismatch',
        'the held snapshot counts a different number of items than the draft it was built from',
      );
    }
    for (const [index, item] of published.entries()) {
      // Canonical bytes, not a field-by-field walk: the snapshot digest is
      // taken over canonical JSON, so that is the comparison that answers
      // "are these the same items" in the terms the signature is about.
      if (canonicalJson(item) !== canonicalJson(draft.items[index])) {
        return refuse(
          'digest_mismatch',
          `held page item ${String(index)} is not the item the receipt covers`,
        );
      }
    }

    // And the pointer must agree with the snapshot on every field they share.
    // The pointer carries the chain link and the listing binding, neither
    // covered by the snapshot's digest — and a pointer that names the right
    // digest under the wrong rkey sends every consumer to a record that is not
    // there.
    const pointerDisagreement = pointerAgreesWithSnapshot(
      draft.held.pointer,
      draft.held.snapshot,
    );
    if (pointerDisagreement !== null) return refuse('digest_mismatch', pointerDisagreement);
    if (this.deps.publicationFence() !== null) {
      return refuse('fenced', 'this node lost authority to publish (§16.2)');
    }

    // The draft is re-read once more before the first write. The checks above
    // ran against the object loaded at entry, and taking the claim is itself a
    // write — so this is the last chance to notice that what is stored is no
    // longer what was validated.
    const heldNow = this.deps.drafts.get(draftId);
    if (heldNow === null) return refuse('no_such_draft', `no draft ${draftId}`);
    if (heldNow.contentRevision !== draft.contentRevision || heldNow.state !== draft.state) {
      return refuse('stale_revision', 'the draft changed while publication was being prepared');
    }

    const written = await this.deps.publish({ draft });

    // THE DRAFT IS RE-READ AFTER THE AWAIT. Publication is two network round
    // trips, and `accept`, `editValue` and `repairRow` all remain callable
    // during them — the repository has no lock and no revision CAS. Writing
    // the loaded object back would silently discard a correction the seller
    // made while the snapshot was being written, and mark a draft terminal at
    // content nobody approved.
    const current = this.deps.drafts.get(draftId);
    if (current === null) return refuse('no_such_draft', `no draft ${draftId}`);
    if (current.contentRevision !== draft.contentRevision || current.state !== draft.state) {
      return refuse(
        'stale_revision',
        written.ok
          ? 'the draft changed while it was being published; the records are written and this draft no longer describes them'
          : 'the draft changed while publication was in flight',
      );
    }

    if (!written.ok) {
      if (written.lostSwap) {
        // THE HEAD MOVED. The held bytes are stale — a rebuild changes the
        // sequence, and `paginate` stamps the sequence into every page, so the
        // pages, their digests, `payload_root` and `snapshot_digest` are all
        // new. Core resets the draft to `confirmed` itself, which keeps
        // `prepare`'s precondition intact instead of widening it, and voids
        // the held bytes and the approval together. The receipt and the items
        // survive: a lost race did not touch them.
        this.deps.drafts.put({
          ...draft,
          state: 'confirmed',
          held: null,
          approval: null,
          // `draft` was loaded BEFORE the claim, so spreading it would put back
          // whatever claim field it carried then. `current` was read after the
          // release, so it holds null if the claim was ours and a SUCCESSOR'S
          // claim if one took over — and clearing that would undo the token
          // check in `releaseClaim` one statement later, leaving the draft
          // editable while the successor's writes are still in flight.
          publishClaim: current.publishClaim,
          updatedAtMs: this.deps.now(),
        });
      }
      return refuse('publish_failed', written.error);
    }

    const next: CatalogDraft = {
      ...draft,
      state: 'published',
      // Ours was released in the `finally`; anything here now belongs to a
      // publication that took over, and is not this one's to clear.
      publishClaim: current.publishClaim,
      publication: {
        // THE POINTER THAT WAS WRITTEN, not a description of it assembled
        // from the snapshot. The draft's record of what it published has to be
        // what it published, or the two fields that live only on the pointer
        // go missing from the record as well as from the wire.
        //
        // `written.pointer` is present only when the head had already moved
        // past us — the publication happened, and what is live is a later
        // pointer than the one we held. Recording the held one there would
        // describe a head that never existed.
        pointer: written.pointer ?? draft.held.pointer,
        pointerCid: written.pointerCid,
        snapshotCid: written.snapshotCid,
      },
      updatedAtMs: this.deps.now(),
    };
    this.deps.drafts.put(next);
    return { ok: true, value: next };
  }

  /**
   * Step 6's other half — the seller vouches for values a model read.
   *
   * WITHOUT THIS THE LANE HAS NO WAY THROUGH. `confirm` refuses while any
   * model-derived field is still `proposed`, every field of a fresh
   * `model_derived` draft IS `proposed`, and nothing else moves one. The
   * transition existed in the type and in no code path — a state machine with
   * a state it can never leave.
   *
   * THE CALLER NAMES FIELDS; CORE WRITES THE STATE. `recordEdit` takes a whole
   * provenance map and must never be a route: a client handed that could mark
   * every field `not_model_derived` and satisfy "nothing is still proposed"
   * with nothing confirmed at all, which is the forgery §5 rejects. Here the
   * only thing a caller supplies is WHICH fields it is accepting, and each one
   * must currently be waiting on a decision — so the request cannot invent an
   * exemption, only exercise one that Core already offered.
   *
   * Naming them is deliberate rather than an "accept all" flag, for the same
   * reason `approve` takes the digest it approves: a blanket yes records that
   * a button was pressed, not that anything was read.
   */
  accept(draftId: string, fields: readonly string[]): DraftOutcome<CatalogDraft> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);
    if (draft.state === 'published') {
      return refuse('wrong_state', 'a published draft is terminal; a republication starts a new one');
    }
    if (fields.length === 0) {
      return refuse('nothing_named', 'an acceptance has to say what was accepted');
    }

    const outstanding = new Set(unconfirmedFields(draft));
    const provenance: CatalogDraft['provenance'] = {};
    for (const [index, byField] of Object.entries(draft.provenance)) {
      provenance[index] = { ...byField };
    }
    for (const ref of fields) {
      if (!outstanding.has(ref)) {
        // Covers three cases with one answer, all of which mean the client is
        // working from a stale view of the draft: no such item, no such field,
        // and a field already decided. Accepting an already-accepted field
        // would be harmless; accepting a field that does not exist writes a
        // provenance row for nothing and hides a client bug.
        return refuse('unknown_field', `${ref} is not waiting on a decision`);
      }
      const split = ref.indexOf('.');
      const index = ref.slice(0, split);
      const field = ref.slice(split + 1);
      provenance[index] = { ...(provenance[index] ?? {}), [field]: 'accepted' };
    }

    // Provenance IS content (§10 item 8), so this bumps the content revision
    // and voids any held snapshot and approval — which is right: what the
    // owner would be approving has changed.
    return this.recordEdit(draftId, { provenance });
  }

  /**
   * §5 step 4 — REPAIR. The seller fixes a cell the model could not read, and
   * Core re-imports and re-assembles from the corrected rows.
   *
   * THIS IS THE STEP THAT MAKES THE LANE USABLE. A photographed price list
   * whose rows do not all import is the normal first state, not an error: §5
   * puts repair between the draft and the assembly precisely because the model
   * returns unreadable cells empty rather than guessed. Without it a seller
   * with one smudged line had no way forward at all.
   *
   * `editValue` is the other repair, one level along: this one edits the ROW
   * the model produced, that one edits an assembled ITEM. A row that does not
   * import has no item to edit yet, which is why both exist.
   *
   * Re-assembly uses the draft's OWN stamp, so a repair does not re-mint
   * `generated_at` or `item_revision` — those are minted once per draft, and a
   * repair is not a new draft.
   */
  repairRow(
    draftId: string,
    /**
     * A cell to set, a cell to clear (`value: null`), or a row to remove
     * (`column: null`).
     *
     * §8's failure table says a seller facing an invented product "deletes the
     * row", and an off-vocabulary column the model returned is refused by name
     * for ever — `unknown_column` is raised on the column NAME, so setting its
     * value to `''` does not clear it. A repair surface that can only SET
     * leaves both of those as dead ends, and the importer is all-or-nothing,
     * so one of them blocks the whole draft.
     */
    ref: { row: number; column: string | null; value: string | null },
    reassemble: (rows: readonly DraftRow[], draft: CatalogDraft) => {
      items: CatalogItem[];
      findings: unknown[];
    },
  ): DraftOutcome<CatalogDraft> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);
    if (draft.state === 'published') {
      return refuse('wrong_state', 'a published draft is terminal; a republication starts a new one');
    }
    const target = draft.rows.find((r) => r.row === ref.row);
    if (target === undefined) return refuse('unknown_field', `no row ${String(ref.row)} on this draft`);
    if (ref.column === '') return refuse('unknown_field', 'a repair has to name a column');

    let rows: DraftRow[];
    if (ref.column === null) {
      // THE INVENTED PRODUCT. §8's answer is that the seller deletes the row,
      // and until now there was no way to. A draft with no rows left is not a
      // catalog, so the last one cannot go this way.
      if (draft.rows.length === 1) {
        return refuse('no_items', 'removing the last row would leave no catalog to publish');
      }
      rows = draft.rows.filter((r) => r.row !== ref.row);
    } else {
      const column = ref.column;
      rows = draft.rows.map((r) => {
        if (r.row !== ref.row) return r;
        const cells: Record<string, string> = {};
        for (const [key, value] of Object.entries(r.cells)) {
          if (key !== column) cells[key] = value;
        }
        // `null` CLEARS THE KEY rather than emptying it. `unknown_column` is
        // raised on the column's NAME, so a value of `''` leaves the finding
        // exactly where it was and the draft never assembles.
        if (ref.value !== null) cells[column] = ref.value;
        return { row: r.row, cells };
      });
    }
    const rebuilt = reassemble(rows, draft);

    // Provenance is re-seeded from the NEW items, because a repair can change
    // how many items there are: a row that failed to import produces one where
    // there was none, and carrying the old map across would attach a decision
    // to an item that is not the one it was made about.
    // KEYED BY PRODUCT IDENTITY, NOT BY POSITION. A repair can change how many
    // items there are — a row that failed to import produces one where there
    // was none — and every later item then shifts down. Pairing by array index
    // across that shift hands one product's acceptances to a different
    // product wherever their field values happen to match, which is a person
    // vouching for something they never saw.
    const carriedByProduct = new Map<string, Record<string, FieldProvenance>>();
    const previousByProduct = new Map<string, CatalogItem>();
    draft.items.forEach((existing, index) => {
      const key = productIdentity(existing);
      carriedByProduct.set(key, draft.provenance[String(index)] ?? {});
      previousByProduct.set(key, existing);
    });

    const provenance: CatalogDraft['provenance'] = {};
    rebuilt.items.forEach((item, index) => {
      const key = productIdentity(item);
      const previous = previousByProduct.get(key);
      const carried = previous === undefined ? {} : (carriedByProduct.get(key) ?? {});
      const forItem: Record<string, FieldProvenance> = {};
      // `Object.entries` rather than an index cast: `CatalogItem` is an
      // interface and so has no index signature, and casting one in is how a
      // wrong field name stops being a compile error.
      const before: Record<string, unknown> =
        previous === undefined ? {} : Object.fromEntries(Object.entries(previous));
      const after: Record<string, unknown> = Object.fromEntries(Object.entries(item));
      for (const field of Object.keys(item)) {
        const unchanged =
          previous !== undefined && JSON.stringify(before[field]) === JSON.stringify(after[field]);
        // A field whose VALUE the repair changed goes back to needing a
        // decision. Keeping an `accepted` on a value that has since moved
        // would record a person vouching for something they never saw.
        forItem[field] = unchanged ? (carried[field] ?? 'proposed') : 'proposed';
      }
      provenance[String(index)] = forItem;
    });

    return this.recordEdit(draftId, {
      items: rebuilt.items,
      provenance,
      rows,
      findings: rebuilt.findings,
    });
  }

  /**
   * §5's repair step — the seller CORRECTS a value the model misread.
   *
   * The other half of `accept`, and the half that decides what gets published:
   * a seller who can only accept is choosing between a wrong price and no
   * catalog. Here they supply the right one.
   *
   * WHAT A CALLER MAY NOT TOUCH, and this is the whole safety of the
   * operation. Only fields the SOURCE ROW supplied are editable
   * (`CATALOG_FIELD_ORIGIN`). `supplier_did`, `catalog_id`, `item_revision`,
   * `category_ids`, `fulfilment_regions` and `freshness` are minted by the
   * assembler or come from the seller's settings, and an edit route that
   * reached them would let a client publish under another supplier's DID or
   * into a category the vocabulary never granted — through the one route whose
   * whole purpose is to accept a value from outside.
   *
   * The corrected item is re-validated as a WHOLE through
   * `validateCatalogItem`, so an edit cannot leave behind an item the publisher
   * would sign and every consumer refuse. Core then writes `edited` itself: the
   * caller supplies a VALUE and never a provenance state.
   */
  editValue(draftId: string, ref: string, value: unknown): DraftOutcome<CatalogDraft> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);
    if (draft.state === 'published') {
      return refuse('wrong_state', 'a published draft is terminal; a republication starts a new one');
    }

    const split = ref.indexOf('.');
    if (split <= 0) {
      return refuse('unknown_field', `${ref} is not an "<index>.<field>" reference`);
    }
    const index = Number(ref.slice(0, split));
    const field = ref.slice(split + 1);
    const item = Number.isInteger(index) ? draft.items[index] : undefined;
    if (item === undefined) return refuse('unknown_field', `${ref} names no item on this draft`);
    if (!(field in CATALOG_FIELD_ORIGIN)) {
      return refuse('unknown_field', `${field} is not a published field`);
    }
    if (CATALOG_FIELD_ORIGIN[field as keyof CatalogItem] !== 'row') {
      return refuse(
        'immutable_field',
        `${field} comes from the assembler or the seller's settings, not from a row`,
      );
    }

    // `undefined` CLEARS an optional field rather than storing a hole: a
    // seller striking out a description the model invented is a repair, and
    // `validateCatalogItem` below decides whether the field was optional.
    const clears = value === undefined || value === null;
    const edited: Record<string, unknown> = {};
    for (const [key, existing] of Object.entries(item)) {
      if (key !== field) edited[key] = existing;
    }
    if (!clears) edited[field] = value;

    const invalid = validateCatalogItem(edited);
    if (invalid !== null) return refuse('item_rejected', invalid);

    // AND THE FIELD GUARD ABOVE IS NOT ENOUGH ON ITS OWN. `product` and
    // `identifiers` are row-derived, so they are editable — and both carry an
    // `issuer_did` that `validateCatalogItem` accepts as any well-formed DID.
    // Scoping at field granularity while the VALUE carries a foreign DID
    // leaves the same hole one level down: a `manufacturer_sku` attributed to
    // a party that never issued it, published from this node. The importer and
    // the assembler both scope every identifier to the publishing supplier;
    // this keeps the edit route to the same rule.
    const foreign = foreignIssuer(edited, item.supplier_did);
    if (foreign !== null) {
      return refuse(
        'immutable_field',
        `${field} names issuer ${foreign}, which is not this supplier — an identifier is scoped to whoever issued it`,
      );
    }

    // AND NEITHER GUARD SEES THE OTHER ITEMS. `assembleCatalogItems` refuses
    // two rows resolving to one product identity, and every other way into a
    // draft goes through it — the three ingress routes build one, and
    // `repairRow` re-enters it through `reassemble`. This route does not: it
    // rewrites ONE assembled item in place, so editing `0.product` to item
    // 1's `ProductRef` would put the collision back that the assembler exists
    // to keep out. Both harms return with it: AppView refuses the whole
    // snapshot as `duplicate_identity`, so a correctly signed catalog is
    // indexed nowhere; and `repairRow` keys its carried provenance by product
    // identity, so a later repair would hand one product's acceptances to the
    // other — a person recorded as vouching for a value they never saw.
    const editedItem = edited as unknown as CatalogItem;
    const identity = productIdentity(editedItem);
    const collidesWith = draft.items.findIndex(
      (existing, at) => at !== index && productIdentity(existing) === identity,
    );
    if (collidesWith !== -1) {
      return refuse(
        'item_rejected',
        `this product is already item ${String(collidesWith + 1)} — two items cannot publish one identity (§9.4)`,
      );
    }

    const items = draft.items.map((existing, at) =>
      at === index ? editedItem : existing,
    );
    const provenance: CatalogDraft['provenance'] = {};
    for (const [key, byField] of Object.entries(draft.provenance)) {
      provenance[key] = { ...byField };
    }
    // The seller wrote this value, so it is `edited` — not `accepted`, which
    // records vouching for what a MODEL produced. A field the edit removed has
    // no provenance row, and `unconfirmedFields` walks the item's own keys, so
    // it stops being asked about.
    const forItem: Record<string, FieldProvenance> = {};
    for (const [key, state] of Object.entries(provenance[String(index)] ?? {})) {
      if (key !== field) forItem[key] = state;
    }
    if (!clears) forItem[field] = 'edited';
    provenance[String(index)] = forItem;

    return this.recordEdit(draftId, { items, provenance });
  }

  /**
   * The shared write behind `accept` and `editValue` — an edit returns the
   * draft to `created` and voids everything downstream.
   *
   * PRIVATE, and that is the safety property rather than tidiness. It takes a
   * whole provenance map, so a route reaching it could mark every field
   * `not_model_derived` and satisfy "nothing is still proposed" with nothing
   * confirmed at all. The two public operations each supply one half — a set
   * of fields, or a field and a value — and Core writes the state.
   *
   * Bumping the revision is what makes the receipt, the held bytes and the
   * approval stale, and voiding them here means a caller cannot publish from
   * a draft whose content moved under it.
   */
  private recordEdit(
    draftId: string,
    edit: {
      items?: readonly CatalogItem[];
      provenance?: CatalogDraft['provenance'];
      rows?: readonly DraftRow[];
      findings?: readonly unknown[];
    },
  ): DraftOutcome<CatalogDraft> {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no draft ${draftId}`);
    if (draft.state === 'published') {
      return refuse('wrong_state', 'a published draft is terminal; a republication starts a new one');
    }
    // THE OTHER HALF OF THE LEASE, AND IT DOES NOT CONSULT THE CLOCK.
    //
    // The TTL answers "may another publication take this over?", which a clock
    // can decide safely because the pointer write is a CAS and a duplicate
    // attempt loses harmlessly. It cannot decide "may an edit land here?": age
    // is a guess about whether the first publication is still running, and a
    // publication that is merely SLOW — two network round trips on a bad
    // mobile connection — is indistinguishable from a dead one. Guess wrong
    // and the edit is accepted locally while the old bytes are still on their
    // way to the wire, which is the interleaving the lease exists to prevent
    // and which the post-await revision check can only report after the fact.
    //
    // So any claim at all excludes an edit. The escape from a claim left by a
    // process that died is to PUBLISH, not to edit: a claim is only ever taken
    // in `publish`, which needs `approved`, so a draft wedged this way is by
    // construction one whose bytes the owner already approved, and finishing
    // that publication is both allowed (the TTL lets it take over) and the
    // right thing to do — the records may already be half-written. Every
    // publish path ends by clearing or replacing the claim, so editing works
    // again immediately afterwards.
    if (draft.publishClaim !== null) {
      return refuse(
        'publishing',
        'a publication is holding this draft; publish it to finish or release that attempt, then edit',
      );
    }
    const next: CatalogDraft = {
      ...draft,
      state: 'created',
      contentRevision: draft.contentRevision + 1,
      ...(edit.items === undefined ? {} : { items: edit.items }),
      ...(edit.provenance === undefined ? {} : { provenance: edit.provenance }),
      ...(edit.rows === undefined ? {} : { rows: edit.rows }),
      ...(edit.findings === undefined ? {} : { findings: edit.findings }),
      receipt: null,
      held: null,
      approval: null,
      updatedAtMs: this.deps.now(),
    };
    this.deps.drafts.put(next);
    return { ok: true, value: next };
  }

  /**
   * The receipt rule, in ONE place so `prepare` and `publish` cannot disagree.
   *
   * `model_derived` needs one at the current revision; the other classes must
   * NOT carry one, because a receipt on an exempt draft means something
   * minted it outside the path that checks presence.
   */
  private checkReceipt(draft: CatalogDraft): DraftRefusalOutcome | null {
    if (draft.provenanceClass !== 'model_derived') {
      if (draft.receipt !== null) {
        return refuse('missing_receipt', 'an exempt draft carries no content receipt');
      }
      return null;
    }
    if (draft.receipt === null) {
      return refuse('missing_receipt', 'a model-derived draft publishes only what a person confirmed');
    }
    if (draft.receipt.revision !== draft.contentRevision) {
      return refuse('stale_revision', 'the draft changed after the receipt was taken');
    }
    const recomputed = catalogContentReceiptDigest(
      {
        items: draft.items,
        provenance: draft.provenance,
        contentRevision: draft.contentRevision,
        extraction: draft.extraction,
      },
      this.deps.sha256,
    );
    if (recomputed !== draft.receipt.digest) {
      // The stored receipt does not describe the stored items. Re-derived
      // rather than trusted, because the receipt is the whole reason to
      // believe a person saw these bytes.
      return refuse('digest_mismatch', 'the content receipt does not match the draft it is on');
    }
    return null;
  }
}
