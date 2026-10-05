/**
 * The mock UCP merchant (UCP plan §3.19 step 2): a real HTTPS server, on
 * loopback with a test certificate, that serves a v2026-08-25 business
 * profile and the catalogue over REST and MCP, as a live merchant would.
 * Dina's real merchant client reaches it through its real Node policy
 * socket (a test resolver and CA let the socket connect to loopback).
 *
 * What it holds a client to, as live merchants do:
 *  - The agent's profile, on every call (MCP: `meta.ucp-agent.profile`;
 *    REST: the `UCP-Agent` header's `profile`). With `fetchProfile` given,
 *    the merchant fetches it and negotiates, answering the spec's
 *    negotiation errors (overview, "Error Codes") with their HTTP status and,
 *    over MCP, JSON-RPC `-32001` carrying the UCP code: a missing or bad URL
 *    (`invalid_profile_url`, 400), a failed fetch (`profile_unreachable`,
 *    424), a body that is not a profile (`profile_malformed`, 422), another
 *    version (`version_unsupported`, 422), and no shared capability for the
 *    call (`capabilities_incompatible`, a UCP answer).
 *  - MCP (Streamable HTTP, 2025-11-25): `initialize` first, answered with
 *    `serverInfo` and the client's version when it is one this server speaks;
 *    a session id required on every later call; an ended session answered
 *    404; `notifications/initialized` answered 202; a tool result carrying
 *    both `structuredContent` and its JSON as `content` text; with `sse`, every
 *    answer sent as a server-sent event, split across writes.
 *  - REST: the OpenAPI paths under the endpoint.
 * Every catalogue operation is recorded (`requests`), and every MCP post
 * (`mcpLog`), so a test can see exactly what Dina sent. Checkout, carts,
 * signing and webhooks come with U2 and U3.
 */

import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import * as https from 'node:https';

import { MockAuthServer, type MockAuthOptions } from './auth_server';
import { UCP_VERSION, type MockProduct } from './catalog';
import {
  CAPABILITY,
  MockMerchantLogic,
  sha256Hex,
  type MerchantAnswer,
  type MerchantCall,
  type MerchantOperation,
  type MockMerchantState,
} from './merchant';
import { orderAnswer } from './orders';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const RELEASE_SCHEMAS = `https://ucp.dev/${UCP_VERSION}/schemas/`;
/** REST routes under the endpoint (the OpenAPI paths), and the operation each is. */
const ROUTES: { method: string; path: RegExp; operation: MerchantOperation }[] = [
  { method: 'POST', path: /^\/catalog\/search$/, operation: 'search_catalog' },
  { method: 'POST', path: /^\/catalog\/lookup$/, operation: 'lookup_catalog' },
  { method: 'POST', path: /^\/catalog\/product$/, operation: 'get_product' },
  { method: 'POST', path: /^\/carts$/, operation: 'create_cart' },
  { method: 'GET', path: /^\/carts\/([^/]+)$/, operation: 'get_cart' },
  { method: 'PUT', path: /^\/carts\/([^/]+)$/, operation: 'update_cart' },
  { method: 'POST', path: /^\/carts\/([^/]+)\/cancel$/, operation: 'cancel_cart' },
  { method: 'POST', path: /^\/checkout-sessions$/, operation: 'create_checkout' },
  { method: 'GET', path: /^\/checkout-sessions\/([^/]+)$/, operation: 'get_checkout' },
  { method: 'PUT', path: /^\/checkout-sessions\/([^/]+)$/, operation: 'update_checkout' },
  {
    method: 'POST',
    path: /^\/checkout-sessions\/([^/]+)\/cancel$/,
    operation: 'cancel_checkout',
  },
  { method: 'GET', path: /^\/orders\/([^/]+)$/, operation: 'get_order' },
];
/** The argument an operation's payload rides in, over MCP. */
const PAYLOAD_ARG: Partial<Record<MerchantOperation, string>> = {
  search_catalog: 'catalog',
  lookup_catalog: 'catalog',
  get_product: 'catalog',
  create_cart: 'cart',
  update_cart: 'cart',
  create_checkout: 'checkout',
  update_checkout: 'checkout',
};
/** MCP versions this server speaks, newest first. */
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

