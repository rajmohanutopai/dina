/**
 * The two reference Commerce Pack manifests (§8.1 Supplier, §8.2 Buyer).
 *
 * WHY THEY LIVE IN THE PRODUCT RATHER THAN IN A TEST. A manifest is the
 * contract a plugin publishes: it declares which capabilities exist, what
 * params they take, what results they return, and what authority they ask
 * for. §24 Phase 1 cannot be demonstrated without two of them, and a pair
 * that only ever existed inside a `.test.ts` would be a pair nothing else
 * could install, review, or diff — the scenario would pass while the
 * artefact the spec asks for did not exist.
 *
 * These are REFERENCE manifests, not the shipped Commerce Pack. They declare
 * the capability surface §9.9–§9.11 requires and nothing else, so they can
 * serve as the worked example a third-party pack is written against (§25.1
 * "third-party pack via the conformance kit") and as the fixture the
 * end-to-end procurement scenario installs.
 *
 * TWO DELIBERATE OMISSIONS, stated so their absence is not read as an
 * oversight:
 *
 *   - No `host_operations`. Every operation a supplier needs here is Core's
 *     own commerce lane; the §3.4 broker is for reaching OUTSIDE (an ERP, a
 *     connector), and a reference manifest that asked for that authority
 *     without using it would teach the wrong default.
 *   - No `network_domains`. These runners answer from the owner's own data.
 *     A pack that calls an external inventory system declares its domains;
 *     this one has none to declare, and §17 is explicit that the field is
 *     consent-card transparency rather than a firewall.
 *
 * `privacy_class` is `personal` throughout, not `public`. Commercial terms
 * and a counterparty's identity are owner-scoped private data even when the
 * owner is a business: the §5 vocabulary has no `business` class, and
 * `public` would be a claim that this data may leave without gating.
 *
 * The SUPPLIER capabilities are `kinds: ['provider']` — they answer inbound
 * D2D queries from a buyer. The BUYER capabilities are `kinds: ['tool']` —
 * the owner drives them. That split is not cosmetic: the claim guard refuses
 * a provider task riding a tool consent and the reverse, so getting it wrong
 * makes the pack uninstallable for its own purpose rather than silently
 * over-privileged.
 */

import { PLUGIN_NSIDS, type PluginManifest } from '@dina/protocol';

/**
 * §9.2 quantity, as a pinned schema. Repeated by value rather than shared by
 * reference because the manifest validator bans `$ref` (§5 rule 4) — a
 * schema a node cannot resolve locally is a schema it cannot check.
 */
const QUANTITY_SCHEMA = {
  type: 'object',
  required: ['value', 'unit_code'],
  properties: {
    value: { type: 'string' },
    unit_code: { type: 'string' },
  },
} as const;

const MONEY_SCHEMA = {
  type: 'object',
  required: ['currency', 'minor_units'],
  properties: {
    currency: { type: 'string' },
    minor_units: { type: 'string' },
  },
} as const;

/**
 * What a supplier runner is asked when a buyer wants a price.
 *
 * `quote_request` travels whole rather than field-by-field: the request is
 * digest-bound (§9.7) and a runner that received a reshaped copy could not
 * verify it was answering the request the buyer actually signed.
 */
const QUOTE_PARAMS = {
  type: 'object',
  required: ['request_id', 'lines'],
  properties: {
    request_id: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        required: ['line_id', 'product', 'quantity'],
        properties: {
          line_id: { type: 'string' },
          product: {
            type: 'object',
            required: ['scheme', 'value'],
            properties: { scheme: { type: 'string' }, value: { type: 'string' } },
          },
          quantity: QUANTITY_SCHEMA,
        },
      },
    },
  },
} as const;

/**
 * The runner's answer is its COMMERCIAL decision, not a signed quote.
 *
 * Core signs. A runner that returned a `SignedQuote` would be claiming an
 * authority it does not hold — it has no key, no ledger, and no view of how
 * much capacity a quote may grant. So it returns terms, and Core turns terms
 * into a signed quote with a use counter (§9.8).
 */
