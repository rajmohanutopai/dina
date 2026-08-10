/**
 * §9.8 — the buyer's RETAINED quote requests.
 *
 * WHY THIS EXISTS, and why its absence was not a small gap. §9.8 gives the
 * buyer two checks nobody else can make: that an arriving quote's
 * `request_digest` matches the request this node actually sent, and that its
 * `priced_delivery_projection_digest` matches the projection this node priced
 * against. Both compare the quote to something only the buyer holds — and this
 * node held nothing. `verifySignedQuoteForBuyer` implements exactly those
 * checks and had no caller, because its `BuyerQuoteContext` needs a retained
 * request and there was no store to retain one in.
 *
 * The consequence is §20.4's bait-and-switch: a supplier could answer a
 * different question, or price a different delivery projection, and the buyer
 * would record the quote as a legitimate offer for what it asked.
 *
 * WHY THE WHOLE REQUEST AND NOT ITS DIGEST. The digest proves the supplier saw
 * the request. It proves nothing about whether the quote's LINES correspond to
 * it — a quote can carry a genuine digest while inventing line ids, renaming
 * `requested_product`, or substituting a different exact variant where the
 * buyer said `acceptable_substitutions: 'none'`. Line correspondence needs the
 * request body, so the body is what is kept.
 *
 * FIRST-WRITER-WINS on `request_id`. A resent request is the same document
 * with the same digest; overwriting would let a later write change what the
 * buyer is holding a supplier to.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { validateQuoteRequest, type Sha256Fn, type QuoteRequest } from '@dina/commerce-protocol';

import type { DatabaseAdapter } from '../storage/db_adapter';

const hash: Sha256Fn = (data) => sha256(data);

export interface BuyerQuoteRequestRepository {
  /** Retain a request this node is about to send. False when already held. */
  put(request: QuoteRequest, sentAt: number): boolean;
  /** The retained request, or null when this node never sent it. */
  get(requestId: string): QuoteRequest | null;
}

export class SQLiteBuyerQuoteRequestRepository implements BuyerQuoteRequestRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(request: QuoteRequest, sentAt: number): boolean {
    // READ-THEN-INSERT rather than trusting what `run` returns. The adapter
    // contract types it as a number, and the base implementation returns a
    // constant 1 regardless of what happened — a mobile CAS bug has already
    // been traced to exactly that. Deciding "was this new" from it would be
    // right on one platform and wrong on the other.
    //
    // Both statements go in one transaction so the check and the write cannot
    // be separated by a concurrent writer.
    let inserted = false;
    this.db.transaction(() => {
      const existing = this.db.query<{ request_id: string }>(
        `SELECT request_id FROM commerce_buyer_quote_requests WHERE request_id = ?`,
        [request.request_id],
      );
      if (existing[0]) return;
      this.db.run(
        `INSERT INTO commerce_buyer_quote_requests
           (request_id, supplier_did, request_digest, projection_digest, request_json, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          request.request_id,
          request.supplier_did,
          request.request_digest,
          request.delivery.projection.projection_digest,
          JSON.stringify(request),
          sentAt,
        ],
      );
      inserted = true;
    });
    return inserted;
  }

  get(requestId: string): QuoteRequest | null {
    const rows = this.db.query<{ request_json: string }>(
      `SELECT request_json FROM commerce_buyer_quote_requests WHERE request_id = ?`,
      [requestId],
    );
    if (!rows[0]) return null;
    return parseRetained(String(rows[0].request_json));
  }
}

export class InMemoryBuyerQuoteRequestRepository implements BuyerQuoteRequestRepository {
  private readonly held = new Map<string, string>();

  // Same arity as the interface even though the timestamp is unused here — a
  // double that narrows its own signature stops standing in for the real one
  // at the call sites that matter.
  put(request: QuoteRequest, _sentAt: number): boolean {
    void _sentAt;
    if (this.held.has(request.request_id)) return false;
    this.held.set(request.request_id, JSON.stringify(request));
    return true;
  }

  get(requestId: string): QuoteRequest | null {
    const json = this.held.get(requestId);
    return json === undefined ? null : parseRetained(json);
  }
}

/**
 * A retained row, RE-DERIVED, or null when it cannot be believed.
 *
 * `validateQuoteRequest` ends in `verifyCommerceRecordDigest`, so the stored
 * body is checked against its own `request_digest` on every read. That is the
 * difference between a yardstick and a note: this row is what an arriving
 * quote is measured against, and a row edited in the store after writing would
 * silently redefine the question the buyer is holding the supplier to. A
 * tampered pair — body and digest changed together — is caught because the
 * digest is recomputed from the body rather than compared to a neighbouring
 * column.
 *
 * An unreadable or non-verifying row reads as ABSENT, so the quote it would
 * have authorised is refused rather than accepted against a yardstick this
 * node cannot reconstruct.
 */
function parseRetained(json: string): QuoteRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (validateQuoteRequest(parsed, hash) !== null) return null;
  return parsed as QuoteRequest;
}
