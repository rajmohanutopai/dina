/**
 * Linking an account at a merchant (UCP plan §3.17, U4): Core's half.
 *
 *  - `start`: the merchant's identity-linking config and the scopes Dina
 *    uses; the issuer from protected-resource metadata (404: the merchant's
 *    own origin); the server's metadata by RFC 8414, then OIDC on 404 only;
 *    a refusal before any redirect when the server cannot serve a public
 *    client. A pending link (state, PKCE verifier, exact redirect URI) lives
 *    10 minutes and is consumed once. The owner opens the URL `start` gives.
 *  - `complete`: the callback (from the gateway, the phone's claimed link, or
 *    a NAT'd server's pull): its pending link taken once, `state` and `iss`
 *    checked, the code exchanged for tokens, the link stored.
 *  - `bearer`: the access token for a merchant's calls, refreshed first when
 *    it is about to expire. One refresh at a time per link (a lease): other
 *    callers wait for the winner's token (a merchant may revoke a link when an
 *    old refresh token is reused, RFC 9700 §4.14.2). A refresh whose answer
 *    is lost is retried once with the same token; `invalid_grant` means the
 *    owner must link again.
 *  - `unlink`: the link is `revoking` at once (nothing uses it) and every
 *    token is queued; `sweep` revokes them (RFC 7009) with backoff until the
 *    merchant answers, or for 7 days, then the link goes.
 *
 * Tokens never reach Brain: they leave the store only through `useTokens`,
 * here, to become an `Authorization` header to the merchant they came from.
 */

import { base64urlEncode } from '@dina/a2a';
import {
  NEVER_ASKED_SCOPES,
  authorizationServerMetadataUrls,
  authorizationUrl,
  codeTokenRequest,
  deriveScopes,
  pkceChallenge,
  protectedResourceMetadataUrl,
  readAuthorizationServerMetadata,
  readCallback,
  readIdentityLinkingConfig,
  readProtectedResourceMetadata,
  readTokenResponse,
  refreshTokenRequest,
  revocationRequest,
  type AuthorizationServer,
  type Sha256Fn,
} from '@dina/ucp';

import { listDevices } from '../../devices/registry';
import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../../workflow/domain';

import { settleCard } from './card_settle';
import { readJsonBytes } from './json_bytes';
import { buildLinkCard, linkCardCorrelation, linkCardDescription, readLinkCard } from './link_card';

import type { UcpFetchResult } from './fetch';
import type { LinkAttempt, LinkView, PendingLink, UcpLinkStore } from './link_store';
import type { UcpMerchantClient } from './merchant_client';
import type { WorkflowTask } from '../../workflow/domain';
import type { ApprovalDecision, WorkflowService } from '../../workflow/service';
import type { PolicySocketRequest } from '@dina/net-policy';

const MINUTE = 60_000;
/** How long a started link waits for its callback. */
export const PENDING_LINK_TTL_MS = 10 * MINUTE;
const LIMITS = { maxResponseBytes: 64 * 1024, timeoutMs: 15_000 };
/** How long a callback caught for a paired server is kept, and how many at once (§3.17). */
export const HELD_CALLBACK_LIFE_MS = PENDING_LINK_TTL_MS;
const HELD_CALLBACK_CAP = 20;
/** A `state` as Dina makes one (32 random bytes, base64url), with room for any server's. */
const STATE_SYNTAX = /^[A-Za-z0-9_-]{16,128}$/;
/** A refresh's lease on its link: longer than the worst refresh (two posts, each to its timeout). */
export const REFRESH_LEASE_MS = 2 * LIMITS.timeoutMs + 15_000;
/**
 * How long the gateway waits for Core to finish a callback: one code
 * exchange to its timeout, a step-up's wait for a running refresh (at most
 * its lease), and a margin.
 */
export const UCP_OAUTH_CALLBACK_WAIT_MS = LIMITS.timeoutMs + REFRESH_LEASE_MS + 5_000;
/** An access token this close to expiry is refreshed first. */
export const EXPIRY_MARGIN_MS = MINUTE;
/** How long a revocation is retried before its token is given up on. */
export const REVOKE_FOR_MS = 7 * 24 * 60 * MINUTE;
const IDENTITY_LINKING = 'dev.ucp.common.identity_linking';

