/**
 * The UCP buying tools (UCP plan §3.7, §3.8, §4.3 U2): Brain builds carts and
 * proposes checkouts, by the handles it saw in a search (v1.2) and step
 * counts. Core maps handles to the merchant's ids; nothing here ever names a
 * merchant id, URL or token, and nothing a merchant wrote comes back (its
 * messages read by code, their text withheld; its delivery offers by `c1`,
 * `c2` and their cost).
 *
 *  - `ucp_cart`: build, change, cancel or read a cart. Browsing only.
 *  - `start_ucp_checkout`: ask to open a checkout. Core raises the owner's
 *    start card and answers at once: nothing opens until the owner says yes
 *    on that card (Dina never decides it).
 *  - `get_ucp_checkout`: read it: its state, lines, totals and offers.
 *  - `choose_ucp_delivery`: pick one of the merchant's delivery offers.
 *  - `hand_off_ucp_checkout`: raise the owner's "review and pay" card once the
 *    checkout is ready. The owner pays on the merchant's own page, in person;
 *    Dina never pays and never completes a checkout.
 *  - `cancel_ucp_checkout`: end a checkout that was not handed off.
 * Logs carry operations, states and counts only.
 */

import { formatMoney } from '@dina/core';

import type { AgentTool } from './tool_registry';
import type { CoreClient, UcpLineInput, UcpShopResult } from '@dina/core';

export type UcpShopCoreClient = Pick<CoreClient, 'ucpCart' | 'ucpCheckout'>;

export interface UcpShopToolOptions {
  core: UcpShopCoreClient;
  /** The conversation the tools serve (`chat:<thread>` or `ask:<id>`). */
  releaseSession: string;
  logger?: (entry: Record<string, unknown>) => void;
}

const DATA_NOTE =
  'Name products by the handles a search gave (v1.2) and quantities in the unit’s steps. Merchant messages are given by code only; their text is withheld. Delivery offers are c1, c2… with their kind and cost; their names (which store, which day) are withheld, so offers that differ only by name cannot be told apart here: choose one only when the owner’s words settle it by kind or cost, otherwise leave the shop’s own choice (`chosen`) and let the owner see and change it on the shop’s page. Dina never pays: the owner reviews and pays on the merchant’s own page.';

const REFUSAL_NOTES: Record<string, string> = {
  no_lines: 'Name at least one product variant.',
  too_many_lines: 'A cart or checkout holds at most 50 lines.',
  unknown_variant: 'A variant handle is not one seen in this conversation. Search first.',
  one_merchant: 'All lines must be at one shop. Start one checkout per shop.',
  merchant_not_allowed: 'That shop is not one the owner allows. Choose from their allowed shops.',
  variant_gone: 'The shop no longer offers one of those variants. Search again.',
  bad_quantity:
    'A quantity is not a whole number of the unit’s step (or a variant was named twice). Check the unit.',
  bad_discount_code: 'A discount code was empty, too long or had odd characters.',
  carts_unavailable: 'This shop does not offer carts through UCP.',
  checkout_unavailable: 'This shop does not offer checkout through UCP.',
  price_unreadable:
    'A price at this shop could not be shown to the owner, so it cannot be approved.',
  no_owner_turn:
    'Carts and checkouts change only on the owner’s own request in this conversation. Ask them what they want.',
  start_declined:
    'The owner declined a checkout here. Do not propose another unless they bring it up themselves.',
  too_many_starts:
    'Three checkouts already wait on the owner’s approval in this conversation. Let them decide first.',
  unknown_cart: 'No such cart in this conversation.',
  unknown_session: 'No such checkout in this conversation.',
  cart_gone: 'The cart is gone (ended, expired, or unknown to the shop). Offer to build it again.',
  session_closed:
    'The checkout is past this step (declined, handed off, ended, or its approval lapsed). Read it with get_ucp_checkout.',
  outside_permit:
    'That change is not one the owner approved. Changing items, quantities or codes needs a new checkout.',
  checkout_changed: 'The checkout changed since you read it. Read it again, then choose.',
  not_settled:
    'An earlier change is still being confirmed with the shop. Try the hand-off again shortly; tell the owner.',
  answer_unreadable: 'The shop’s answer could not be read faithfully. Try again shortly.',
  refused: 'The shop refused that change.',
  busy: 'Another change to this is still in progress. Try again shortly.',
  ucp_not_ready: 'Shopping is not available while Dina is locked.',
  ucp_key_pending:
    'Shopping is not ready yet: this Dina’s shopping profile is not published (its profile host may be out of reach), so no shop could check its requests. Tell the owner; it starts working once the profile is published, and Settings → Shopping shows its state.',
  ucp_unavailable: 'Shopping through online shops is not turned on for this Dina.',
  merchant_unreachable: 'The shop could not be reached. Try again later.',
  no_workflow: 'Dina is still starting up. Try again shortly.',
};

