/**
 * Carts (UCP plan §3.7, U2.3): for browsing only. A cart carries items,
 * quantities and units, and the owner-allowed `context`; never buyer fields.
 * It needs no card, so it never passes the checkout permit gate.
 *
 *  - Brain names lines by the handles it saw (`v1.2`) and step counts; Core
 *    maps them back to the merchant's variant ids. All lines are at one
 *    merchant the owner allows. Using a cart keeps its handles alive.
 *  - Each line's product is fetched afresh first (`get_product`): the line
 *    echoes the merchant's own `quantity_unit`, and a quantity must be a
 *    whole number of the unit's increment.
 *  - Every change goes through the dispatcher, one at a time per cart, each
 *    journaled and resent with the same bytes and key until it settles
 *    (§3.10). An earlier change still open is resumed first, under its own
 *    operation's gate. An update's full replacement is built under the slot
 *    from the latest answer.
 *  - A cart is `gone` once the merchant no longer knows it (`not_found`), it
 *    passed its `expires_at`, it was cancelled, or its create never settled;
 *    Dina offers to build it again. A refused change says so, with the
 *    spec's code; the cart stays as it was.
 *
 * What Brain reads of a cart: handles, quantities, prices and totals in
 * minor units (a total's type only when it is a well-known one), and its
 * state; none of the merchant's text or ids.
 */

import { parseStrictJson } from '@dina/a2a';
import {
  buildCreateCartBody,
  buildUpdateCartBody,
  isWellKnownTotalType,
  specErrorCode,
  readCart,
  type Cart,
} from '@dina/ucp';

import { OWNER_TURN_LIVE_MS } from '../../a2a/proposal';

import { freshLines, lineTargets, type LineInput, type LineRefusal } from './lines';

import type { CartRow, RequestRow, UcpCheckoutStore } from './checkout_store';
import type { Gate, MutateResult, Mutation, Outcome, UcpDispatcher } from './dispatch';
import type { CallResult, MerchantConnection, UcpMerchantClient } from './merchant_client';
import type { UcpSearchStore } from './search_store';
import type { UcpSettings } from './settings';

/** A cart change's retry deadline: inside the 24 hours a merchant keeps keys (§3.10). */
export const CART_RETRY_MS = 23 * 60 * 60_000;
/** How long a change waits for another one on the same cart, or for the merchant's Retry-After. */
const WAIT_MS = 30_000;

type CartOperation = 'create_cart' | 'update_cart' | 'cancel_cart';

export type CartRefusal =
  | LineRefusal
  | 'merchant_not_allowed'
  | 'unknown_cart'
  | 'cart_gone'
  | 'ucp_not_ready'
  | 'ucp_key_pending'
  | 'merchant_unreachable'
  | 'carts_unavailable'
  /** The merchant refused the create or the change (`detail`: the spec's code). */
  | 'refused'
  /** Another change, or the merchant's wait, still holds the cart; nothing new was sent. */
  | 'busy'
  /** No owner turn in this conversation lately: carts change only on the owner's own request. */
  | 'no_owner_turn';

export interface CartView {
  cart_id: string;
  merchant: string;
  state: CartRow['state'];
  lines: { variant: string; quantity: number; price: { amount: string; currency: string } }[];
  totals: { type: string; amount: string; currency: string }[];
  expires_at?: number;
}

export type CartResult =
  /** `pending`: the change may have reached the merchant and its answer is not known yet. */
  | { ok: true; cart: CartView; outcome: 'settled' | 'pending' }
  | { ok: false; reason: CartRefusal; detail?: string };

export interface CartDeps {
  store: UcpCheckoutStore;
  search: UcpSearchStore;
  client: Pick<UcpMerchantClient, 'open' | 'notReady'>;
  dispatcher: UcpDispatcher;
  settings: () => UcpSettings;
  /** When the owner last spoke in this conversation (the release log), or null. */
  ownerTurn: (conversation: string) => number | null;
  nowMs: () => number;
  newId: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/** The spec's code a refusal names, or `other` (never the merchant's words). */
function refusalCode(answer: CallResult): string {
  if (answer.ok) return '';
  if (answer.kind === 'transport') return specErrorCode(answer.error.code);
  if (answer.kind === 'error_response')
    return specErrorCode(answer.messages.messages.find((m) => m.type === 'error')?.code ?? '');
  return answer.kind;
}

const isNotFound = (answer: CallResult): boolean =>
  !answer.ok &&
  answer.kind === 'error_response' &&
  answer.messages.messages.some((m) => m.type === 'error' && m.code === 'not_found');

export class UcpCartService {
  constructor(private readonly deps: CartDeps) {}

