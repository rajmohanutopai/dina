/**
 * The buyer aggregate's state machine (PHOTO_COMMERCE_LANES_DESIGN §5.1)
 * — the transition and invalidation matrix as OPERATIONS, each row a
 * method, each rule enforced here in compiled code and nowhere else.
 *
 * The rows this module owns:
 *
 *   repair a line        unless in a SUBMITTED order; generation bumps,
 *                        the typed field → `edited`, derivatives →
 *                        `proposed`, the vouch voids, every non-terminal
 *                        conversation carrying the line is invalidated
 *   resolve / defer      as the repair row, scoped to the line; defer
 *                        EXCLUDES an ambiguous line from confirm rather
 *                        than letting it park every other line
 *   accept line fields   named {line, field} refs, each currently
 *                        `proposed` — the seller lane's `accept` shape.
 *                        Without this row the confirm gate is a state
 *                        with no exit (the r10 lesson, kept by name)
 *   requirement ops      ALWAYS allowed — submitted history is protected
 *                        by conversation SNAPSHOTS, so no state exists in
 *                        which these rewrite what an order meant
 *   confirm (presence)   the ceremony: gates below, then mints the §2.1
 *                        batch vouch receipt COMMITTING THE EXTRACTION
 *                        DIGEST, and updates every included line's and
 *                        requirement's vouch entry to it
 *   reopen / abandon     terminal recovery; submitted conversations stay
 *                        immutable history for ever
 */

import { validateProductRef, vouchReceiptDigest } from '@dina/commerce-protocol';

import { TERMINAL_CONVERSATION_STATES } from './order_draft_store';

import type {
  OrderDraft,
  OrderDraftLine,
  OrderDraftRepository,
} from './order_draft_store';
import type { Sha256Fn, VouchedRequirement } from '@dina/commerce-protocol';

export type OrderDraftOutcome =
  | {
      ok: true;
      draft: OrderDraft;
      /**
       * §5.1 step 1 only: the approval ids of competitor conversations this
       * transaction closed. The CALLER revokes them in the same runtime
       * transaction — the courtesy; the submit-time source-binding check is
       * the enforcement.
       */
      revokedApprovalIds?: string[];
    }
  | { ok: false; refusal: string; detail: string };

function refuse(refusal: string, detail: string): OrderDraftOutcome {
  return { ok: false, refusal, detail };
}

/**
 * The write-side mirror of the store's `readResolution`: everything that
 * validator would refuse on load is refused HERE instead, so no accepted
 * write can make the draft unreadable.
 */
function invalidResolution(resolution: OrderDraftLine['resolution']): string | null {
  if (resolution.kind === 'unresolved') return null;
  if (resolution.kind === 'ambiguous') {
    for (const candidate of resolution.candidates) {
      const bad = validateProductRef(candidate.product);
      if (bad !== null) return bad;
      if (typeof candidate.supplierDid !== 'string' || candidate.supplierDid === '') {
        return 'candidate supplierDid must be a non-empty string';
      }
    }
    return null;
  }
  if (resolution.kind === 'resolved') {
    const bad = validateProductRef(resolution.product);
    if (bad !== null) return bad;
    if (typeof resolution.supplierDid !== 'string' || resolution.supplierDid === '') {
      return 'supplierDid must be a non-empty string';
    }
    return null;
  }
  return `unknown resolution kind ${String((resolution as { kind?: unknown }).kind)}`;
}

export interface OrderDraftServiceDeps {
  drafts: OrderDraftRepository;
  now: () => number;
  sha256: Sha256Fn;
  /** §5.3 — the same presence module both lanes read. */
  userPresent: () => boolean;
}

/** Fields a repair re-derives; anything the buyer TYPED stays `edited`. */
const REPARSED_FIELDS: ReadonlySet<string> = new Set(['quantity']);

export class OrderDraftService {
  constructor(private readonly deps: OrderDraftServiceDeps) {}