export type StartRefusal =
  | 'merchant_unreachable'
  | 'not_offered'
  | 'nothing_to_link'
  | 'discovery_failed'
  | 'no_callback'
  | 'issuer_mismatch'
  | 'endpoints_invalid'
  | 'no_s256'
  | 'no_iss_parameter'
  | 'no_public_client'
  /** A server behind NAT with no phone paired as its node: no one would catch the answer. */
  | 'no_phone'
  /** The server offers no revocation endpoint: Dina could never take the access back. */
  | 'no_revocation'
  /** The server lists the scopes it supports, and those Dina would ask are not all there. */
  | 'scope_mismatch'
  /** The merchant needs a scope Dina never holds (cancelling or returning orders). */
  | 'scope_refused';

/** Whether a link could be made now: yes; not now but perhaps later; never at this merchant. */
export type Linkable = 'yes' | 'later' | 'never';

/** Refusals that pass: the merchant or its sign-in was out of reach, or no phone is paired yet. */
const PASSING_REFUSALS: ReadonlySet<StartRefusal> = new Set([
  'merchant_unreachable',
  'discovery_failed',
  'no_phone',
]);

export type StartOutcome =
  | { ok: true; url: string; issuer: string; scopes: string[]; expiresAt: number }
  | { ok: false; reason: StartRefusal };

export type CompleteOutcome =
  | { ok: true; merchantOrigin: string; scopes: string[] }
  | {
      ok: false;
      reason:
        | 'unknown_state'
        | 'discarded'
        | 'denied'
        | 'token_refused'
        | 'token_unreachable'
        // The owner unlinked the merchant while the attempt was open: its tokens are revoked.
        | 'cancelled'
        // Another run is finishing this callback now: not an end, so not acknowledged.
        | 'busy';
    };

/** A callback the phone's claimed link caught: finished here, kept for a paired server, or dropped. */
export type ReceiveOutcome = CompleteOutcome | { ok: false; reason: 'held' | 'not_held' };

/** Each refusal word an attempt can end with, kept for the owner. */
type AttemptOutcome = 'linked' | Exclude<CompleteOutcome, { ok: true }>['reason'];

export interface LinkServiceDeps {
  store: UcpLinkStore;
  client: Pick<UcpMerchantClient, 'open'>;
  fetch: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  /** Dina's `client_id` at this merchant (D6: the owner's, the merchant's registration, or the profile URL); null: none works. */
  clientId: (origin: string) => string | null;
  /** Where this node takes the callback now; null when it cannot. */
  redirectUri: () => string | null;
  nowMs: () => number;
  randomBytes: (n: number) => Uint8Array;
  sha256: Sha256Fn;
  newId: () => string;
  /** This process's refresh holder name. */
  holder: string;
  sleep?: (ms: number) => Promise<void>;
  /** A link completed: what waited for it (orders whose polling a challenge paused) goes on. */
  onLinked?: (origin: string, now: number) => void;
  /**
   * Whether the merchant's answer comes back to this node itself: its own
   * public origin (the gateway), or the claimed link caught by this very
   * app. When not (a server behind NAT), the sign-in page goes to the
   * paired phone on a card. Default yes.
   */
  opensHere?: () => boolean;
  /** Where the link card is raised; none: no card, and such a node cannot link. */
  workflow?: () => WorkflowService | null;
  /**
   * Where the answer does not come back here: whether a phone is paired as
   * this node's own (which shows the card and catches the answer). Default yes.
   */
  phoneReady?: () => boolean;
  /** On a phone: whether a server is paired with it as its node, for whom it keeps callbacks. */
  serverPaired?: () => boolean;
}

/** Starting a link for the owner: the page to open here, or the card that took it to the phone. */
export type OwnerStartOutcome =
  | { ok: true; opens: 'here'; url: string; scopes: string[]; expiresAt: number }
  | { ok: true; opens: 'phone'; cardId: string; scopes: string[]; expiresAt: number }
  | { ok: false; reason: StartRefusal | 'url_too_long' | 'no_workflow' };

