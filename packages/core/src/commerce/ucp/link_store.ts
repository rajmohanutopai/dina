/**
 * Linked accounts (UCP plan §3.17; migration 68): synchronous SQL on the
 * identity database, which SQLCipher encrypts like every other owner
 * secret. The protocol work is `links.ts`.
 *
 * Tokens leave through one door, `useTokens`, which hands them to a
 * callback; a link's view never carries them. A pending link is consumed
 * once. A link's tokens are replaced only under its current generation, so
 * a refresh that lost a race, or that answers after unlink began, never
 * overwrites newer tokens or wakes a revoking link: its tokens go to the
 * revocation queue instead.
 */

import { isPlainObject, parseStrictJson } from '@dina/a2a';

import type { DatabaseAdapter, DBRow } from '../../storage/db_adapter';

export type LinkState = 'active' | 'needs_relink' | 'revoking';

export interface PendingLink {
  state: string;
  merchant_origin: string;
  issuer: string;
  token_endpoint: string;
  revocation_endpoint: string | null;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
  scopes: string[];
  /**
   * Asks only for scopes a live link lacks (an `insufficient_scope` challenge):
   * its answer is merged into that link, never replacing it (identity-linking §insufficient_scope).
   */
  step_up: boolean;
  expires_at: number;
}

/** A link as the owner and Core's flow see it: never its tokens. */
export interface LinkView {
  merchant_origin: string;
  issuer: string;
  token_endpoint: string;
  revocation_endpoint: string | null;
  client_id: string;
  scopes: string[];
  state: LinkState;
  generation: number;
  access_expires_at: number | null;
  refresh_holder: string | null;
  refresh_until: number | null;
  /** This link's lifetime; a refresh begun under another never lands. */
  link_id: string;
  /** Raised by each new authorization in this link (a step-up), never by a refresh (§3.7). */
  auth_revision: number;
  created_at: number;
  updated_at: number;
}

/** A linking attempt that ended without a link, for the owner to see (§3.17). */
export interface LinkAttempt {
  merchant_origin: string;
  outcome: string;
  at: number;
}

export interface LinkTokens {
  accessToken: string;
  refreshToken: string | null;
}

