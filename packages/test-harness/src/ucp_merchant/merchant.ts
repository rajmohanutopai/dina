/**
 * The mock merchant's operations, whatever the transport (UCP plan §3.19 step
 * 2): the catalogue (`catalog.ts`), carts (`carts.ts`) and, from U2.4,
 * checkouts. State changes follow the spec's idempotency rules
 * (signatures.md, "Idempotency Key Requirements"): a key is unique per client (the
 * agent's profile) and per operation, and kept 24 hours;
 * a duplicate with the same body hash gets the cached answer and nothing runs
 * again; a duplicate with another body is refused (`409` / `-32000`,
 * `idempotency_conflict`); after 24 hours the key is forgotten and a resend
 * runs as new. A duplicate that arrives while the first
 * still runs is refused with a 409 too (the merchant is still working on it).
 */

import { createHash, randomUUID } from 'node:crypto';

import { cartAnswer, linesFrom, notFound, type MockCart, type MockExtraTotal } from './carts';
import { catalogAnswer, type CatalogOperation, type MockProduct } from './catalog';
import {
  checkoutAnswer,
  checkoutLines,
  outOfStock,
  pickupChoice,
  shippingChoice,
  type MockCheckout,
} from './checkouts';
import { orderAnswer, orderFrom, orderUnauthorized, type MockOrder } from './orders';

export type MerchantOperation =
  | CatalogOperation
  | 'create_cart'
  | 'get_cart'
  | 'update_cart'
  | 'cancel_cart'
  | 'create_checkout'
  | 'get_checkout'
  | 'update_checkout'
  | 'cancel_checkout'
  | 'get_order';

export const CAPABILITY: Record<MerchantOperation, string> = {
  search_catalog: 'dev.ucp.shopping.catalog.search',
  lookup_catalog: 'dev.ucp.shopping.catalog.lookup',
  get_product: 'dev.ucp.shopping.catalog.lookup',
  create_cart: 'dev.ucp.shopping.cart',
  get_cart: 'dev.ucp.shopping.cart',
  update_cart: 'dev.ucp.shopping.cart',
  cancel_cart: 'dev.ucp.shopping.cart',
  create_checkout: 'dev.ucp.shopping.checkout',
  get_checkout: 'dev.ucp.shopping.checkout',
  update_checkout: 'dev.ucp.shopping.checkout',
  cancel_checkout: 'dev.ucp.shopping.checkout',
  get_order: 'dev.ucp.shopping.order',
};

const MUTATING = new Set<MerchantOperation>([
  'create_cart',
  'update_cart',
  'cancel_cart',
  'create_checkout',
  'update_checkout',
  'cancel_checkout',
]);

/** The buyer a request names, as an object, or undefined. */
function buyerOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const b = payload.buyer;
  return b !== null && typeof b === 'object' && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : undefined;
}

/** How long a checkout session lives when nothing else is set (the spec's default). */
const CHECKOUT_TTL_MS = 6 * 60 * 60_000;

/** How long an idempotency key is kept (the spec's minimum). */
export const KEY_TTL_MS = 24 * 60 * 60_000;

export interface MerchantCall {
  operation: MerchantOperation;
  id?: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  /** SHA-256 of the raw body bytes (the whole JSON-RPC envelope over MCP). */
  bodyHash: string;
  /** The agent's profile URL: idempotency keys are the client's own. */
  agent: string | null;
  /** The `Authorization` header as sent (a linked account's bearer token). */
  authorization?: string | null;
}

/** An answer: a success status and resource, a UCP error answer, or a transport refusal. */
export type MerchantAnswer =
  | { kind: 'resource'; status: number; body: Record<string, unknown> }
  | { kind: 'refusal'; status: number; code: string; content: string; challenge?: string };

export interface MockMerchantState {
  products: () => readonly MockProduct[];
  now: () => number;
  cartTtlMs: number;
  /** The merchant's origin, for the links its answers carry. */
  origin: () => string;
  /** A variant the merchant cannot sell now: a create naming it is answered `out_of_stock`. */
  outOfStock?: (variantId: string) => boolean;
  /** Offer pickup on every checkout session (the fulfillment extension's shape). */
  pickup?: boolean;
  /** Offer shipping to an address the buyer gives (the conformance run only; Dina sends none). */
  shipping?: boolean;
  /** Carry an empty `payment` block on checkout answers (the conformance run only). */
  emptyPayment?: boolean;
  /**
   * How Get Order answers the platform: `share` (the order), `unauthorized` (a business
   * outcome: not shared), `identity_required` (a 401 asking for a linked account).
   */
  orderSharing?: () => 'share' | 'unauthorized' | 'identity_required';
  /** Messages every checkout answer carries (warnings, disclosures, errors). */
  checkoutMessages?: () => readonly Record<string, unknown>[];
  /** Whether checkout answers carry a `continue_url` (default yes). */
  continueUrl?: () => boolean;
  /**
   * Gate an operation behind a linked account's scope: undefined when the
   * call may go on, else the refusal (with its Bearer challenge).
   */
  authorize?: (call: MerchantCall, scope: string) => MerchantAnswer | undefined;
  /** Answer a change to an ended session with the session as it stands (200), not a 409. */
  endedAsIs?: () => boolean;
  /** Hold a call while it runs (a slow merchant): resolves when it may finish. A state change is held after its key is taken. */
  hold?: (call: MerchantCall) => Promise<void> | undefined;
  /** Refuse a call outright, before its key is read (as a merchant refuses a profile it cannot fetch). */
  refuse?: (call: MerchantCall) => { status: number; code: string } | undefined;
  /** The merchant's own total lines on every cart answer. */
  extraTotals?: () => readonly MockExtraTotal[];
}