export interface MockMerchantOptions {
  /** The host name the certificate covers; the merchant's origin is `https://<host>:<port>`. */
  host: string;
  cert: string;
  key: string;
  products: () => readonly MockProduct[];
  /** The transports the profile offers, in its order. Default: MCP only, as Shopify. */
  transports?: readonly ('mcp' | 'rest')[];
  /** Leave the lookup capability out of the profile (then lookup and get_product are not offered). */
  withoutLookup?: boolean;
  /**
   * Fetch the agent's profile, as a merchant does: the HTTP status and body,
   * or null when it cannot be reached. Without it only the URL's presence
   * and form are checked.
   */
  fetchProfile?: (url: string) => Promise<{ status: number; body: string } | null>;
  /** Answer every MCP message as a server-sent event. */
  sse?: boolean;
  /**
   * Sign every answer (RFC 9421: `@status`, and `content-digest content-type`
   * with a body), with a key the profile lists (`listed`) or one it does not
   * (`unlisted`, as a merchant whose profile lags its key). Built with Node's
   * own crypto and a hand-written signature base, not Dina's code.
   */
  signAnswers?: 'listed' | 'unlisted';
  /** Offer carts (`dev.ucp.shopping.cart`). */
  carts?: boolean;
  /** Offer checkout sessions (`dev.ucp.shopping.checkout`). */
  checkouts?: boolean;
  /** A variant the merchant cannot sell now; see `MockMerchantState.outOfStock`. */
  outOfStock?: MockMerchantState['outOfStock'];
  /**
   * Accept an agent profile URL over plain http (the official conformance suite serves its
   * test agent's profile on localhost). Never in a test of Dina, which only sends https.
   */
  acceptHttpProfile?: boolean;
  /** The MCP endpoint's path the profile names (it may change between calls, as a profile does). */
  mcpPath?: () => string;
  /** More public keys the profile lists (a key rotation, say). */
  extraKeys?: () => readonly Record<string, unknown>[];
  /** List the signing key, so this merchant can sign order webhooks (`MockMerchant.webhook`). */
  signWebhooks?: boolean;
  /** List the second key too, from now on (a key rotation the merchant publishes). */
  listSecondKey?: () => boolean;
  /** Offer pickup on checkout sessions; see `MockMerchantState.pickup`. */
  pickup?: boolean;
  /** Offer identity linking (`dev.ucp.common.identity_linking`) with this authorization server. */
  auth?: Omit<MockAuthOptions, 'now'>;
  /** Offer orders (`dev.ucp.shopping.order`): Get Order on a completed checkout's order. */
  orders?: boolean;
  orderSharing?: MockMerchantState['orderSharing'];
  endedAsIs?: MockMerchantState['endedAsIs'];
  /** Offer shipping to a given address; see `MockMerchantState.shipping`. */
  shipping?: boolean;
  emptyPayment?: boolean;
  checkoutMessages?: MockMerchantState['checkoutMessages'];
  continueUrl?: MockMerchantState['continueUrl'];
  /** Advertise `dev.ucp.shopping.permalink` with this path on the merchant's origin as its endpoint. */
  permalinkPath?: string;
  /** The merchant's clock (key expiry, cart expiry). Default: Date.now. */
  now?: () => number;
  /** How long a cart lives. Default: 30 minutes. */
  cartTtlMs?: number;
  /**
   * Do the work, then drop the connection without answering (an answer lost
   * on the way back), when this returns true for the call.
   */
  dropAnswer?: (operation: MerchantOperation) => boolean;
  /** Hold a state change while it runs (a slow merchant); see `MockMerchantState.hold`. */
  hold?: MockMerchantState['hold'];
  extraTotals?: MockMerchantState['extraTotals'];
  refuse?: MockMerchantState['refuse'];
}