  /** Build a cart at one merchant from variant handles. */
  async create(conversation: string, input: readonly LineInput[]): Promise<CartResult> {
    const { deps } = this;
    if (!this.ownerSpoke(conversation)) return { ok: false, reason: 'no_owner_turn' };
    const targets = lineTargets(deps.search, conversation, input);
    if (!targets.ok) return targets;
    const { merchant } = targets;
    const settings = deps.settings();
    if (!settings.merchants.includes(merchant))
      return { ok: false, reason: 'merchant_not_allowed' };
    const opened = await this.open(merchant);
    if (!opened.ok) return opened;
    const connection = opened.connection;
    if (!connection.schemas.available('create_cart'))
      return { ok: false, reason: 'carts_unavailable' };
    const lines = await freshLines(connection, settings, input, targets.list);
    if (!lines.ok) return lines;

    const now = deps.nowMs();
    deps.search.touchHandles(
      conversation,
      input.map((l) => l.variant),
      now,
    );
    const cartId = `ucp-cart-${deps.newId()}`;
    deps.store.insertCart({
      cart_id: cartId,
      conversation,
      merchant_origin: merchant,
      version: connection.merchant.negotiated.get('dev.ucp.shopping.cart')?.version ?? '',
      transport: connection.merchant.transport,
      endpoint: connection.merchant.endpoint,
      state: 'creating',
      created_at: now,
    });
    const payload = buildCreateCartBody(lines.lines, settings.context);
    return this.change(cartId, conversation, connection, 'create_cart', () => ({ payload }));
  }

  /** Replace a cart's lines (full replacement from the latest answer, reusing the merchant's line ids). */
  async update(
    conversation: string,
    cartId: string,
    input: readonly LineInput[],
  ): Promise<CartResult> {
    if (!this.ownerSpoke(conversation)) return { ok: false, reason: 'no_owner_turn' };
    const { deps } = this;
    const settled = await this.settleCreate(conversation, cartId);
    if (!settled.ok) return settled;
    const row = settled.row;
    const targets = lineTargets(deps.search, conversation, input);
    if (!targets.ok) return targets;
    if (targets.merchant !== row.merchant_origin) return { ok: false, reason: 'one_merchant' };
    const opened = await this.open(row.merchant_origin);
    if (!opened.ok) return opened;
    const settings = deps.settings();
    const lines = await freshLines(opened.connection, settings, input, targets.list);
    if (!lines.ok) return lines;
    deps.search.touchHandles(
      conversation,
      input.map((l) => l.variant),
      deps.nowMs(),
    );
    return this.change(cartId, conversation, opened.connection, 'update_cart', () => {
      // Under the slot, from the cart as it stands now.
      const fresh = deps.store.getCart(cartId);
      const last = fresh === null ? null : this.lastCart(fresh);
      if (fresh?.state !== 'open' || fresh.merchant_cart_id === null || last === null) return null;
      return {
        id: fresh.merchant_cart_id,
        payload: buildUpdateCartBody(lines.lines, settings.context, last),
      };
    });
  }

  /** End a cart at the merchant. */
  async cancel(conversation: string, cartId: string): Promise<CartResult> {
    if (!this.ownerSpoke(conversation)) return { ok: false, reason: 'no_owner_turn' };
    const settled = await this.settleCreate(conversation, cartId);
    if (!settled.ok) return settled;
    const opened = await this.open(settled.row.merchant_origin);
    if (!opened.ok) return opened;
    return this.change(cartId, conversation, opened.connection, 'cancel_cart', () => {
      const fresh = this.deps.store.getCart(cartId);
      return fresh?.state === 'open' && fresh.merchant_cart_id !== null
        ? { id: fresh.merchant_cart_id }
        : null;
    });
  }

