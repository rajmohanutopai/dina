/**
 * `ComparisonCard` → `CardSpec` (RESEARCHER_KERNEL_ARCHITECTURE.md §5.A4/A5).
 *
 * The research loop's `search_products` tool builds a money-free `ComparisonCard`
 * (`@dina/core`), whose fields already read as a generic key/value list. This
 * turns that card into the wire-safe `CardSpec` the mobile chat renders, so the
 * where-to-buy result surfaces as a structured card — with tappable links where
 * a supplier states an https source page — instead of only the LLM's prose.
 *
 * It is a PROJECTION, not a second opinion: it renders exactly what the card
 * recorded (the ranking already decided). It re-orders nothing that would change
 * the meaning — the headline stays first, alternatives keep the ranking's order,
 * and the where-to-buy links sit high so the block cap never trims them.
 *
 * Boundary-safe: it accepts `unknown` and validates the shape, then runs the
 * whole result through `validateCardSpec` as UNTRUSTED — the same discipline as
 * `result_card_mapper`. A `link` block survives only for an https URL, so a
 * supplier's `at://` service URI is named as a plain line, never a fake link.
 */

import { validateCardSpec, type CardBlock, type CardSpec } from '@dina/protocol';

interface RawField {
  label: string;
  value: string;
}

/** The ranking's own reasoning tail — kept below the structured sections so the
 *  where-to-buy links and alternatives always sit above the 32-block cap. */
const REASONING_LABELS = new Set(['Why', 'Scored on', 'Excluded']);
/** The card's owner-decision lines (`buildComparisonCard({choice})`). */
const SET_ASIDE_LABEL = 'Set aside';

/**
 * Cap on individual tappable where-to-buy `link` blocks. Discovery can return
 * up to ~20 suppliers; one block per supplier would push the §18.4 incomparable
 * notes and the recommendation reasoning past the 32-block cap, where
 * `validateCardSpec` silently truncates them. Beyond this cap, and for every
 * service-URI-only supplier, the hand-offs collapse into ONE bounded list block.
 */
const MAX_HANDOFF_LINKS = 8;

function isRawField(v: unknown): v is RawField {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.label === 'string' && typeof f.value === 'string';
}

/**
 * Build a `CardSpec` from a `ComparisonCard`, or `null` when the value is not a
 * comparison card or nothing renders. The input is typed `unknown` because it
 * arrives from a serialised tool result at a trust boundary.
 */
