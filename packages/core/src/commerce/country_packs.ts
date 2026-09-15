/**
 * The COUNTRY PACKS (RESEARCHER_KERNEL_ARCHITECTURE.md §5.D — D1 India, D2
 * USA, D5 notification rails): first-party manifests, shipped with the build
 * like the buyer and supplier packs (`reference_manifests.ts`), that declare
 * the RAIL connectors a market needs as runner-mode plugin capabilities.
 *
 * WHY PLUGINS, NOT CORE. The kernel is geography-neutral and never calls an
 * external API (CLAUDE.md). A payment rail, a tax registry, a government
 * filing and a messaging provider are exactly what the plugin substrate
 * exists for: out-of-process code, paired as a device with its own key, whose
 * every answer Core validates against the schema pinned here at consent, and
 * whose credentials live on the operator's machine — never in this repo, never
 * in Core. The manifest is the contract; the runner behind it is the
 * operator's (a `dina-plugin` process holding the provider account), and
 * without one an installed pack simply has no runner to claim its work.
 *
 * WHAT THIS PINS, and what it does not. It pins the shape of each rail's
 * question and answer, its action class (a filing or an outward message is a
 * `write`, a status lookup is a `read`), its privacy class (payment data is
 * `regulated`), idempotency, and the DATA SCOPE — which categories of the
 * owner's data may ride the params (§11.5); a param the caller classifies
 * outside that scope, or cannot classify, always cards. It does NOT pick a provider: the manifest
 * declares no network domains, the consent card lists the rails by name, and
 * which provider the operator's runner talks to is the operator's business,
 * outside this repo. Dina treats every answer as a claim to verify, not a fact.
 *
 * Nothing here moves money. `payment` stays BLOCKED for plugins at every ring
 * (docs/PLUGIN_ARCHITECTURE.md §8); a rail READS a payment's status so the
 * khata can be acknowledged, it never initiates one.
 *
 * D5, the notification rails, ride here as `tool` capabilities Dina invokes
 * (an outward message is an effectful `write`, so it meets the approval gate
 * like any HIGH plugin effect — Silence First applies to reminders too). The
 * substrate's `notify` kind (plugin-originated notices) is not shipped in this
 * Dina (`NODE_SUPPORTED_FEATURES`), and a manifest declaring it is refused as
 * `needs_newer_dina` — correctly, since nothing could dispatch it yet.
 */

import { PLUGIN_NSIDS, type PluginManifest } from '@dina/protocol';

const MONEY_SCHEMA = {
  type: 'object',
  required: ['currency', 'minor_units'],
  properties: {
    currency: { type: 'string' },
    minor_units: { type: 'string' },
  },
} as const;

/** One settled/pending/failed answer shape for every payment-status rail. */
const PAYMENT_STATUS_RESULT = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['settled', 'pending', 'failed', 'unknown'] },
    settled_at: { type: 'string' },
    amount: MONEY_SCHEMA,
    provider_ref: { type: 'string' },
  },
} as const;

const NOTIFY_RESULT = {
  type: 'object',
  required: ['delivered'],
  properties: {
    delivered: { type: 'boolean' },
    message_id: { type: 'string' },
    failure: { type: 'string' },
  },
} as const;

/**
 * §15.6 — the CARD TEMPLATES a rail's answer renders through. Literal text is
 * Dina's own words here (these are first-party packs); a value position is a
 * SLOT naming a field of the same capability's `result_schema`, which the
 * manifest validator checks and the render fills. A field the runner leaves
 * out drops its block, so a pending payment with no settlement time renders a
 * shorter card rather than an empty row.
 *
 * No `link` and no `media`: a plugin answer has no outbound exit (§11), and
 * the renderer drops them whatever a template says.
 */
const PAYMENT_STATUS_CARD = {
  version: 1,
  blocks: [
    { kind: 'title', text: 'Payment status', icon: 'price' },
    { kind: 'stat', value: '{status}', caption: 'as the rail reports it' },
    { kind: 'keyValue', label: 'Settled at', value: '{settled_at}' },
    { kind: 'keyValue', label: 'Provider reference', value: '{provider_ref}' },
  ],
} as const;

const NOTIFY_CARD = {
  version: 1,
  blocks: [
    { kind: 'title', text: 'Message', icon: 'info' },
    { kind: 'keyValue', label: 'Delivered', value: '{delivered}' },
    { kind: 'keyValue', label: 'Message id', value: '{message_id}' },
    { kind: 'keyValue', label: 'Why not', value: '{failure}', tone: 'caution' },
  ],
} as const;

export const COUNTRY_PACK_IDS = {
  in: 'com.dinakernel.country.in',
  us: 'com.dinakernel.country.us',
} as const;

export type CountryPack = keyof typeof COUNTRY_PACK_IDS;