/** Refusal codes a linked account answers (identity-linking §identity_required, §insufficient_scope). */
const LINK_CODES = new Set(['identity_required', 'insufficient_scope']);
const LINK_NOTE =
  'The shop asks the owner to link their account there first. Tell them to open Settings, Linked accounts, and link it; then try again.';

/** The state of a checkout as the model should read it. */
const STATE_NOTES: Record<string, string> = {
  awaiting_approval:
    'Waiting for the owner to approve starting this checkout on their card. Nothing has been sent to the shop.',
  creating: 'Approved; the shop is opening the checkout.',
  open: 'Open at the shop. Choose a delivery offer if needed, then hand it off for the owner to review and pay.',
  handed_off:
    'Handed to the owner: they review and pay on the shop’s own page. Dina does nothing more with it.',
  declined: 'The owner declined, or the card lapsed. Do not ask again unless they bring it up.',
  stale: 'The shop changed its terms since the owner approved. Propose the checkout again.',
  lapsed:
    'The approval ran out before the checkout was opened. Propose it again if the owner still wants it.',
  create_failed: 'The shop refused to open the checkout (an item may be out of stock).',
  create_unknown:
    'Dina cannot tell whether the shop opened the checkout. Tell the owner; they may check at the shop.',
  unsettled:
    'A change could not be confirmed with the shop, so this checkout cannot be handed off. Tell the owner.',
  canceled: 'Cancelled.',
  completed: 'Completed at the shop. The order is in My Orders.',
  // Never a claim that nothing was bought (UCP plan §3.12): the owner may have paid on
  // another session the shop made.
  not_completed:
    'The shop no longer shows this checkout as completed. If the owner paid anyway, the shop’s email has the order.',
  unknown:
    'Dina can’t see whether the owner bought this at the shop. Tell them to check their email from the shop.',
};

function lineArgs(v: unknown): UcpLineInput[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((l) =>
    l !== null &&
    typeof l === 'object' &&
    typeof (l as { variant?: unknown }).variant === 'string' &&
    typeof (l as { quantity?: unknown }).quantity === 'number'
      ? [{ variant: (l as UcpLineInput).variant, quantity: (l as UcpLineInput).quantity }]
      : [],
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Amounts read in the currency's own decimals beside the minor units. */
function withShown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withShown);
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = withShown(v);
  if (typeof o.amount === 'string' && typeof o.currency === 'string' && /^\d+$/.test(o.amount)) {
    try {
      out.shown = formatMoney({ currency: o.currency, minor_units: o.amount });
    } catch {
      /* an amount the formatter refuses keeps its minor units only */
    }
  }
  return out;
}

function answer(
  opts: UcpShopToolOptions,
  op: string,
  result: UcpShopResult,
): Record<string, unknown> {
  if (!result.ok) {
    opts.logger?.({ ucp_shop: op, ok: false, reason: result.reason });
    return {
      status: 'refused',
      reason: result.reason,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      note:
        // The shop asks for a linked account (UCP plan §3.17): Core has offered it to the owner.
        result.reason === 'refused' && LINK_CODES.has(result.detail ?? '')
          ? LINK_NOTE
          : (REFUSAL_NOTES[result.reason] ?? 'That could not be done.'),
    };
  }
  const checkout = result.body.checkout as Record<string, unknown> | undefined;
  const state = typeof checkout?.state === 'string' ? checkout.state : undefined;
  opts.logger?.({ ucp_shop: op, ok: true, ...(state !== undefined ? { state } : {}) });
  return {
    status: 'ok',
    ...(withShown(result.body) as Record<string, unknown>),
    ...(state !== undefined ? { meaning: STATE_NOTES[state] ?? '' } : {}),
    note: DATA_NOTE,
  };
}

const LINES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      variant: { type: 'string', description: 'A variant handle from a search (v1.2).' },
      quantity: { type: 'integer', description: 'Steps of the variant’s unit (1 for one item).' },
    },
    required: ['variant', 'quantity'],
  },
};