  /** Read a cart from the merchant again; one it no longer knows, or past its expiry, is gone. */
  async read(conversation: string, cartId: string): Promise<CartResult> {
    const { deps } = this;
    const settled = await this.settleCreate(conversation, cartId);
    if (!settled.ok) return settled;
    const now = deps.nowMs();
    if (settled.row.expires_at !== null && settled.row.expires_at <= now) {
      this.gone(cartId);
      return { ok: false, reason: 'cart_gone' };
    }
    const opened = await this.open(settled.row.merchant_origin);
    if (!opened.ok) return opened;
    // A change still open is settled first, under its own gate: its answer is the cart.
    const earlier = await this.resumeEarlier(cartId, opened.connection);
    let row = deps.store.getCart(cartId) as CartRow;
    if (row.state === 'gone') return { ok: false, reason: 'cart_gone' };
    if (earlier !== null && earlier.kind !== 'answered' && earlier.kind !== 'abandoned')
      return { ok: true, cart: this.view(row, conversation), outcome: 'pending' };
    const seen = row.last_answer_json;
    const answer = await opened.connection.call('get_cart', { id: row.merchant_cart_id as string });
    if (isNotFound(answer)) {
      this.gone(cartId);
      return { ok: false, reason: 'cart_gone' };
    }
    const cart = answer.ok ? readCart(answer.value) : null;
    if (cart === null || !cart.ok || !answer.ok)
      // No answer to trust: the cart as last known, not called settled.
      return { ok: true, cart: this.view(row, conversation), outcome: 'pending' };
    // Written only if no change's answer was stored while this read ran.
    deps.store.setCartAnswerIfUnchanged(cartId, seen, deps.nowMs(), {
      expires_at: cart.value.expiresAt ?? null,
      last_answer_json: JSON.stringify(answer.value),
    });
    row = deps.store.getCart(cartId) as CartRow;
    deps.search.touchHandles(conversation, this.lineHandles(row, conversation), deps.nowMs());
    return { ok: true, cart: this.view(row, conversation), outcome: 'settled' };
  }

  /** A cart changes only on the owner's own request in this conversation (Silence First). */
  private ownerSpoke(conversation: string): boolean {
    const turn = this.deps.ownerTurn(conversation);
    return turn !== null && this.deps.nowMs() - turn <= OWNER_TURN_LIVE_MS;
  }

  // ------------------------------------------------------------ changes

  /**
   * Send one change, waiting (briefly) for another change on the cart or the
   * merchant's Retry-After: an earlier change still open is resumed first
   * under its own gate; this one is sent only once that settles.
   */
  private async change(
    cartId: string,
    conversation: string,
    connection: MerchantConnection,
    operation: CartOperation,
    build: Mutation['build'],
  ): Promise<CartResult> {
    const { deps } = this;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = deps.nowMs() + WAIT_MS;
    let pause = 50;
    for (;;) {
      const result: MutateResult = await deps.dispatcher.mutate(
        { kind: 'cart', id: cartId },
        connection,
        { operation, build, retryDeadline: deps.nowMs() + CART_RETRY_MS },
        this.gateFor(cartId, operation),
      );
      let waitMs: number;
      if (result.kind === 'busy') waitMs = pause;
      else if (result.kind === 'earlier') {
        const earlier = await this.resumeEarlier(cartId, connection);
        // Settled or ended: try this change again at once. Anything else holds it.
        if (earlier === null || earlier.kind === 'answered' || earlier.kind === 'abandoned')
          continue;
        if (earlier.kind === 'busy') waitMs = pause;
        else if (earlier.kind === 'wait') waitMs = earlier.retryAfterMs;
        else if (earlier.kind === 'in_doubt' && earlier.retryAfterMs !== undefined)
          waitMs = earlier.retryAfterMs;
        else return { ok: false, reason: 'busy' };
      } else return this.finish(cartId, conversation, result);
      if (deps.nowMs() + waitMs > until) return { ok: false, reason: 'busy' };
      await sleep(waitMs);
      pause = Math.min(pause * 2, 1_000);
    }
  }