/** Every pack, in the order surfaces list them — derived, so a new pack cannot be left off a screen. */
export const COUNTRY_PACKS: readonly CountryPack[] = Object.keys(COUNTRY_PACK_IDS) as CountryPack[];

/**
 * D1 — India small-commerce rails. The khata engine is built (§4.2/§4.3); these
 * are the connectors the doc names: UPI, GST, e-way bills, WhatsApp reminders.
 */
export const INDIA_PACK_MANIFEST: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: COUNTRY_PACK_IDS.in,
  version: '1.0.0',
  display_name: 'Country pack — India',
  short_description: 'UPI payment status, GSTIN checks, e-way bills and WhatsApp reminders for the khata.',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.dinakernel.country.in.upi-payment-status',
      display_name: 'Check whether a UPI payment settled',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'regulated',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /** What may ride the params (§11.5) — anything else cards. */
      data_scope: { categories: ['payment'] },
      card: PAYMENT_STATUS_CARD,
      params_schema: {
        type: 'object',
        required: ['utr'],
        properties: {
          /** The UPI transaction reference the payer quoted on the payment note. */
          utr: { type: 'string' },
          expected_amount: MONEY_SCHEMA,
        },
      },
      result_schema: PAYMENT_STATUS_RESULT,
    },
    {
      id: 'com.dinakernel.country.in.gstin-validate',
      display_name: 'Validate a GSTIN against the GST registry',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'public',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /**
       * What may ride the params (§11.5) — anything else cards — and what
       * Core's own projection may add (§11): the registrations both sides
       * hold, so a lookup can say which of them it just checked.
       */
      data_scope: { categories: ['business_registry'], max_context_items: 4 },
      card: {
        version: 1,
        blocks: [
          { kind: 'title', text: 'GST registry', icon: 'document' },
          { kind: 'stat', value: '{status}', caption: 'registration status' },
          { kind: 'keyValue', label: 'Registered name', value: '{legal_name}' },
          { kind: 'keyValue', label: 'State code', value: '{state_code}' },
          { kind: 'keyValue', label: 'Valid', value: '{valid}' },
        ],
      },
      params_schema: {
        type: 'object',
        required: ['gstin'],
        properties: { gstin: { type: 'string' } },
      },
      result_schema: {
        type: 'object',
        required: ['valid'],
        properties: {
          valid: { type: 'boolean' },
          legal_name: { type: 'string' },
          state_code: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
    {
      id: 'com.dinakernel.country.in.eway-bill',
      display_name: 'Generate an e-way bill for a delivery',
      interaction: 'query',
      action_class: 'write',
      privacy_class: 'regulated',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /**
       * What may ride the params (§11.5) — anything else cards — and what
       * Core's own projection may add (§11). A bill names two parties and
       * two places, so `address` is declared: the owner sees it on the
       * consent card, which is the point of declaring it.
       */
      data_scope: {
        categories: ['address', 'business_registry', 'delivery', 'tax_filing'],
        max_context_items: 6,
      },
      card: {
        version: 1,
        blocks: [
          { kind: 'title', text: 'E-way bill', icon: 'document' },
          { kind: 'stat', value: '{eway_bill_no}', caption: 'bill number' },
          { kind: 'keyValue', label: 'Valid until', value: '{valid_until}' },
        ],
      },
      params_schema: {
        type: 'object',
        required: ['delivery_note_digest', 'consignor_gstin', 'consignee_gstin', 'value'],
        properties: {
          /** Binds the filing to the retained khata document it describes. */
          delivery_note_digest: { type: 'string' },
          consignor_gstin: { type: 'string' },
          consignee_gstin: { type: 'string' },
          value: MONEY_SCHEMA,
          vehicle_number: { type: 'string' },
          distance_km: { type: 'number' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['eway_bill_no', 'valid_until'],
        properties: {
          eway_bill_no: { type: 'string' },
          valid_until: { type: 'string' },
        },
      },
    },
    {
      id: 'com.dinakernel.country.in.whatsapp-reminder',
      display_name: 'Send a WhatsApp reminder about a due payment or delivery',
      interaction: 'query',
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /**
       * What may ride the params (§11.5) — anything else cards — and what
       * Core's own projection may add (§11): who the reminder is for, never
       * a second copy of the number it dials.
       */
      data_scope: { categories: ['contact', 'delivery', 'payment'], max_context_items: 2 },
      card: NOTIFY_CARD,
      params_schema: {
        type: 'object',
        required: ['to', 'template', 'subject_digest'],
        properties: {
          to: { type: 'string' },
          template: { type: 'string', enum: ['payment_due', 'delivery_dispatched', 'receipt_pending'] },
          /** The khata document the reminder is about — never free text from the runner. */
          subject_digest: { type: 'string' },
          due_at: { type: 'string' },
          amount: MONEY_SCHEMA,
        },
      },
      result_schema: NOTIFY_RESULT,
    },
  ],
};

/**
 * D2 — USA small-business rails: a different model (invoices, net terms,
 * ACH/cards, sales tax) over the same shared protocol and the same money pack.
 */
export const USA_PACK_MANIFEST: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: COUNTRY_PACK_IDS.us,
  version: '1.0.0',
  display_name: 'Country pack — USA',
  short_description: 'ACH and card settlement status, sales-tax rates, invoice terms, and SMS or email notices.',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.dinakernel.country.us.settlement-status',
      display_name: 'Check whether an ACH or card payment settled',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'regulated',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /** What may ride the params (§11.5) — anything else cards. */
      data_scope: { categories: ['payment'] },
      card: PAYMENT_STATUS_CARD,
      params_schema: {
        type: 'object',
        required: ['payment_ref'],
        properties: {
          payment_ref: { type: 'string' },
          rail: { type: 'string', enum: ['ach', 'card'] },
          expected_amount: MONEY_SCHEMA,
        },
      },
      result_schema: PAYMENT_STATUS_RESULT,
    },
    {
      id: 'com.dinakernel.country.us.sales-tax-rate',
      display_name: 'Look up the sales-tax rate for a delivery address',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'public',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /**
       * What may ride the params (§11.5) — anything else cards — and what
       * Core's own projection may add (§11): the jurisdictions on file. A
       * `read` capability gets the city, region and postcode from the
       * template, never the street.
       */
      data_scope: { categories: ['address', 'tax'], max_context_items: 2 },
      card: {
        version: 1,
        blocks: [
          { kind: 'title', text: 'Sales tax', icon: 'price' },
          { kind: 'stat', value: '{rate_bps}', unit: 'bp', caption: 'rate for this address' },
          { kind: 'keyValue', label: 'Jurisdictions', value: '{jurisdictions}' },
        ],
      },
      params_schema: {
        type: 'object',
        required: ['postal_code', 'state'],
        properties: {
          postal_code: { type: 'string' },
          state: { type: 'string' },
          product_tax_class: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['rate_bps'],
        properties: {
          rate_bps: { type: 'integer' },
          jurisdictions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      id: 'com.dinakernel.country.us.invoice-terms',
      display_name: 'Issue an invoice with net payment terms',
      interaction: 'query',
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /**
       * What may ride the params (§11.5) — anything else cards — and what
       * Core's own projection may add (§11). An invoice prints two names,
       * two registrations and two addresses, so it declares them.
       */
      data_scope: {
        categories: ['address', 'business_registry', 'delivery', 'invoice'],
        max_context_items: 6,
      },
      card: {
        version: 1,
        blocks: [
          { kind: 'title', text: 'Invoice', icon: 'document' },
          { kind: 'stat', value: '{invoice_number}', caption: 'invoice number' },
          { kind: 'keyValue', label: 'Due', value: '{due_at}' },
        ],
      },
      params_schema: {
        type: 'object',
        required: ['delivery_note_digest', 'net_days', 'total'],
        properties: {
          delivery_note_digest: { type: 'string' },
          net_days: { type: 'integer', enum: [0, 15, 30, 45, 60] },
          total: MONEY_SCHEMA,
        },
      },
      result_schema: {
        type: 'object',
        required: ['invoice_number', 'due_at'],
        properties: {
          invoice_number: { type: 'string' },
          due_at: { type: 'string' },
          document_url: { type: 'string' },
        },
      },
    },
    {
      id: 'com.dinakernel.country.us.notice',
      display_name: 'Send an SMS or email notice about an invoice or delivery',
      interaction: 'query',
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      /**
       * What may ride the params (§11.5) — anything else cards — and what
       * Core's own projection may add (§11): who the notice is for, never a
       * second copy of the address it sends to.
       */
      data_scope: { categories: ['contact', 'delivery', 'payment'], max_context_items: 2 },
      card: NOTIFY_CARD,
      params_schema: {
        type: 'object',
        required: ['to', 'channel', 'template', 'subject_digest'],
        properties: {
          to: { type: 'string' },
          channel: { type: 'string', enum: ['sms', 'email'] },
          template: { type: 'string', enum: ['invoice_issued', 'payment_due', 'delivery_dispatched'] },
          subject_digest: { type: 'string' },
          due_at: { type: 'string' },
          amount: MONEY_SCHEMA,
        },
      },
      result_schema: NOTIFY_RESULT,
    },
  ],
};

export const COUNTRY_PACK_MANIFESTS: Readonly<Record<CountryPack, PluginManifest>> = {
  in: INDIA_PACK_MANIFEST,
  us: USA_PACK_MANIFEST,
};

export function isCountryPack(value: unknown): value is CountryPack {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COUNTRY_PACK_IDS, value);
}
