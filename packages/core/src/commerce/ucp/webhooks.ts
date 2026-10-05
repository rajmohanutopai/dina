/**
 * Order webhooks (UCP plan §3.13, U3.3).
 *
 * A server with a public domain lists `https://<public-origin>/ucp/webhooks/orders`
 * as its order `webhook_url` unless the owner turned it off (S8); every other
 * node lists the drop-box (S9) and polls. The node's A2A gateway receives the
 * POST (its per-IP edge limit, a 512 KiB body cap) and forwards the raw bytes
 * and the webhook's own headers to Core's ingress route, signed with its
 * service key, waiting at most 2 seconds; anything else is a 503, so the
 * merchant retries.
 *
 * Accepting a delivery (`accept`): Core reads the lookup fields (the origin
 * of the root profile `UCP-Agent` names, the order and checkout ids). If no
 * session or order is held under that origin and id, or the two ids name
 * different sessions, the delivery is dropped unfetched, with a 200: an
 * unknown sender learns nothing. Otherwise its raw bytes go to the inbox,
 * and only then does the gateway answer 200.
 *
 * Processing (`sweep`): the signature is verified with the keys of the
 * merchant's root profile. A delivery that fails verification is deleted
 * and records nothing, so it cannot suppress a later valid one with the
 * same `Webhook-Id`. A verified one, in one transaction: its `Webhook-Id` is
 * recorded (per merchant origin, kept 7 days; a repeat adds nothing), its
 * resource is prompted, and the inbox row goes. The prompt is durable: an
 * open order's next poll is due now, a handed-off session's next read is due
 * now; each is retried by its own sweep until it succeeds. Only a
 * webhook-only (or closed) order takes the body itself (`absorbPushed`).
 */

import { base64Decode, base64Encode, isPlainObject, parseStrictJson } from '@dina/a2a';
import {
  readOrder,
  readWebhookDelivery,
  UCP_VERSION,
  WEBHOOK_HEADERS,
  WEBHOOK_MAX_BYTES,
  type HttpMessage,
} from '@dina/ucp';

import { jsonOrUndefined } from './json_bytes';
import { getUcpSettingsStore } from './settings';

import type { CheckoutRow, CheckoutState, UcpCheckoutStore } from './checkout_store';
import type { UcpMerchantClient } from './merchant_client';
import type { OrderKey, UcpOrderStore } from './order_store';
import type { UcpOrderService } from './orders';
import type { DatabaseAdapter, DBRow } from '../../storage/db_adapter';

/** The largest webhook body the gateway takes (§3.13 step 1). */
export const UCP_WEBHOOK_MAX_BYTES = WEBHOOK_MAX_BYTES;
/** Where the public gateway takes order webhooks. */
export const UCP_WEBHOOK_PUBLIC_PATH = '/ucp/webhooks/orders';
/** Core's ingress route for them; the gateway's alone. */
export const UCP_WEBHOOK_INGRESS_ROUTE = '/v1/ucp/ingress/webhook';
/** Where a public server's gateway takes the OAuth callback (§3.17), and Core's door for it. */
export const UCP_OAUTH_CALLBACK_PATH = '/ucp/oauth/callback';
export const UCP_OAUTH_INGRESS_ROUTE = '/v1/ucp/ingress/oauth-callback';

/** Whether `method` + `path` (no query) is one of the gateway's UCP doors; hosts scope limiter exemptions with it. */
export function isUcpGatewayRoute(method: string, path: string): boolean {
  return (
    method === 'POST' && (path === UCP_WEBHOOK_INGRESS_ROUTE || path === UCP_OAUTH_INGRESS_ROUTE)
  );
}

/** How long the gateway waits for Core to store a delivery before answering 503. */
export const UCP_WEBHOOK_STORE_WAIT_MS = 2_000;
/** How long a verified `Webhook-Id` is remembered (§3.13 step 5). */
export const WEBHOOK_SEEN_KEEP_MS = 7 * 24 * 60 * 60_000;
/** How long an unverified delivery is retried (its merchant unreachable) before it is dropped. */
export const WEBHOOK_RETRY_FOR_MS = 24 * 60 * 60_000;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const SWEEP_LIMIT = 50;

// ------------------------------------------------------------ the node's webhook URL

let publicOrigin: string | null = null;
/** Set while this node's publisher stands down (§3.5): it then takes no webhooks. */
let stoodDown = false;

/** The publisher's role, as it saves or reads it: a stood-down node stops taking webhooks (§3.5). */
export function setUcpWebhooksStoodDown(value: boolean): void {
  stoodDown = value;
}

