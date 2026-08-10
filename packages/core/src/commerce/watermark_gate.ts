/**
 * Counterparty epoch watermark gate (§16.2, WS-2.9) — the BUYER's half of the
 * restore fence.
 *
 * THE SUPPLIER'S HALF IS ALREADY BUILT and does not cover this. After a
 * restore a supplier increments its epoch, voids capacity, and refuses to sign
 * below the new epoch. All of that is enforced on the supplier's own node, by
 * a supplier who is behaving.
 *
 * THE CASE IT CANNOT COVER is the one §25.3 calls delayed-pre-restore-write. A
 * record signed BEFORE the restore is already in flight — sitting in a relay
 * queue, or on a node that never learned it had been superseded — and arrives
 * afterwards. It is genuinely signed, its digest verifies, and its epoch is
 * one the supplier has abandoned. Nothing on the supplier's side can stop it,
 * because the supplier is not the one delivering it. Only the buyer, holding
 * the highest epoch it has ever seen from that supplier, can tell.
 *
 * SO THE WATERMARK IS A RECEIVE-SIDE RULE, and it is the whole reason the
 * table exists. The table and its repository have been present since CMC-1;
 * nothing read them. A fence with no reader is a fence with a gate left open.
 *
 * WHY THE COMPARISON IS STRICTLY BELOW. Equal is normal traffic — a supplier
 * signs many records in one epoch — so `<` and not `<=`. And it is compared as
 * a BigInt over canonical integer strings, never as text: `"10" < "9"` is true
 * in every string collation, and epochs pass 9 on the tenth restore.
 *
 * WHAT IT DOES NOT DO. It does not verify signatures, digests, or identity;
 * those run before it and answer different questions. This one asks only
 * whether a correctly-signed record belongs to a generation the supplier has
 * abandoned.
 */

import type { CommerceEpochWatermarkRepository } from './watermarks';

export type WatermarkVerdict =
  | { accept: true; /** The watermark after accepting, for the caller's log. */ watermark: string }
  | {
      accept: false;
      refusal:
        | 'stale_epoch'
        | 'unreadable_epoch'
        /**
         * A record attributed to a DID other than the authenticated sender.
         * Only reachable on a lane that names one.
         */
        | 'foreign_supplier';
      /** What the record claimed. */
      epoch: string;
      /** The highest this node has seen from that supplier. */
      watermark: string;
    };

/**
 * Canonical integer strings only. A record whose epoch is not one — empty,
 * signed, decimal, or padded — is REFUSED rather than coerced.
 *
 * Coercion is the tempting reading ("it is obviously 7") and it is wrong here:
 * the epoch is compared against a stored value, so accepting `"007"` as 7 lets
 * one wire form pass a comparison that its own canonical form would fail, and
 * the two would disagree the moment either side re-serialized.
 */
