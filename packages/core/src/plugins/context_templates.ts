/**
 * The DINA-OWNED CONTEXT TEMPLATES (PLUGIN_ARCHITECTURE.md §11 point 3).
 *
 * "The manifest declares only categories and limits (`data_scope`); which
 * fields exist per category and action class is first-party and versioned,
 * like the ops library — a manifest cannot request the fields it wants to
 * exfiltrate."
 *
 * So a template is not a filter a caller passes in. It is a table in Dina's
 * own source, keyed by (category, action_class), and it does two jobs:
 *
 *   1. NAMES the fields. A field not named here cannot travel, whatever a
 *      source hands over and whatever a manifest asks for. Copy in by name,
 *      never copy-then-delete: a scrubber that removes known-bad keys leaks
 *      every key nobody thought of, and those are the keys next month's vault
 *      feature adds.
 *   2. CONVERTS the value to its declared class. This is the half that makes
 *      the table load-bearing rather than decorative. A `date_class` field
 *      turns a timestamp into a coarse bucket, so a source cannot hand a
 *      runner the minute the owner dispatched a lorry even by accident; a
 *      `kind` field must land inside an enumerated set, so a free-text value
 *      in a slot meant for an enum is dropped rather than passed along.
 *
 * EVERY PROJECTED VALUE IS A STRING. That is the structural half of "raw
 * vault rows and metadata objects never enter a payload" — the projector's
 * output type cannot hold an object, so no nesting can appear in a context
 * item however a source behaves. Money arrives already formatted
 * (`formatMoney`), which is what a document prints anyway.
 *
 * NARROWING BY ACTION CLASS EARNS ITS PLACE. A `read` capability looking up a
 * tax rate needs the jurisdiction, not the street; a `write` capability
 * printing an invoice needs the street. Listing the fields per class is how
 * the lookup capability stops receiving what only the document capability has
 * any use for.
 *
 * VERSIONED. `CONTEXT_TEMPLATE_VERSION` rides the audit line, so an operator
 * reading an old entry knows which table produced it.
 */

import { oneLine } from '../util/one_line';

import type { ActionClass } from '@dina/protocol';


/** Bump when a template gains, loses, or re-classes a field. */
export const CONTEXT_TEMPLATE_VERSION = 1;

/**
 * What a projected value IS, which decides how it is converted and checked.
 *
 * `kind`       — one of an enumerated set; anything else is dropped.
 * `text`       — free text: control and bidi characters stripped, whitespace
 *                collapsed, length bounded. Dropped when it carries regulated
 *                content.
 * `date_class` — a timestamp coarsened to a bucket. The raw instant never
 *                travels, so a source cannot leak one through this slot.
 */
export type ContextFieldClass = 'kind' | 'text' | 'date_class';

export interface ContextTemplateField {
  readonly name: string;
  readonly class: ContextFieldClass;
  /** Required for `kind`: the only values this field may carry. */
  readonly values?: readonly string[];
}

/** The coarse buckets a `date_class` field may carry. Never an instant. */
export const DATE_CLASSES = ['today', 'this_week', 'this_month', 'this_quarter', 'older', 'future'] as const;
export type DateClass = (typeof DATE_CLASSES)[number];

export interface ContextTemplate {
  /** Every field this category can ever carry, whatever the action class. */
  readonly fields: readonly ContextTemplateField[];
  /**
   * Which of those fields each action class may see. A class absent from this
   * table sees NOTHING — `payment` is absent because a payment-class
   * capability is blocked before it ever reaches a projection, and a table
   * that quietly listed fields for it would be a promise nothing keeps.
   */
  readonly byActionClass: Readonly<Partial<Record<ActionClass, readonly string[]>>>;
}

/** Which side of the trade an item describes. */
const ROLE: ContextTemplateField = { name: 'role', class: 'kind', values: ['self', 'counterparty'] };

/**
 * The table. Three categories, because a category belongs here only once Dina
 * owns a store it can read and a rule for what that store may say. A category
 * a manifest declares but this table does not name projects NOTHING — the
 * fail-closed direction, and the owner sees it as an exclusion rather than a
 * silent nothing.
 */