export function createUcpCartTool(opts: UcpShopToolOptions): AgentTool {
  return {
    name: 'ucp_cart',
    description:
      'Build, change, cancel or read a cart at one UCP shop, by variant handles. For browsing: a cart commits to nothing. To buy, use start_ucp_checkout.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'cancel', 'read'] },
        cart_id: { type: 'string', description: 'The cart (for update, cancel, read).' },
        lines: { ...LINES_SCHEMA, description: 'The whole cart (for create and update).' },
      },
      required: ['action'],
    },
    async execute(args) {
      const releaseSession = opts.releaseSession;
      const action = str(args.action);
      const cartId = str(args.cart_id);
      const result =
        action === 'create'
          ? await opts.core.ucpCart({ releaseSession, op: 'create', lines: lineArgs(args.lines) })
          : action === 'update'
            ? await opts.core.ucpCart({
                releaseSession,
                op: 'update',
                cartId,
                lines: lineArgs(args.lines),
              })
            : action === 'cancel' || action === 'read'
              ? await opts.core.ucpCart({ releaseSession, op: action, cartId })
              : ({ ok: false, status: 400, reason: 'bad_action' } as const);
      return answer(opts, `cart_${action}`, result);
    },
  };
}

export function createStartUcpCheckoutTool(opts: UcpShopToolOptions): AgentTool {
  return {
    name: 'start_ucp_checkout',
    description:
      'Ask to start buying at one UCP shop: the exact variants and quantities (and any discount codes the owner gave). This raises a card for the owner to approve; nothing is sent to the shop until they do. Use only when the owner has asked to buy.',
    parameters: {
      type: 'object',
      properties: {
        lines: { ...LINES_SCHEMA, description: 'Exactly what to buy.' },
        discount_codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Codes the owner gave, if any.',
        },
      },
      required: ['lines'],
    },
    async execute(args) {
      const codes = Array.isArray(args.discount_codes)
        ? args.discount_codes.filter((c): c is string => typeof c === 'string')
        : [];
      const result = await opts.core.ucpCheckout({
        releaseSession: opts.releaseSession,
        op: 'propose',
        lines: lineArgs(args.lines),
        ...(codes.length > 0 ? { discountCodes: codes } : {}),
      });
      return answer(opts, 'checkout_propose', result);
    },
  };
}

const SESSION_SCHEMA = {
  type: 'object',
  properties: {
    session_id: { type: 'string', description: 'The checkout, from start_ucp_checkout.' },
  },
  required: ['session_id'],
};

function sessionTool(
  opts: UcpShopToolOptions,
  name: string,
  op: 'view' | 'handoff' | 'cancel',
  description: string,
): AgentTool {
  return {
    name,
    description,
    parameters: SESSION_SCHEMA,
    async execute(args) {
      const result = await opts.core.ucpCheckout({
        releaseSession: opts.releaseSession,
        op,
        sessionId: str(args.session_id),
      });
      return answer(opts, `checkout_${op}`, result);
    },
  };
}

export const createGetUcpCheckoutTool = (opts: UcpShopToolOptions): AgentTool =>
  sessionTool(
    opts,
    'get_ucp_checkout',
    'view',
    'Read a checkout: its state, lines, totals, the shop’s messages (by code) and its delivery offers (c1, c2…).',
  );

export const createHandOffUcpCheckoutTool = (opts: UcpShopToolOptions): AgentTool =>
  sessionTool(
    opts,
    'hand_off_ucp_checkout',
    'handoff',
    'When an open checkout is ready, raise the owner’s card to review and pay on the shop’s own page. After this Dina changes nothing at the shop; the owner pays there, in person.',
  );

export const createCancelUcpCheckoutTool = (opts: UcpShopToolOptions): AgentTool =>
  sessionTool(
    opts,
    'cancel_ucp_checkout',
    'cancel',
    'Cancel an open checkout the owner no longer wants (one not yet handed off).',
  );

export function createChooseUcpDeliveryTool(opts: UcpShopToolOptions): AgentTool {
  return {
    name: 'choose_ucp_delivery',
    description:
      'Choose one of an open checkout’s delivery offers (c1, c2…), as read by get_ucp_checkout, passing that read’s rev. Only when the owner’s words settle which (by kind or cost): offers whose names are withheld cannot be told apart here, and the owner can choose on the shop’s page.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        choice: { type: 'string', description: 'An offer, e.g. c2.' },
        rev: { type: 'string', description: 'The rev from get_ucp_checkout.' },
      },
      required: ['session_id', 'choice', 'rev'],
    },
    async execute(args) {
      const result = await opts.core.ucpCheckout({
        releaseSession: opts.releaseSession,
        op: 'choose',
        sessionId: str(args.session_id),
        choice: str(args.choice),
        rev: str(args.rev),
      });
      return answer(opts, 'checkout_choose', result);
    },
  };
}

/** Every buying tool, for one conversation. */
export function createUcpShopTools(opts: UcpShopToolOptions): AgentTool[] {
  return [
    createUcpCartTool(opts),
    createStartUcpCheckoutTool(opts),
    createGetUcpCheckoutTool(opts),
    createChooseUcpDeliveryTool(opts),
    createHandOffUcpCheckoutTool(opts),
    createCancelUcpCheckoutTool(opts),
  ];
}