const FORM = 'application/x-www-form-urlencoded';

/** Whether a server is paired with this node as its own (an agent device of scope `node`). */
export function serverNodePaired(): boolean {
  return listDevices().some((d) => !d.revoked && d.role === 'agent' && d.scope === 'node');
}

/**
 * Keep a callback for the paired server whose link it is (§3.17), to pull by
 * its state, for 10 minutes; at most 20 at once. Only on a phone a server is
 * paired with as its node (`serverPaired`); on any other it is a callback for
 * nothing. A node keeps them whether or not it runs UCP itself.
 */
export function holdLinkCallback(
  store: UcpLinkStore,
  params: Readonly<Record<string, string | undefined>>,
  now: number,
  serverPaired: boolean,
): { ok: false; reason: 'held' | 'not_held' | 'unknown_state' } {
  const state = params.state;
  if (!serverPaired || typeof state !== 'string' || !STATE_SYNTAX.test(state))
    return { ok: false, reason: 'unknown_state' };
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string') kept[k] = v;
  const held = store.holdCallback(state, kept, now, HELD_CALLBACK_LIFE_MS, HELD_CALLBACK_CAP);
  return { ok: false, reason: held ? 'held' : 'not_held' };
}

/** Callbacks kept here for a paired server, under the states it names (its own secrets). */
export function heldLinkCallbacks(
  store: UcpLinkStore,
  states: readonly string[],
  now: number,
): { state: string; params: Record<string, string> }[] {
  return store.heldCallbacks(
    states.filter((s) => STATE_SYNTAX.test(s)),
    now,
  );
}

/** The paired server has taken these: they go. */
export function dropHeldLinkCallbacks(store: UcpLinkStore, states: readonly string[]): number {
  return store.dropHeld(states.filter((s) => STATE_SYNTAX.test(s)));
}

/**
 * What a revocation answer means (RFC 7009 §2.2): only a 200 revokes. A
 * server that does not revoke access tokens (`unsupported_token_type`) lets
 * one lapse on its own: done; for a refresh token it is access Dina cannot
 * take back. Anything else is tried again.
 */
function revocationVerdict(
  answer: { kind: 'answer'; status: number; value: unknown } | { kind: 'failed'; sent: boolean },
  hint: 'access_token' | 'refresh_token',
): 'revoked' | 'never' | 'retry' {
  if (answer.kind !== 'answer') return 'retry';
  if (answer.status === 200) return 'revoked';
  const error = (answer.value as { error?: unknown } | undefined)?.error;
  if (answer.status === 400 && error === 'unsupported_token_type')
    return hint === 'access_token' ? 'revoked' : 'never';
  return 'retry';
}

