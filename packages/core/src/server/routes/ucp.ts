/**
 * UCP routes (UCP plan §3.11, §3.16, §4.2 U1).
 *
 * Brain (the signed service key on a server; in-process on the phone):
 *   POST /v1/ucp/search              {release_session, query, merchants?, review_id?}
 *   GET  /v1/ucp/search/:id          ?release_session=  the products as Brain may read them
 *   POST /v1/ucp/search/review       {release_session, query, merchants?}  raise the owner's card
 *   POST /v1/ucp/products            {release_session, products: handles}  fetch products afresh
 *   POST /v1/ucp/guard/next          claim a product's text to judge (the only reader of unguarded text)
 *   POST /v1/ucp/guard/verdict       the digest-bound verdict
 *   POST /v1/ucp/cart                {release_session, op: create|update|cancel|read, cart_id?, lines?}
 *   POST /v1/ucp/checkout            {release_session, op: propose|view|choose|handoff|cancel,
 *                                     session_id?, lines?, discount_codes?, choice?, rev?}
 * Carts and checkouts (UCP plan §3.7, U2.7) are named by handles only; Core
 * maps them to the merchant's ids. A proposal raises the owner's start card
 * and returns at once: nothing opens a checkout until the owner says yes. What
 * comes back holds no merchant words or ids.
 * A search goes only to merchants the owner allows (all of them when Brain
 * names none and there are at most ten). It is refused with `needs_review`
 * (409) and its reasons when the query carried personal data or the
 * conversation read a private vault; Brain may then ask Core to raise the
 * owner's card, and search again naming it. A session with no live owner turn
 * is refused `no_owner_turn` (409); a node without its UCP identity,
 * `ucp_not_ready` (503).
 *
 * Owner (handler-checked, like every /v1/owner route):
 *   GET|PUT /v1/owner/ucp/settings          the allowed merchants and context fields
 *   GET     /v1/owner/ucp/searches/:id      a search as the owner sees it (the comparison card)
 *   GET     /v1/owner/ucp/searches/:id/trust  each of its shops' PeerLens trust, looked up by Core
 */

import { A2A_CORE_ANSWER_HEADER, isPlainObject } from '@dina/a2a';
import { UCP_VERSION } from '@dina/ucp';

import { ownerPresenceRefusal } from '../../commerce/owner_presence';
import { merchantOrigin } from '../../commerce/ucp/discovery';
import { getUcpLinkStore } from '../../commerce/ucp/link_store';
import {
  dropHeldLinkCallbacks,
  heldLinkCallbacks,
  holdLinkCallback,
  serverNodePaired,
  type UcpLinkService,
} from '../../commerce/ucp/links';
import { merchantTrust } from '../../commerce/ucp/merchant_trust';
import { ucpOrderView } from '../../commerce/ucp/order_view';
import {
  getUcpPublication,
  runUcpPublicationAction,
  ucpPublicationView,
  UCP_PUBLICATION_ACTIONS,
  type UcpPublicationAction,
} from '../../commerce/ucp/publication_control';
import { getUcpCheckoutRuntime, getUcpSearchRuntime } from '../../commerce/ucp/runtime';
import {
  claimUcpGuardJob,
  fetchUcpProducts,
  ownerSearchView,
  raiseUcpSearchReview,
  searchView,
  startSearch,
  submitUcpGuardVerdict,
} from '../../commerce/ucp/search';
import {
  getUcpSettingsStore,
  readUcpSettings,
  ucpSettingsChanged,
} from '../../commerce/ucp/settings';
import {
  UCP_OAUTH_INGRESS_ROUTE,
  UCP_WEBHOOK_INGRESS_ROUTE,
  ucpOrderWebhookUrl,
} from '../../commerce/ucp/webhooks';
import { parseReleaseSession } from '../../vault/release';

import { ownerDidForRequest } from './owner_guard';
import { REMOTE_APPROVAL_API_PREFIX } from './remote_approval';

import type { LinkView } from '../../commerce/ucp/link_store';
import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

