/**
 * Deterministic result → CardSpec mapper.
 *
 * SERVICES_LAUNCH_ARCHITECTURE — result presentation, the deterministic
 * producer (see `docs/CARD_SPEC_DESIGN.md`). Given a service-query `result`
 * (the provider's reply JSON) + its `capability`, build a safe `CardSpec`
 * (the fixed-vocabulary display spec from `@dina/protocol`). NO LLM, NO
 * per-capability hard-coding, NO I/O — a pure function so the card is
 * instant + testable.
 *
 * Heuristics are FIELD-SHAPE based, not capability-specific, so a brand-new
 * capability with a sensible result shape renders a good card with zero code
 * changes:
 *   - title  ← a name-ish field (route_name / name / *_name / title) or the
 *              provider serviceName; icon ← the capability's domain.
 *   - status ← a status-ish field → a TONED `keyValue` (NOT a badge — badges
 *              are Dina-owned, §7 of the design doc; an untrusted producer
 *              must never render a trust-stamp pill).
 *   - stat   ← the most "headline" numeric field (eta_minutes/price/temp…),
 *              with unit + caption inferred from siblings.
 *   - rating ← a 0–5 rating field; bar ← 0–1 / 0–5 dimension fields.
 *   - map    ← lat/lng (or a nested location object) — STRUCTURED, never a
 *              URL (the client builds the maps link).
 *   - link   ← an https URL field (renderer shows the real host, open_url).
 *   - keyValue ← remaining scalars; body ← message/note/summary (canned
 *              stub markers dropped).
 *   - staleness ← as_of/generated_at/updated_at → generatedAt; ttl/expires
 *              → ttlSeconds/expiresAt.
 *
 * Conservative: anything it can't place safely becomes a keyValue or is
 * omitted; it never invents data. Returns `null` when the result is
 * empty/unusable (caller falls back to the generic text card).
 *
 * Output is always run through `validateCardSpec(spec, { trusted: false })`
 * so it's guaranteed wire-safe (no badges, https-only links, capped sizes)
 * regardless of the heuristics.
 *
 * Source: new in the TS stack (no Python predecessor).
 */

import {
  validateCardSpec,
  getCapabilityEntry,
  type CardSpec,
  type CardBlock,
  type CardIcon,
  type CardTone,
} from '@dina/protocol';

export interface ResultCardInput {
  /** Canonical (or alias) capability the query used. */
  capability: string;
  /** Provider display name — title fallback. */
  serviceName?: string;
  /** The provider's reply payload (parsed). */
  result: unknown;
}

// ── field-name classification ──────────────────────────────────────────

const NAME_FIELDS = ['route_name', 'name', 'title', 'product_name', 'item_name', 'place_name'];
const STATUS_FIELDS = ['status', 'state', 'availability'];
const BODY_FIELDS = ['message', 'note', 'notes', 'description', 'summary', 'detail', 'details'];
const RATING_FIELDS = ['rating', 'stars', 'score'];
const STAT_PRIORITY = [
  'eta_minutes',
  'minutes',
  'eta',
  'price',
  'amount',
  'cost',
  'total',
  'temperature',
  'temp',
  'count',
  'available',
  'quantity',
  'qty',
];
const STALE_GENERATED_FIELDS = ['as_of', 'generated_at', 'updated_at', 'timestamp', 'observed_at'];
/** Fields that name a row's leading text when a result carries a list of small objects. */
const ROW_LEAD_FIELDS = ['time', 'start', 'name', 'title', 'label', 'date', 'slot'];
/** Fields that name a row's secondary text. */
const ROW_SUB_FIELDS = ['note', 'notes', 'description', 'detail', 'service', 'end'];
/** Rows shown from one list; the rest is counted, never dropped in silence. */
const MAX_LIST_ROWS = 6;
const STALE_EXPIRES_FIELDS = ['expires_at', 'valid_until'];
const STALE_TTL_FIELDS = ['ttl_seconds', 'ttl'];

/** Numeric stat fields that are money — they get currency formatting and
 *  NEVER a "to {destination}" caption (a price has no destination). */
const MONEY_FIELDS = ['price', 'amount', 'cost', 'total', 'subtotal', 'fare', 'balance'];
/** Sibling fields naming the currency of a money stat. */
const CURRENCY_FIELDS = ['currency', 'currency_code', 'ccy'];
/** Minimal currency → symbol map; an unknown code is appended as a unit. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  INR: '₹',
  KRW: '₩',
  BRL: 'R$',
};
/** A destination a journey/time stat travels "to" — `stop_name`/`destination`,
 *  NOT product/store/place `_name` fields (those are not destinations). */
const DESTINATION_RE = /(^stop|_stop$|destination|arrival|drop_?off)/i;

