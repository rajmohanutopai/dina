/**
 * Storage for merchant searches (UCP plan §3.11; migration 64): the handles
 * behind what Brain reads, each search and its products, and the guard jobs
 * over their text. On the identity database, beside the release log.
 *
 * Handles are per conversation and stable: the same merchant value always
 * gets the same handle there (`m1`, `p3`, `v3.2`, `u1`), so Brain can refer
 * to a product it saw two turns ago and Core can map it back.
 *
 * Guard jobs are claimed in turn across searches (the search whose last
 * claim came first, or that has had none, goes first; a counter, so claims in
 * one millisecond still take turns), so one search cannot starve another, and only within their search's budget. A claim lasts until
 * the budget ends. Once it has, a job not started and a claim with no verdict
 * are both abandoned, and stay so after a restart (no job of a search past
 * its budget is ever claimable); a verdict that arrives after the budget is
 * not used.
 *
 * Rows do not outlive their use: a conversation's handles and searches go
 * with its last message where Core keeps the chat (`forgetSession`); any
 * search older than a day, and any handle no search has used for a day, go
 * on the next search (`purgeBefore`). Deletes name every table: the
 * server's SQLite runs without foreign keys, so a cascade cannot be relied on.
 */

import { parseStrictJson } from '@dina/a2a';

import type { DatabaseAdapter, DBRow } from '../../storage/db_adapter';

export type HandleKind = 'merchant' | 'product' | 'variant' | 'unit';

export interface HandleTarget {
  kind: HandleKind;
  merchantOrigin: string;
  value: string;
}

export type UcpGuardJobState = 'pending' | 'claimed' | 'passed' | 'blocked' | 'abandoned';

export interface UcpGuardJobRow {
  job_id: string;
  search_id: string;
  position: number;
  merchant_origin: string;
  content_json: string;
  digest: string;
  state: UcpGuardJobState;
  claim_id: string | null;
  claimed_until: number | null;
  created_at: number;
  resolved_at: number | null;
  verdict_json: string | null;
}

export interface SearchRow {
  search_id: string;
  session_id: string;
  query_digest: string;
  merchants_json: string;
  state: 'running' | 'complete';
  created_at: number;
  guard_until: number;
  last_claim_seq: number | null;
}

export interface ResultRow {
  search_id: string;
  position: number;
  product_handle: string;
  merchant_origin: string;
  /** What Brain reads: handles and checked fields. */
  record_json: string;
  /** What the owner reads: the merchant's title (display-safe) and its link. */
  owner_json: string;
}

/** A product's variant counter: `variant:` and the product's handle. */
const VARIANT_COUNTER = 'variant:';

const PREFIX: Record<Exclude<HandleKind, 'variant'>, string> = {
  merchant: 'm',
  product: 'p',
  unit: 'u',
};

const toJob = (r: DBRow): UcpGuardJobRow => ({
  job_id: String(r.job_id),
  search_id: String(r.search_id),
  position: Number(r.position),
  merchant_origin: String(r.merchant_origin),
  content_json: String(r.content_json),
  digest: String(r.digest),
  state: String(r.state) as UcpGuardJobState,
  claim_id: r.claim_id === null || r.claim_id === undefined ? null : String(r.claim_id),
  claimed_until:
    r.claimed_until === null || r.claimed_until === undefined ? null : Number(r.claimed_until),
  created_at: Number(r.created_at),
  resolved_at: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
  verdict_json:
    r.verdict_json === null || r.verdict_json === undefined ? null : String(r.verdict_json),
});

export class UcpSearchStore {
  constructor(private readonly db: DatabaseAdapter) {}

  transaction<T>(fn: () => T): T {
    let out: T | undefined;
    this.db.transaction(() => {
      out = fn();
    });
    return out as T;
  }

  // ------------------------------------------------------------ handles