/** The public https origin this node's gateway serves; null on a node with none (a phone, a NAT'd server). */
export function installUcpWebhookOrigin(origin: string | null): void {
  publicOrigin = origin === null ? null : new URL(origin).origin;
}

/** This node's public origin, when its gateway has one (the OAuth callback lives there too, §3.17). */
export function ucpPublicOrigin(): string | null {
  return publicOrigin;
}

/**
 * The `webhook_url` this node lists for orders: its own on a public server
 * with order webhooks on (S8), and not stood down (§3.5); else null (the
 * drop-box, S9, and polling).
 */
export function ucpOrderWebhookUrl(): string | null {
  if (publicOrigin === null || stoodDown) return null;
  if (getUcpSettingsStore()?.get().order_webhooks === false) return null;
  return `${publicOrigin}${UCP_WEBHOOK_PUBLIC_PATH}`;
}

// ------------------------------------------------------------ the envelope

/** What the gateway forwards: the request as it came, cut to the webhook's own headers. */
export interface UcpWebhookEnvelope {
  path: string;
  /** The query string, without `?`; empty for none. */
  query: string;
  /** Lower-case names, from `WEBHOOK_HEADERS` only. */
  headers: Record<string, string>;
  /** The exact body bytes, base64. */
  body_b64: string;
}

/** Build the envelope from a request (the gateway's half): only the webhook's own headers go to Core. */
export function ucpWebhookEnvelope(
  path: string,
  query: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: Uint8Array,
): UcpWebhookEnvelope {
  const kept: Record<string, string> = {};
  for (const name of WEBHOOK_HEADERS) {
    const value = headers[name];
    if (value !== undefined) kept[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return { path, query, headers: kept, body_b64: base64Encode(body) };
}

function readEnvelope(value: unknown): { envelope: UcpWebhookEnvelope; body: Uint8Array } | null {
  if (!isPlainObject(value)) return null;
  const { path, query, headers, body_b64: b64 } = value;
  if (path !== UCP_WEBHOOK_PUBLIC_PATH || typeof query !== 'string' || typeof b64 !== 'string')
    return null;
  if (!isPlainObject(headers)) return null;
  const kept: Record<string, string> = {};
  for (const name of WEBHOOK_HEADERS) {
    const v = headers[name];
    if (v === undefined) continue;
    if (typeof v !== 'string') return null;
    kept[name] = v;
  }
  // Base64 of the cap is a third larger; anything past that is not a delivery Dina reads.
  if (b64.length > Math.ceil(WEBHOOK_MAX_BYTES / 3) * 4) return null;
  const body = base64Decode(b64);
  if (body === null) return null;
  return { envelope: { path, query, headers: kept, body_b64: b64 }, body };
}

// ------------------------------------------------------------ the store

interface InboxRow {
  id: string;
  merchant_origin: string;
  webhook_id: string;
  order_id: string;
  checkout_id: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: Uint8Array;
  attempts: number;
  received_at: number;
}

/** Stored headers read back: only the webhook's own, each a string; null when they do not read. */
function storedHeaders(text: string): Record<string, string> | null {
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.value)) {
    if (!(WEBHOOK_HEADERS as readonly string[]).includes(name) || typeof value !== 'string')
      return null;
    out[name] = value;
  }
  return out;
}

/** An inbox row; null when its stored headers do not read (it is then dropped, never verified half-read). */
function inboxRow(r: DBRow): InboxRow | null {
  const raw = r.body;
  const headers = storedHeaders(String(r.headers_json));
  if (headers === null) return null;
  return {
    id: String(r.id),
    merchant_origin: String(r.merchant_origin),
    webhook_id: String(r.webhook_id),
    order_id: String(r.order_id),
    checkout_id: String(r.checkout_id),
    path: String(r.path),
    query: String(r.query),
    headers,
    body: raw instanceof Uint8Array ? raw : new Uint8Array(raw as unknown as ArrayBuffer),
    attempts: Number(r.attempts),
    received_at: Number(r.received_at),
  };
}

export class UcpWebhookStore {
  constructor(private readonly db: DatabaseAdapter) {}

  transaction(fn: () => void): void {
    this.db.transaction(fn);
  }