const QUOTE_RESULT = {
  type: 'object',
  required: ['can_supply', 'lines'],
  properties: {
    can_supply: { type: 'boolean' },
    decline_reason: { type: 'string' },
    valid_until: { type: 'string' },
    max_uses: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        required: ['line_id', 'unit_price', 'quantity'],
        properties: {
          line_id: { type: 'string' },
          unit_price: MONEY_SCHEMA,
          quantity: QUANTITY_SCHEMA,
        },
      },
    },
  },
} as const;

/**
 * §9.9 — the runner decides whether to TAKE the business, nothing else.
 *
 * Idempotency, quote capacity and the reservation are settled in compiled
 * Core before this capability is ever dispatched, so the params carry the
 * order's identity and the result carries a decision. A runner cannot
 * accept twice, cannot accept against spent capacity, and cannot mint an
 * acknowledgement: `transformInboundOrderResult` replaces whatever it says
 * with the acknowledgement Core signed.
 */
const SUBMIT_ORDER_PARAMS = {
  type: 'object',
  required: ['purchase_order_id', 'order_digest'],
  properties: {
    purchase_order_id: { type: 'string' },
    order_digest: { type: 'string' },
    quote_id: { type: 'string' },
    approved_total: MONEY_SCHEMA,
  },
} as const;

/**
 * The discriminant is `kind`, matching the protocol's `SupplierDecision`
 * union and the acknowledgement's own `kind` — NOT a manifest-local word.
 *
 * The first version of this file called it `decision`. Nothing rejected that:
 * the manifest validated, the runner SDK accepted an answer shaped to it, and
 * the schema check passed. It failed only at the seam that actually reads the
 * answer (`readDecision`), which looks for `kind` — so a CONFORMING supplier
 * plugin could never decide an order, and the buyer got the runner's raw
 * words instead of a signed acknowledgement. Two sides of one contract,
 * agreeing with themselves and not with each other; the end-to-end scenario
 * is what caught it, and `reference_manifests.test.ts` now pins them together.
 *
 * The per-kind requirements (`accepted` needs `supplier_order_id`, `rejected`
 * needs `reason_code`) are NOT expressible in the pinned-schema subset, which
 * has no conditional required. They are enforced where they can be, in
 * `readDecision`, and named here so a pack author reads them with the schema
 * rather than discovering them from a refusal.
 */
const SUBMIT_ORDER_RESULT = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['accepted', 'rejected', 'counterproposal'] },
    /** Required when `kind` is `accepted`. */
    supplier_order_id: { type: 'string' },
    /** Required when `kind` is `rejected`. */
    reason_code: { type: 'string' },
  },
} as const;

const ORDER_SCOPED_PARAMS = {
  type: 'object',
  required: ['purchase_order_id'],
  properties: { purchase_order_id: { type: 'string' } },
} as const;

/**
 * §9.11 — the buyer says WHERE ITS CHAIN ENDS, and gets the records after it.
 *
 * A status answer carrying only the head is unverifiable by anyone who missed
 * a step: the receiver's succession check needs each record's predecessor, so
 * a buyer holding sequence 2 and handed sequence 5 can neither link it nor
 * call it a fork with any confidence. Asking from a known point is what makes
 * the chain checkable rather than merely present.
 *
 * DECLARED HERE, not merely sent. Brain strips undeclared fields before
 * dispatch, so a parameter the manifest does not name arrives absent — the
 * same defect `CANCEL_PARAMS` below records, and the reason this schema is
 * separate from `ORDER_SCOPED_PARAMS` rather than an addition to it.
 *
 * OPTIONAL, because a buyer with no chain and a buyer that has lost one both
 * mean "from the beginning", and the absent value already says that.
 */