  /** Resend the cart's open request, if any, under the gate of its own operation. */
  private async resumeEarlier(
    cartId: string,
    connection: MerchantConnection,
  ): Promise<Outcome | { kind: 'busy' } | null> {
    const open = this.deps.store.openRequest('cart', cartId);
    if (open === null) return null;
    return this.deps.dispatcher.resume(
      { kind: 'cart', id: cartId },
      connection,
      this.gateFor(cartId, open.operation as CartOperation),
    );
  }

  /** The gate of one cart operation: the state it is sent in, and what its answer does. */
  private gateFor(cartId: string, operation: CartOperation): Gate {
    const { store, nowMs } = this.deps;
    const state = () => store.getCart(cartId)?.state;
    const from: CartRow['state'] = operation === 'create_cart' ? 'creating' : 'open';
    return {
      admitFirst: () => state() === from,
      admitResend: () => state() === from,
      apply: (_row: RequestRow, answer: CallResult) => {
        const now = nowMs();
        if (operation === 'cancel_cart') {
          // Cancelled, or already unknown to the merchant: gone. A refusal leaves it as it was.
          if (answer.ok || isNotFound(answer)) store.moveCart(cartId, ['open'], 'gone', now);
          return;
        }
        const cart = answer.ok ? readCart(answer.value) : null;
        if (cart !== null && cart.ok && answer.ok) {
          store.moveCart(cartId, [from], 'open', now, {
            merchant_cart_id: cart.value.id,
            expires_at: cart.value.expiresAt ?? null,
            last_answer_json: JSON.stringify(answer.value),
          });
          return;
        }
        // A create refused, or an answer Dina cannot read as a cart: no cart to use. An update
        // refused leaves the cart as it was, unless the merchant no longer knows it.
        if (operation === 'create_cart' || isNotFound(answer) || answer.ok)
          store.moveCart(cartId, [from], 'gone', now);
      },
      abandon: (_row, _reason, sent) => {
        const now = nowMs();
        // A create that will not settle: no cart Dina can name (one may exist at the merchant).
        if (operation === 'create_cart') store.moveCart(cartId, ['creating'], 'gone', now);
        // A cancel that may have been sent: the cart is not Dina's to use any more.
        else if (operation === 'cancel_cart' && sent) store.moveCart(cartId, ['open'], 'gone', now);
        // An update that will not settle: the next read asks the merchant for the cart.
      },
    };
  }

  private finish(cartId: string, conversation: string, result: MutateResult): CartResult {
    const row = this.deps.store.getCart(cartId) as CartRow;
    if (result.kind === 'busy') return { ok: false, reason: 'busy' };
    if (result.kind === 'not_sent')
      return { ok: false, reason: 'carts_unavailable', detail: result.reason };
    if (result.kind === 'answered' && !result.result.ok)
      // A cart the merchant no longer knows is gone; any other refusal says so, with its code.
      return isNotFound(result.result) && result.request.operation !== 'create_cart'
        ? { ok: false, reason: 'cart_gone' }
        : { ok: false, reason: 'refused', detail: refusalCode(result.result) };
    // Cancelled: done, and the cart is gone.
    if (result.kind === 'answered' && result.request.operation === 'cancel_cart')
      return { ok: true, cart: this.view(row, conversation), outcome: 'settled' };
    // Not admitted, an answer that is no cart, or a change that ended unsettled with it.
    if (row.state === 'gone' || result.kind === 'not_admitted')
      return { ok: false, reason: 'cart_gone' };
    return {
      ok: true,
      cart: this.view(row, conversation),
      outcome: result.kind === 'answered' ? 'settled' : 'pending',
    };
  }

  /**
   * A cart that is gone here: its open request (if any) is abandoned under its
   * own gate first, so no journal row waits on a cart nobody will use again.
   */
  private gone(cartId: string): void {
    const open = this.deps.store.openRequest('cart', cartId);
    if (open !== null)
      this.deps.dispatcher.abandonOpen(
        { kind: 'cart', id: cartId },
        this.gateFor(cartId, open.operation as CartOperation),
        'gate_closed',
      );
    this.deps.store.moveCart(cartId, ['creating', 'open'], 'gone', this.deps.nowMs());
  }