export const UCP_SEARCH = '/v1/ucp/search';
export const UCP_SEARCH_REVIEW = '/v1/ucp/search/review';
export const UCP_PRODUCTS = '/v1/ucp/products';
export const UCP_GUARD_NEXT = '/v1/ucp/guard/next';
export const UCP_GUARD_VERDICT = '/v1/ucp/guard/verdict';
export const UCP_CART = '/v1/ucp/cart';
export const UCP_CHECKOUT = '/v1/ucp/checkout';
export const UCP_OWNER_SETTINGS = '/v1/owner/ucp/settings';
export const UCP_OWNER_SEARCHES = '/v1/owner/ucp/searches';
/** My Orders, for UCP orders (§3.14), and marking a webhook-only one done (§3.13). */
export const UCP_OWNER_ORDERS = '/v1/owner/ucp/orders';
export const UCP_OWNER_ORDER_DONE = '/v1/owner/ucp/orders/done';
/** §3.17: the owner's linked accounts. */
export const UCP_OWNER_LINKS = '/v1/owner/ucp/links';
export const UCP_OWNER_LINK_START = '/v1/owner/ucp/links/start';
export const UCP_OWNER_LINK_UNLINK = '/v1/owner/ucp/links/unlink';
export const UCP_OWNER_LINK_CALLBACK = '/v1/owner/ucp/links/callback';
export const UCP_OWNER_LINK_DISMISS = '/v1/owner/ucp/links/dismiss';
/** §3.5, §4.8 (U7): the profile's publication and key ring, and the owner's four actions on it. */
export const UCP_OWNER_PUBLICATION = '/v1/owner/ucp/publication';
/**
 * §3.17: a paired server pulls the callbacks the phone's claimed link caught
 * for it, by the states it waits on, then acknowledges them.
 */
export const UCP_HELD_CALLBACKS_PULL = `${REMOTE_APPROVAL_API_PREFIX}/oauth-callbacks/pull`;
export const UCP_HELD_CALLBACKS_ACK = `${REMOTE_APPROVAL_API_PREFIX}/oauth-callbacks/ack`;
/** The most states one pull or acknowledgement names (a server's live pending links). */
const MAX_STATES_PER_CALL = 20;
const ORDERS_DEFAULT_LIMIT = 20;
const ORDERS_MAX_LIMIT = 100;

const json = (status: number, body: unknown): CoreResponse => ({ status, body });

/** A link as the owner sees it: the merchant, the scopes, its state; never its tokens or endpoints. */
function linkForOwner(link: LinkView): Record<string, unknown> {
  return {
    merchant_origin: link.merchant_origin,
    merchant_host: new URL(link.merchant_origin).host,
    scopes: link.scopes,
    state: link.state,
    linked_at: link.created_at,
    updated_at: link.updated_at,
  };
}

/** An authorization response's parameters (RFC 6749 §4.1.2, RFC 9207), each a short string; anything else is dropped. */
export function callbackParams(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(body)) return out;
  for (const name of ['code', 'state', 'iss', 'error'] as const) {
    const v = body[name];
    if (typeof v === 'string' && v.length <= 2048) out[name] = v;
  }
  return out;
}
const body = (req: CoreRequest): Record<string, unknown> =>
  isPlainObject(req.body) ? req.body : {};
/** Brain on a server (the signed service key) or in-process on the phone. */
const isBrain = (req: CoreRequest): boolean =>
  req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined);

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((m): m is string => typeof m === 'string') ? value : null;

function searchInput(
  b: Record<string, unknown>,
): { sessionId: string; query: string; merchants: string[] } | null {
  const sessionId = parseReleaseSession(b.release_session);
  if (sessionId === null || typeof b.query !== 'string') return null;
  const merchants = b.merchants === undefined ? [] : strings(b.merchants);
  if (merchants === null) return null;
  return { sessionId, query: b.query, merchants };
}

/** Why a request was refused, as its status: the caller's input, a state to resolve, or this node. */
const REFUSAL_STATUS: Record<string, number> = {
  bad_query: 400,
  bad_merchants: 400,
  bad_products: 400,
  unknown_product: 404,
  needs_review: 409,
  no_owner_turn: 409,
  not_needed: 409,
  no_merchants_allowed: 409,
  choose_merchants: 409,
  merchant_not_allowed: 409,
  review_declined: 409,
  too_many_reviews: 409,
  too_many_merchants: 400,
  ucp_not_ready: 503,
};