  /**
   * The handle for a merchant value in this conversation, made the first time
   * it is met and marked used each time. Every handle takes the next number
   * from a counter that only rises (`ucp_handle_counters`): one per kind for
   * merchants, products and units, one per product for its variants. A purged
   * handle's number is therefore never given to another value.
   */
  handle(sessionId: string, target: HandleTarget, now: number, productHandle?: string): string {
    const found = this.db.query(
      `SELECT handle FROM ucp_handles WHERE session_id = ? AND kind = ? AND merchant_origin = ? AND value = ?`,
      [sessionId, target.kind, target.merchantOrigin, target.value],
    );
    if (found.length > 0) {
      const handle = String(found[0]?.handle);
      this.db.run(`UPDATE ucp_handles SET used_at = ? WHERE session_id = ? AND handle = ?`, [
        now,
        sessionId,
        handle,
      ]);
      return handle;
    }
    let parent = '';
    let counter: string;
    if (target.kind === 'variant') {
      if (productHandle === undefined || !/^p\d+$/.test(productHandle))
        throw new Error('ucp handles: a variant needs its product');
      parent = productHandle;
      counter = `${VARIANT_COUNTER}${productHandle}`;
    } else {
      counter = target.kind;
    }
    this.db.run(
      `INSERT INTO ucp_handle_counters (session_id, kind, last) VALUES (?, ?, 1)
       ON CONFLICT (session_id, kind) DO UPDATE SET last = last + 1`,
      [sessionId, counter],
    );
    const seq = Number(
      this.db.query(`SELECT last FROM ucp_handle_counters WHERE session_id = ? AND kind = ?`, [
        sessionId,
        counter,
      ])[0]?.last,
    );
    const handle =
      target.kind === 'variant' ? `v${parent.slice(1)}.${seq}` : `${PREFIX[target.kind]}${seq}`;
    this.db.run(
      `INSERT INTO ucp_handles (session_id, handle, kind, merchant_origin, value, parent, seq, created_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, handle, target.kind, target.merchantOrigin, target.value, parent, seq, now, now],
    );
    return handle;
  }

  /**
   * Mark product handles used now, with their variants and their merchants'
   * handles (the merchant itself and its units), so a purge that runs while
   * the products are fetched afresh takes none of them and nothing is given a
   * new number. Handles that do not exist are ignored.
   */
  touchHandles(sessionId: string, handles: readonly string[], now: number): void {
    for (const h of handles) {
      this.db.run(
        `UPDATE ucp_handles SET used_at = ?
          WHERE session_id = ?
            AND (handle = ? OR parent = ?
                 OR (kind IN ('merchant', 'unit') AND merchant_origin =
                      (SELECT merchant_origin FROM ucp_handles WHERE session_id = ? AND handle = ?)))`,
        [now, sessionId, h, h, sessionId, h],
      );
    }
  }

  /** Note a review card raised for a session, so the session's cards can be read together. */
  recordReview(sessionId: string, reviewId: string, now: number): void {
    this.db.run(
      `INSERT OR IGNORE INTO ucp_review_cards (review_id, session_id, created_at) VALUES (?, ?, ?)`,
      [reviewId, sessionId, now],
    );
  }

  /** The session's review cards raised since `since`, newest first. */
  reviewsSince(sessionId: string, since: number): string[] {
    return this.db
      .query(
        `SELECT review_id FROM ucp_review_cards
          WHERE session_id = ? AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC`,
        [sessionId, since],
      )
      .map((r) => String(r.review_id));
  }

  /** Each merchant's outcome for a search, as the owner's view reports it. */
  setOutcomes(searchId: string, outcomesJson: string): void {
    this.db.run(`UPDATE ucp_searches SET merchants_json = ? WHERE search_id = ?`, [
      outcomesJson,
      searchId,
    ]);
  }

  /** The handle this conversation gave a merchant's variant, found by the variant's id; null when none. */
  variantHandle(sessionId: string, merchantOrigin: string, variantId: string): string | null {
    // Variant values are JSON pairs [product id, variant id]; a merchant's variants in one
    // conversation are bounded (200 products a search, 10 variants each).
    const rows = this.db.query(
      `SELECT handle, value FROM ucp_handles WHERE session_id = ? AND kind = 'variant' AND merchant_origin = ?`,
      [sessionId, merchantOrigin],
    );
    for (const r of rows) {
      const parsed = parseStrictJson(String(r.value));
      if (parsed.ok && Array.isArray(parsed.value) && parsed.value[1] === variantId)
        return String(r.handle);
    }
    return null;
  }

  /** A variant handle's merchant, product id and variant id in this conversation, or null. */
  variantTarget(
    sessionId: string,
    handle: string,
  ): { merchant: string; productId: string; variantId: string } | null {
    const t = this.resolveHandle(sessionId, handle);
    if (t === null || t.kind !== 'variant') return null;
    const parsed = parseStrictJson(t.value);
    if (!parsed.ok || !Array.isArray(parsed.value)) return null;
    const [productId, variantId] = parsed.value as unknown[];
    return typeof productId === 'string' && typeof variantId === 'string'
      ? { merchant: t.merchantOrigin, productId, variantId }
      : null;
  }

  /** What a handle stands for in this conversation, or null. */
  resolveHandle(sessionId: string, handle: string): HandleTarget | null {
    const row = this.db.query(
      `SELECT kind, merchant_origin, value FROM ucp_handles WHERE session_id = ? AND handle = ?`,
      [sessionId, handle],
    )[0];
    if (row === undefined) return null;
    return {
      kind: String(row.kind) as HandleKind,
      merchantOrigin: String(row.merchant_origin),
      value: String(row.value),
    };
  }

  // ------------------------------------------------------------ searches

  insertSearch(row: Omit<SearchRow, 'last_claim_seq'>): void {
    this.db.run(
      `INSERT INTO ucp_searches (search_id, session_id, query_digest, merchants_json, state, created_at, guard_until)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.search_id,
        row.session_id,
        row.query_digest,
        row.merchants_json,
        row.state,
        row.created_at,
        row.guard_until,
      ],
    );
  }

  insertResult(row: ResultRow): void {
    this.db.run(
      `INSERT INTO ucp_search_results (search_id, position, product_handle, merchant_origin, record_json, owner_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.search_id,
        row.position,
        row.product_handle,
        row.merchant_origin,
        row.record_json,
        row.owner_json,
      ],
    );
  }

  insertJob(
    row: Omit<
      UcpGuardJobRow,
      'state' | 'claim_id' | 'claimed_until' | 'resolved_at' | 'verdict_json'
    >,
  ): void {
    this.db.run(
      `INSERT INTO ucp_guard_jobs (job_id, search_id, position, merchant_origin, content_json, digest, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        row.job_id,
        row.search_id,
        row.position,
        row.merchant_origin,
        row.content_json,
        row.digest,
        row.created_at,
      ],
    );
  }

  getSearch(searchId: string): SearchRow | null {
    const r = this.db.query(`SELECT * FROM ucp_searches WHERE search_id = ?`, [searchId])[0];
    if (r === undefined) return null;
    return {
      search_id: String(r.search_id),
      session_id: String(r.session_id),
      query_digest: String(r.query_digest),
      merchants_json: String(r.merchants_json),
      state: String(r.state) as SearchRow['state'],
      created_at: Number(r.created_at),
      guard_until: Number(r.guard_until),
      last_claim_seq:
        r.last_claim_seq === null || r.last_claim_seq === undefined
          ? null
          : Number(r.last_claim_seq),
    };
  }

  results(searchId: string): ResultRow[] {
    return this.db
      .query(`SELECT * FROM ucp_search_results WHERE search_id = ? ORDER BY position ASC`, [
        searchId,
      ])
      .map((r) => ({
        search_id: String(r.search_id),
        position: Number(r.position),
        product_handle: String(r.product_handle),
        merchant_origin: String(r.merchant_origin),
        record_json: String(r.record_json),
        owner_json: String(r.owner_json),
      }));
  }

  jobs(searchId: string): UcpGuardJobRow[] {
    return this.db
      .query(`SELECT * FROM ucp_guard_jobs WHERE search_id = ? ORDER BY position ASC`, [searchId])
      .map(toJob);
  }

  getJob(jobId: string): UcpGuardJobRow | null {
    const r = this.db.query(`SELECT * FROM ucp_guard_jobs WHERE job_id = ?`, [jobId])[0];
    return r === undefined ? null : toJob(r);
  }

  // ------------------------------------------------------------ the guard queue

  /**
   * Abandon what a search past its budget still holds open: jobs never
   * started (`budget`) and claims that got no verdict (`no_verdict`, the
   * model failed or was too slow). A verdict for either is refused as late.
   */
  abandonLapsed(now: number): number {
    const lapsed = `search_id IN (SELECT search_id FROM ucp_searches WHERE guard_until <= ?)`;
    return (
      this.db.run(
        `UPDATE ucp_guard_jobs SET state = 'abandoned', resolved_at = ?, verdict_json = '{"reason":"budget"}'
          WHERE state = 'pending' AND ${lapsed}`,
        [now, now],
      ) +
      this.db.run(
        `UPDATE ucp_guard_jobs SET state = 'abandoned', resolved_at = ?, claimed_until = NULL,
                verdict_json = '{"reason":"no_verdict"}'
          WHERE state = 'claimed' AND ${lapsed}`,
        [now, now],
      )
    );
  }

  /**
   * The next job to claim: pending, in a search still within its budget,
   * from the search whose last claim came first (one never claimed first),
   * then the oldest search, in the merchant's order.
   */
  nextClaimable(now: number): UcpGuardJobRow | null {
    const r = this.db.query(
      `SELECT j.* FROM ucp_guard_jobs j JOIN ucp_searches s ON s.search_id = j.search_id
        WHERE s.guard_until > ? AND j.state = 'pending'
        ORDER BY COALESCE(s.last_claim_seq, 0) ASC, s.created_at ASC, j.position ASC
        LIMIT 1`,
      [now],
    )[0];
    return r === undefined ? null : toJob(r);
  }

  /**
   * Compare-and-set a pending job to claimed until `until`, and mark its
   * search's turn taken; false when someone else took the job first.
   */
  claimJob(job: UcpGuardJobRow, claimId: string, until: number): boolean {
    const affected = this.db.run(
      `UPDATE ucp_guard_jobs SET state = 'claimed', claim_id = ?, claimed_until = ?
        WHERE job_id = ? AND state = 'pending'`,
      [claimId, until, job.job_id],
    );
    if (affected === 0) return false;
    this.db.run(
      `UPDATE ucp_searches
          SET last_claim_seq = (SELECT COALESCE(MAX(last_claim_seq), 0) + 1 FROM ucp_searches)
        WHERE search_id = ?`,
      [job.search_id],
    );
    return true;
  }

  // ------------------------------------------------------------ retention

  /** A conversation's handles and searches, gone with its last message. */
  forgetSession(sessionId: string): void {
    const searches = `SELECT search_id FROM ucp_searches WHERE session_id = ?`;
    this.db.run(`DELETE FROM ucp_guard_jobs WHERE search_id IN (${searches})`, [sessionId]);
    this.db.run(`DELETE FROM ucp_search_results WHERE search_id IN (${searches})`, [sessionId]);
    this.db.run(`DELETE FROM ucp_searches WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM ucp_handles WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM ucp_handle_counters WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM ucp_review_cards WHERE session_id = ?`, [sessionId]);
  }

  /**
   * Searches made before `cutoff`, with their products and jobs, and handles
   * no search has used since. This holds for every kind of session, whether
   * or not Core sees its messages (a server's chat lives in Brain). A counter
   * goes only where no id can come back to it: a purged product's variant
   * counter (product numbers are never reused), and every counter of a
   * session that is not a chat thread (an ask's id is never reused) once it
   * has no handle and no search left. A chat thread's counters stay while the
   * thread does.
   */
  purgeBefore(cutoff: number): void {
    const searches = `SELECT search_id FROM ucp_searches WHERE created_at < ?`;
    this.db.run(`DELETE FROM ucp_guard_jobs WHERE search_id IN (${searches})`, [cutoff]);
    this.db.run(`DELETE FROM ucp_search_results WHERE search_id IN (${searches})`, [cutoff]);
    this.db.run(`DELETE FROM ucp_searches WHERE created_at < ?`, [cutoff]);
    this.db.run(`DELETE FROM ucp_handles WHERE used_at < ?`, [cutoff]);
    this.db.run(`DELETE FROM ucp_review_cards WHERE created_at < ?`, [cutoff]);
    this.db.run(
      `DELETE FROM ucp_handle_counters
        WHERE kind LIKE '${VARIANT_COUNTER}%'
          AND NOT EXISTS (SELECT 1 FROM ucp_handles h
                           WHERE h.session_id = ucp_handle_counters.session_id
                             AND h.handle = substr(ucp_handle_counters.kind, ${VARIANT_COUNTER.length + 1}))`,
    );
    this.db.run(
      `DELETE FROM ucp_handle_counters
        WHERE session_id NOT LIKE 'chat:%'
          AND session_id NOT IN (SELECT session_id FROM ucp_handles)
          AND session_id NOT IN (SELECT session_id FROM ucp_searches)`,
    );
  }

  /** Record a verdict under the live claim; false when the claim was lost. */
  resolveJob(
    jobId: string,
    claimId: string,
    state: 'passed' | 'blocked' | 'abandoned',
    verdictJson: string,
    now: number,
  ): boolean {
    const affected = this.db.run(
      `UPDATE ucp_guard_jobs SET state = ?, verdict_json = ?, resolved_at = ?, claimed_until = NULL
        WHERE job_id = ? AND state = 'claimed' AND claim_id = ?`,
      [state, verdictJson, now, jobId, claimId],
    );
    return affected > 0;
  }

  /** Read a job's stored content back; null when it does not parse (never expected). */
  static jobContent(job: UcpGuardJobRow): unknown {
    const parsed = parseStrictJson(job.content_json);
    return parsed.ok ? parsed.value : null;
  }
}