  insert(row: Omit<InboxRow, 'attempts'>): void {
    this.db.run(
      `INSERT INTO ucp_webhook_inbox (id, merchant_origin, webhook_id, order_id, checkout_id, path,
         query, headers_json, body, next_try_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.merchant_origin,
        row.webhook_id,
        row.order_id,
        row.checkout_id,
        row.path,
        row.query,
        JSON.stringify(row.headers),
        row.body,
        row.received_at,
        row.received_at,
      ],
    );
  }

  due(now: number, limit: number): InboxRow[] {
    return this.db
      .query(
        `SELECT * FROM ucp_webhook_inbox WHERE next_try_at <= ? ORDER BY received_at LIMIT ?`,
        [now, limit],
      )
      .flatMap((r) => {
        const row = inboxRow(r as DBRow);
        // A row whose headers no longer read is dropped: it can never be verified.
        if (row === null) this.delete(String((r as DBRow).id));
        return row === null ? [] : [row];
      });
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM ucp_webhook_inbox WHERE id = ?`, [id]);
  }

  retryAt(id: string, at: number): void {
    this.db.run(
      `UPDATE ucp_webhook_inbox SET attempts = attempts + 1, next_try_at = ? WHERE id = ?`,
      [at, id],
    );
  }

  /** Record a verified delivery's id; false when it was recorded already (a repeat). */
  markSeen(origin: string, webhookId: string, now: number): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO ucp_webhook_seen (merchant_origin, webhook_id, seen_at) VALUES (?, ?, ?)`,
        [origin, webhookId, now],
      ) > 0
    );
  }

  pruneSeen(before: number): void {
    this.db.run(`DELETE FROM ucp_webhook_seen WHERE seen_at < ?`, [before]);
  }

  inboxSize(): number {
    return Number(this.db.query(`SELECT COUNT(*) AS n FROM ucp_webhook_inbox`)[0]?.n ?? 0);
  }
}

// ------------------------------------------------------------ the service

export interface WebhookServiceDeps {
  store: UcpWebhookStore;
  checkouts: UcpCheckoutStore;
  orders: UcpOrderStore;
  orderService: Pick<UcpOrderService, 'absorbPushed'>;
  client: Pick<UcpMerchantClient, 'open' | 'notReady'>;
  nowMs: () => number;
  newId: () => string;
  /** The URL this node lists; null when it takes no webhooks now. */
  webhookUrl: () => string | null;
  /** A session a signed order completed: its order to follow. Runs in the completion's transaction. */
  onCompleted?: (row: CheckoutRow, now: number) => void;
}

/** Session states a signed order settles: any not already ended, from a live session to one the watcher gave up on. */
const SETTLES_FROM_ORDER: readonly CheckoutState[] = [
  'open',
  'unsettled',
  'handed_off',
  'not_completed',
  'unknown',
];

/** The answer the gateway relays: 200 with the version, whatever became of the delivery. */
export interface WebhookAnswer {
  status: 200;
  body: { ucp: { version: string } };
}

type Lookup =
  | { kind: 'order'; key: OrderKey; version: string }
  | { kind: 'session'; sessionId: string; version: string };

export class UcpWebhookService {
  constructor(private readonly deps: WebhookServiceDeps) {}

  /**
   * Take a delivery from the gateway: stored in the inbox when it concerns a
   * session or order Dina holds, dropped unfetched otherwise. Throws only
   * when the store fails, which the route answers with a 503.
   */
  accept(value: unknown): WebhookAnswer {
    const answer = (version: string): WebhookAnswer => ({
      status: 200,
      body: { ucp: { version } },
    });
    if (this.deps.webhookUrl() === null) return answer(UCP_VERSION);
    const read = readEnvelope(value);
    if (read === null) return answer(UCP_VERSION);
    const delivery = readWebhookDelivery(read.envelope.headers, read.body);
    if (!delivery.ok) return answer(UCP_VERSION);
    const d = delivery.delivery;
    const found = this.lookup(d.origin, d.orderId, d.checkoutId);
    if (found === null) return answer(UCP_VERSION);
    const now = this.deps.nowMs();
    this.deps.store.insert({
      id: this.deps.newId(),
      merchant_origin: d.origin,
      webhook_id: d.webhookId,
      order_id: d.orderId,
      checkout_id: d.checkoutId,
      path: read.envelope.path,
      query: read.envelope.query,
      headers: read.envelope.headers,
      body: read.body,
      received_at: now,
    });
    return answer(found.version);
  }

  /**
   * What a delivery is about, under the origin its sender names: the order,
   * else the session its checkout id names; null when Dina holds neither, or
   * when both are held and name different sessions.
   */
  private lookup(origin: string, orderId: string, checkoutId: string): Lookup | null {
    const order = this.deps.orders.get({ merchant_origin: origin, order_id: orderId });
    const session = this.deps.checkouts.byMerchantCheckout(origin, checkoutId);
    if (order !== null) {
      if (session !== null && order.session_id !== null && order.session_id !== session.session_id)
        return null;
      if (order.checkout_id !== checkoutId) return null;
      return { kind: 'order', key: order, version: order.version };
    }
    if (session === null) return null;
    return { kind: 'session', sessionId: session.session_id, version: session.version };
  }

  /** Verify and apply every inbox delivery that is due; prune remembered ids. */
  async sweep(): Promise<void> {
    if (this.deps.client.notReady() !== null) return;
    const now = this.deps.nowMs();
    this.deps.store.pruneSeen(now - WEBHOOK_SEEN_KEEP_MS);
    for (const row of this.deps.store.due(now, SWEEP_LIMIT)) {
      try {
        await this.process(row);
      } catch {
        this.retry(row);
      }
    }
  }

  private async process(row: InboxRow): Promise<void> {
    const { store } = this.deps;
    const url = this.deps.webhookUrl();
    const found = this.lookup(row.merchant_origin, row.order_id, row.checkout_id);
    // Webhooks turned off since, or the resource gone: nothing to verify it for.
    if (url === null || found === null) {
      store.delete(row.id);
      return;
    }
    const opened = await this.deps.client.open(row.merchant_origin);
    if (!opened.ok) {
      this.retry(row);
      return;
    }
    const target = new URL(url);
    const msg: HttpMessage = {
      method: 'POST',
      url: `${target.origin}${row.path}${row.query === '' ? '' : `?${row.query}`}`,
      headers: row.headers,
      body: row.body,
    };
    const verified = await opened.connection.verifyWebhook(msg);
    if (!verified.ok) {
      // An unknown key may be a rotation not yet readable (the profile is re-read at most
      // once a minute): try again later. Every other failure is final, and records nothing.
      if (verified.reason === 'key_not_found') this.retry(row);
      else store.delete(row.id);
      return;
    }
    // The body as strict JSON (verified bytes, read once): what a webhook-only order keeps.
    const body = jsonOrUndefined(row.body);
    const order = readOrder(body);
    const now = this.deps.nowMs();
    store.transaction(() => {
      if (store.markSeen(row.merchant_origin, row.webhook_id, now))
        this.prompt(found, order, body, row);
      store.delete(row.id);
    });
  }

  /** The delivery's resource, prompted (in the caller's transaction). */
  private prompt(
    found: Lookup,
    order: ReturnType<typeof readOrder>,
    body: unknown,
    row: InboxRow,
  ): void {
    const now = this.deps.nowMs();
    if (found.kind === 'session') {
      // A signed order for this checkout is the merchant's word that it completed (§3.12): the
      // session settles at once, whatever a Get Checkout could still say (or may not be asked).
      if (
        order.ok &&
        order.value.id === row.order_id &&
        order.value.checkoutId === row.checkout_id
      ) {
        this.deps.checkouts.completeCheckout(
          found.sessionId,
          SETTLES_FROM_ORDER,
          { id: order.value.id, permalinkUrl: order.value.permalinkUrl },
          now,
          (done) => this.deps.onCompleted?.(done, now),
        );
        // The order it opened keeps this body until its first poll settles it (§3.13).
        this.deps.orders.holdPushed(
          { merchant_origin: row.merchant_origin, order_id: order.value.id },
          order.value,
          body,
          now,
        );
        return;
      }
      this.deps.checkouts.promptWatch(found.sessionId, now);
      return;
    }
    const held = this.deps.orders.get(found.key);
    if (held === null) return;
    if (held.state === 'open') {
      // Kept until a poll settles it: used if the merchant turns out not to share the order.
      if (order.ok && order.value.id === row.order_id)
        this.deps.orders.holdPushed(found.key, order.value, body, now);
      this.deps.orders.requestPoll(found.key, now);
      return;
    }
    // Webhook-only or closed: the body is all Dina gets. One it cannot read adds nothing.
    if (!order.ok || order.value.id !== row.order_id) return;
    // Another reconciler holds the order: abort, and the delivery is tried again.
    if (!this.deps.orderService.absorbPushed(found.key, order.value, body))
      throw new Error('order_busy');
  }

  private retry(row: InboxRow): void {
    const now = this.deps.nowMs();
    if (now - row.received_at >= WEBHOOK_RETRY_FOR_MS) {
      this.deps.store.delete(row.id);
      return;
    }
    const wait = Math.min(FIRST_RETRY_MS * 2 ** row.attempts, MAX_RETRY_MS);
    this.deps.store.retryAt(row.id, now + wait);
  }
}
