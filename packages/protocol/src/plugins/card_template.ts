/**
 * THE PLUGIN CARD TEMPLATE (PLUGIN_ARCHITECTURE.md §15.6, §11).
 *
 * "Third-party UI is CardSpec only, rendered in untrusted mode." A plugin
 * result used to reach the owner as `label: value` lines — the floor, and an
 * honest one, but it means a filing's bill number, its validity and its
 * status all read the same weight, and a status nobody should miss looks like
 * a footnote.
 *
 * THE TEMPLATE IS THE MANIFEST'S, THE VALUES ARE THE RESULT'S. A capability
 * declares `card`: a CardSpec whose literal text is the publisher's words —
 * content-addressed, signed, and inside the presentation hash (§8.1), so a
 * rewrite of it lands in the owner's Activity — and whose value positions are
 * SLOTS naming fields of the capability's own `result_schema`. At render the
 * runner supplies only data, already validated against that pinned schema.
 * So a runner cannot author layout per answer, and a publisher cannot name a
 * field the runner will never send.
 *
 * A SLOT IS A WHOLE STRING, NEVER A FRAGMENT. `"{eway_bill_no}"` is a slot;
 * `"Bill {eway_bill_no}"` is literal text that happens to contain braces.
 * Partial interpolation is where the interesting bugs live — a value that
 * runs past its bound truncates the sentence around it, and a value carrying
 * its own braces starts a substitution nobody wrote. The block vocabulary
 * already separates label from value, so nothing needs fragments: a
 * `keyValue` block is `{label: "Bill number", value: "{eway_bill_no}"}`.
 *
 * AN ABSENT OR UNSHOWABLE VALUE BECOMES `null`, and `validateCardSpec` drops
 * the block that held it. That is the whole error-handling story: a result
 * missing an optional field renders a shorter card, never "undefined".
 */

/** A slot: the whole string, one identifier, braces either side. */
const SLOT = /^\{([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;

/** How deep a template may nest before this module stops walking it. */
const MAX_TEMPLATE_DEPTH = 8;

/** The result field a slot names, or null when the string is literal text. */
export function cardTemplateSlot(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = SLOT.exec(value);
  return match === null ? null : (match[1] ?? null);
}

/**
 * Every result field this template names, deduplicated, in first-seen order.
 * The manifest validator uses it to refuse a template that names a field the
 * capability's `result_schema` never declares.
 */
export function cardTemplateSlots(template: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  walk(template, 0, (value) => {
    const slot = cardTemplateSlot(value);
    if (slot !== null && !seen.has(slot)) {
      seen.add(slot);
      found.push(slot);
    }
  });
  return found;
}

/**
 * Fill a template from one validated result.
 *
 * Returns a NEW structure; the template is never mutated. Every slot becomes
 * a display string or `null`:
 *
 *   string  → itself (the CardSpec validator trims and bounds it)
 *   number  → its decimal form, finite only
 *   boolean → "yes" / "no", because a card is read by a person
 *   array   → "3 items", which is what a bounded card can honestly say
 *   absent, null, or an object → null, and the block holding it is dropped
 */
export function fillCardTemplate(template: unknown, result: unknown): unknown {
  const fields = isRecord(result) ? result : {};
  return fill(template, fields, 0);
}

function fill(value: unknown, fields: Record<string, unknown>, depth: number): unknown {
  if (depth > MAX_TEMPLATE_DEPTH) return null;
  const slot = cardTemplateSlot(value);
  if (slot !== null) return displayValue(fields[slot]);
  if (Array.isArray(value)) return value.map((entry) => fill(entry, fields, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = fill(entry, fields, depth + 1);
    return out;
  }
  return value;
}

/** One result value as the string a person reads, or null when there is none to read. */
function displayValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  if (Array.isArray(raw)) return `${raw.length} item${raw.length === 1 ? '' : 's'}`;
  return null;
}

function walk(value: unknown, depth: number, visit: (value: unknown) => void): void {
  if (depth > MAX_TEMPLATE_DEPTH) return;
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, depth + 1, visit);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) walk(entry, depth + 1, visit);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