const STATUS_PARAMS = {
  type: 'object',
  required: ['purchase_order_id'],
  properties: {
    purchase_order_id: { type: 'string' },
    since_sequence: { type: 'string' },
  },
} as const;

const STATUS_RESULT = {
  type: 'object',
  required: ['state'],
  properties: {
    state: {
      type: 'string',
      enum: [
        'accepted',
        'preparing',
        'partially_fulfilled',
        'dispatched',
        'delivered',
        'cancelled',
        'disputed',
        'rejected',
      ],
    },
    supplier_order_id: { type: 'string' },
    // Suppliers enrich a status with what only they know. This is exactly
    // why `order_status` routes to the runner rather than being answered
    // from Core's chain: the published result shape is the SUPPLIER's.
    carrier_reference: { type: 'string' },
    note: { type: 'string' },
  },
} as const;

/**
 * §12.8 — the FULL cancellation request, because Brain strips undeclared
 * fields before dispatch.
 *
 * `ORDER_SCOPED_PARAMS` declared only `purchase_order_id`, so a real
 * `CancellationRequest` arrived at Core with its version, cancellation id,
 * order digest, idempotency key and its own digest removed — every field the
 * atomic resolver needs to bind and replay it. Declaring less than the
 * protocol carries does not narrow the surface; it silently guts the request.
 */
const CANCEL_PARAMS = {
  type: 'object',
  required: [
    'protocol_version',
    'cancellation_id',
    'purchase_order_id',
    'order_digest',
    'idempotency_key',
    'issued_at',
    'cancellation_digest',
  ],
  properties: {
    protocol_version: { type: 'string' },
    cancellation_id: { type: 'string' },
    purchase_order_id: { type: 'string' },
    order_digest: { type: 'string' },
    reason_code: { type: 'string' },
    idempotency_key: { type: 'string' },
    issued_at: { type: 'string' },
    cancellation_digest: { type: 'string' },
  },
} as const;

/**
 * What the RUNNER answers: a policy opinion, not the outcome.
 *
 * Core replaces this with the persisted `CancellationResult` before the buyer
 * sees anything (`settleInboundCancellation`). The shapes differ deliberately
 * — the runner says what this business WANTS, and only Core knows whether
 * dispatch already won the race.
 */
const CANCEL_RESULT = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['cancelled', 'refused_policy', 'pending_review'] },
    reason: { type: 'string' },
  },
} as const;

/**
 * §8.1 — the Supplier pack. Answers a buyer's inbound queries.
 *
 * `action_class` is per capability and drives the gatekeeper floor: quoting
 * and reading status commit to nothing, while taking an order and ruling on a
 * cancellation both change what this business owes someone. Declaring them
 * all `read` would be the cheap lie that makes every commerce action pass
 * silently.
 */
export const SUPPLIER_REFERENCE_MANIFEST: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.dinakernel.commerce.supplier',
  version: '1.0.0',
  display_name: 'Commerce — Supplier',
  short_description: 'Answer buyers: quote, take orders, report status, rule on cancellations.',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.dinakernel.commerce.request-quote',
      display_name: 'Quote a buyer request',
      interaction: 'query',
      // `quote` rather than `read`: the §5 vocabulary has a class for
      // exactly this, and pricing is not the same risk as reading a status.
      action_class: 'quote',
      privacy_class: 'personal',
      kinds: ['provider'],
      // A quote has no external effect, so replaying one is free.
      effects: { idempotency: 'supported' },
      params_schema: QUOTE_PARAMS,
      result_schema: QUOTE_RESULT,
    },
    {
      id: 'com.dinakernel.commerce.submit-order',
      display_name: 'Decide an incoming order',
      interaction: 'query',
      // §5 vocabulary: `write`, not a `read`. Taking an order commits this
      // business to supplying goods — the one capability here whose answer
      // creates an obligation, and the gatekeeper floor should reflect that.
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['provider'],
      // `supported` is a PROMISE, and this one is kept by Core rather than by
      // the runner: admission is idempotent on the order's own key, so a
      // retried submission replays its original acknowledgement instead of
      // reaching the runner twice (§9.9, §15.5).
      effects: { idempotency: 'supported' },
      params_schema: SUBMIT_ORDER_PARAMS,
      result_schema: SUBMIT_ORDER_RESULT,
    },
    {
      id: 'com.dinakernel.commerce.order-status',
      display_name: 'Report order status',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'personal',
      kinds: ['provider'],
      effects: { idempotency: 'supported' },
      params_schema: STATUS_PARAMS,
      result_schema: STATUS_RESULT,
    },
    {
      id: 'com.dinakernel.commerce.cancel-order',
      display_name: 'Rule on a cancellation request',
      interaction: 'query',
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['provider'],
      // Cancellation is idempotent on `cancellation_id`: a repeat returns the
      // recorded result rather than re-running policy (§12.8).
      effects: { idempotency: 'supported' },
      params_schema: CANCEL_PARAMS,
      result_schema: CANCEL_RESULT,
    },
  ],
} as unknown as PluginManifest;

