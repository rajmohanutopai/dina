/**
 * The gateway's only way into Core: signed POSTs to the ingress routes and
 * a signed GET of the public card (design §4.3, §5.1). Every request carries
 * the four canonical-signing headers under the gateway's own service key.
 *
 * Core's answer is relayed to the client only when Core's ingress handler
 * wrote it, which it marks with `A2A_CORE_ANSWER_HEADER`. Anything else
 * (Core refusing the gateway itself, a Core-wide limit, a Core error, a
 * timeout) is not the client's business: the client sees 503 and the
 * operator sees the status in the log.
 *
 * It also carries the delivery loop's two calls (design §7.5): claim the
 * task events due for the gateway's streams and webhooks, and report what
 * became of each.
 */

import {
  A2A_CORE_ANSWER_HEADER,
  A2A_CREDENTIAL_GEN_HEADER,
  A2A_EVENTS_ACK_ROUTE,
  A2A_EVENTS_CLAIM_ROUTE,
  A2A_EVENT_SEQ_HEADER,
  A2A_SEND_WAIT_MS,
  A2A_STREAM_CLIENT_HEADER,
  ingressRouteOf,
  isStreamClientKey,
  parseDeliveryClaim,
  type DeliveryAck,
  type DeliveryClaim,
} from '@dina/a2a';
import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import {
  UCP_OAUTH_CALLBACK_WAIT_MS,
  UCP_OAUTH_INGRESS_ROUTE,
  UCP_WEBHOOK_INGRESS_ROUTE,
  UCP_WEBHOOK_STORE_WAIT_MS,
} from '@dina/core';

import type { GatewayServiceKey } from './service_key';
import type { GatewayEnvelope, UcpWebhookEnvelope } from '@dina/core';

export interface CoreAnswer {
  status: number;
  /** Headers the client may see. */
  headers: Record<string, string>;
  body: unknown;
  /** On a streaming answer: the last task event the answered Task reflects (never relayed). */
  eventSeq?: number;
  /** On a streaming answer: the client's credential generation the call was authenticated under (never relayed). */
  credentialGen?: number;
  /** On a streaming answer: the opaque key of the client the stream belongs to (never relayed). */
  streamClient?: string;
}

export type CoreReply = { ok: true; answer: CoreAnswer } | { ok: false; status: number | 'unreachable' };

export interface CoreLink {
  /** Forward one client call to its internal route. */
  forward(path: string, envelope: GatewayEnvelope): Promise<CoreReply>;
  /** Read the signed public card and the JWK Set its `jku` names. */
  card(): Promise<{ ok: true; card: unknown; jwks: unknown } | { ok: false; status: number | 'unreachable' }>;
  /** Claim due task events: at most `limit`, of which at most `webhookLimit` webhook POSTs. */
  claimEvents(limit: number, webhookLimit: number): Promise<{ ok: true; claim: DeliveryClaim } | { ok: false; status: number | 'unreachable' }>;
  /**
   * Hand a UCP order webhook to Core (UCP plan §3.13). Core answers within
   * `UCP_WEBHOOK_STORE_WAIT_MS` or the merchant is told 503 and retries.
   */
  ucpWebhook(envelope: UcpWebhookEnvelope): Promise<CoreReply>;
  /**
   * Hand an OAuth callback's parameters to Core (UCP plan §3.17), which
   * exchanges the code: up to `UCP_OAUTH_CALLBACK_WAIT_MS`.
   */
  ucpOauthCallback(params: Readonly<Record<string, string>>): Promise<CoreReply>;
  /** Report claimed events; resolves to how many Core applied. */
  ackEvents(acks: readonly DeliveryAck[]): Promise<{ ok: true; applied: number } | { ok: false; status: number | 'unreachable' }>;
}

/** Headers of Core's answer the client may see. */
const RELAYED_HEADERS = ['www-authenticate', 'retry-after'] as const;