export interface MockMerchantRequest {
  transport: 'mcp' | 'rest';
  operation: string;
  /** The agent's profile URL, as the call named it. */
  agent: string | null;
  payload: Record<string, unknown>;
}

/** One MCP post: what came in and what went back. */
export interface McpExchange {
  method: string;
  session: string | null;
  id: unknown;
  rawBody: string;
  status: number;
}

export interface MockMerchant {
  origin: string;
  /** Every catalogue operation asked, in order (answered or refused). */
  requests: MockMerchantRequest[];
  /** Every MCP post, in order. */
  mcpLog: McpExchange[];
  /** The shop itself: its carts, and what actually ran. */
  logic: MockMerchantLogic;
  /** End every MCP session; a call on one is answered 404. */
  endSessions(): void;
  /**
   * An order webhook as this merchant sends one (order/index.md "Events"): the
   * order as it stands, or `body`, signed over method, authority, path and the
   * body pair with its listed key (or another `key`), to `target`.
   */
  webhook(target: string, orderId: string, options?: MockWebhookOptions): MockWebhook;
  /** The merchant's authorization server, when it offers identity linking. */
  auth: MockAuthServer | null;
  close(): Promise<void>;
}

export interface MockWebhookOptions {
  webhookId?: string;
  /** Unix seconds. */
  timestamp?: number;
  /** The body sent; default the order as Get Order would answer it. */
  body?: Record<string, unknown>;
  /** Sign with the listed key (default), a key the profile does not list, or not at all. */
  key?: 'listed' | 'unlisted' | 'none';
  /** The `UCP-Agent` profile URL; default this merchant's root profile. */
  agent?: string;
  /** Change the body after signing (the digest then fails). */
  tamper?: boolean;
}

export interface MockWebhook {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

type Negotiation = { ok: true } | { ok: false; code: string; status: number; content: string };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The `profile` member of a `UCP-Agent` header (an RFC 8941 dictionary). */
function agentFromHeader(header: string | undefined): string | null {
  const m = header === undefined ? null : /(?:^|[;,\s])profile="([^"\\]*)"/.exec(header);
  return m === null ? null : (m[1] ?? null);
}

/** The answer to a call whose capability the agent's profile does not share. */
const incompatible = (content: string) => ({
  ucp: { version: UCP_VERSION, status: 'error' },
  messages: [
    { type: 'error', code: 'capabilities_incompatible', content, severity: 'unrecoverable' },
  ],
});