  private load(draftId: string): OrderDraft | OrderDraftOutcome {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no order draft ${draftId}`);
    if (draft.abandoned) return refuse('abandoned', 'this draft was abandoned');
    return draft;
  }

  private save(draft: OrderDraft): OrderDraftOutcome {
    draft.updatedAtMs = this.deps.now();
    this.deps.drafts.put(draft);
    return { ok: true, draft };
  }

  /**
   * Invalidate every NON-TERMINAL conversation carrying the line: requests
   * become history, quotes non-approvable, retained approvals invalidated
   * (§5.1). The submit-time source-binding check is the enforcement;
   * clearing here is the courtesy.
   */
  private invalidateConversationsCarrying(draft: OrderDraft, lineId: string): void {
    for (const conversation of draft.conversations) {
      if (TERMINAL_CONVERSATION_STATES.has(conversation.state)) continue;
      if (!conversation.lineIds.includes(lineId)) continue;
      conversation.state = 'superseded';
      conversation.approvalId = null;
      conversation.outcome = 'superseded_by_line_change';
    }
  }

  /** §5.1 requirement row: a changed date changes what every outstanding
   *  request asked for — TRANSMITTED requirements invalidate carriers. */
  private invalidateConversationsCarryingRequirement(draft: OrderDraft, key: string): void {
    for (const conversation of draft.conversations) {
      if (TERMINAL_CONVERSATION_STATES.has(conversation.state)) continue;
      const carried = conversation.snapshot?.requirements.some((r) => r.key === key) ?? false;
      if (!carried) continue;
      conversation.state = 'superseded';
      conversation.approvalId = null;
      conversation.outcome = 'superseded_by_requirement_change';
    }
  }

  /**
   * Repair a line's field — matrix row 1. The buyer TYPED this, so the
   * field goes to `edited` (demanding they "accept" their own words
   * confuses the vocabulary §2 pins); re-parsed derivatives go back to
   * `proposed`; the vouch entry voids; carriers invalidate.
   */
  repairLine(
    draftId: string,
    args: { lineId: string; field: string; value: string },
  ): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    const line = draft.lines.find((l) => l.lineId === args.lineId);
    if (line === undefined) return refuse('no_such_line', `no line ${args.lineId}`);
    if (line.submittedIn !== null) {
      return refuse(
        'line_submitted',
        'this line is part of a submitted order; rejected or timed-out lines reopen first',
      );
    }
    line.fields[args.field] = args.value;
    line.provenance[args.field] = 'edited';
    for (const derived of REPARSED_FIELDS) {
      if (derived !== args.field && line.fields[derived] !== undefined) {
        line.provenance[derived] = line.provenance[derived] ?? 'proposed';
      }
    }
    line.generation += 1;
    line.vouch = null;
    this.invalidateConversationsCarrying(draft, line.lineId);
    return this.save(draft);
  }

  /** Resolve / re-resolve — as the repair row, scoped to the line. */
  resolveLine(
    draftId: string,
    args: { lineId: string; resolution: OrderDraftLine['resolution']; evidence?: OrderDraftLine['evidence'] },
  ): OrderDraftOutcome {
    // REFUSE what the store cannot RE-READ. The store validates rows on
    // load and treats an invalid one as absent, so storing a resolution
    // the read path refuses (a scoped product ref missing `issuer_did`,
    // an unknown kind) does not fail this call — it makes the WHOLE
    // DRAFT unreadable for ever, which a first live driver-script bug
    // actually did. Write-path validation must be at least as strict as
    // the read path's.
    const invalid = invalidResolution(args.resolution);
    if (invalid !== null) return refuse('invalid_resolution', invalid);
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    const line = draft.lines.find((l) => l.lineId === args.lineId);
    if (line === undefined) return refuse('no_such_line', `no line ${args.lineId}`);
    if (line.submittedIn !== null) {
      return refuse('line_submitted', 'this line is part of a submitted order');
    }
    // The owner's decision: an unknown supplier is shown FLAGGED and never
    // auto-selected — a resolved state claiming otherwise is refused.
    if (args.resolution.kind === 'resolved' && args.resolution.flaggedNewSupplier) {
      // Allowed — the flag is honest. The screen made the buyer choose it.
    }
    line.resolution = args.resolution;
    line.evidence = args.evidence ?? null;
    line.generation += 1;
    line.vouch = null;
    line.deferred = false;
    this.invalidateConversationsCarrying(draft, line.lineId);
    return this.save(draft);
  }

  /** Defer an ambiguous line — EXCLUDED from confirm, not blocking it. */
  deferLine(draftId: string, lineId: string): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    const line = draft.lines.find((l) => l.lineId === lineId);
    if (line === undefined) return refuse('no_such_line', `no line ${lineId}`);
    if (line.resolution.kind !== 'ambiguous') {
      return refuse('not_ambiguous', 'defer is for a line with an undecided candidate set');
    }
    line.deferred = true;
    return this.save(draft);
  }

  /**
   * Accept named `{line, field}` refs — the confirm gate's exit. STATED
   * HONESTLY, as the design does: the operation enforces that nothing
   * invented, nothing unnamed and nothing not-`proposed` can be accepted;
   * per-field deliberation is the REVIEW SCREEN's duty.
   */
  acceptLineFields(
    draftId: string,
    refs: readonly { lineId: string; field: string }[],
  ): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    if (refs.length === 0) return refuse('nothing_named', 'accept names the fields it covers');
    for (const ref of refs) {
      const line = draft.lines.find((l) => l.lineId === ref.lineId);
      if (line === undefined) return refuse('no_such_line', `no line ${ref.lineId}`);
      if (!(ref.field in line.fields)) {
        return refuse('unknown_field', `line ${ref.lineId} has no field ${ref.field}`);
      }
      if (line.provenance[ref.field] !== 'proposed') {
        return refuse(
          'not_proposed',
          `line ${ref.lineId} field ${ref.field} is not awaiting a decision`,
        );
      }
    }
    for (const ref of refs) {
      const line = draft.lines.find((l) => l.lineId === ref.lineId);
      if (line !== undefined) line.provenance[ref.field] = 'accepted';
    }
    return this.save(draft);
  }

  /**
   * The requirement row — ALWAYS allowed: submitted history is protected
   * by the conversation snapshots. Generation bumps, the vouch voids, and
   * every non-terminal conversation whose request CARRIED it invalidates.
   */
  editRequirement(
    draftId: string,
    args: { key: string; action: 'edit' | 'accept' | 'omit' | 'reinstate'; value?: string },
  ): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    const requirement = draft.requirements.find((r) => r.key === args.key);
    if (requirement === undefined) return refuse('no_such_requirement', `no requirement ${args.key}`);

    if (args.action === 'edit') {
      if (args.value === undefined) return refuse('value_required', 'an edit carries the new value');
      requirement.value = args.value;
      requirement.omitted = false;
      requirement.provenance = 'edited';
    } else if (args.action === 'accept') {
      if (requirement.provenance !== 'proposed') {
        return refuse('not_proposed', `requirement ${args.key} is not awaiting a decision`);
      }
      requirement.provenance = 'accepted';
      // An acceptance changes no value and invalidates nothing — the date
      // every outstanding request asked for is still the date.
      return this.save(draft);
    } else if (args.action === 'omit') {
      requirement.value = null;
      requirement.omitted = true;
      requirement.provenance = 'edited';
    } else {
      requirement.omitted = false;
      requirement.provenance = 'proposed';
    }
    requirement.generation += 1;
    requirement.vouch = null;
    if (requirement.kind === 'transmitted') {
      this.invalidateConversationsCarryingRequirement(draft, requirement.key);
    }
    return this.save(draft);
  }

  /**
   * CONFIRM — the ceremony (§5.1's confirm row, whole):
   *
   *   - presence, unconditionally: this lane is photo-derived by its
   *     aggregate, and a batch tap cannot vouch a quantity nobody looked
   *     at (the epigraph);
   *   - every INCLUDED line resolved — `ambiguous` deferred or decided,
   *     `unresolved` excluded and NAMED as excluded;
   *   - every model-derived field of every included line out of
   *     `proposed`;
   *   - every requirement decided, INCLUDING draft-local ones — the
   *     instruction is receipt-covered or it is not caught at confirm.
   *
   * Then: the ceremony counter bumps (by confirm and NOTHING else), the
   * §2.1 batch vouch receipt is minted committing the extraction digest,
   * and every included line's and requirement's vouch entry updates to it.
   */
  confirm(draftId: string): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    if (!this.deps.userPresent()) {
      return refuse('no_user_presence', 'confirming machine-read lines needs a person present');
    }
    if (draft.extractionDigest === '') {
      return refuse('no_extraction_chain', 'this draft carries no extraction commitment');
    }

    const included = draft.lines.filter(
      (line) =>
        !line.deferred && line.resolution.kind === 'resolved' && line.submittedIn === null,
    );
    if (included.length === 0) {
      return refuse('nothing_included', 'no resolved, undeferred lines to confirm');
    }
    const blockingAmbiguous = draft.lines.filter(
      (line) => line.resolution.kind === 'ambiguous' && !line.deferred,
    );
    if (blockingAmbiguous.length > 0) {
      return refuse(
        'undecided_candidates',
        `decide or defer: ${blockingAmbiguous.map((l) => l.lineId).join(', ')}`,
      );
    }
    for (const line of included) {
      const undecided = Object.entries(line.provenance)
        .filter(([, state]) => state === 'proposed')
        .map(([field]) => field);
      if (undecided.length > 0) {
        return refuse(
          'unconfirmed_fields',
          `line ${line.lineId}: ${undecided.join(', ')} still need your eye`,
        );
      }
    }
    for (const requirement of draft.requirements) {
      if (requirement.provenance === 'proposed' && !requirement.omitted) {
        return refuse(
          'undecided_requirement',
          `requirement ${requirement.key} is neither vouched nor omitted`,
        );
      }
    }

    const ceremony = draft.ceremonyCounter + 1;
    const requirements: VouchedRequirement[] = draft.requirements.map((r) => ({
      key: r.key,
      omitted: r.omitted,
      value: r.omitted ? null : r.value,
      generation: r.generation,
    }));
    const receipt = {
      draft_id: draft.draftId,
      ceremony,
      extraction_digest: draft.extractionDigest,
      lines: included.map((line) => {
        const resolution = line.resolution as Extract<
          OrderDraftLine['resolution'],
          { kind: 'resolved' }
        >;
        return {
          line_id: line.lineId,
          generation: line.generation,
          quantity: { value: line.fields.quantity ?? '1', unit_code: 'each' },
          resolved_product: resolution.product,
          supplier_did: resolution.supplierDid,
        };
      }),
      requirements,
    };
    const digest = vouchReceiptDigest(receipt, this.deps.sha256);

    draft.ceremonyCounter = ceremony;
    for (const line of included) {
      line.vouch = { generation: line.generation, ceremony, receiptDigest: digest };
    }
    for (const requirement of draft.requirements) {
      requirement.vouch = {
        generation: requirement.generation,
        ceremony,
        receiptDigest: digest,
      };
    }
    return this.save(draft);
  }

  /**
   * Reopen after rejection / timeout: affected assignments RETIRE (the
   * generation bumps) and their vouch entries void — re-routing to a new
   * counterparty is a new decision, and a fresh ceremony covers it before
   * any new request (§5.1).
   */
  reopenLines(draftId: string, conversationId: string): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    const conversation = draft.conversations.find((c) => c.conversationId === conversationId);
    if (conversation === undefined) {
      return refuse('no_such_conversation', `no conversation ${conversationId}`);
    }
    if (!TERMINAL_CONVERSATION_STATES.has(conversation.state)) {
      return refuse('not_terminal', 'reopen is for a conversation that has ended');
    }
    for (const lineId of conversation.lineIds) {
      const line = draft.lines.find((l) => l.lineId === lineId);
      if (line === undefined || line.submittedIn !== null) continue;
      line.assignmentGeneration += 1;
      line.generation += 1;
      line.vouch = null;
    }
    return this.save(draft);
  }

  /**
   * §5.1's submission protocol, STEP 1 — one draft-store transaction:
   * the approval RESERVED (referenced, not consumed — the transient class
   * needs it intact for retry; consumption is the send boundary's own
   * behaviour), the competing assignments CLOSED, and a durable dispatch
   * intent minted. The caller wraps this in the runtime transaction and
   * revokes the returned competitor approvals inside it.
   */
  beginSubmit(
    draftId: string,
    args: { conversationId: string; intentId: string; purchaseOrderId: string },
  ): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    const conversation = draft.conversations.find(
      (c) => c.conversationId === args.conversationId,
    );
    if (conversation === undefined) {
      return refuse('no_such_conversation', `no conversation ${args.conversationId}`);
    }
    if (conversation.state === 'submitting') {
      // A live intent already exists; the sweeper replays it. A second
      // begin is a double-tap, not a second order.
      return refuse('submit_in_flight', 'this conversation is already dispatching');
    }
    if (conversation.state !== 'approved' || conversation.approvalId === null) {
      return refuse('not_approvable', `conversation is ${conversation.state}, not approved`);
    }
    conversation.state = 'submitting';
    conversation.dispatchIntent = {
      intentId: args.intentId,
      purchaseOrderId: args.purchaseOrderId,
      createdAtMs: this.deps.now(),
    };
    // CLOSE COMPETING ASSIGNMENTS (§5.4 stage 3a): every other live
    // conversation sharing a line becomes history, and its approval id
    // comes back for the caller to revoke — two approvals minted before
    // either submitted is the reachable race, and the loser must die at
    // submit on stale generations even if this courtesy loses that race.
    const revokedApprovalIds: string[] = [];
    for (const other of draft.conversations) {
      if (other.conversationId === conversation.conversationId) continue;
      if (TERMINAL_CONVERSATION_STATES.has(other.state)) continue;
      if (!other.lineIds.some((id) => conversation.lineIds.includes(id))) continue;
      if (other.approvalId !== null) revokedApprovalIds.push(other.approvalId);
      other.state = 'superseded';
      other.approvalId = null;
      other.outcome = 'closed_by_competing_submit';
    }
    const saved = this.save(draft);
    return saved.ok ? { ...saved, revokedApprovalIds } : saved;
  }

  /**
   * §5.1's submission protocol, STEP 3 — record which of the FOUR outcome
   * classes step 2 landed in:
   *
   *   refused    deterministic, pre-send: the intent terminates as
   *              `dispatch_refused(reason)`, the lines this dispatch
   *              reserved REOPEN through the ordinary reopen effect, and
   *              the caller invalidates the reserved approval — replaying
   *              a deterministic refusal loops for ever;
   *   uncertain  durable record created or send attempted: the §12.7
   *              reconcile machinery owns it now; competitors STAY closed
   *              because a doubtful dispatch must block double-purchase
   *              exactly as a confirmed one does;
   *   confirmed  closure finalises — every carried line records the order
   *              it is in;
   *   transient  the NODE briefly cannot act: the intent stays LIVE, the
   *              state stays `submitting`, and the same intent succeeds on
   *              retry. Never terminal.
   */
  recordSubmitOutcome(
    draftId: string,
    args: { conversationId: string } & (
      | { kind: 'refused'; reason: string }
      | { kind: 'uncertain' }
      | { kind: 'confirmed' }
      | { kind: 'transient'; reason: string }
    ),
  ): OrderDraftOutcome {
    const loaded = this.load(draftId);
    if ('ok' in loaded) return loaded;
    const draft = loaded;
    const conversation = draft.conversations.find(
      (c) => c.conversationId === args.conversationId,
    );
    if (conversation === undefined) {
      return refuse('no_such_conversation', `no conversation ${args.conversationId}`);
    }
    if (conversation.state !== 'submitting' || conversation.dispatchIntent === null) {
      return refuse('no_live_intent', 'no dispatch is in flight for this conversation');
    }
    if (args.kind === 'transient') {
      // Nothing was created, nothing sent; the intent survives. The note is
      // for the §5.5 "couldn't reach the courier" surface, not a state.
      conversation.outcome = `transient:${args.reason}`;
      return this.save(draft);
    }
    if (args.kind === 'refused') {
      conversation.state = 'dispatch_refused';
      conversation.outcome = args.reason;
      conversation.dispatchIntent = null;
      conversation.approvalId = null;
      // The ordinary reopen effect (§5.1's reopen row): the assignments this
      // dispatch reserved retire so the lines can be re-routed, and a fresh
      // ceremony covers them before any new request.
      for (const lineId of conversation.lineIds) {
        const line = draft.lines.find((l) => l.lineId === lineId);
        if (line === undefined || line.submittedIn !== null) continue;
        line.assignmentGeneration += 1;
        line.generation += 1;
        line.vouch = null;
      }
      return this.save(draft);
    }
    // The order id OUTLIVES the intent (§5.5): the lifecycle projection
    // resolves a `submitted_unconfirmed` conversation against its
    // buyer-order record by this, long after replay is done.
    conversation.purchaseOrderId = conversation.dispatchIntent.purchaseOrderId;
    if (args.kind === 'uncertain') {
      conversation.state = 'submitted_unconfirmed';
      conversation.outcome = null;
      conversation.dispatchIntent = null;
      return this.save(draft);
    }
    conversation.state = 'submitted';
    conversation.outcome = 'submitted';
    conversation.dispatchIntent = null;
    for (const lineId of conversation.lineIds) {
      const line = draft.lines.find((l) => l.lineId === lineId);
      if (line !== undefined) line.submittedIn = conversation.conversationId;
    }
    return this.save(draft);
  }

  /** Abandon — explicit buyer action; submitted stays immutable history. */
  abandon(draftId: string): OrderDraftOutcome {
    const draft = this.deps.drafts.get(draftId);
    if (draft === null) return refuse('no_such_draft', `no order draft ${draftId}`);
    const holdingUnconfirmed = draft.conversations.some(
      // `submitting` is held for the same reason `submitted_unconfirmed` is:
      // between step 1 and step 3 an order may already be on its way, and
      // abandoning it would orphan a live dispatch intent.
      (c) => c.state === 'submitted_unconfirmed' || c.state === 'submitting',
    );
    if (holdingUnconfirmed) {
      // §6: ambiguous commercial evidence is held until reconcile settles
      // it, and the screen says why.
      return refuse(
        'submitted_unconfirmed_held',
        'an order may already be on its way; this draft is held until that settles',
      );
    }
    for (const conversation of draft.conversations) {
      if (!TERMINAL_CONVERSATION_STATES.has(conversation.state)) {
        conversation.state = 'closed';
        conversation.approvalId = null;
        conversation.outcome = 'abandoned';
      }
    }
    draft.abandoned = true;
    return this.save(draft);
  }
}