/** Cart and checkout refusals: bad input 400, unknown 404, this node 503; the rest are states (409). */
const SHOP_REFUSAL_STATUS: Record<string, number> = {
  no_lines: 400,
  too_many_lines: 400,
  bad_quantity: 400,
  bad_discount_code: 400,
  unknown_variant: 404,
  unknown_cart: 404,
  unknown_session: 404,
  ucp_not_ready: 503,
  no_workflow: 503,
  merchant_unreachable: 502,
};

const refused = (reason: string): CoreResponse =>
  json(REFUSAL_STATUS[reason] ?? 400, { error: reason });

export function registerUcpRoutes(router: CoreRouter, ownerCapability?: string): void {
  const brainRuntime = (req: CoreRequest) => {
    if (!isBrain(req)) return json(403, { error: 'access_denied', reason: 'brain only' });
    return getUcpSearchRuntime() ?? json(503, { error: 'ucp_unavailable' });
  };
  const isResponse = (v: unknown): v is CoreResponse =>
    isPlainObject(v) && typeof (v as { status?: unknown }).status === 'number' && 'body' in v;

  /** A shopping call's lines: `[{variant, quantity}]` by handle, or null. */
  const lineInput = (v: unknown): { variant: string; quantity: number }[] | null =>
    Array.isArray(v) &&
    v.every(
      (l) => isPlainObject(l) && typeof l.variant === 'string' && Number.isSafeInteger(l.quantity),
    )
      ? (v as { variant: string; quantity: number }[])
      : null;
  /** A refusal from carts or checkouts: the caller's input, a state to resolve, or this node. */
  const shopRefusal = (reason: string, detail?: string): CoreResponse =>
    json(SHOP_REFUSAL_STATUS[reason] ?? 409, {
      error: reason,
      ...(detail !== undefined ? { detail } : {}),
    });
  const shopRuntime = (req: CoreRequest) => {
    if (!isBrain(req)) return json(403, { error: 'access_denied', reason: 'brain only' });
    return getUcpCheckoutRuntime() ?? json(503, { error: 'ucp_unavailable' });
  };

  // Order webhooks (§3.13): the gateway forwards each delivery; Core stores it or drops
  // it, and answers what the gateway relays. A store that fails is a 503 the gateway
  // does not relay as Core's answer, so the merchant sees 503 and retries.
  router.post(UCP_WEBHOOK_INGRESS_ROUTE, async (req) => {
    if (req.callerType !== 'gateway') return json(403, { error: 'gateway_only' });
    const rt = getUcpCheckoutRuntime();
    const relayed = (body: unknown): CoreResponse => ({
      status: 200,
      body,
      headers: { [A2A_CORE_ANSWER_HEADER]: '1' },
    });
    if (rt === null) return relayed({ ucp: { version: UCP_VERSION } });
    try {
      const answer = rt.webhooks.accept(req.body);
      rt.processWebhooks();
      return relayed(answer.body);
    } catch {
      return json(503, { error: 'storage_unavailable' });
    }
  });

  // The OAuth callback a public server's gateway took (§3.17): its four parameters, nothing
  // else. Core finishes the link (its pending record consumed once) and answers what the
  // gateway shows the owner.
  router.post(UCP_OAUTH_INGRESS_ROUTE, async (req) => {
    if (req.callerType !== 'gateway') return json(403, { error: 'gateway_only' });
    const relayed = (body: unknown): CoreResponse => ({
      status: 200,
      body,
      headers: { [A2A_CORE_ANSWER_HEADER]: '1' },
    });
    const rt = getUcpCheckoutRuntime();
    if (rt === null) return relayed({ linked: false, reason: 'unavailable' });
    const params = callbackParams(req.body);
    const out = await rt.links.complete(params);
    return relayed(
      out.ok
        ? { linked: true, merchant_host: new URL(out.merchantOrigin).host }
        : { linked: false, reason: out.reason },
    );
  });

  router.post(UCP_CART, async (req) => {
    const rt = shopRuntime(req);
    if (isResponse(rt)) return rt;
    const b = body(req);
    const session = parseReleaseSession(b.release_session);
    if (session === null) return json(400, { error: 'release_session is required' });
    const cartId = typeof b.cart_id === 'string' ? b.cart_id : '';
    const lines = lineInput(b.lines);
    let out;
    switch (b.op) {
      case 'create':
        if (lines === null) return json(400, { error: 'lines are required' });
        out = await rt.carts.create(session, lines);
        break;
      case 'update':
        if (lines === null || cartId === '')
          return json(400, { error: 'cart_id and lines are required' });
        out = await rt.carts.update(session, cartId, lines);
        break;
      case 'cancel':
        out = await rt.carts.cancel(session, cartId);
        break;
      case 'read':
        out = await rt.carts.read(session, cartId);
        break;
      default:
        return json(400, { error: 'op must be create, update, cancel or read' });
    }
    return out.ok
      ? json(200, { cart: out.cart, outcome: out.outcome })
      : shopRefusal(out.reason, out.detail);
  });

  router.post(UCP_CHECKOUT, async (req) => {
    const rt = shopRuntime(req);
    if (isResponse(rt)) return rt;
    const b = body(req);
    const session = parseReleaseSession(b.release_session);
    if (session === null) return json(400, { error: 'release_session is required' });
    const sessionId = typeof b.session_id === 'string' ? b.session_id : '';
    const { checkouts } = rt;
    const answer = (sid: string) => {
      const view = checkouts.view(session, sid);
      return view === null ? shopRefusal('unknown_session') : json(200, { checkout: view });
    };
    switch (b.op) {
      case 'propose': {
        const lines = lineInput(b.lines);
        const codes = b.discount_codes === undefined ? [] : strings(b.discount_codes);
        if (lines === null || codes === null)
          return json(400, { error: 'lines (and discount_codes, if any) are required' });
        const out = await checkouts.propose(session, { lines, discountCodes: codes });
        return out.ok
          ? json(201, {
              checkout: checkouts.view(session, out.session.session_id),
              card_expires_at: out.expiresAtMs,
            })
          : shopRefusal(out.reason, out.detail);
      }
      case 'view':
        // The owner looking at a purchase whose outcome is not known yet reads it once more
        // (§3.12); only for this conversation's own session.
        if (checkouts.view(session, sessionId) !== null) await rt.watcher.look(sessionId);
        return answer(sessionId);
      case 'choose': {
        if (typeof b.choice !== 'string' || typeof b.rev !== 'string')
          return json(400, { error: 'choice and rev are required' });
        const out = await checkouts.choose(session, sessionId, b.choice, b.rev);
        return out.ok ? answer(sessionId) : shopRefusal(out.reason, out.detail);
      }
      case 'handoff': {
        const out = await checkouts.handoff(session, sessionId);
        return out.ok ? answer(sessionId) : shopRefusal(out.reason, out.detail);
      }
      case 'cancel': {
        const out = await checkouts.cancel(session, sessionId);
        return out.ok ? answer(sessionId) : shopRefusal(out.reason, out.detail);
      }
      default:
        return json(400, { error: 'op must be propose, view, choose, handoff or cancel' });
    }
  });

  router.post(UCP_SEARCH, async (req) => {
    const rt = brainRuntime(req);
    if (isResponse(rt)) return rt;
    const b = body(req);
    const input = searchInput(b);
    if (input === null) return json(400, { error: 'release_session and query are required' });
    const reviewId = typeof b.review_id === 'string' ? b.review_id : undefined;
    const out = await startSearch(
      { ...input, ...(reviewId !== undefined ? { reviewId } : {}) },
      rt,
    );
    if (out.ok)
      return json(200, {
        search_id: out.searchId,
        merchants: out.merchants,
        provenance: out.provenance,
      });
    if (out.reason === 'needs_review') return json(409, { error: 'needs_review', why: out.why });
    if (out.reason === 'review') return json(409, { error: `review_${out.review}` });
    if ('allowed' in out && out.allowed !== undefined)
      return json(409, { error: out.reason, allowed: out.allowed });
    return refused(out.reason);
  });

  router.post(UCP_SEARCH_REVIEW, async (req) => {
    const rt = brainRuntime(req);
    if (isResponse(rt)) return rt;
    const input = searchInput(body(req));
    if (input === null) return json(400, { error: 'release_session and query are required' });
    const out = raiseUcpSearchReview(input, rt);
    if (!out.ok && 'allowed' in out && out.allowed !== undefined)
      return json(409, { error: out.reason, allowed: out.allowed });
    if (!out.ok) return refused(out.reason);
    return json(201, { review_id: out.reviewId, expires_at: out.expiresAtMs });
  });

  router.post(UCP_PRODUCTS, async (req) => {
    const rt = brainRuntime(req);
    if (isResponse(rt)) return rt;
    const b = body(req);
    const sessionId = parseReleaseSession(b.release_session);
    const products = strings(b.products);
    if (sessionId === null || products === null)
      return json(400, { error: 'release_session and products are required' });
    const out = await fetchUcpProducts({ sessionId, products }, rt);
    if (!out.ok) return refused(out.reason);
    return json(200, { search_id: out.searchId, merchants: out.merchants, missing: out.missing });
  });

  router.get(`${UCP_SEARCH}/:id`, async (req) => {
    const rt = brainRuntime(req);
    if (isResponse(rt)) return rt;
    const sessionId = parseReleaseSession(req.query.release_session);
    if (sessionId === null) return json(400, { error: 'release_session is required' });
    const view = searchView(rt.store, req.params.id ?? '', sessionId, rt.nowMs());
    return view === null ? json(404, { error: 'not_found' }) : json(200, view);
  });

  router.post(UCP_GUARD_NEXT, async (req) => {
    const rt = brainRuntime(req);
    if (isResponse(rt)) return rt;
    const work = claimUcpGuardJob(rt.store, rt.nowMs(), rt.newId);
    return work === null ? json(204, {}) : json(200, work);
  });

  router.post(UCP_GUARD_VERDICT, async (req) => {
    const rt = brainRuntime(req);
    if (isResponse(rt)) return rt;
    const b = body(req);
    if (
      typeof b.job_id !== 'string' ||
      typeof b.claim_id !== 'string' ||
      typeof b.digest !== 'string'
    ) {
      return json(400, { error: 'job_id, claim_id and digest are required' });
    }
    const out = submitUcpGuardVerdict(
      rt.store,
      { jobId: b.job_id, claimId: b.claim_id, digest: b.digest, verdict: b.verdict, code: b.code },
      rt.nowMs(),
    );
    if (!out.ok) {
      const status = out.reason === 'not_found' ? 404 : out.reason === 'bad_verdict' ? 400 : 409;
      return json(status, { error: out.reason });
    }
    return json(200, { state: out.state });
  });

  // ------------------------------------------------------------------ owner

  const ownerRoute =
    (handler: (req: CoreRequest) => Promise<CoreResponse>) =>
    async (req: CoreRequest): Promise<CoreResponse> => {
      const owner = ownerDidForRequest(req, ownerCapability);
      return typeof owner === 'string' ? handler(req) : owner;
    };

  router.get(
    UCP_OWNER_SETTINGS,
    ownerRoute(async () => {
      const store = getUcpSettingsStore();
      if (store === null) return json(503, { error: 'storage_unavailable' });
      // `searching`: whether this node runs UCP now. The settings are kept either way, and
      // apply once it does; the owner's screen says which.
      // `order_webhook_url`: the URL this node's profile lists for order webhooks; null
      // when it lists the drop-box (no public domain, or the owner turned them off).
      return json(200, {
        ...store.get(),
        searching: getUcpSearchRuntime() !== null,
        order_webhook_url: ucpOrderWebhookUrl(),
      });
    }),
  );

  router.put(
    UCP_OWNER_SETTINGS,
    ownerRoute(async (req) => {
      const store = getUcpSettingsStore();
      if (store === null) return json(503, { error: 'storage_unavailable' });
      const read = readUcpSettings(req.body);
      if (!read.ok) return json(400, { error: 'invalid_settings', field: read.field });
      // A screen that does not show the webhook choice leaves it as it was.
      const given =
        typeof req.body === 'object' && req.body !== null && 'order_webhooks' in req.body;
      const settings = given
        ? read.settings
        : { ...read.settings, order_webhooks: store.get().order_webhooks };
      store.set(settings, Date.now());
      ucpSettingsChanged();
      return json(200, {
        ...settings,
        searching: getUcpSearchRuntime() !== null,
        order_webhook_url: ucpOrderWebhookUrl(),
      });
    }),
  );

  router.get(
    UCP_OWNER_ORDERS,
    ownerRoute(async (req) => {
      const rt = getUcpCheckoutRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      let limit = ORDERS_DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        if (!/^\d{1,3}$/.test(req.query.limit)) return json(400, { error: 'invalid_limit' });
        limit = Number(req.query.limit);
        if (limit < 1 || limit > ORDERS_MAX_LIMIT) return json(400, { error: 'invalid_limit' });
      }
      return json(200, { orders: rt.orderStore.recent(limit).map(ucpOrderView) });
    }),
  );
  router.post(
    UCP_OWNER_ORDER_DONE,
    ownerRoute(async (req) => {
      const rt = getUcpCheckoutRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      const body = req.body;
      if (
        !isPlainObject(body) ||
        typeof body.merchant_origin !== 'string' ||
        typeof body.order_id !== 'string'
      )
        return json(400, { error: 'invalid_request' });
      const key = { merchant_origin: body.merchant_origin, order_id: body.order_id };
      if (rt.orderStore.get(key) === null) return json(404, { error: 'not_found' });
      // Only an order fed by webhooks alone closes this way; any other closes by Dina's rule.
      if (!rt.orderStore.closeByOwner(key, Date.now()))
        return json(409, { error: 'not_webhook_only' });
      const row = rt.orderStore.get(key);
      return json(200, { order: row === null ? null : ucpOrderView(row) });
    }),
  );

  // ---- linked accounts (§3.17)

  router.get(
    UCP_OWNER_LINKS,
    ownerRoute(async () => {
      const rt = getUcpCheckoutRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      const host = (origin: string) => new URL(origin).host;
      return json(200, {
        links: rt.links.list().map(linkForOwner),
        // Shops that asked for a linked account on some call, until linked there.
        wanted: rt.links.wanted().map((w) => ({ ...w, merchant_host: host(w.merchant_origin) })),
        // Access Dina could not take back: the owner removes it at the shop.
        unrevoked: rt.links
          .unrevoked()
          .map((u) => ({ ...u, merchant_host: host(u.merchant_origin) })),
        // The last day's attempts that ended without a link (a callback through the phone too).
        failed: rt.links
          .failedAttempts()
          .map((a) => ({ ...a, merchant_host: host(a.merchant_origin) })),
      });
    }),
  );
  router.post(
    UCP_OWNER_LINK_START,
    ownerRoute(async (req) => {
      const rt = getUcpCheckoutRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      const b = body(req);
      const origin =
        typeof b.merchant_origin === 'string' ? merchantOrigin(b.merchant_origin) : null;
      const scopes = b.scopes === undefined ? [] : strings(b.scopes);
      if (
        origin === null ||
        scopes === null ||
        scopes.length > 20 ||
        scopes.some((s) => s.length > 200)
      )
        return json(400, { error: 'invalid_request' });
      const out = await rt.links.startForOwner(origin, scopes);
      if (!out.ok) return json(200, { started: false, reason: out.reason });
      // The page to open here, or the card that carries it to the paired phone.
      return json(200, {
        started: true,
        opens: out.opens,
        ...(out.opens === 'here' ? { url: out.url } : { card_id: out.cardId }),
        scopes: out.scopes,
        expires_at: out.expiresAt,
      });
    }),
  );
  router.post(
    UCP_OWNER_LINK_UNLINK,
    ownerRoute(async (req) => {
      const rt = getUcpCheckoutRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      const b = body(req);
      const origin =
        typeof b.merchant_origin === 'string' ? merchantOrigin(b.merchant_origin) : null;
      if (origin === null) return json(400, { error: 'invalid_request' });
      return json(200, { unlinked: rt.links.unlink(origin) });
    }),
  );
  // Publication (§3.5, §4.8): whether the host serves the profile, which device holds
  // shopping, and the key ring; then the owner's actions on it.
  router.get(
    UCP_OWNER_PUBLICATION,
    ownerRoute(async () => {
      const publication = getUcpPublication();
      if (publication === null) return json(503, { error: 'ucp_unavailable' });
      return json(200, await ucpPublicationView(publication.publisher));
    }),
  );
  router.post(
    UCP_OWNER_PUBLICATION,
    ownerRoute(async (req) => {
      const publication = getUcpPublication();
      if (publication === null) return json(503, { error: 'ucp_unavailable' });
      const action = body(req).action;
      if (!UCP_PUBLICATION_ACTIONS.includes(action as UcpPublicationAction))
        return json(400, { error: 'invalid_action' });
      // Retiring every key for good, or taking shopping from another device, needs the owner
      // here; turning UCP off never waits for that, and a rotation changes nothing a merchant sees.
      if (action === 'compromised' || action === 'activate') {
        const refusal = ownerPresenceRefusal(req, Date.now(), 'confirm it is you first');
        if (refusal !== null) return json(refusal.status, refusal.body);
      }
      await runUcpPublicationAction(publication, action as UcpPublicationAction);
      return json(200, await ucpPublicationView(publication.publisher));
    }),
  );

  // The owner removed Dina's access at the shop by hand: the record goes.
  router.post(
    UCP_OWNER_LINK_DISMISS,
    ownerRoute(async (req) => {
      const rt = getUcpCheckoutRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      const b = body(req);
      const origin =
        typeof b.merchant_origin === 'string' ? merchantOrigin(b.merchant_origin) : null;
      if (origin === null) return json(400, { error: 'invalid_request' });
      return json(200, { dismissed: rt.links.dismissUnrevoked(origin) });
    }),
  );

  // A callback the Dina app's claimed link caught (§3.17): finished here, or kept for the
  // paired server whose link it is.
  router.post(
    UCP_OWNER_LINK_CALLBACK,
    ownerRoute(async (req) => {
      const params = callbackParams(req.body);
      const rt = getUcpCheckoutRuntime();
      // A node that does not run UCP itself still keeps a callback for its paired server.
      const store = getUcpLinkStore();
      let out: Awaited<ReturnType<UcpLinkService['receive']>>;
      if (rt !== null) out = await rt.links.receive(params);
      else if (store !== null)
        out = holdLinkCallback(store, params, Date.now(), serverNodePaired());
      else return json(503, { error: 'storage_unavailable' });
      if (out.ok)
        return json(200, { linked: true, merchant_host: new URL(out.merchantOrigin).host });
      // Kept for the server; an answer that carries an error links nothing, and the phone says so.
      if (out.reason === 'held' && params.error !== undefined)
        return json(200, {
          linked: false,
          reason: params.error === 'access_denied' ? 'denied' : 'not_linked',
        });
      if (out.reason === 'held') return json(200, { linked: false, held: true });
      return json(200, { linked: false, reason: out.reason });
    }),
  );

  // The owner's paired server node alone pulls (S7: a card that opens a link, or a code
  // that finishes one, is the node's). A state is the server's own secret, so it is named.
  const heldCallbackStates = (req: CoreRequest): string[] | CoreResponse => {
    if (req.callerType !== 'agent' || req.agentScope !== 'node')
      return json(403, { error: 'access_denied', reason: 'only the owner’s paired node' });
    const states = strings(body(req).states);
    if (states === null || states.length > MAX_STATES_PER_CALL)
      return json(400, { error: 'invalid_request' });
    return states;
  };
  router.post(UCP_HELD_CALLBACKS_PULL, async (req) => {
    const states = heldCallbackStates(req);
    if (!Array.isArray(states)) return states;
    const store = getUcpLinkStore();
    if (store === null) return json(200, { callbacks: [] });
    return json(200, { callbacks: heldLinkCallbacks(store, states, Date.now()) });
  });
  router.post(UCP_HELD_CALLBACKS_ACK, async (req) => {
    const states = heldCallbackStates(req);
    if (!Array.isArray(states)) return states;
    const store = getUcpLinkStore();
    return json(200, { dropped: store === null ? 0 : dropHeldLinkCallbacks(store, states) });
  });

  router.get(
    `${UCP_OWNER_SEARCHES}/:id`,
    ownerRoute(async (req) => {
      const rt = getUcpSearchRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      const view = ownerSearchView(rt.store, req.params.id ?? '');
      return view === null ? json(404, { error: 'not_found' }) : json(200, view);
    }),
  );
  // The card's trust lines come from Core (plan §3.7), for the shops Core asked: a caller
  // cannot name others.
  router.get(
    `${UCP_OWNER_SEARCHES}/:id/trust`,
    ownerRoute(async (req) => {
      const rt = getUcpSearchRuntime();
      if (rt === null) return json(503, { error: 'ucp_unavailable' });
      const view = ownerSearchView(rt.store, req.params.id ?? '');
      if (view === null) return json(404, { error: 'not_found' });
      const trust = await merchantTrust(view.merchants.map((m) => m.origin));
      return json(200, { merchants: [...trust].map(([origin, t]) => ({ origin, trust: t })) });
    }),
  );
}