function decode(body: Uint8Array): unknown {
  if (body.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

/** A header Core sets to a count (0, 1, …), or undefined when it is absent or anything else. */
function counter(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Whether Core's ingress handler wrote this answer for the client. */
export function isClientAnswer(headers: Record<string, string>): boolean {
  return headers[A2A_CORE_ANSWER_HEADER] === '1';
}

/** How much longer than Core's wait the gateway gives a `SendMessage` forward: Core answers inside it. */
export const SEND_WAIT_MARGIN_MS = 5_000;

export function createCoreLink(options: { baseUrl: string; key: GatewayServiceKey; timeoutMs: number }): CoreLink {
  const crypto = new Crypto();
  const http = new HttpClient({ timeoutMs: options.timeoutMs });
  // Core holds a SendMessage that did not ask to return at once for up to
  // A2A_SEND_WAIT_MS, so its forward may take that long whatever the
  // timeout set for every other call.
  const sendRoute = ingressRouteOf('SendMessage');
  const waiting = new HttpClient({ timeoutMs: Math.max(options.timeoutMs, A2A_SEND_WAIT_MS + SEND_WAIT_MARGIN_MS) });
  // A webhook is stored or refused quickly: past this, the merchant is better off retrying.
  const storing = new HttpClient({ timeoutMs: Math.min(options.timeoutMs, UCP_WEBHOOK_STORE_WAIT_MS) });
  // A callback waits for Core's one code exchange with the merchant.
  const exchanging = new HttpClient({ timeoutMs: Math.max(options.timeoutMs, UCP_OAUTH_CALLBACK_WAIT_MS) });
  const sign = createCanonicalRequestSigner({
    did: options.key.did,
    privateKey: options.key.seed,
    sign: (privateKey, message) => crypto.ed25519Sign(privateKey, message),
    nonce: (n) => crypto.randomBytes(n),
  });
  const base = options.baseUrl.replace(/\/+$/, '');

  async function send(method: 'GET' | 'POST', path: string, body?: unknown, client: HttpClient = http) {
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const signed = await sign({ method, path, query: '', body: bytes });
    const headers: Record<string, string> = {
      'x-did': signed.did,
      'x-timestamp': signed.timestamp,
      'x-nonce': signed.nonce,
      'x-signature': signed.signature,
    };
    if (bytes.byteLength > 0) headers['content-type'] = 'application/json';
    return client.request(`${base}${path}`, { method, headers, ...(bytes.byteLength > 0 ? { body: bytes } : {}) });
  }

  return {
    async forward(path, envelope) {
      let res;
      try {
        res = await send('POST', path, envelope, path === sendRoute ? waiting : http);
      } catch {
        return { ok: false, status: 'unreachable' };
      }
      if (!isClientAnswer(res.headers)) return { ok: false, status: res.status };
      const body = decode(res.body);
      const headers: Record<string, string> = {};
      for (const name of RELAYED_HEADERS) {
        const value = res.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      const seq = counter(res.headers[A2A_EVENT_SEQ_HEADER]);
      const gen = counter(res.headers[A2A_CREDENTIAL_GEN_HEADER]);
      const client = res.headers[A2A_STREAM_CLIENT_HEADER];
      return {
        ok: true,
        answer: {
          status: res.status,
          headers,
          body,
          ...(seq === undefined ? {} : { eventSeq: seq }),
          ...(gen === undefined ? {} : { credentialGen: gen }),
          ...(isStreamClientKey(client) ? { streamClient: client } : {}),
        },
      };
    },
    async card() {
      let res;
      try {
        res = await send('GET', '/v1/a2a/card');
      } catch {
        return { ok: false, status: 'unreachable' };
      }
      const body = decode(res.body) as { card?: unknown; jwks?: unknown } | undefined;
      if (res.status !== 200 || body?.card === undefined || body.jwks === undefined) return { ok: false, status: res.status };
      return { ok: true, card: body.card, jwks: body.jwks };
    },
    async ucpWebhook(envelope) {
      let res;
      try {
        res = await send('POST', UCP_WEBHOOK_INGRESS_ROUTE, envelope, storing);
      } catch {
        return { ok: false, status: 'unreachable' };
      }
      if (!isClientAnswer(res.headers)) return { ok: false, status: res.status };
      return { ok: true, answer: { status: res.status, headers: {}, body: decode(res.body) } };
    },
    async ucpOauthCallback(params) {
      let res;
      try {
        res = await send('POST', UCP_OAUTH_INGRESS_ROUTE, params, exchanging);
      } catch {
        return { ok: false, status: 'unreachable' };
      }
      if (!isClientAnswer(res.headers)) return { ok: false, status: res.status };
      return { ok: true, answer: { status: res.status, headers: {}, body: decode(res.body) } };
    },
    async claimEvents(limit, webhookLimit) {
      let res;
      try {
        res = await send('POST', A2A_EVENTS_CLAIM_ROUTE, { limit, webhook_limit: webhookLimit });
      } catch {
        return { ok: false, status: 'unreachable' };
      }
      const claim = res.status === 200 ? parseDeliveryClaim(decode(res.body)) : null;
      return claim === null ? { ok: false, status: res.status } : { ok: true, claim };
    },
    async ackEvents(acks) {
      let res;
      try {
        res = await send('POST', A2A_EVENTS_ACK_ROUTE, { acks });
      } catch {
        return { ok: false, status: 'unreachable' };
      }
      const body = decode(res.body) as { applied?: unknown } | undefined;
      return res.status === 200 && typeof body?.applied === 'number'
        ? { ok: true, applied: body.applied }
        : { ok: false, status: res.status };
    },
  };
}