  /**
   * End the journal rows of carts past their retry deadline: they can never
   * be sent again, and once ended they go 48 hours later.
   */
  sweep(): void {
    const { store, dispatcher, nowMs } = this.deps;
    for (const row of store.staleOpenRequests('cart', nowMs()))
      dispatcher.abandonOpen(
        { kind: 'cart', id: row.owner_id },
        this.gateFor(row.owner_id, row.operation as CartOperation),
        'deadline',
      );
  }

  // ------------------------------------------------------------ internals

  /**
   * The cart, after its create has settled: a create still open is resumed;
   * a cart still `creating` with nothing open never got its answer, and is gone.
   */
  private async settleCreate(
    conversation: string,
    cartId: string,
  ): Promise<{ ok: true; row: CartRow } | { ok: false; reason: CartRefusal }> {
    const { deps } = this;
    let row = deps.store.getCart(cartId);
    // Another conversation's cart reads as no cart at all.
    if (row === null || row.conversation !== conversation)
      return { ok: false, reason: 'unknown_cart' };
    if (row.state === 'creating') {
      const opened = await this.open(row.merchant_origin);
      if (!opened.ok) return opened;
      const earlier = await this.resumeEarlier(cartId, opened.connection);
      row = deps.store.getCart(cartId) as CartRow;
      if (row.state === 'creating') {
        if (earlier === null) {
          deps.store.moveCart(cartId, ['creating'], 'gone', deps.nowMs());
          return { ok: false, reason: 'cart_gone' };
        }
        return { ok: false, reason: 'busy' };
      }
    }
    return row.state === 'gone' ? { ok: false, reason: 'cart_gone' } : { ok: true, row };
  }

  private async open(
    merchant: string,
  ): Promise<{ ok: true; connection: MerchantConnection } | { ok: false; reason: CartRefusal }> {
    const notReady = this.deps.client.notReady();
    if (notReady !== null) return { ok: false, reason: notReady };
    const opened = await this.deps.client.open(merchant);
    return opened.ok
      ? { ok: true, connection: opened.connection }
      : { ok: false, reason: 'merchant_unreachable' };
  }

  private lastCart(row: CartRow): Cart | null {
    if (row.last_answer_json === null) return null;
    // The stored answer is read back through the same reader as a live one.
    const json = parseStrictJson(row.last_answer_json);
    const parsed = json.ok ? readCart(json.value) : null;
    return parsed?.ok === true ? parsed.value : null;
  }

  /** The handles of the cart's lines Brain knows. */
  private lineHandles(row: CartRow, conversation: string): string[] {
    return (this.lastCart(row)?.lineItems ?? [])
      .map((l) => this.deps.search.variantHandle(conversation, row.merchant_origin, l.itemId))
      .filter((h): h is string => h !== null);
  }

  /** The cart as Brain reads it: handles, quantities, minor-unit amounts; no merchant text. */
  private view(row: CartRow, conversation: string): CartView {
    const { search, nowMs } = this.deps;
    const last = this.lastCart(row);
    const currency = last?.currency ?? '';
    return {
      cart_id: row.cart_id,
      merchant: search.handle(
        conversation,
        { kind: 'merchant', merchantOrigin: row.merchant_origin, value: row.merchant_origin },
        nowMs(),
      ),
      state: row.state,
      lines: (last?.lineItems ?? []).map((l) => ({
        // A line whose variant Brain never saw (the merchant added it) has no handle.
        variant: search.variantHandle(conversation, row.merchant_origin, l.itemId) ?? '',
        quantity: Number(l.quantity),
        price: { amount: String(l.unitPrice), currency },
      })),
      // A merchant's own total label is its text: only the spec's types reach Brain.
      totals: (last?.totals ?? []).map((t) => ({
        type: isWellKnownTotalType(t.type) ? t.type : 'other',
        amount: String(t.amount),
        currency,
      })),
      ...(row.expires_at !== null ? { expires_at: row.expires_at } : {}),
    };
  }
}