export class UcpLinkService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: LinkServiceDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ------------------------------------------------------------ start

  /**
   * Begin linking: the URL the owner opens, or why Dina will not link with
   * this merchant. `required`: the full scope set a challenge named. With a
   * live link, only the scopes it lacks are asked for and the answer is
   * merged into it (incremental authorization: a merchant's
   * `insufficient_scope` is never answered by a fresh link, which would
   * drop what was granted).
   */
  async start(origin: string, required: readonly string[] = []): Promise<StartOutcome> {
    const ready = await this.prepare(origin, required);
    if (!ready.ok) return ready;
    const { scopes, stepUp, server, clientId, redirectUri } = ready;
    const verifier = base64urlEncode(this.deps.randomBytes(32));
    const state = base64urlEncode(this.deps.randomBytes(32));
    const now = this.deps.nowMs();
    const expiresAt = now + PENDING_LINK_TTL_MS;
    this.deps.store.addPending(
      {
        state,
        merchant_origin: origin,
        issuer: server.issuer,
        token_endpoint: server.tokenEndpoint,
        revocation_endpoint: server.revocationEndpoint ?? null,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        scopes,
        step_up: stepUp,
        expires_at: expiresAt,
      },
      now,
    );
    return {
      ok: true,
      url: authorizationUrl({
        authorizationEndpoint: server.authorizationEndpoint,
        clientId,
        redirectUri,
        scopes,
        state,
        codeChallenge: pkceChallenge(verifier, this.deps.sha256),
      }),
      issuer: server.issuer,
      scopes,
      expiresAt,
    };
  }

  /**
   * Start linking for the owner. Where the merchant's answer comes back
   * here, the page to open; otherwise a `ucp_link_handoff` card carries it
   * to the paired phone (replacing any earlier card for this merchant).
   */
  async startForOwner(
    origin: string,
    required: readonly string[] = [],
  ): Promise<OwnerStartOutcome> {
    const here = this.deps.opensHere?.() ?? true;
    const workflow = here ? null : (this.deps.workflow?.() ?? null);
    if (!here && workflow === null) return { ok: false, reason: 'no_workflow' };
    const started = await this.start(origin, required);
    if (!started.ok) return started;
    const { scopes, expiresAt } = started;
    if (workflow === null) return { ok: true, opens: 'here', url: started.url, scopes, expiresAt };
    const card = buildLinkCard(origin, started);
    if (card === null) return { ok: false, reason: 'url_too_long' };
    this.closeCards(workflow, origin, 'replaced');
    const cardId = `ucp-link-${this.deps.newId()}`;
    workflow.create({
      id: cardId,
      kind: WorkflowTaskKind.Approval,
      description: linkCardDescription(card),
      payload: JSON.stringify(card),
      correlationId: linkCardCorrelation(origin),
      priority: WorkflowTaskPriority.UserBlocking,
      expiresAtSec: Math.floor(expiresAt / 1000),
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
    });
    return { ok: true, opens: 'phone', cardId, scopes, expiresAt };
  }

  /** The owner's yes to a link card: the page opened on the phone, and the card is done. */
  decide(task: WorkflowTask, decision: ApprovalDecision): 'opened' | 'ignored' {
    if (readLinkCard(task.payload) === null || decision !== 'approved') return 'ignored';
    const workflow = this.deps.workflow?.() ?? null;
    if (workflow === null) return 'ignored';
    if (workflow.store().getById(task.id)?.status !== WorkflowTaskState.Queued) return 'ignored';
    settleCard(workflow, task.id, this.deps.nowMs(), { ok: true, result: { opened: 'true' } });
    return 'opened';
  }

  /** Cards for this merchant's link still waiting on the owner end: replaced, or linked by now. */
  private closeCards(workflow: WorkflowService, origin: string, reason: string): void {
    for (const t of workflow.store().getByCorrelationId(linkCardCorrelation(origin))) {
      if (t.status !== WorkflowTaskState.PendingApproval || readLinkCard(t.payload) === null)
        continue;
      try {
        workflow.cancel(t.id, reason);
      } catch {
        /* decided or expired meanwhile */
      }
    }
  }

  /**
   * Whether the owner could link with this merchant for `required`: the
   * same checks `start` makes, with nothing kept. `later` when a refusal
   * passes (the merchant or its sign-in out of reach, no phone paired yet);
   * `never` when the merchant's setup rules a link out, so it does not share.
   */
  async canLink(origin: string, required: readonly string[] = []): Promise<Linkable> {
    const ready = await this.prepare(origin, required);
    if (ready.ok) return 'yes';
    return PASSING_REFUSALS.has(ready.reason) ? 'later' : 'never';
  }

  private async prepare(
    origin: string,
    required: readonly string[],
  ): Promise<
    | {
        ok: true;
        scopes: string[];
        stepUp: boolean;
        server: AuthorizationServer;
        clientId: string;
        redirectUri: string;
      }
    | { ok: false; reason: StartRefusal }
  > {
    // Asked before anything leaves: the answer must have somewhere to come back to.
    if (!(this.deps.opensHere?.() ?? true) && !(this.deps.phoneReady?.() ?? true))
      return { ok: false, reason: 'no_phone' };
    const opened = await this.deps.client.open(origin);
    if (!opened.ok) return { ok: false, reason: 'merchant_unreachable' };
    const negotiated = opened.connection.merchant.negotiated;
    const entry = negotiated.get(IDENTITY_LINKING);
    const config = entry === undefined ? null : readIdentityLinkingConfig(entry.entry.config);
    if (config === null) return { ok: false, reason: 'not_offered' };
    // A challenge that needs a scope Dina never holds is one Dina does not answer.
    if (required.some((s) => NEVER_ASKED_SCOPES.has(s)))
      return { ok: false, reason: 'scope_refused' };
    // What may be asked: listed by the merchant, for a negotiated capability (§"scope derivation").
    const derived = deriveScopes(config, new Set(negotiated.keys()), required);
    const live = this.deps.store.get(origin);
    const stepUp = live !== null && live.state === 'active' && required.length > 0;
    let scopes = derived;
    if (stepUp) {
      // Only what the challenge needs, less what the link holds. A challenge for scopes the
      // link already holds is a policy one (a newer sign-in, a stronger one): asked again.
      const needed = derived.filter((s) => required.includes(s));
      const missing = needed.filter((s) => !live.scopes.includes(s));
      scopes = missing.length > 0 ? missing : needed;
    }
    if (scopes.length === 0) return { ok: false, reason: 'nothing_to_link' };

    const issuer = await this.issuerOf(origin);
    if (issuer === null) return { ok: false, reason: 'discovery_failed' };
    const server = await this.serverOf(issuer);
    if (!server.ok) return server;
    // Access Dina could never take back is not taken (identity-linking: revocation is required).
    if (server.value.revocationEndpoint === undefined)
      return { ok: false, reason: 'no_revocation' };
    const supported = server.value.scopesSupported;
    if (supported !== undefined && scopes.some((s) => !supported.includes(s)))
      return { ok: false, reason: 'scope_mismatch' };

    const clientId = this.deps.clientId(origin);
    const redirectUri = this.deps.redirectUri();
    if (clientId === null || redirectUri === null) return { ok: false, reason: 'no_callback' };
    return { ok: true, scopes, stepUp, server: server.value, clientId, redirectUri };
  }

  /** The issuer protecting a merchant (RFC 9728): its own origin when it publishes no metadata. */
  private async issuerOf(origin: string): Promise<string | null> {
    const got = await this.getJson(protectedResourceMetadataUrl(origin));
    if (got.kind === 'status' && got.status === 404) return origin;
    if (got.kind !== 'json') return null;
    // The resource the metadata names is the merchant's origin, with or without its slash.
    for (const resource of [origin, `${origin}/`]) {
      const read = readProtectedResourceMetadata(got.value, resource);
      if (read.ok) return read.value;
    }
    return null;
  }

  /** The issuer's metadata: RFC 8414 first, OIDC only on its 404; checked for a public client. */
  private async serverOf(
    issuer: string,
  ): Promise<{ ok: true; value: AuthorizationServer } | { ok: false; reason: StartRefusal }> {
    const urls = authorizationServerMetadataUrls(issuer);
    let got = await this.getJson(urls.rfc8414);
    if (got.kind === 'status' && got.status === 404) got = await this.getJson(urls.oidc);
    if (got.kind !== 'json') return { ok: false, reason: 'discovery_failed' };
    const read = readAuthorizationServerMetadata(got.value, issuer);
    if (read.ok) return read;
    return { ok: false, reason: read.reason === 'not_object' ? 'discovery_failed' : read.reason };
  }

  private async getJson(
    url: string,
  ): Promise<
    { kind: 'json'; value: unknown } | { kind: 'status'; status: number } | { kind: 'failed' }
  > {
    const r = await this.deps.fetch({
      method: 'GET',
      url,
      headers: { accept: 'application/json' },
      accept: 'json',
      minTls: 'TLSv1.2',
      readAuthErrorBodies: false,
      ...LIMITS,
    });
    if (!r.ok) return { kind: 'failed' };
    if (r.status !== 200) return { kind: 'status', status: r.status };
    const json = readJsonBytes(r.bodyBytes);
    return json.ok ? { kind: 'json', value: json.value } : { kind: 'failed' };
  }

  // ------------------------------------------------------------ complete

  /**
   * The authorization response, wherever it arrived: its pending link taken
   * once, then the code exchanged. `relayed`: pulled from the phone, which
   * keeps it until `markRelayed`. How it ended is kept for the owner.
   */
  async complete(
    params: Readonly<Record<string, string | undefined>>,
    options: { relayed?: boolean } = {},
  ): Promise<CompleteOutcome> {
    const state = params.state;
    if (typeof state !== 'string' || state === '') return { ok: false, reason: 'unknown_state' };
    const now = this.deps.nowMs();
    // A claim left without an outcome (the process stopped part-way) is claimed again after the
    // longest an exchange can take: the callback is finished, never lost. The code may then be
    // refused as used, which is recorded like any refusal.
    const pending = this.deps.store.consumePending(
      state,
      now,
      options.relayed === true,
      UCP_OAUTH_CALLBACK_WAIT_MS,
    );
    if (pending === 'busy') return { ok: false, reason: 'busy' };
    if (pending === null) {
      // Linked already: a process that stopped right after the link was written left what follows
      // it undone (cards, orders waiting on the link). Done now; the repeat is still refused.
      const attempt = this.deps.store.attemptOf(state);
      if (attempt?.outcome === 'linked') this.afterLinked(attempt.merchant_origin, now);
      return { ok: false, reason: 'unknown_state' };
    }
    const out = await this.exchange(pending, params);
    // A link records its own outcome in the commit that writes it; a refusal is recorded here.
    if (!out.ok) this.deps.store.recordOutcome(state, out.reason satisfies AttemptOutcome);
    return out;
  }

  /** What follows a link (each step safe to repeat): orders waiting on it resume, its cards close. */
  private afterLinked(origin: string, at: number): void {
    this.deps.onLinked?.(origin, at);
    const workflow = this.deps.workflow?.() ?? null;
    if (workflow !== null) this.closeCards(workflow, origin, 'linked');
  }

  private async exchange(
    pending: PendingLink,
    params: Readonly<Record<string, string | undefined>>,
  ): Promise<CompleteOutcome> {
    const read = readCallback(params, { state: pending.state, issuer: pending.issuer });
    if (!read.ok) return { ok: false, reason: read.reason === 'denied' ? 'denied' : 'discarded' };
    const answer = await this.post(
      pending.token_endpoint,
      codeTokenRequest({
        code: read.code,
        redirectUri: pending.redirect_uri,
        codeVerifier: pending.code_verifier,
        clientId: pending.client_id,
      }),
    );
    if (answer.kind === 'failed') return { ok: false, reason: 'token_unreachable' };
    const tokens = readTokenResponse(answer.status, answer.value);
    if (!tokens.ok) return { ok: false, reason: 'token_refused' };
    const at = this.deps.nowMs();
    const t = tokens.tokens;
    const granted = t.scopes ?? pending.scopes;
    const expiresAt = t.expiresIn === undefined ? null : at + t.expiresIn * 1000;
    const pair = { accessToken: t.accessToken, refreshToken: t.refreshToken ?? null };
    // A step-up extends the live link it was asked for, once no refresh is running on it
    // (a lease lasts at most REFRESH_LEASE_MS); with that link gone, it stands alone.
    // Unlinked while the code was out: the tokens are revoked, never made a link. Checked right
    // before each write below (no wait in between), so an unlink cannot slip into the gap.
    const cancelled = () =>
      this.deps.store.landCancelled(pending, pair, this.deps.nowMs(), this.deps.newId);
    let merged: 'merged' | 'gone' | 'busy' = 'gone';
    if (pending.step_up)
      for (let waited = 0; ; waited += 250) {
        if (cancelled()) return { ok: false, reason: 'cancelled' };
        merged = this.deps.store.stepUpLink(
          pending.merchant_origin,
          pending.issuer,
          pending.client_id,
          granted,
          pair,
          expiresAt,
          this.deps.nowMs(),
          pending.state,
        );
        if (merged !== 'busy' || waited > REFRESH_LEASE_MS) break;
        await this.sleep(250);
      }
    if (merged !== 'merged') {
      if (cancelled()) return { ok: false, reason: 'cancelled' };
      this.deps.store.putLink(
        {
          merchant_origin: pending.merchant_origin,
          issuer: pending.issuer,
          token_endpoint: pending.token_endpoint,
          revocation_endpoint: pending.revocation_endpoint,
          client_id: pending.client_id,
          // The scopes granted, when the server said; else those asked.
          scopes: granted,
          access_expires_at: expiresAt,
        },
        pair,
        at,
        this.deps.newId,
        pending.state,
      );
    }
    this.afterLinked(pending.merchant_origin, at);
    return {
      ok: true,
      merchantOrigin: pending.merchant_origin,
      scopes: this.deps.store.get(pending.merchant_origin)?.scopes ?? granted,
    };
  }

  /**
   * A callback the Dina app's claimed link caught (§3.17). This node's own
   * pending link finishes here; any other is kept for the paired server
   * whose link it is (`holdLinkCallback`).
   */
  async receive(params: Readonly<Record<string, string | undefined>>): Promise<ReceiveOutcome> {
    const state = params.state;
    if (typeof state === 'string' && this.deps.store.isWaiting(state, this.deps.nowMs()))
      return this.complete(params);
    return holdLinkCallback(
      this.deps.store,
      params,
      this.deps.nowMs(),
      this.deps.serverPaired?.() ?? false,
    );
  }

  /** The states this node's links wait on: what it pulls a paired phone's held callbacks by. */
  waitingStates(): string[] {
    return this.deps.store.waitingStates(this.deps.nowMs());
  }

  /** The phone dropped these after the pull: nothing more is owed. */
  markRelayed(states: readonly string[]): void {
    this.deps.store.markAcked(states, this.deps.nowMs());
  }

  /** Attempts in the last day that ended without a link, for the owner. */
  failedAttempts(): LinkAttempt[] {
    return this.deps.store.failedAttempts(this.deps.nowMs() - 24 * 60 * MINUTE);
  }

  /** Merchants where Dina could not take its access back. */
  unrevoked(): { merchant_origin: string; since: number }[] {
    return this.deps.store.unrevoked();
  }

  dismissUnrevoked(origin: string): boolean {
    return this.deps.store.dismissUnrevoked(origin);
  }

  /** A merchant asked for a linked account on some call: offered to the owner. */
  want(origin: string, scopes: readonly string[]): void {
    this.deps.store.want(origin, scopes, this.deps.nowMs());
  }

  wanted(): { merchant_origin: string; scopes: string[]; at: number }[] {
    return this.deps.store.wanted();
  }

  private async post(
    url: string,
    form: string,
  ): Promise<
    { kind: 'answer'; status: number; value: unknown } | { kind: 'failed'; sent: boolean }
  > {
    const r = await this.deps.fetch({
      method: 'POST',
      url,
      headers: { 'content-type': FORM, accept: 'application/json' },
      body: new TextEncoder().encode(form),
      accept: 'json',
      minTls: 'TLSv1.2',
      readAuthErrorBodies: true,
      ...LIMITS,
    });
    if (!r.ok) return { kind: 'failed', sent: r.sent };
    const json = readJsonBytes(r.bodyBytes);
    return { kind: 'answer', status: r.status, value: json.ok ? json.value : undefined };
  }

  // ------------------------------------------------------------ use

  /** Every link, as the owner sees them; never their tokens. */
  list(): LinkView[] {
    return this.deps.store.list();
  }

  /** The link as the owner sees it; never its tokens. */
  view(origin: string): LinkView | null {
    return this.deps.store.get(origin);
  }

  /**
   * The access token for a call to this merchant, refreshed first when it
   * is about to expire; null when the link is not usable now.
   */
  async bearer(origin: string): Promise<string | null> {
    const link = this.deps.store.get(origin);
    if (link === null || link.state !== 'active') return null;
    const now = this.deps.nowMs();
    if (link.access_expires_at !== null && now >= link.access_expires_at - EXPIRY_MARGIN_MS)
      await this.refresh(origin);
    const fresh = this.deps.store.get(origin);
    if (fresh === null || fresh.state !== 'active') return null;
    if (fresh.access_expires_at !== null && this.deps.nowMs() >= fresh.access_expires_at)
      return null;
    return this.deps.store.useTokens(origin, (t) => t.accessToken);
  }

  /**
   * Refresh the link's tokens, one caller at a time. A caller that finds
   * another refreshing waits for it (up to the lease) and uses its result.
   * `refused`: the token a merchant just refused; when the link holds
   * another already (a refresh landed meanwhile), nothing is sent. Returns
   * whether the link is usable after.
   */
  async refresh(origin: string, refused?: string): Promise<boolean> {
    const { store } = this.deps;
    if (refused !== undefined) {
      const current = store.useTokens(origin, (t, link) =>
        link.state === 'active' ? t.accessToken : null,
      );
      if (current === null) return false;
      if (current !== refused) return true;
    }
    // This refresh's own lease: releasing it never frees another's.
    const lease = `${this.deps.holder}#${this.deps.newId()}`;
    const began = store.takeRefresh(origin, lease, this.deps.nowMs(), REFRESH_LEASE_MS);
    if (began === null) {
      // Another caller is refreshing: wait for its token rather than send our own.
      const before = store.get(origin)?.generation;
      for (let waited = 0; waited < REFRESH_LEASE_MS; waited += 250) {
        await this.sleep(250);
        const now = store.get(origin);
        if (now === null || now.state !== 'active') return false;
        if (now.generation !== before || now.refresh_holder === null) return true;
      }
      return false;
    }
    try {
      const refreshToken = store.useTokens(origin, (t) => t.refreshToken);
      if (refreshToken === null || refreshToken === undefined) {
        store.markNeedsRelink(origin, began.generation, this.deps.nowMs());
        return false;
      }
      const form = refreshTokenRequest({ refreshToken, clientId: began.client_id });
      let answer = await this.post(began.token_endpoint, form);
      // A lost answer: once more with the same refresh token (the merchant may rotate it).
      if (answer.kind === 'failed' && answer.sent)
        answer = await this.post(began.token_endpoint, form);
      if (answer.kind === 'failed') return false;
      const read = readTokenResponse(answer.status, answer.value);
      if (!read.ok) {
        if (read.error === 'invalid_grant')
          store.markNeedsRelink(origin, began.generation, this.deps.nowMs());
        return false;
      }
      const now = this.deps.nowMs();
      return store.replaceTokens(
        began,
        { accessToken: read.tokens.accessToken, refreshToken: read.tokens.refreshToken ?? null },
        read.tokens.expiresIn === undefined ? null : now + read.tokens.expiresIn * 1000,
        now,
        this.deps.newId,
      );
    } finally {
      store.releaseRefresh(origin, lease);
    }
  }

  // ------------------------------------------------------------ unlink

  /** Unlink at once: nothing uses the link from now; its tokens are revoked by `sweep`. */
  unlink(origin: string): boolean {
    return this.deps.store.beginUnlink(origin, this.deps.nowMs(), this.deps.newId);
  }

  /** Revoke queued tokens (backoff from a minute to an hour, given up after 7 days); drop old pending links. */
  async sweep(): Promise<void> {
    const { store } = this.deps;
    const now = this.deps.nowMs();
    store.prunePending(now - 24 * 60 * MINUTE);
    for (const q of store.dueRevocations(now, 20)) {
      if (q.revocation_endpoint === null || now - q.created_at >= REVOKE_FOR_MS) {
        // No endpoint to revoke at, or a week of trying: the owner is told to remove it there.
        store.giveUpRevocation(q, now);
        continue;
      }
      const answer = await this.post(
        q.revocation_endpoint,
        revocationRequest({ token: q.token, hint: q.hint, clientId: q.client_id }),
      );
      const verdict = revocationVerdict(answer, q.hint);
      if (verdict === 'revoked') store.doneRevocation(q.id);
      else if (verdict === 'never') store.giveUpRevocation(q, now);
      else store.retryRevocation(q.id, now + Math.min(MINUTE * 2 ** q.attempts, 60 * MINUTE));
    }
    store.finishUnlinks(now);
  }
}
