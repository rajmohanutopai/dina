/**
 * The Slot Pack (SHELF_SPACE_NEGOTIATION §4) — shelf-space rental for small
 * stores, as TWO first-party manifests: the seller half a store installs and
 * the buyer half a brand installs. Zeev contributes the content (categories,
 * default rules, wording); Dina publishes it, so the first-party gates stay
 * closed to any other publisher (spec Q6).
 *
 * WHAT THE PACK HOLDS — every item on a field the manifest validator accepts
 * (`packages/protocol/src/plugins/validate.ts`):
 *
 *   - a slot's descriptive attributes and the category list: the
 *     `params_schema` of `term-request`, with `enum` lists. The category
 *     enum IS the tag vocabulary Core counts holdings by; Core never knows
 *     that `beverages.juice` means juice;
 *   - the slot kinds a listing may name: the same schema's `kind` enum;
 *   - NOT the default rules or the runner's step size, which §4 puts in a
 *     `config_schema`: that derives the `config` feature this node does not
 *     ship (no config-value store, P2-9), so the manifests would not install.
 *     The step is pinned on the store half's row of `FIRST_PARTY_PACKS`; the
 *     suggested rule is the phone's form default. Core stores a rule only
 *     from the owner's own submission;
 *   - no prices, floors, rules in force or deals — those live in the
 *     store's Core and nowhere in a manifest.
 *
 * The capabilities are the general term capabilities (§5); the pack supplies
 * their schemas, Core supplies the gates, floors, signing and transport. The
 * seller half is `provider` kind and the buyer half `tool` kind, as with the
 * Commerce Pack: a buyer that also declared `provider` would advertise itself
 * as answerable by strangers.
 */

import { PLUGIN_NSIDS, type PluginManifest } from '@dina/protocol';

import type { NumberPartSpec } from '../commitment/parts';

/** The id term documents name this pack by, shared by both halves (§4). */
export const SLOT_PACK_ID = 'com.dinakernel.slot';
export const SLOT_PACK_SCHEMA_MAJOR = 1;

/** Shelf categories — the tag vocabulary (Zeev-contributed content). */
export const SLOT_PACK_CATEGORIES = [
  'bakery',
  'beverages.juice',
  'beverages.soft_drinks',
  'beverages.tea_coffee',
  'dairy',
  'frozen',
  'home_care',
  'personal_care',
  'snacks',
  'staples',
] as const;

/** The kinds of slot a store can list. */
export const SLOT_PACK_KINDS = ['chiller', 'counter', 'end_cap', 'shelf'] as const;

/**
 * What a brand describes when it asks for a slot: the category (tag), and
 * what it would stock. Bounded scalars only; validated by Core against this
 * schema before a request is admitted.
 */
const TERM_REQUEST_PARAMS = {
  type: 'object',
  required: ['tag', 'attributes'],
  additionalProperties: false,
  properties: {
    tag: { type: 'string', enum: [...SLOT_PACK_CATEGORIES] },
    kind: { type: 'string', enum: [...SLOT_PACK_KINDS] },
    attributes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        products: { type: 'string', maxLength: 200 },
        skus: { type: 'integer', minimum: 1, maximum: 500 },
        needs_chilling: { type: 'boolean' },
      },
    },
  },
} as const;

const TERM_OFFER_RESULT = {
  type: 'object',
  required: ['offer_digest'],
  properties: { offer_digest: { type: 'string' } },
} as const;

const TERM_COUNTER_PARAMS = {
  type: 'object',
  required: ['offer_digest', 'targets'],
  properties: {
    offer_digest: { type: 'string' },
    targets: {
      type: 'object',
      additionalProperties: false,
      properties: { fee: { type: 'string' }, share_bps: { type: 'string' } },
    },
  },
} as const;

const TERM_AGREEMENT_PARAMS = {
  type: 'object',
  required: ['proposal_digest'],
  properties: { proposal_digest: { type: 'string' } },
} as const;

const TERM_AGREEMENT_RESULT = {
  type: 'object',
  required: ['decision'],
  properties: { decision: { type: 'string', enum: ['accepted', 'rejected'] } },
} as const;