/** status value → tone (the color scheme). */
function toneForStatus(value: string): CardTone {
  const v = value.toLowerCase();
  if (['confirmed', 'available', 'on_route', 'in_stock', 'open', 'active', 'ok', 'in-network'].includes(v)) {
    return 'positive';
  }
  if (['rescheduled', 'delayed', 'low_stock', 'pending', 'limited', 'out_for_delivery'].includes(v)) {
    return 'caution';
  }
  if (
    [
      'cancelled',
      'canceled',
      'not_found',
      'out_of_service',
      'out_of_stock',
      'unavailable',
      'closed',
      'sold_out',
    ].includes(v)
  ) {
    return 'critical';
  }
  return 'neutral';
}

function iconForCapability(capability: string): CardIcon {
  const entry = getCapabilityEntry(capability);
  switch (entry?.domain) {
    case 'transit':
      return 'transit';
    case 'appointments':
      return 'calendar';
    default:
      break;
  }
  const c = capability.toLowerCase();
  if (c.includes('price') || c.includes('stock') || c.includes('cost')) return 'price';
  if (c.includes('eta') || c.includes('transit') || c.includes('bus')) return 'transit';
  if (c.includes('appoint') || c.includes('book')) return 'calendar';
  if (c.includes('place') || c.includes('restaurant') || c.includes('store')) return 'store';
  if (c.includes('weather')) return 'weather';
  if (c.includes('flight')) return 'flight';
  if (c.includes('ship') || c.includes('delivery') || c.includes('package')) return 'package';
  if (c.includes('movie') || c.includes('media') || c.includes('film')) return 'document';
  return 'info';
}