export interface QueuedRevocation {
  id: string;
  merchant_origin: string;
  revocation_endpoint: string | null;
  client_id: string;
  token: string;
  hint: 'access_token' | 'refresh_token';
  attempts: number;
  created_at: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** A stored scope list; one that does not read is none (asks are re-derived, never half-read). */
function scopesOf(text: unknown): string[] {
  const parsed = parseStrictJson(String(text));
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  const v: unknown[] = parsed.value;
  return v.every((s): s is string => typeof s === 'string') ? (v as string[]) : [];
}

/** A held callback's parameters: string values only; one that does not read is dropped. */
function paramsOf(text: unknown): Record<string, string> | null {
  const parsed = parseStrictJson(String(text));
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.value)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

function viewOf(r: DBRow): LinkView {
  return {
    merchant_origin: String(r.merchant_origin),
    issuer: String(r.issuer),
    token_endpoint: String(r.token_endpoint),
    revocation_endpoint: str(r.revocation_endpoint),
    client_id: String(r.client_id),
    scopes: scopesOf(r.scopes_json),
    state: String(r.state) as LinkState,
    generation: Number(r.generation),
    auth_revision: Number(r.auth_revision),
    access_expires_at: num(r.access_expires_at),
    refresh_holder: str(r.refresh_holder),
    refresh_until: num(r.refresh_until),
    link_id: String(r.link_id),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

let installedStore: UcpLinkStore | null = null;

/**
 * The node's link store, installed at storage start whether or not it runs
 * UCP: a phone keeps callbacks for its paired server either way (§3.17).
 */
export function installUcpLinkStore(store: UcpLinkStore | null): void {
  installedStore = store;
}

export function getUcpLinkStore(): UcpLinkStore | null {
  return installedStore;
}

export class UcpLinkStore {
  constructor(private readonly db: DatabaseAdapter) {}

  transaction<T>(fn: () => T): T {
    let out: T | undefined;
    this.db.transaction(() => {
      out = fn();
    });
    return out as T;
  }

  // ------------------------------------------------------------ pending

  addPending(p: PendingLink, now: number): void {
    this.db.run(
      `INSERT INTO ucp_link_pending (state, merchant_origin, issuer, token_endpoint, revocation_endpoint,
         client_id, redirect_uri, code_verifier, scopes_json, step_up, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.state,
        p.merchant_origin,
        p.issuer,
        p.token_endpoint,
        p.revocation_endpoint,
        p.client_id,
        p.redirect_uri,
        p.code_verifier,
        JSON.stringify(p.scopes),
        p.step_up ? 1 : 0,
        p.expires_at,
        now,
      ],
    );
  }

  /**
   * Take a pending link by its `state`, once: null when there is none, it
   * has expired, or it was taken already (a replayed callback). `relayed`:
   * it came through the phone, which keeps it until acknowledged (`markAcked`).
   */
  /**
   * Claim a pending link for its callback. Each attempt ends once (an
   * outcome is recorded); a claim with no outcome after `abandonedAfterMs`
   * belongs to a process that stopped part-way, and is claimed again so the
   * callback is finished rather than lost. 'busy': claimed and still within
   * that time (another run is finishing it).
   */
  consumePending(
    state: string,
    now: number,
    relayed: boolean,
    abandonedAfterMs: number,
  ): PendingLink | 'busy' | null {
    return this.transaction(() => {
      const r = this.db.query(
        `SELECT * FROM ucp_link_pending
          WHERE state = ? AND outcome IS NULL AND cancelled_at IS NULL AND expires_at > ?`,
        [state, now],
      )[0] as DBRow | undefined;
      if (r === undefined) return null;
      if (
        r.consumed_at !== null &&
        r.consumed_at !== undefined &&
        now - Number(r.consumed_at) < abandonedAfterMs
      )
        return 'busy';
      this.db.run(`UPDATE ucp_link_pending SET consumed_at = ?, acked_at = ? WHERE state = ?`, [
        now,
        relayed ? null : now,
        state,
      ]);
      return {
        state: String(r.state),
        merchant_origin: String(r.merchant_origin),
        issuer: String(r.issuer),
        token_endpoint: String(r.token_endpoint),
        revocation_endpoint: str(r.revocation_endpoint),
        client_id: String(r.client_id),
        redirect_uri: String(r.redirect_uri),
        code_verifier: String(r.code_verifier),
        scopes: scopesOf(r.scopes_json),
        step_up: Number(r.step_up) === 1,
        expires_at: Number(r.expires_at),
      };
    });
  }

  /** Pending links that ended (consumed or expired) a day ago go. */
  prunePending(before: number): void {
    this.db.run(
      `DELETE FROM ucp_link_pending WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?`,
      [before, before],
    );
  }

  /**
   * The states a server pulls the phone's held callbacks by: its live pending
   * links, and those finished from a pull but not yet acknowledged (a crash
   * between the two pulls again, and the repeat is refused and acknowledged).
   */
  waitingStates(now: number): string[] {
    return this.db
      .query(
        `SELECT state FROM ucp_link_pending WHERE (consumed_at IS NULL OR acked_at IS NULL) AND expires_at > ?
          ORDER BY created_at`,
        [now],
      )
      .map((r) => String((r as DBRow).state));
  }

  /** The phone dropped these held callbacks: nothing more is owed for them. */
  markAcked(states: readonly string[], now: number): void {
    if (states.length === 0) return;
    const marks = states.map(() => '?').join(', ');
    this.db.run(
      `UPDATE ucp_link_pending SET acked_at = ? WHERE state IN (${marks}) AND consumed_at IS NOT NULL`,
      [now, ...states],
    );
  }

  /** How a consumed attempt ended. */
  recordOutcome(state: string, outcome: string): void {
    this.db.run(`UPDATE ucp_link_pending SET outcome = ? WHERE state = ?`, [outcome, state]);
  }

  /**
   * Each merchant's latest attempt since `since` that ended without a link,
   * unless a link there changed after it (the owner tried again and it worked).
   */
  failedAttempts(since: number): LinkAttempt[] {
    return this.db
      .query(
        `SELECT p.merchant_origin, p.outcome, p.consumed_at FROM ucp_link_pending p
          WHERE p.consumed_at >= ? AND p.outcome IS NOT NULL AND p.outcome != 'linked'
            AND p.consumed_at = (SELECT MAX(q.consumed_at) FROM ucp_link_pending q
                                  WHERE q.merchant_origin = p.merchant_origin AND q.outcome IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM ucp_merchant_links l
                             WHERE l.merchant_origin = p.merchant_origin AND l.updated_at > p.consumed_at)
          ORDER BY p.merchant_origin`,
        [since],
      )
      .map((row) => {
        const r = row as DBRow;
        return {
          merchant_origin: String(r.merchant_origin),
          outcome: String(r.outcome),
          at: Number(r.consumed_at),
        };
      });
  }

  /** Whether this node holds a live pending link under `state`. */
  isWaiting(state: string, now: number): boolean {
    return (
      this.db.query(
        `SELECT 1 FROM ucp_link_pending WHERE state = ? AND consumed_at IS NULL AND expires_at > ?`,
        [state, now],
      ).length > 0
    );
  }

  // ------------------------------------------------------------ held callbacks

  /**
   * Keep a callback for a paired server to pull (§3.17). At most `cap`
   * live at once; the same state again replaces nothing. False when not kept.
   */
  holdCallback(
    state: string,
    params: Readonly<Record<string, string>>,
    now: number,
    lifeMs: number,
    cap: number,
  ): boolean {
    return this.transaction(() => {
      this.db.run(`DELETE FROM ucp_link_held_callbacks WHERE expires_at <= ?`, [now]);
      const live = Number(
        this.db.query(`SELECT COUNT(*) AS n FROM ucp_link_held_callbacks`)[0]?.n ?? 0,
      );
      if (live >= cap) return false;
      return (
        this.db.run(
          `INSERT INTO ucp_link_held_callbacks (state, params_json, expires_at, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (state) DO NOTHING`,
          [state, JSON.stringify(params), now + lifeMs, now],
        ) > 0
      );
    });
  }

  /** The held callbacks under these states (the caller's own: a state is its secret). */
  heldCallbacks(
    states: readonly string[],
    now: number,
  ): { state: string; params: Record<string, string> }[] {
    if (states.length === 0) return [];
    const marks = states.map(() => '?').join(', ');
    return this.db
      .query(
        `SELECT state, params_json FROM ucp_link_held_callbacks WHERE state IN (${marks}) AND expires_at > ?`,
        [...states, now],
      )
      .flatMap((row) => {
        const r = row as DBRow;
        const params = paramsOf(r.params_json);
        return params === null ? [] : [{ state: String(r.state), params }];
      });
  }

  /** Drop held callbacks the puller has taken: how many went. */
  dropHeld(states: readonly string[]): number {
    if (states.length === 0) return 0;
    const marks = states.map(() => '?').join(', ');
    return this.db.run(`DELETE FROM ucp_link_held_callbacks WHERE state IN (${marks})`, [
      ...states,
    ]);
  }

  // ------------------------------------------------------------ links

  get(origin: string): LinkView | null {
    const r = this.db.query(`SELECT * FROM ucp_merchant_links WHERE merchant_origin = ?`, [
      origin,
    ])[0];
    return r === undefined ? null : viewOf(r as DBRow);
  }

  list(): LinkView[] {
    return this.db
      .query(`SELECT * FROM ucp_merchant_links ORDER BY merchant_origin`)
      .map((r) => viewOf(r as DBRow));
  }

  /**
   * Store a new link from a completed flow (or replace one being re-linked):
   * the old tokens of a replaced link are queued for revocation, in the same
   * transaction.
   */
  putLink(
    link: Omit<
      LinkView,
      | 'state'
      | 'generation'
      | 'refresh_holder'
      | 'refresh_until'
      | 'link_id'
      | 'auth_revision'
      | 'created_at'
      | 'updated_at'
    >,
    tokens: LinkTokens,
    now: number,
    queueId: () => string,
    /** The attempt this answers: marked linked in the same commit as the link. */
    attempt?: string,
  ): void {
    this.transaction(() => {
      const before = this.get(link.merchant_origin);
      if (before !== null) this.queueTokensOf(before, now, queueId);
      this.db.run(
        `INSERT INTO ucp_merchant_links (merchant_origin, issuer, token_endpoint, revocation_endpoint, client_id,
           scopes_json, state, generation, access_token, refresh_token, access_expires_at, link_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (merchant_origin) DO UPDATE SET issuer = excluded.issuer,
           token_endpoint = excluded.token_endpoint, revocation_endpoint = excluded.revocation_endpoint,
           client_id = excluded.client_id, scopes_json = excluded.scopes_json, state = 'active',
           generation = excluded.generation, access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, access_expires_at = excluded.access_expires_at,
           link_id = excluded.link_id, auth_revision = 1, superseded_json = NULL,
           refresh_holder = NULL, refresh_until = NULL, updated_at = excluded.updated_at`,
        [
          link.merchant_origin,
          link.issuer,
          link.token_endpoint,
          link.revocation_endpoint,
          link.client_id,
          JSON.stringify(link.scopes),
          (before?.generation ?? 0) + 1,
          tokens.accessToken,
          tokens.refreshToken,
          link.access_expires_at,
          queueId(),
          now,
          now,
        ],
      );
      this.db.run(`DELETE FROM ucp_link_wanted WHERE merchant_origin = ?`, [link.merchant_origin]);
      if (attempt !== undefined) this.recordOutcome(attempt, 'linked');
    });
  }

  /** How an attempt ended, and at which merchant; null when unknown. Outcome null while open. */
  attemptOf(state: string): { merchant_origin: string; outcome: string | null } | null {
    const r = this.db.query(
      `SELECT merchant_origin, outcome FROM ucp_link_pending WHERE state = ?`,
      [state],
    )[0] as DBRow | undefined;
    if (r === undefined) return null;
    return {
      merchant_origin: String(r.merchant_origin),
      outcome: r.outcome === null || r.outcome === undefined ? null : String(r.outcome),
    };
  }

  /**
   * Merge a step-up grant into the live link it was asked for: the new
   * tokens replace the old ones, which are not revoked (a server may revoke
   * a whole grant with any of its tokens, RFC 7009 §2.1, and an incremental
   * grant extends the one the link holds); the scopes are the union. A
   * refresh token the answer replaces is kept aside, never used, and
   * revoked with the link (a server may keep it alive). `gone` when that
   * link is no longer live under the same issuer and client; `busy` while a
   * refresh holds its lease (its rotated tokens would be refused as stale).
   */
  stepUpLink(
    origin: string,
    issuer: string,
    clientId: string,
    granted: readonly string[],
    tokens: LinkTokens,
    accessExpiresAt: number | null,
    now: number,
    /** The attempt this answers: marked linked in the same commit as the tokens. */
    attempt?: string,
  ): 'merged' | 'gone' | 'busy' {
    return this.transaction(() => {
      const link = this.get(origin);
      if (
        link === null ||
        link.state !== 'active' ||
        link.issuer !== issuer ||
        link.client_id !== clientId
      )
        return 'gone';
      if (link.refresh_holder !== null && (link.refresh_until ?? 0) > now) return 'busy';
      const scopes = [...new Set([...link.scopes, ...granted])].sort();
      const old = this.useTokens(origin, (t) => t.refreshToken);
      const superseded = this.supersededOf(origin);
      if (typeof old === 'string' && tokens.refreshToken !== null && tokens.refreshToken !== old)
        superseded.push(old);
      this.db.run(
        `UPDATE ucp_merchant_links SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
           access_expires_at = ?, scopes_json = ?, superseded_json = ?, generation = generation + 1,
           auth_revision = auth_revision + 1,
           updated_at = ? WHERE merchant_origin = ?`,
        [
          tokens.accessToken,
          tokens.refreshToken,
          accessExpiresAt,
          JSON.stringify(scopes),
          superseded.length > 0 ? JSON.stringify(superseded) : null,
          now,
          origin,
        ],
      );
      this.db.run(`DELETE FROM ucp_link_wanted WHERE merchant_origin = ?`, [origin]);
      if (attempt !== undefined) this.recordOutcome(attempt, 'linked');
      return 'merged';
    });
  }

  private supersededOf(origin: string): string[] {
    const r = this.db.query(
      `SELECT superseded_json FROM ucp_merchant_links WHERE merchant_origin = ?`,
      [origin],
    )[0] as DBRow | undefined;
    return r?.superseded_json === null || r?.superseded_json === undefined
      ? []
      : scopesOf(r.superseded_json);
  }

  /** The one door the tokens leave by: the callback sees them, nothing keeps them. */
  useTokens<T>(origin: string, fn: (tokens: LinkTokens, link: LinkView) => T): T | null {
    const r = this.db.query(`SELECT * FROM ucp_merchant_links WHERE merchant_origin = ?`, [
      origin,
    ])[0] as DBRow | undefined;
    if (r === undefined || typeof r.access_token !== 'string') return null;
    return fn({ accessToken: r.access_token, refreshToken: str(r.refresh_token) }, viewOf(r));
  }

  /**
   * Take the link's refresh lease under `lease`, a name unique to this one
   * refresh: the link as it stood (its generation and endpoints), or null
   * while another lease runs.
   */
  takeRefresh(origin: string, lease: string, now: number, leaseMs: number): LinkView | null {
    return this.transaction(() => {
      const taken = this.db.run(
        `UPDATE ucp_merchant_links SET refresh_holder = ?, refresh_until = ?
          WHERE merchant_origin = ? AND state = 'active' AND (refresh_holder IS NULL OR refresh_until <= ?)`,
        [lease, now + leaseMs, origin, now],
      );
      return taken === 0 ? null : this.get(origin);
    });
  }

  /** Give up this lease only: a lapsed one taken over since is another refresh's. */
  releaseRefresh(origin: string, lease: string): void {
    this.db.run(
      `UPDATE ucp_merchant_links SET refresh_holder = NULL, refresh_until = NULL
        WHERE merchant_origin = ? AND refresh_holder = ?`,
      [origin, lease],
    );
  }

  /**
   * Replace the tokens after a refresh, only under the generation the
   * refresh began with and only while the link is active. Otherwise the
   * new tokens go to the revocation queue (a rotated refresh token would
   * stay valid if only the old one were revoked, RFC 6749 §6). True when
   * stored.
   */
  replaceTokens(
    began: LinkView,
    tokens: LinkTokens,
    accessExpiresAt: number | null,
    now: number,
    queueId: () => string,
  ): boolean {
    return this.transaction(() => {
      const stored =
        this.db.run(
          `UPDATE ucp_merchant_links SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
             access_expires_at = ?, generation = generation + 1, updated_at = ?
            WHERE merchant_origin = ? AND link_id = ? AND generation = ? AND state = 'active'`,
          [
            tokens.accessToken,
            tokens.refreshToken,
            accessExpiresAt,
            now,
            began.merchant_origin,
            began.link_id,
            began.generation,
          ],
        ) > 0;
      if (stored) return true;
      // Revoked where they were issued: the link the refresh began with, whatever stands now.
      const origin = began.merchant_origin;
      this.queue(origin, began, tokens.accessToken, 'access_token', now, queueId);
      if (tokens.refreshToken !== null)
        this.queue(origin, began, tokens.refreshToken, 'refresh_token', now, queueId);
      return false;
    });
  }

  /** The merchant refused the refresh token (`invalid_grant`): the owner must link again. */
  markNeedsRelink(origin: string, generation: number, now: number): void {
    this.db.run(
      `UPDATE ucp_merchant_links SET state = 'needs_relink', updated_at = ?
        WHERE merchant_origin = ? AND generation = ? AND state = 'active'`,
      [now, origin, generation],
    );
  }

  /**
   * Begin unlinking, in one transaction: the link is `revoking` (no request,
   * refresh or poll uses it), and every token it holds is queued for
   * revocation and removed from it. A refresh lease already running is
   * kept, so the link stays until that refresh has answered and queued its
   * new tokens too (`finishUnlinks`). False when there is no link.
   */
  beginUnlink(origin: string, now: number, queueId: () => string): boolean {
    return this.transaction(() => {
      // Every attempt still open at this merchant, taken or not, ends with the unlink: its tokens
      // are revoked when they come (`landCancelled`), never made into a link.
      this.db.run(
        `UPDATE ucp_link_pending SET cancelled_at = ? WHERE merchant_origin = ? AND cancelled_at IS NULL`,
        [now, origin],
      );
      const link = this.get(origin);
      if (link === null) return false;
      this.queueTokensOf(link, now, queueId);
      this.db.run(
        `UPDATE ucp_merchant_links SET state = 'revoking', access_token = NULL, refresh_token = NULL,
           superseded_json = NULL, updated_at = ? WHERE merchant_origin = ?`,
        [now, origin],
      );
      return true;
    });
  }

  /**
   * Whether the owner unlinked this attempt's merchant since it began; if so,
   * the tokens it was given go to the revocation queue and true is returned.
   * Called right before any link write, with no wait between, so an unlink
   * cannot land in the gap.
   */
  landCancelled(
    pending: PendingLink,
    tokens: LinkTokens,
    now: number,
    queueId: () => string,
  ): boolean {
    return this.transaction(() => {
      const r = this.db.query(`SELECT cancelled_at FROM ucp_link_pending WHERE state = ?`, [
        pending.state,
      ])[0] as DBRow | undefined;
      if (r === undefined || r.cancelled_at === null || r.cancelled_at === undefined) return false;
      const at = { revocation_endpoint: pending.revocation_endpoint, client_id: pending.client_id };
      this.queue(pending.merchant_origin, at, tokens.accessToken, 'access_token', now, queueId);
      if (tokens.refreshToken !== null)
        this.queue(pending.merchant_origin, at, tokens.refreshToken, 'refresh_token', now, queueId);
      return true;
    });
  }

  private queueTokensOf(link: LinkView, now: number, queueId: () => string): void {
    const r = this.db.query(
      `SELECT access_token, refresh_token FROM ucp_merchant_links WHERE merchant_origin = ?`,
      [link.merchant_origin],
    )[0] as DBRow | undefined;
    if (typeof r?.access_token === 'string')
      this.queue(link.merchant_origin, link, r.access_token, 'access_token', now, queueId);
    if (typeof r?.refresh_token === 'string')
      this.queue(link.merchant_origin, link, r.refresh_token, 'refresh_token', now, queueId);
    for (const old of this.supersededOf(link.merchant_origin))
      this.queue(link.merchant_origin, link, old, 'refresh_token', now, queueId);
  }

  private queue(
    origin: string,
    link: Pick<LinkView, 'revocation_endpoint' | 'client_id'> | null,
    token: string,
    hint: 'access_token' | 'refresh_token',
    now: number,
    queueId: () => string,
  ): void {
    this.db.run(
      `INSERT INTO ucp_link_revocations (id, merchant_origin, revocation_endpoint, client_id, token, hint,
         next_try_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        queueId(),
        origin,
        link?.revocation_endpoint ?? null,
        link?.client_id ?? '',
        token,
        hint,
        now,
        now,
      ],
    );
  }

  // ------------------------------------------------------------ revocations

  dueRevocations(now: number, limit: number): QueuedRevocation[] {
    return this.db
      .query(
        `SELECT * FROM ucp_link_revocations WHERE next_try_at <= ? ORDER BY created_at LIMIT ?`,
        [now, limit],
      )
      .map((row) => {
        const r = row as DBRow;
        return {
          id: String(r.id),
          merchant_origin: String(r.merchant_origin),
          revocation_endpoint: str(r.revocation_endpoint),
          client_id: String(r.client_id),
          token: String(r.token),
          hint: String(r.hint) as QueuedRevocation['hint'],
          attempts: Number(r.attempts),
          created_at: Number(r.created_at),
        };
      });
  }

  doneRevocation(id: string): void {
    this.db.run(`DELETE FROM ucp_link_revocations WHERE id = ?`, [id]);
  }

  retryRevocation(id: string, at: number): void {
    this.db.run(
      `UPDATE ucp_link_revocations SET attempts = attempts + 1, next_try_at = ? WHERE id = ?`,
      [at, id],
    );
  }

  /** A revoking link goes once no refresh may still answer for it and its every token is revoked (or given up on). */
  finishUnlinks(now: number): void {
    this.db.run(
      `DELETE FROM ucp_merchant_links WHERE state = 'revoking'
         AND (refresh_until IS NULL OR refresh_until <= ?)
         AND NOT EXISTS (SELECT 1 FROM ucp_link_revocations q
                          WHERE q.merchant_origin = ucp_merchant_links.merchant_origin)`,
      [now],
    );
  }

  /**
   * A token Dina could not revoke (no endpoint, or a week without an
   * answer that it was): dropped from the queue, and the merchant recorded
   * for the owner, who removes Dina's access there (§3.17).
   */
  giveUpRevocation(q: QueuedRevocation, now: number): void {
    this.transaction(() => {
      this.db.run(`DELETE FROM ucp_link_revocations WHERE id = ?`, [q.id]);
      this.db.run(
        `INSERT INTO ucp_link_unrevoked (merchant_origin, since) VALUES (?, ?)
         ON CONFLICT (merchant_origin) DO NOTHING`,
        [q.merchant_origin, now],
      );
    });
  }

  unrevoked(): { merchant_origin: string; since: number }[] {
    return this.db
      .query(`SELECT merchant_origin, since FROM ucp_link_unrevoked ORDER BY merchant_origin`)
      .map((row) => {
        const r = row as DBRow;
        return { merchant_origin: String(r.merchant_origin), since: Number(r.since) };
      });
  }

  /** The owner removed Dina's access at the merchant: the record goes. */
  dismissUnrevoked(origin: string): boolean {
    return this.db.run(`DELETE FROM ucp_link_unrevoked WHERE merchant_origin = ?`, [origin]) > 0;
  }

  // ------------------------------------------------------------ links merchants asked for

  /** A merchant asked for a linked account (a Bearer challenge on some call). */
  want(origin: string, scopes: readonly string[], now: number): void {
    this.db.run(
      `INSERT INTO ucp_link_wanted (merchant_origin, scopes_json, at) VALUES (?, ?, ?)
       ON CONFLICT (merchant_origin) DO UPDATE SET scopes_json = excluded.scopes_json, at = excluded.at`,
      [origin, JSON.stringify([...scopes]), now],
    );
  }

  wanted(): { merchant_origin: string; scopes: string[]; at: number }[] {
    return this.db.query(`SELECT * FROM ucp_link_wanted ORDER BY merchant_origin`).map((row) => {
      const r = row as DBRow;
      return {
        merchant_origin: String(r.merchant_origin),
        scopes: scopesOf(r.scopes_json),
        at: Number(r.at),
      };
    });
  }

  pendingRevocations(origin: string): number {
    return Number(
      this.db.query(`SELECT COUNT(*) AS n FROM ucp_link_revocations WHERE merchant_origin = ?`, [
        origin,
      ])[0]?.n ?? 0,
    );
  }
}