export async function startMockMerchant(options: MockMerchantOptions): Promise<MockMerchant> {
  const transports = options.transports ?? ['mcp'];
  const mcpPath = options.mcpPath ?? (() => '/ucp/mcp');
  const requests: MockMerchantRequest[] = [];
  const mcpLog: McpExchange[] = [];
  const sessions = new Set<string>();
  const now = options.now ?? Date.now;
  let origin = '';
  const auth =
    options.auth === undefined ? null : new MockAuthServer({ ...options.auth, now }, () => origin);
  const logic = new MockMerchantLogic({
    products: options.products,
    now: options.now ?? Date.now,
    cartTtlMs: options.cartTtlMs ?? 30 * 60_000,
    origin: () => origin,
    ...(options.outOfStock !== undefined ? { outOfStock: options.outOfStock } : {}),
    ...(options.pickup !== undefined ? { pickup: options.pickup } : {}),
    ...(options.shipping !== undefined ? { shipping: options.shipping } : {}),
    ...(options.orderSharing !== undefined ? { orderSharing: options.orderSharing } : {}),
    ...(options.endedAsIs !== undefined ? { endedAsIs: options.endedAsIs } : {}),
    // A merchant offering identity linking gates the scopes it lists behind a linked account.
    authorize: (call: MerchantCall, scope: string) => {
      if (auth === null || !options.auth?.scopes.includes(scope)) return undefined;
      const v = auth.authorized(call.authorization ?? undefined, scope);
      if (v === 'ok') return undefined;
      return {
        kind: 'refusal' as const,
        status: v === 'insufficient' ? 403 : 401,
        code: v === 'insufficient' ? 'insufficient_scope' : 'identity_required',
        content: 'Link your account to do this.',
        challenge: auth.challenge(v, scope),
      };
    },
    ...(options.emptyPayment !== undefined ? { emptyPayment: options.emptyPayment } : {}),
    ...(options.checkoutMessages !== undefined
      ? { checkoutMessages: options.checkoutMessages }
      : {}),
    ...(options.continueUrl !== undefined ? { continueUrl: options.continueUrl } : {}),
    ...(options.hold !== undefined ? { hold: options.hold } : {}),
    ...(options.extraTotals !== undefined ? { extraTotals: options.extraTotals } : {}),
    ...(options.refuse !== undefined ? { refuse: options.refuse } : {}),
  });
  const offered = (operation: MerchantOperation): boolean =>
    operation === 'search_catalog' ||
    (CAPABILITY[operation] === 'dev.ucp.shopping.catalog.lookup' &&
      options.withoutLookup !== true) ||
    (CAPABILITY[operation] === 'dev.ucp.shopping.cart' && options.carts === true) ||
    (CAPABILITY[operation] === 'dev.ucp.shopping.checkout' && options.checkouts === true) ||
    (CAPABILITY[operation] === 'dev.ucp.shopping.order' && options.orders === true);
  const signingKey = (kid: string) => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
      kid,
      privateKey: pair.privateKey,
      jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' },
    };
  };
  const listedKey = signingKey('mock-key-1');
  const unlistedKey = signingKey('mock-key-2');
  const answerKey: { kid: string; privateKey: KeyObject } | null =
    options.signAnswers === 'listed'
      ? listedKey
      : options.signAnswers === 'unlisted'
        ? unlistedKey
        : null;

  /** The signature headers for an answer, as a merchant signs one. */
  const answerSignature = (
    status: number,
    bytes: Buffer,
    contentType: string | null,
  ): Record<string, string> => {
    if (answerKey === null) return {};
    const covered =
      bytes.length > 0 && contentType !== null
        ? ['@status', 'content-digest', 'content-type']
        : ['@status'];
    const digest = `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
    const params = `(${covered.map((c) => `"${c}"`).join(' ')});keyid="${answerKey.kid}"`;
    const lines = covered.map((c) =>
      c === '@status'
        ? `"@status": ${status}`
        : c === 'content-digest'
          ? `"content-digest": ${digest}`
          : `"content-type": ${contentType}`,
    );
    const base = [...lines, `"@signature-params": ${params}`].join('\n');
    const signature = sign('sha256', Buffer.from(base), {
      key: answerKey.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return {
      ...(covered.includes('content-digest') ? { 'content-digest': digest } : {}),
      'signature-input': `sig1=${params}`,
      signature: `sig1=:${signature.toString('base64')}:`,
    };
  };

  /** A signed order webhook to `target` (RFC 9421, the way the spec's example signs one). */
  const webhook = (target: string, orderId: string, w: MockWebhookOptions = {}): MockWebhook => {
    const order = logic.orders.get(orderId);
    const body = Buffer.from(
      JSON.stringify(w.body ?? (order === undefined ? {} : orderAnswer(order, origin))),
    );
    const url = new URL(target);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'ucp-agent': `profile="${w.agent ?? `${origin}/.well-known/ucp`}"`,
      'webhook-id': w.webhookId ?? `evt_${randomUUID().slice(0, 8)}`,
      'webhook-timestamp': String(w.timestamp ?? Math.floor(now() / 1000)),
      'content-digest': `sha-256=:${createHash('sha256').update(body).digest('base64')}:`,
    };
    if (w.key !== 'none') {
      const key = w.key === 'unlisted' ? unlistedKey : listedKey;
      const covered = ['@method', '@authority', '@path', 'content-digest', 'content-type'];
      const params = `(${covered.map((c) => `"${c}"`).join(' ')});keyid="${key.kid}"`;
      const value = (c: string): string =>
        c === '@method'
          ? 'POST'
          : c === '@authority'
            ? url.host
            : c === '@path'
              ? url.pathname
              : (headers[c] as string);
      const base = [
        ...covered.map((c) => `"${c}": ${value(c)}`),
        `"@signature-params": ${params}`,
      ].join('\n');
      const signature = sign('sha256', Buffer.from(base), {
        key: key.privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      headers['signature-input'] = `sig1=${params}`;
      headers.signature = `sig1=:${signature.toString('base64')}:`;
    }
    return { url: target, headers, body: w.tamper === true ? Buffer.from(`${body} `) : body };
  };

  const profile = () => ({
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': transports.map((t) => ({
          version: UCP_VERSION,
          transport: t,
          endpoint: t === 'mcp' ? `${origin}${mcpPath()}` : `${origin}/ucp/${t}`,
        })),
      },
      capabilities: {
        'dev.ucp.shopping.catalog.search': [
          { version: UCP_VERSION, schema: `${RELEASE_SCHEMAS}shopping/catalog_search.json` },
        ],
        ...(options.withoutLookup === true
          ? {}
          : {
              'dev.ucp.shopping.catalog.lookup': [
                { version: UCP_VERSION, schema: `${RELEASE_SCHEMAS}shopping/catalog_lookup.json` },
              ],
            }),
        ...(options.carts === true
          ? {
              'dev.ucp.shopping.cart': [
                { version: UCP_VERSION, schema: `${RELEASE_SCHEMAS}shopping/cart.json` },
              ],
            }
          : {}),
        ...(options.checkouts === true
          ? {
              'dev.ucp.shopping.checkout': [
                { version: UCP_VERSION, schema: `${RELEASE_SCHEMAS}shopping/checkout.json` },
              ],
            }
          : {}),
        ...(auth !== null
          ? {
              'dev.ucp.common.identity_linking': [
                {
                  version: UCP_VERSION,
                  schema: `${RELEASE_SCHEMAS}common/identity_linking.json`,
                  config: auth.configFor(),
                },
              ],
            }
          : {}),
        ...(options.orders === true
          ? {
              'dev.ucp.shopping.order': [
                { version: UCP_VERSION, schema: `${RELEASE_SCHEMAS}shopping/order.json` },
              ],
            }
          : {}),
        ...(options.permalinkPath !== undefined
          ? {
              'dev.ucp.shopping.permalink': [
                {
                  version: UCP_VERSION,
                  schema: `${RELEASE_SCHEMAS}shopping/permalink.json`,
                  config: { endpoint: `${origin}${options.permalinkPath}` },
                },
              ],
            }
          : {}),
      },
      payment_handlers: {},
    },
    ...(options.signAnswers !== undefined ||
    options.extraKeys !== undefined ||
    options.signWebhooks === true
      ? {
          keys: [
            ...(options.signAnswers !== undefined || options.signWebhooks === true
              ? [listedKey.jwk]
              : []),
            ...(options.listSecondKey?.() === true ? [unlistedKey.jwk] : []),
            ...(options.extraKeys?.() ?? []),
          ],
        }
      : {}),
  });

  /** Resolve the agent's profile and negotiate with it, for one operation. */
  const negotiate = async (
    agent: string | null,
    operation: MerchantOperation,
  ): Promise<Negotiation> => {
    let url: URL | null = null;
    try {
      url = agent === null ? null : new URL(agent);
    } catch {
      url = null;
    }
    if (
      url === null ||
      (url.protocol !== 'https:' &&
        !(options.acceptHttpProfile === true && url.protocol === 'http:'))
    )
      return {
        ok: false,
        code: 'invalid_profile_url',
        status: 400,
        content: 'The agent profile URL is missing or not https.',
      };
    if (options.fetchProfile === undefined) return { ok: true };
    const fetched = await options.fetchProfile(url.href).catch(() => null);
    if (fetched === null || fetched.status < 200 || fetched.status > 299)
      return {
        ok: false,
        code: 'profile_unreachable',
        status: 424,
        content: 'Unable to fetch the agent profile.',
      };
    const ucp = parse(fetched.body)?.ucp as Record<string, unknown> | undefined;
    const caps = ucp?.capabilities;
    if (
      ucp === undefined ||
      typeof ucp.version !== 'string' ||
      caps === null ||
      typeof caps !== 'object'
    )
      return {
        ok: false,
        code: 'profile_malformed',
        status: 422,
        content: 'The agent profile is not a UCP profile.',
      };
    if (ucp.version !== UCP_VERSION)
      return {
        ok: false,
        code: 'version_unsupported',
        status: 422,
        content: `This business supports version ${UCP_VERSION}.`,
      };
    if (!(CAPABILITY[operation] in caps))
      return {
        ok: false,
        code: 'capabilities_incompatible',
        status: 200,
        content: 'No shared capability for this operation.',
      };
    return { ok: true };
  };

  const write = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
    sse = false,
  ) => {
    const text = body === '' ? '' : JSON.stringify(body);
    if (sse && text !== '') {
      // One event, split across writes, as a stream arrives.
      const event = Buffer.from(`event: message\ndata: ${text}\n\n`);
      res.writeHead(status, {
        'content-type': 'text/event-stream',
        ...headers,
        ...answerSignature(status, event, 'text/event-stream'),
      });
      const half = Math.floor(event.length / 2);
      res.write(event.subarray(0, half));
      res.end(event.subarray(half));
      return;
    }
    const bytes = Buffer.from(text);
    res.writeHead(status, {
      ...(text !== '' ? { 'content-type': 'application/json' } : {}),
      'cache-control': 'public, max-age=60',
      ...headers,
      ...answerSignature(status, bytes, text !== '' ? 'application/json' : null),
    });
    res.end(bytes);
  };

  const mcp = async (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const body = parse(raw);
    const header = req.headers['mcp-session-id'];
    const session = typeof header === 'string' ? header : null;
    const answer = (status: number, message: unknown, headers: Record<string, string> = {}) => {
      mcpLog.push({
        method: String(body?.method ?? ''),
        session,
        id: body?.id ?? null,
        rawBody: raw,
        status,
      });
      write(res, status, message, headers, options.sse === true);
    };
    if (body === null || body.jsonrpc !== '2.0')
      return answer(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      });
    const id = body.id ?? null;
    if (body.method === 'initialize') {
      const asked = ((body.params ?? {}) as Record<string, unknown>).protocolVersion;
      const version =
        typeof asked === 'string' && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0];
      const fresh = randomUUID();
      sessions.add(fresh);
      return answer(
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: 'ucp-mock-merchant', version: '0.0.0' },
          },
        },
        { 'mcp-session-id': fresh },
      );
    }
    if (session === null)
      return answer(400, {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'initialize first' },
      });
    if (!sessions.has(session))
      return answer(404, {
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'session not found' },
      });
    if (body.method === 'notifications/initialized') return answer(202, '');
    const params = (body.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const operation = name in CAPABILITY ? (name as MerchantOperation) : undefined;
    if (body.method !== 'tools/call' || operation === undefined || !offered(operation))
      return answer(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const meta = (args.meta ?? {}) as Record<string, unknown>;
    const profileUrl = ((meta['ucp-agent'] ?? {}) as Record<string, unknown>).profile;
    const agent = typeof profileUrl === 'string' ? profileUrl : null;
    const arg = PAYLOAD_ARG[operation];
    const payload = (arg === undefined ? {} : (args[arg] ?? {})) as Record<string, unknown>;
    requests.push({ transport: 'mcp', operation, agent, payload });
    const toolResult = (result: unknown) => ({
      jsonrpc: '2.0',
      id,
      result: {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      },
    });
    const n = await negotiate(agent, operation);
    if (!n.ok && n.code === 'capabilities_incompatible')
      return answer(200, toolResult(incompatible(n.content)));
    if (!n.ok)
      return answer(n.status, {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32001,
          message: 'UCP discovery failed',
          data: { code: n.code, content: n.content },
        },
      });
    const key = meta['idempotency-key'];
    const done = await logic.handle({
      operation,
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      payload,
      idempotencyKey: typeof key === 'string' ? key : null,
      bodyHash: sha256Hex(raw),
      agent,
      authorization:
        typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
    });
    if (options.dropAnswer?.(operation) === true) return void res.destroy();
    if (done.kind === 'refusal')
      return answer(
        done.status,
        {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: done.content,
            data: { code: done.code, content: done.content },
          },
        },
        done.challenge === undefined ? {} : { 'www-authenticate': done.challenge },
      );
    return answer(200, toolResult(done.body));
  };

  const rest = async (
    req: IncomingMessage,
    res: ServerResponse,
    operation: MerchantOperation,
    id: string | undefined,
    raw: string,
  ) => {
    const header = req.headers['ucp-agent'];
    const agent = agentFromHeader(typeof header === 'string' ? header : undefined);
    const body = raw === '' ? {} : parse(raw);
    requests.push({ transport: 'rest', operation, agent, payload: body ?? {} });
    if (!offered(operation))
      return write(res, 404, { code: 'not_found', content: 'No such operation.' });
    const n = await negotiate(agent, operation);
    if (!n.ok && n.code === 'capabilities_incompatible')
      return write(res, 200, incompatible(n.content));
    if (!n.ok) return write(res, n.status, { code: n.code, content: n.content });
    if (body === null)
      return write(res, 400, { code: 'invalid_request', content: 'The body is not JSON.' });
    const key = req.headers['idempotency-key'];
    const done: MerchantAnswer = await logic.handle({
      operation,
      ...(id !== undefined ? { id } : {}),
      payload: body,
      idempotencyKey: typeof key === 'string' ? key : null,
      bodyHash: sha256Hex(raw),
      agent,
      authorization:
        typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
    });
    if (options.dropAnswer?.(operation) === true) return void res.destroy();
    if (done.kind === 'refusal')
      return write(
        res,
        done.status,
        { code: done.code, content: done.content },
        done.challenge === undefined ? {} : { 'www-authenticate': done.challenge },
      );
    return write(res, done.status, done.body);
  };

  const server = https.createServer({ cert: options.cert, key: options.key }, (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === '/.well-known/ucp')
        return write(res, 200, profile());
      const raw = await readBody(req);
      if (auth !== null) {
        let handled: ReturnType<MockAuthServer['handle']>;
        try {
          handled = auth.handle(req.method ?? 'GET', url.pathname, raw);
        } catch {
          // The grant ran, and its answer is lost on the way back.
          res.destroy();
          return;
        }
        if (handled !== null) return write(res, handled.status, handled.body);
      }
      // The endpoint the profile names now, and the one it named first (a session started
      // there keeps working, as at a merchant that moved its endpoint).
      if (
        req.method === 'POST' &&
        (url.pathname === '/ucp/mcp' || url.pathname === mcpPath()) &&
        transports.includes('mcp')
      )
        return mcp(req, res, raw);
      const prefix = '/ucp/rest';
      if (url.pathname.startsWith(prefix) && transports.includes('rest')) {
        const path = url.pathname.slice(prefix.length);
        for (const r of ROUTES) {
          const m = r.method === req.method ? r.path.exec(path) : null;
          if (m !== null)
            return rest(
              req,
              res,
              r.operation,
              m[1] === undefined ? undefined : decodeURIComponent(m[1]),
              raw,
            );
        }
      }
      return write(res, 404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) write(res, 500, { error: 'internal' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `https://${options.host}:${port}`;
  return {
    origin,
    requests,
    mcpLog,
    logic,
    endSessions: () => sessions.clear(),
    webhook,
    auth,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