/**
 * §8.2 — the Buyer pack. Driven by its own owner, never by a peer.
 *
 * Every capability is `kinds: ['tool']`. A buyer pack that also declared
 * `provider` would be advertising itself as answerable by strangers, which
 * is the opposite of what a buyer is.
 */
export const BUYER_REFERENCE_MANIFEST: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.dinakernel.commerce.buyer',
  version: '1.0.0',
  display_name: 'Commerce — Buyer',
  short_description: 'Ask suppliers for prices, compare offers, and place an approved order.',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.dinakernel.commerce.collect-quotes',
      display_name: 'Ask suppliers for a price',
      interaction: 'query',
      action_class: 'quote',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      params_schema: QUOTE_PARAMS,
      result_schema: {
        type: 'object',
        required: ['offers'],
        properties: {
          offers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['supplier_did', 'quote_id'],
              properties: {
                supplier_did: { type: 'string' },
                quote_id: { type: 'string' },
                total: MONEY_SCHEMA,
                // §13.4 — an offer that could not be scored says WHY rather
                // than being dropped. A comparison silently missing a
                // supplier is a comparison the owner cannot trust.
                unscorable_reason: { type: 'string' },
              },
            },
          },
        },
      },
    },
    {
      id: 'com.dinakernel.commerce.place-order',
      display_name: 'Place an approved order',
      interaction: 'query',
      // §15.2 — the owner approves ONE canonical payload and this executes
      // exactly that. `write` is what puts it behind an approval card.
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['tool'],
      // `unsupported`, and this is the interesting one. Placing an order is
      // an effect on ANOTHER party's node, and §15.5 asks that party to
      // deduplicate — but this buyer cannot verify that they do. Declaring
      // `supported` would authorise Core to auto-retry on the strength of a
      // promise nobody here can keep, and a duplicated order is exactly the
      // harm §12.7 exists to avoid. Declaring `unsupported` means an
      // interrupted attempt surfaces as `outcome_unknown` and is reconciled
      // honestly instead of being replayed hopefully.
      effects: { idempotency: 'unsupported' },
      params_schema: {
        type: 'object',
        required: ['quote_id', 'supplier_did'],
        properties: {
          quote_id: { type: 'string' },
          supplier_did: { type: 'string' },
          buyer_reference: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['purchase_order_id', 'outcome'],
        properties: {
          purchase_order_id: { type: 'string' },
          outcome: { type: 'string', enum: ['accepted', 'rejected', 'countered', 'unresolved'] },
        },
      },
    },
    {
      id: 'com.dinakernel.commerce.track-order',
      display_name: 'Check on an order',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      params_schema: STATUS_PARAMS,
      result_schema: STATUS_RESULT,
    },
  ],
} as unknown as PluginManifest;