function humanizeLabel(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function humanizeValue(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? value : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Rows for a list value: objects lead with a time/name field and carry a note; scalars stand alone. */
function listRows(items: unknown[]): { text: string; sub?: string }[] {
  const rows: { text: string; sub?: string }[] = [];
  for (const item of items) {
    if (isScalar(item)) {
      const text = String(item).trim();
      if (text !== '') rows.push({ text: humanizeValue(text) });
      continue;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const scalars = Object.entries(o).filter(([, val]) => isScalar(val) && String(val).trim() !== '');
    if (scalars.length === 0) continue;
    const pick = (fields: readonly string[], skip: Set<string>): string | undefined => {
      for (const f of fields) {
        const hit = scalars.find(([key]) => !skip.has(key) && key.toLowerCase() === f);
        if (hit) {
          skip.add(hit[0]);
          return String(hit[1]).trim();
        }
      }
      return undefined;
    };
    const taken = new Set<string>();
    const lead = pick(ROW_LEAD_FIELDS, taken);
    const second = pick(ROW_LEAD_FIELDS, taken); // e.g. `date` next to `time`, `end` next to `start`
    const sub = pick(ROW_SUB_FIELDS, taken);
    const text =
      lead !== undefined
        ? second !== undefined
          ? `${lead} · ${second}`
          : lead
        : scalars
            .filter(([key]) => !taken.has(key))
            .map(([key, val]) => `${humanizeLabel(key)}: ${String(val).trim()}`)
            .join(' · ');
    if (text === '') continue;
    rows.push(sub !== undefined ? { text, sub } : { text });
  }
  return rows;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isHttpsUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v.trim());
}

function fieldMatches(key: string, candidates: readonly string[]): boolean {
  const k = key.toLowerCase();
  return candidates.some((c) => k === c || k.includes(c));
}

function unitForNumericField(key: string): string | undefined {
  const k = key.toLowerCase();
  if (k.includes('minute') || k === 'eta' || k.includes('eta_min')) return 'min';
  if (k.includes('hour')) return 'hr';
  if (k.includes('second')) return 'sec';
  if (k.includes('temp')) return '°';
  return undefined;
}

/** Read a {lat,lng} pair from the result top-level or a nested location. */
function extractCoords(obj: Record<string, unknown>): { lat: number; lng: number } | null {
  const tryPair = (lat: unknown, lng: unknown): { lat: number; lng: number } | null =>
    typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng)
      ? { lat, lng }
      : null;
  const top = tryPair(obj.lat, obj.lng);
  if (top !== null) return top;
  const loc = obj.location;
  if (typeof loc === 'object' && loc !== null) {
    const l = loc as Record<string, unknown>;
    return tryPair(l.lat, l.lng);
  }
  return null;
}

/**
 * Build a CardSpec from a service result, or `null` when nothing renderable.
 */
export function buildResultCardSpec(input: ResultCardInput): CardSpec | null {
  const result = input.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null;
  }
  const obj = result as Record<string, unknown>;
  const entries = Object.entries(obj).filter(([, v]) => isScalar(v) || isHttpsUrl(v));
  const coords = extractCoords(obj);
  if (entries.length === 0 && coords === null) return null;

  const used = new Set<string>();
  const blocks: CardBlock[] = [];

  // 1) Title — name-ish field, else serviceName. Icon from capability.
  let titleText: string | undefined;
  for (const f of NAME_FIELDS) {
    const hit = entries.find(([k]) => k.toLowerCase() === f && typeof obj[k] === 'string');
    if (hit) {
      titleText = String(hit[1]).trim();
      used.add(hit[0]);
      break;
    }
  }
  if ((titleText === undefined || titleText === '') && input.serviceName && input.serviceName.trim() !== '') {
    titleText = input.serviceName.trim();
  }
  if (titleText !== undefined && titleText !== '') {
    blocks.push({ kind: 'title', text: titleText, icon: iconForCapability(input.capability) });
  }

  // 2) Status — a TONED keyValue (NOT a badge — badges are Dina-owned).
  for (const [k, v] of entries) {
    if (used.has(k)) continue;
    if (fieldMatches(k, STATUS_FIELDS) && typeof v === 'string' && v.trim() !== '') {
      blocks.push({
        kind: 'keyValue',
        label: 'Status',
        value: humanizeValue(v),
        tone: toneForStatus(v),
      });
      used.add(k);
      break;
    }
  }

  // 3) Rating — a 0–5 rating field.
  for (const f of RATING_FIELDS) {
    const hit = entries.find(([k, v]) => !used.has(k) && k.toLowerCase() === f && typeof v === 'number');
    if (hit) {
      const value = hit[1] as number;
      if (value >= 0 && value <= 5) {
        const count = typeof obj.rating_count === 'number' ? (obj.rating_count as number) : undefined;
        blocks.push(count !== undefined ? { kind: 'rating', value, count } : { kind: 'rating', value });
        used.add(hit[0]);
        if (typeof obj.rating_count === 'number') used.add('rating_count');
        break;
      }
    }
  }

  // 4) Dimension bars — a `dimensions` object of 0–1 or 0–5 values.
  const dims = obj.dimensions;
  if (typeof dims === 'object' && dims !== null && !Array.isArray(dims)) {
    for (const [dk, dv] of Object.entries(dims as Record<string, unknown>)) {
      if (typeof dv !== 'number' || !Number.isFinite(dv)) continue;
      const ratio = dv > 1 ? Math.min(dv / 5, 1) : Math.max(dv, 0);
      const valueLabel = dv > 1 ? dv.toFixed(1) : `${Math.round(dv * 100)}%`;
      const tone: CardTone = ratio >= 0.75 ? 'positive' : ratio >= 0.5 ? 'caution' : 'critical';
      blocks.push({ kind: 'bar', label: humanizeLabel(dk), ratio, valueLabel, tone });
    }
    used.add('dimensions');
  }

  // 5) Stat — highest-priority numeric. Money is currency-formatted ($0.79);
  //    a journey/time stat gets a "to {destination}" caption. Coordinates are
  //    never a headline stat (they belong to the map block).
  const numericEntries = entries.filter(
    ([k, v]) =>
      !used.has(k) &&
      typeof v === 'number' &&
      Number.isFinite(v) &&
      !(coords !== null && (k === 'lat' || k === 'lng')),
  );
  let statKey: string | undefined;
  for (const pref of STAT_PRIORITY) {
    const hit = numericEntries.find(([k]) => k.toLowerCase() === pref || k.toLowerCase().includes(pref));
    if (hit) {
      statKey = hit[0];
      break;
    }
  }
  if (statKey === undefined && numericEntries.length > 0) statKey = numericEntries[0][0];
  if (statKey !== undefined) {
    const isMoney = fieldMatches(statKey, MONEY_FIELDS);
    let value = String(obj[statKey]);
    let unit = unitForNumericField(statKey);

    if (isMoney) {
      // Fold a sibling currency into the headline ($0.79), not a separate row.
      const curHit = entries.find(
        ([k, v]) =>
          !used.has(k) && typeof v === 'string' && v.trim() !== '' && fieldMatches(k, CURRENCY_FIELDS),
      );
      if (curHit) {
        const code = String(curHit[1]).trim().toUpperCase();
        const symbol = CURRENCY_SYMBOLS[code];
        if (symbol !== undefined) {
          value = `${symbol}${value}`;
        } else {
          unit = code; // unknown code → render "0.79 CHF"
        }
        used.add(curHit[0]);
      }
    }

    // "to {destination}" is a journey idiom — only for a non-money stat with a
    // genuine destination sibling (so a price never reads "0.79 to <store>").
    let caption: string | undefined;
    if (!isMoney) {
      const capHit = entries.find(
        ([k, v]) =>
          !used.has(k) &&
          k !== statKey &&
          typeof v === 'string' &&
          v.trim() !== '' &&
          DESTINATION_RE.test(k),
      );
      if (capHit) {
        caption = `to ${String(capHit[1]).trim()}`;
        used.add(capHit[0]);
      }
    }

    const stat: CardBlock = { kind: 'stat', value };
    if (unit !== undefined) (stat as { unit?: string }).unit = unit;
    if (caption !== undefined) (stat as { caption?: string }).caption = caption;
    blocks.push(stat);
    used.add(statKey);
  }

  // 6) Map — STRUCTURED coords (never a URL).
  if (coords !== null) {
    blocks.push({ kind: 'map', label: 'Open in Maps', lat: coords.lat, lng: coords.lng });
    used.add('lat');
    used.add('lng');
    used.add('location');
  }

  // 7) Link — any https URL field (host shown by renderer, open_url).
  for (const [k, v] of entries) {
    if (used.has(k)) continue;
    if (isHttpsUrl(v)) {
      blocks.push({ kind: 'link', label: labelForUrlField(k), url: String(v).trim(), action: 'open_url' });
      used.add(k);
    }
  }

  // 8) keyValue — remaining scalars, except body/marker/stale fields.
  for (const [k, v] of entries) {
    if (used.has(k)) continue;
    if (fieldMatches(k, BODY_FIELDS)) continue;
    if (fieldMatches(k, STALE_GENERATED_FIELDS) || fieldMatches(k, STALE_EXPIRES_FIELDS) || fieldMatches(k, STALE_TTL_FIELDS)) {
      continue;
    }
    if (!isScalar(v)) continue;
    const value = typeof v === 'string' ? v.trim() : String(v);
    if (value === '') continue;
    blocks.push({ kind: 'keyValue', label: humanizeLabel(k), value: humanizeValue(value) });
    used.add(k);
  }

  // 8b) List — an array of small objects (appointment `slots`, quote `lines`,
  //     `options`): one row each, led by its time/name and followed by its
  //     note. Without this an availability answer that says WHEN in `slots`
  //     rendered as "Status: Ok" alone (found on the group hand-off's first
  //     live run). Arrays of scalars become one row per value.
  for (const [k, v] of Object.entries(obj)) {
    if (used.has(k) || !Array.isArray(v) || v.length === 0) continue;
    const rows = listRows(v);
    if (rows.length === 0) continue;
    const shown = rows.slice(0, MAX_LIST_ROWS);
    if (rows.length > MAX_LIST_ROWS) shown.push({ text: `and ${rows.length - MAX_LIST_ROWS} more` });
    blocks.push({ kind: 'section', label: humanizeLabel(k) });
    blocks.push({ kind: 'list', rows: shown });
    used.add(k);
  }

  // 9) Body — first free-text field, dropping the stub's canned marker.
  for (const [k, v] of entries) {
    if (used.has(k)) continue;
    if (!fieldMatches(k, BODY_FIELDS)) continue;
    if (typeof v !== 'string') continue;
    const text = v.trim();
    if (text === '' || /canned test data|stub_/i.test(text)) {
      used.add(k);
      continue;
    }
    blocks.push({ kind: 'body', text });
    used.add(k);
    break;
  }

  // 10) Staleness — lift as_of / ttl / expires from the result.
  const stale: Partial<Pick<CardSpec, 'generatedAt' | 'expiresAt' | 'ttlSeconds'>> = {};
  for (const [k, v] of entries) {
    if (typeof v === 'string' && fieldMatches(k, STALE_GENERATED_FIELDS) && stale.generatedAt === undefined) {
      stale.generatedAt = v.trim();
    }
    if (typeof v === 'string' && fieldMatches(k, STALE_EXPIRES_FIELDS) && stale.expiresAt === undefined) {
      stale.expiresAt = v.trim();
    }
    if (typeof v === 'number' && fieldMatches(k, STALE_TTL_FIELDS) && stale.ttlSeconds === undefined) {
      stale.ttlSeconds = v;
    }
  }

  // Validate as UNTRUSTED — drops any stray badge, enforces all safety rules.
  return validateCardSpec({ version: 1, blocks, ...stale }, { trusted: false });
}

/** Button label from a url field name. Never implies a completed transaction. */
function labelForUrlField(key: string): string {
  const k = key.toLowerCase();
  if (k.includes('map')) return 'Open in Maps';
  if (k.includes('book') || k.includes('appoint')) return 'View booking';
  if (k.includes('menu')) return 'View menu';
  if (k.includes('watch') || k.includes('stream')) return 'Watch';
  if (k.includes('product') || k.includes('item') || k.includes('shop') || k.includes('buy')) {
    return 'View item';
  }
  return 'Open';
}