export const SLOT_SELLER_MANIFEST: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.dinakernel.slot.seller',
  version: `${String(SLOT_PACK_SCHEMA_MAJOR)}.0.0`,
  display_name: 'Shelf space — Store',
  short_description: 'List open shelf slots and let Dina bargain with brands inside your limits.',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.dinakernel.commerce.term-request',
      display_name: 'Answer a brand asking for a slot',
      interaction: 'query',
      // A price, like a quote: nothing binds until both owners approve.
      action_class: 'quote',
      privacy_class: 'personal',
      kinds: ['provider'],
      // Core answers a repeated request from its record, by digest.
      effects: { idempotency: 'supported' },
      params_schema: TERM_REQUEST_PARAMS,
      result_schema: TERM_OFFER_RESULT,
    },
    {
      id: 'com.dinakernel.commerce.term-counter',
      display_name: 'Answer a brand’s counter-offer',
      interaction: 'query',
      action_class: 'quote',
      privacy_class: 'personal',
      kinds: ['provider'],
      effects: { idempotency: 'supported' },
      params_schema: TERM_COUNTER_PARAMS,
      result_schema: TERM_OFFER_RESULT,
    },
    {
      id: 'com.dinakernel.commerce.term-agreement',
      display_name: 'Decide a slot agreement',
      interaction: 'query',
      // Accepting rents out a resource: an obligation, so `write`.
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['provider'],
      effects: { idempotency: 'supported' },
      params_schema: TERM_AGREEMENT_PARAMS,
      result_schema: TERM_AGREEMENT_RESULT,
    },
  ],
} as unknown as PluginManifest;

export const SLOT_BUYER_MANIFEST: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.dinakernel.slot.buyer',
  version: `${String(SLOT_PACK_SCHEMA_MAJOR)}.0.0`,
  display_name: 'Shelf space — Brand',
  short_description: 'Ask stores for shelf slots and let Dina bargain inside your limits.',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.dinakernel.commerce.term-request',
      display_name: 'Ask a store for a slot',
      interaction: 'query',
      action_class: 'quote',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      params_schema: TERM_REQUEST_PARAMS,
      result_schema: TERM_OFFER_RESULT,
    },
    {
      id: 'com.dinakernel.commerce.term-agreement',
      display_name: 'Propose a slot agreement',
      interaction: 'query',
      // The brand's proposal binds it once the store accepts.
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['tool'],
      // Like placing an order: an effect on another node this one cannot
      // make the other side deduplicate.
      effects: { idempotency: 'unsupported' },
      params_schema: TERM_AGREEMENT_PARAMS,
      result_schema: TERM_AGREEMENT_RESULT,
    },
  ],
} as unknown as PluginManifest;

/** The pack's vocabulary, built from the same constants as its schema so the two cannot drift. */
export interface TermPackVocabulary {
  tags: readonly string[];
  kinds: readonly string[];
  requestParamsSchema: unknown;
  /**
   * The parts a deal under this pack is made of, in the kernel's kinds
   * (COMMITMENT_KERNEL §6), sorted by name. Direction comes from who pays.
   * The wire still states exactly the `TERM_TABLE` terms; a boundary test
   * holds the two equal until documents pin a vocabulary of their own.
   */
  parts: readonly NumberPartSpec[];
  /**
   * The promises a deal under this pack may carry (COMMITMENT_KERNEL §6):
   * who keeps each, and each dimension's values — a whole number with the
   * better way named, or one of a closed set of words.
   */
  promises: Readonly<Record<string, TermPackPromise>>;
}

export interface TermPackPromise {
  by: 'buyer' | 'seller';
  dimensions: Readonly<
    Record<string, { order: 'higher_better' | 'lower_better' } | { order: 'exact'; values: readonly string[] }>
  >;
}

/**
 * The brand carries the store's stock from a wholesaler on its own run: how
 * many crates, on which day, how often (every so many days).
 */
export const SLOT_PACK_PROMISES: Readonly<Record<string, TermPackPromise>> = {
  stock_run: {
    by: 'buyer',
    dimensions: {
      crates: { order: 'higher_better' },
      day: { order: 'exact', values: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
      every_days: { order: 'lower_better' },
    },
  },
};

/** Shelf space: the brand pays the store rent and a share of sales. */
export const SLOT_PACK_PARTS: readonly NumberPartSpec[] = [
  { name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' },
  { name: 'share_bps', kind: 'ratio_bps', payer: 'buyer', payee: 'seller' },
];

export const SLOT_PACK_VOCABULARY: TermPackVocabulary = {
  tags: [...SLOT_PACK_CATEGORIES],
  kinds: [...SLOT_PACK_KINDS],
  requestParamsSchema: TERM_REQUEST_PARAMS,
  parts: SLOT_PACK_PARTS,
  promises: SLOT_PACK_PROMISES,
};