export function buildComparisonCardSpec(raw: unknown): CardSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const card = raw as Record<string, unknown>;
  if (card.kind !== 'commerce_comparison') return null;
  if (!Array.isArray(card.fields)) return null;

  const primaryAction = card.primaryAction;
  const blocks: CardBlock[] = [
    {
      kind: 'title',
      text: primaryAction === 'review_order' ? 'Review order' : 'Where to buy',
    },
  ];

  // The card's fields, faithfully, as key/value lines. The headline (recommended
  // supplier, price, delivery, validity, confidence, evidence) comes first in
  // the card's own order; the reasoning tail is split off so the structured
  // sections below stay above it and survive the block cap. Splitting on the
  // reasoning labels only re-orders the key/value lines — the where-to-buy
  // links, alternatives, and incomparable notes are emitted from the card's own
  // typed arrays below, so a label change can never drop them.
  // The owner's set-aside lines (§5.A6) leave the headline for ONE bounded list
  // block: one line per set-aside seller would push the price, the where-to-buy
  // links and the incomparable section past the block cap on a wide research.
  const headline: RawField[] = [];
  const setAside: RawField[] = [];
  const tail: RawField[] = [];
  let inTail = false;
  for (const f of card.fields) {
    if (!isRawField(f)) continue;
    if (REASONING_LABELS.has(f.label)) inTail = true;
    if (inTail) tail.push(f);
    else if (f.label === SET_ASIDE_LABEL) setAside.push(f);
    else headline.push(f);
  }
  for (const f of headline) blocks.push({ kind: 'keyValue', label: f.label, value: f.value });
  if (setAside.length > 0) {
    blocks.push({ kind: 'section', label: 'Set aside' });
    blocks.push({ kind: 'list', rows: setAside.map((f) => ({ text: f.value })) });
  }

  // Where to buy (§5.A5 — Deep Link Default / Cart Handover). A tappable link
  // ONLY for an https source page (capped, so the fan-out cannot bury the
  // sections below the block cap); every service-URI-only supplier, and any
  // https link past the cap, collapses into ONE bounded list. No "buy" action
  // ever, so no money moves through Dina.
  if (Array.isArray(card.handoff) && card.handoff.length > 0) {
    blocks.push({ kind: 'section', label: 'Where to buy' });
    const listed: { text: string; sub?: string }[] = [];
    let links = 0;
    for (const h of card.handoff) {
      if (typeof h !== 'object' || h === null) continue;
      const link = h as Record<string, unknown>;
      const supplierDid = typeof link.supplierDid === 'string' ? link.supplierDid : '';
      if (supplierDid === '') continue;
      // The owner's own name for the seller, when the card carries one.
      const label =
        typeof link.sellerName === 'string' && link.sellerName !== '' ? `${link.sellerName} (${supplierDid})` : supplierDid;
      const httpsUrl =
        typeof link.sourceUrl === 'string' && /^https:\/\//i.test(link.sourceUrl)
          ? link.sourceUrl
          : undefined;
      if (httpsUrl !== undefined && links < MAX_HANDOFF_LINKS) {
        blocks.push({ kind: 'link', label, url: httpsUrl, action: 'open_url' });
        links += 1;
      } else {
        const sub =
          httpsUrl ??
          (typeof link.serviceUri === 'string' && link.serviceUri !== '' ? link.serviceUri : undefined);
        listed.push(sub !== undefined ? { text: label, sub } : { text: label });
      }
    }
    if (listed.length > 0) blocks.push({ kind: 'list', rows: listed });
  }

  // Alternatives, in the ranking's order — a renderer that shows more than the
  // winner does not have to re-sort and risk disagreeing.
  if (Array.isArray(card.alternatives) && card.alternatives.length > 0) {
    const rows = card.alternatives
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => {
        const supplierDid = typeof a.supplierDid === 'string' ? a.supplierDid : '';
        // `seller` is the card's display label (owner's name + DID); older
        // cards carry only the DID.
        const seller = typeof a.seller === 'string' && a.seller !== '' ? a.seller : supplierDid;
        const leadTime = typeof a.leadTime === 'string' ? a.leadTime : undefined;
        const total = typeof a.total === 'string' ? a.total : undefined;
        return {
          text: seller,
          ...(leadTime !== undefined ? { sub: leadTime } : {}),
          ...(total !== undefined ? { trailing: total } : {}),
        };
      })
      .filter((r) => r.text !== '');
    if (rows.length > 0) {
      blocks.push({ kind: 'section', label: 'Alternatives' });
      blocks.push({ kind: 'list', rows });
    }
  }

  // What the ranking could not score, named as a first-class part of the card.
  if (Array.isArray(card.incomparable) && card.incomparable.length > 0) {
    const rows = card.incomparable
      .filter((line): line is string => typeof line === 'string' && line !== '')
      .map((line) => ({ text: line }));
    if (rows.length > 0) {
      blocks.push({ kind: 'section', label: "What couldn't be compared" });
      blocks.push({ kind: 'list', rows });
    }
  }

  // The ranking's own reasons, last — least critical, and safe to trim.
  if (tail.length > 0) {
    blocks.push({ kind: 'section', label: 'Why this one' });
    for (const f of tail) blocks.push({ kind: 'keyValue', label: f.label, value: f.value });
  }

  return validateCardSpec({ version: 1, blocks }, { trusted: false });
}