export const CONTEXT_TEMPLATES: Readonly<Record<string, ContextTemplate>> = {
  /**
   * The paper identity a filing prints (§5.D). A registry lookup needs the
   * number; a document needs the name on it too.
   */
  business_registry: {
    fields: [
      ROLE,
      { name: 'legal_name', class: 'text' },
      { name: 'registration_scheme', class: 'kind', values: ['gstin', 'pan', 'ein', 'sales_tax'] },
      { name: 'registration_value', class: 'text' },
    ],
    byActionClass: {
      read: ['role', 'registration_scheme', 'registration_value'],
      quote: ['role', 'registration_scheme', 'registration_value'],
      write: ['role', 'legal_name', 'registration_scheme', 'registration_value'],
      booking: ['role', 'legal_name', 'registration_scheme', 'registration_value'],
      agentic: ['role', 'legal_name', 'registration_scheme', 'registration_value'],
    },
  },

  /**
   * A registered place of business. The narrowing here is the clearest case
   * in the table: a sales-tax lookup is answered by the jurisdiction, and the
   * street lines only ever matter to something that prints a document.
   */
  address: {
    fields: [
      ROLE,
      { name: 'line1', class: 'text' },
      { name: 'line2', class: 'text' },
      { name: 'city', class: 'text' },
      { name: 'region', class: 'text' },
      { name: 'postal_code', class: 'text' },
      { name: 'country', class: 'text' },
    ],
    byActionClass: {
      read: ['role', 'city', 'region', 'postal_code', 'country'],
      quote: ['role', 'city', 'region', 'postal_code', 'country'],
      write: ['role', 'line1', 'line2', 'city', 'region', 'postal_code', 'country'],
      booking: ['role', 'line1', 'line2', 'city', 'region', 'postal_code', 'country'],
      agentic: ['role', 'line1', 'line2', 'city', 'region', 'postal_code', 'country'],
    },
  },

  /**
   * Who the task is about. A read capability gets which channel the owner
   * states and how far the contact is trusted; only something that addresses
   * a person gets the name it addresses them by.
   */
  contact: {
    fields: [
      ROLE,
      { name: 'display_name', class: 'text' },
      { name: 'channel_kind', class: 'kind', values: ['phone', 'email', 'both', 'none'] },
      { name: 'trust_level', class: 'kind', values: ['blocked', 'unknown', 'verified', 'trusted'] },
      { name: 'known_since_class', class: 'date_class' },
    ],
    byActionClass: {
      read: ['role', 'channel_kind', 'trust_level', 'known_since_class'],
      quote: ['role', 'channel_kind', 'trust_level', 'known_since_class'],
      write: ['role', 'display_name', 'channel_kind', 'trust_level', 'known_since_class'],
      booking: ['role', 'display_name', 'channel_kind', 'trust_level', 'known_since_class'],
      agentic: ['role', 'display_name', 'channel_kind', 'trust_level', 'known_since_class'],
    },
  },
};

/**
 * The fields (category, action class) admits, in table order — or an empty
 * list when either the category or the class is not in the table.
 */
export function templateFieldsFor(category: string, actionClass: string): readonly ContextTemplateField[] {
  const template = Object.prototype.hasOwnProperty.call(CONTEXT_TEMPLATES, category)
    ? CONTEXT_TEMPLATES[category]
    : undefined;
  if (template === undefined) return [];
  const names = template.byActionClass[actionClass as ActionClass];
  if (names === undefined) return [];
  const allowed = new Set(names);
  return template.fields.filter((f) => allowed.has(f.name));
}

/** Longest a projected text field may be. A context line, not a document. */
export const MAX_TEXT_FIELD_CHARS = 120;

/** Milliseconds in a day, for the date buckets. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Coarsen an instant to its bucket. The buckets are ragged rather than even
 * on purpose: a runner needs to know whether something is current, and "how
 * many days ago exactly" is the part that maps an owner's movements.
 */
export function dateClassOf(atMs: number, nowMs: number): DateClass {
  const delta = nowMs - atMs;
  if (delta < 0) return 'future';
  if (delta < DAY_MS) return 'today';
  if (delta < 7 * DAY_MS) return 'this_week';
  if (delta < 31 * DAY_MS) return 'this_month';
  if (delta < 92 * DAY_MS) return 'this_quarter';
  return 'older';
}

/** One bounded line — the shared sanitiser, at this table's text ceiling. */
export function oneLineText(value: string): string {
  return oneLine(value, MAX_TEXT_FIELD_CHARS);
}

/**
 * Convert one raw value to its declared class, or null when it cannot be.
 *
 * Null is the ONLY failure answer: a value that does not fit its class is
 * dropped, never coerced. Coercion is how a timestamp becomes a string that
 * looks like a bucket and a card number becomes a "kind".
 */
export function convertField(field: ContextTemplateField, raw: unknown, nowMs: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (field.class === 'kind') {
    if (typeof raw !== 'string') return null;
    return (field.values ?? []).includes(raw) ? raw : null;
  }
  if (field.class === 'date_class') {
    // Epoch seconds or milliseconds, or an ISO string — whichever a store
    // holds. Whatever arrives, only the bucket leaves.
    let atMs: number | null = null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      atMs = raw > 1e11 ? raw : raw * 1000;
    } else if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) atMs = parsed;
    }
    if (atMs === null) return null;
    return dateClassOf(atMs, nowMs);
  }
  if (typeof raw !== 'string') return null;
  const text = oneLineText(raw);
  return text === '' ? null : text;
}