export const sha256Hex = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export class MockMerchantLogic {
  readonly carts = new Map<string, MockCart>();
  readonly checkouts = new Map<string, MockCheckout>();
  readonly orders = new Map<string, MockOrder>();
  private readonly keys = new Map<
    string,
    { hash: string; at: number; answer: MerchantAnswer | null }
  >();
  /** How many times each operation actually ran (a cached duplicate does not count). */
  readonly executed: MerchantOperation[] = [];

  constructor(private readonly state: MockMerchantState) {}

  async handle(call: MerchantCall): Promise<MerchantAnswer> {
    const refused = this.state.refuse?.(call);
    if (refused !== undefined)
      return { kind: 'refusal', ...refused, content: 'Refused by the test.' };
    if (!MUTATING.has(call.operation)) {
      await this.state.hold?.(call);
      return this.run(call);
    }
    if (call.idempotencyKey === null)
      return {
        kind: 'refusal',
        status: 400,
        code: 'invalid_request',
        content: 'Idempotency-Key is required.',
      };
    const now = this.state.now();
    const scope = `${call.agent ?? ''}|${call.operation}|${call.idempotencyKey}`;
    const kept = this.keys.get(scope);
    if (kept !== undefined && now - kept.at < KEY_TTL_MS) {
      if (kept.hash !== call.bodyHash || kept.answer === null)
        return {
          kind: 'refusal',
          status: 409,
          code: 'idempotency_conflict',
          content:
            kept.answer === null
              ? 'A request with this key is still running.'
              : 'This key was used with another request.',
        };
      return kept.answer;
    }
    // In flight: a duplicate now is refused until this one ends.
    this.keys.set(scope, { hash: call.bodyHash, at: now, answer: null });
    await this.state.hold?.(call);
    const answer = this.run(call);
    this.keys.set(scope, { hash: call.bodyHash, at: now, answer });
    return answer;
  }

  private checkoutExtra() {
    return {
      ...(this.state.checkoutMessages !== undefined
        ? { messages: this.state.checkoutMessages() }
        : {}),
      ...(this.state.continueUrl !== undefined ? { continueUrl: this.state.continueUrl() } : {}),
      ...(this.state.emptyPayment === true ? { emptyPayment: true } : {}),
    };
  }

  /** The buyer finishes in the browser (what Dina hands off to): the session completes with an order. */
  completeInBrowser(checkoutId: string): boolean {
    const checkout = this.checkouts.get(checkoutId);
    if (checkout === undefined || checkout.status !== 'incomplete') return false;
    checkout.status = 'completed';
    checkout.orderId = `ord_${randomUUID().slice(0, 8)}`;
    this.orders.set(
      checkout.orderId,
      orderFrom(checkout.orderId, checkout.id, checkout.currency, checkout.lines),
    );
    return true;
  }

  private run(call: MerchantCall): MerchantAnswer {
    this.executed.push(call.operation);
    const products = this.state.products();
    const ok = (body: Record<string, unknown>, status = 200): MerchantAnswer => ({
      kind: 'resource',
      status,
      body,
    });
    switch (call.operation) {
      case 'search_catalog':
      case 'lookup_catalog':
      case 'get_product': {
        const gate = this.state.authorize?.(call, 'dev.ucp.shopping.catalog.search:read');
        if (gate !== undefined && call.operation === 'search_catalog') return gate;
        return ok(catalogAnswer(call.operation, products, call.payload));
      }
      case 'create_cart': {
        const made = linesFrom(
          products,
          call.payload,
          [],
          () => `line_${randomUUID().slice(0, 8)}`,
        );
        if (!made.ok) return ok(made.answer);
        const cart: MockCart = {
          id: `cart_${randomUUID().slice(0, 8)}`,
          currency: made.currency,
          lines: made.lines,
          expiresAt: this.state.now() + this.state.cartTtlMs,
          canceled: false,
        };
        this.carts.set(cart.id, cart);
        return ok(cartAnswer(cart, this.state.extraTotals?.()), 201);
      }
      case 'create_checkout': {
        const items = Array.isArray(call.payload.line_items) ? call.payload.line_items : [];
        const named = items.map((i) => (i as { item?: { id?: unknown } }).item?.id);
        if (named.some((id) => typeof id === 'string' && this.state.outOfStock?.(id) === true))
          return ok(outOfStock(this.state.origin()));
        const made = checkoutLines(
          products,
          call.payload,
          [],
          () => `li_${randomUUID().slice(0, 8)}`,
        );
        if (!made.ok) return ok(made.answer);
        const checkout: MockCheckout = {
          id: `chk_${randomUUID().slice(0, 8)}`,
          currency: made.currency,
          lines: made.lines,
          status: 'incomplete',
          expiresAt: this.state.now() + CHECKOUT_TTL_MS,
          ...(this.state.pickup === true ? { pickup: { destination: null, option: null } } : {}),
          ...(this.state.shipping === true
            ? { shipping: { destinations: [], destination: null, option: null } }
            : {}),
          ...(buyerOf(call.payload) !== undefined ? { buyer: buyerOf(call.payload) } : {}),
        };
        this.checkouts.set(checkout.id, checkout);
        return ok(checkoutAnswer(checkout, this.state.origin(), this.checkoutExtra()), 201);
      }
      case 'get_order': {
        const gate = this.state.authorize?.(call, 'dev.ucp.shopping.order:read');
        if (gate !== undefined) return gate;
        const order = call.id === undefined ? undefined : this.orders.get(call.id);
        if (order === undefined) return ok(notFound('order'));
        const sharing = this.state.orderSharing?.() ?? 'share';
        if (sharing === 'unauthorized') return ok(orderUnauthorized());
        if (sharing === 'identity_required')
          return {
            kind: 'refusal',
            status: 401,
            code: 'identity_required',
            content: 'Link an account to read this order.',
          };
        return ok(orderAnswer(order, this.state.origin()));
      }
      case 'get_checkout':
      case 'update_checkout':
      case 'cancel_checkout': {
        const checkout = call.id === undefined ? undefined : this.checkouts.get(call.id);
        if (checkout === undefined || checkout.expiresAt <= this.state.now())
          return ok(notFound('checkout session'));
        const answer = () =>
          ok(checkoutAnswer(checkout, this.state.origin(), this.checkoutExtra()));
        if (call.operation === 'get_checkout') return answer();
        // An ended session cannot be changed or cancelled: the spec says "an error indicating the
        // operation is not allowed" without naming its binding; the conformance suite reads it
        // as a client error, as merchants built against it do (a business outcome at 200 would
        // also fit; Dina reads both as a refusal).
        if (checkout.status !== 'incomplete')
          // Or, as some merchants answer, the session as it stands (a cancel that raced the
          // buyer's own completion reports `completed`, checkout/index.md:484-486).
          return this.state.endedAsIs?.() === true
            ? answer()
            : {
                kind: 'refusal',
                status: 409,
                code: 'invalid_state',
                content: 'This checkout session has ended.',
              };
        if (call.operation === 'cancel_checkout') {
          checkout.status = 'canceled';
          return answer();
        }
        const made = checkoutLines(
          products,
          call.payload,
          checkout.lines,
          () => `li_${randomUUID().slice(0, 8)}`,
        );
        if (!made.ok) return ok(made.answer);
        // A merchant without the fulfillment extension ignores its fields, as any unknown
        // field; one that offers pickup refuses a choice it did not offer.
        const choice = checkout.pickup === undefined ? undefined : pickupChoice(call.payload);
        const ship = checkout.shipping === undefined ? undefined : shippingChoice(call.payload);
        if (
          (choice !== undefined && 'refused' in choice) ||
          (ship !== undefined && 'refused' in ship)
        )
          return {
            kind: 'refusal',
            status: 400,
            code: 'invalid_request',
            content: 'That fulfillment choice is not offered.',
          };
        checkout.lines = made.lines;
        if (choice !== undefined && !('refused' in choice)) checkout.pickup = choice;
        if (ship !== undefined && !('refused' in ship)) checkout.shipping = ship;
        // A full replacement: the buyer is what this update names.
        const buyer = buyerOf(call.payload);
        if (buyer !== undefined) checkout.buyer = buyer;
        else delete checkout.buyer;
        return answer();
      }
      case 'get_cart':
      case 'update_cart':
      case 'cancel_cart': {
        const cart = call.id === undefined ? undefined : this.carts.get(call.id);
        if (cart === undefined || cart.canceled || cart.expiresAt <= this.state.now())
          return ok(notFound('cart'));
        if (call.operation === 'get_cart') return ok(cartAnswer(cart, this.state.extraTotals?.()));
        if (call.operation === 'cancel_cart') {
          cart.canceled = true;
          return ok(cartAnswer(cart, this.state.extraTotals?.()));
        }
        const made = linesFrom(
          products,
          call.payload,
          cart.lines,
          () => `line_${randomUUID().slice(0, 8)}`,
        );
        if (!made.ok) return ok(made.answer);
        cart.lines = made.lines;
        return ok(cartAnswer(cart, this.state.extraTotals?.()));
      }
    }
  }
}