function isCanonicalEpoch(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

/**
 * Check an arriving record's supplier epoch against the watermark, and raise
 * the watermark when it is higher.
 *
 * ONE function for check-and-raise rather than two, because a caller that
 * checked and forgot to raise would leave the fence permanently at its
 * starting value — passing every test that only ever sends one message, and
 * failing silently in production against a supplier who has restored twice.
 * The raise happens only on acceptance: a refused record must not teach this
 * node anything about the supplier's generation.
 */
export function admitSupplierEpoch(args: {
  watermarks: CommerceEpochWatermarkRepository;
  supplierDid: string;
  epoch: string;
  nowMs: number;
}): WatermarkVerdict {
  const watermark = args.watermarks.get(args.supplierDid);
  if (!isCanonicalEpoch(args.epoch)) {
    return {
      accept: false,
      refusal: 'unreadable_epoch',
      epoch: args.epoch,
      watermark,
    };
  }
  if (BigInt(args.epoch) < BigInt(watermark)) {
    return { accept: false, refusal: 'stale_epoch', epoch: args.epoch, watermark };
  }
  // Equal is ordinary traffic and raises nothing; higher moves the fence.
  return {
    accept: true,
    watermark: args.watermarks.raiseTo(args.supplierDid, args.epoch, args.nowMs),
  };
}

/**
 * The rejection reason returned on the TOOL-RESULT lane. One string for all
 * three refusal kinds.
 *
 * WHO ACTUALLY READS THIS. Its only consumer is `refuseStaleSupplierRecords`
 * in the workflow routes, which hands it back as the rejection reason for a
 * completed buyer tool result — so the recipient is the owner's own RUNNER,
 * running locally on this node. Not a remote counterparty, and not a stranger.
 *
 * An earlier version of this comment justified the uniformity by what a remote
 * sender would learn from a detailed refusal. That audience does not exist
 * here: the D2D lane never uses this constant at all, returning typed
 * `BuyerResponseOutcome` values instead, where `foreign_supplier` and
 * `stale_epoch` are deliberately kept apart for the owner's decision log.
 *
 * It stays uniform for a different reason. A runner is an untrusted tenant
 * (§20.20), and a refusal that told it which supplier is at which generation
 * would hand a plugin this node's private view of its counterparties'
 * restore history — which is what the plugin is not allowed to accumulate.
 * The structured `WatermarkVerdict` carries the real reason for anything
 * local that wants it.
 */
export const WATERMARK_REFUSAL = 'commerce: record rejected (§16.2)';

/**
 * The buyer-side seam: check every supplier-signed record inside a completed
 * BUYER tool result against that supplier's watermark.
 *
 * WHY IT LIVES ON THE RESULT AND NOT ON THE WIRE. The buyer's records arrive
 * inside a plugin tool result — a `collect-quotes` answer carries several
 * signed quotes, a `track-order` answer carries a status. There is no separate
 * "record arrived" event to hook; the result IS the arrival, and the moment
 * after the pinned-schema check is the last point before it becomes the
 * owner's answer.
 *
 * WHY THE SUPPLIER COMES FROM THE RECORD, NOT FROM THE ENVELOPE. The first
 * version read the envelope's `service_ingress.from_did` and would never have
 * fired: `service_ingress` is SUPPLIER-side correlation, describing an inbound
 * query this node is answering. A buyer's outbound tool call has none, because
 * the buyer is the one asking. The wiring test is what caught it — a gate
 * reading a field that is never present is an orphan wearing a wire.
 *
 * And one envelope-level supplier could not have been right anyway ON THAT
 * LANE: `collect-quotes` fans out to MANY suppliers and returns records from
 * several, each belonging to a different generation. The pair `(supplier_did,
 * supplier_epoch)` travels together inside each signed record, so they are read
 * together.
 *
 * THAT REASONING IS LANE-SPECIFIC, and reading it as general was a mistake
 * worth recording. On the D2D lane one authenticated peer supplies the whole
 * body, so the `supplier_did` inside a record is a claim by that peer about
 * somebody else — and believing it let a supplier raise a THIRD party's
 * watermark and cut this buyer off from them for good. `expectedSupplierDid`
 * below is the binding; see its comment.
 *
 * SHAPE-TOLERANT ON PURPOSE. A buyer pack publishes its own result schema, so
 * this cannot know the shape. It walks the parsed result for objects carrying
 * BOTH fields — the pair pinned by the protocol, not by any pack. An object
 * with an epoch but no supplier is not attributable and is refused, because
 * "somebody's record from some generation" is not something a watermark can
 * judge and must not pass by default.
 *
 * ONE STALE RECORD REFUSES THE WHOLE RESULT. Filtering the stale ones out and
 * returning the rest is the tempting reading, and it is wrong twice: the buyer
 * would silently receive fewer quotes than the supplier sent, with no way to
 * know, and a `place-order` answer is a single record whose removal leaves the
 * order in no state at all.
 */
export function admitSupplierRecords(args: {
  watermarks: CommerceEpochWatermarkRepository;
  /** The already-parsed tool result. */
  result: unknown;
  nowMs: number;
  /**
   * The TRANSPORT-AUTHENTICATED sender, on a lane that has one.
   *
   * WITHOUT THIS, THE FENCE IS A WEAPON. `collectSignedRecords` attributes a
   * record to the `supplier_did` written INSIDE the body; it verifies no
   * signature and no identity, because at this point neither has been checked
   * (the binding checks in `buyer_quotes` run later). On the D2D lane the body
   * comes from a peer, so supplier X could embed
   * `{"supplier_did":"<victim>","supplier_epoch":"99999999"}` anywhere in its
   * answer and this function would raise the VICTIM's watermark. `raiseTo` is
   * monotonic with no floor and no way back down, so every genuinely signed
   * quote and status that victim ever sends afterwards is discarded as
   * `stale_epoch` — a permanent, externally-triggered cut-off between the
   * buyer and a supplier it has orders with, and no recovery path.
   *
   * This is the house rule stated generally: authorization binds to the
   * relay-authenticated envelope, never to a sender-supplied inner body. The
   * gate predates the D2D lane — it was reached only from the buyer's OWN
   * runner result — and moving it to a lane where an untrusted party writes
   * the bytes is what made the rule apply.
   *
   * OPTIONAL, because the tool-result lane genuinely carries many suppliers: a
   * `collect-quotes` answer fans out and comes back with records from all of
   * them, and there is no single sender to bind to. Passing it is therefore
   * the caller's statement that ONE party is accountable for these bytes.
   */
  expectedSupplierDid?: string;
}):
  | { accept: true; checked: number }
  // The REFUSING arm specifically. Typed as the whole `WatermarkVerdict` this
  // said a refusal might carry an acceptance, so a caller that wanted to know
  // WHICH refusal had to narrow a case that cannot occur.
  | { accept: false; refusal: Extract<WatermarkVerdict, { accept: false }> } {
  const records = collectSignedRecords(args.result);
  // Decided across ALL records before any watermark is raised, so a stale
  // record later in the list cannot be admitted by a higher one earlier in it
  // having already moved that supplier's fence.
  for (const record of records) {
    const watermark = args.watermarks.get(record.supplierDid);
    if (record.supplierDid === '' || !isCanonicalEpoch(record.epoch)) {
      return {
        accept: false,
        refusal: { accept: false, refusal: 'unreadable_epoch', epoch: record.epoch, watermark },
      };
    }
    // Refused, not skipped. A sender that names a third party in its own
    // answer is either broken or probing, and either way this node must not
    // record the rest of a message it cannot account for.
    if (args.expectedSupplierDid !== undefined && record.supplierDid !== args.expectedSupplierDid) {
      return {
        accept: false,
        refusal: { accept: false, refusal: 'foreign_supplier', epoch: record.epoch, watermark },
      };
    }
    if (BigInt(record.epoch) < BigInt(watermark)) {
      return {
        accept: false,
        refusal: { accept: false, refusal: 'stale_epoch', epoch: record.epoch, watermark },
      };
    }
  }
  for (const record of records) {
    args.watermarks.raiseTo(record.supplierDid, record.epoch, args.nowMs);
  }
  return { accept: true, checked: records.length };
}

interface SignedRecord {
  supplierDid: string;
  epoch: string;
}

/**
 * Every generation-bearing record reachable in the result.
 *
 * An object carrying `supplier_epoch` is a commerce record; its
 * `supplier_did` — when absent or not a string — comes back as `''`, which the
 * caller refuses. Defaulting to "skip it" would let a runner drop one field to
 * bypass the fence entirely.
 *
 * Depth-bounded: the tool-lane result gate already caps nesting before this
 * runs, and a walker with no bound of its own would be one refactor away from
 * being the place a pathological result lands.
 */
function collectSignedRecords(value: unknown, depth = 0): SignedRecord[] {
  if (depth > 12 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectSignedRecords(entry, depth + 1));
  const found: SignedRecord[] = [];
  const record = value as Record<string, unknown>;
  if (typeof record.supplier_epoch === 'string') {
    found.push({
      supplierDid: typeof record.supplier_did === 'string' ? record.supplier_did : '',
      epoch: record.supplier_epoch,
    });
  }
  for (const key of Object.keys(record)) {
    if (key === 'supplier_epoch' || key === 'supplier_did') continue;
    found.push(...collectSignedRecords(record[key], depth + 1));
  }
  return found;
}
