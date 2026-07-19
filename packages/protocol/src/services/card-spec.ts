/**
 * CardSpec — the safe, fixed-vocabulary, declarative description of a
 * service-result display card.
 *
 * "Card as DATA, not code": a provider's result is mapped to an ordered list
 * of blocks drawn from THIS fixed vocabulary. The client renders ONLY these
 * blocks — never provider- or LLM-authored markup/code/URLs/images. See
 * `docs/CARD_SPEC_DESIGN.md` for the full design + scenario catalogue.
 *
 * Three producers all emit a CardSpec and all pass through
 * `validateCardSpec()`: the deterministic mapper (ships now), the provider
 * `displayTemplate` (v2), and the LLM-authored path (v2).
 *
 * v1 forward-compat envelope (permanent — never a breaking v2):
 *   - `version: 1` is the compatibility envelope; additive features never
 *     bump it.
 *   - Unknown top-level fields are ignored (not fatal).
 *   - Unknown block kinds are dropped (not fatal) — older clients still
 *     render the blocks they know.
 *   - Existing block/field semantics never change; growth is additive only.
 *
 * Safety (enforced by `validateCardSpec`):
 *   - No image URLs. `media` carries a blob CID + DID only (render deferred).
 *   - No provider URLs auto-followed. `map` carries STRUCTURED coords/query
 *     (client builds the maps link); `link` is https-only + hardened host
 *     checks, `action: 'open_url'` only, renderer shows the real host.
 *   - No provider trust UI. `badge` blocks are Dina-owned: the untrusted
 *     path (default) DROPS them; only `validateCardSpec(v, {trusted:true})`
 *     keeps them.
 *   - Bounded everything (text/blocks/items/ratios/coords/ratings/ttl).
 *
 * This module is part of `@dina/protocol` and MUST stay zero-dependency
 * (enforced by dep_hygiene). It is a wire type — changes are wire-format
 * changes (additive only).
 */

// ── Enumerations ─────────────────────────────────────────────────────────

/** Semantic icons (mapped to platform glyphs by the renderer). */
export const CARD_ICONS = [
  'transit',
  'calendar',
  'price',
  'store',
  'location',
  'map',
  'package',
  'flight',
  'weather',
  'food',
  'star',
  'clock',
  'info',
  'check',
  'warning',
  'person',
  'document',
  'link',
] as const;
export type CardIcon = (typeof CARD_ICONS)[number];

/** Color-scheme tones. The renderer maps each to a theme color. */
export const CARD_TONES = ['neutral', 'positive', 'caution', 'critical', 'info', 'accent'] as const;
export type CardTone = (typeof CARD_TONES)[number];

/** Timeline step states. */
export const TIMELINE_STATES = ['done', 'active', 'upcoming'] as const;
export type TimelineState = (typeof TIMELINE_STATES)[number];

/** Allowed media aspect ratios (render deferred until the image proxy). */
export const MEDIA_ASPECTS = ['1:1', '4:3', '16:9'] as const;
export type MediaAspect = (typeof MEDIA_ASPECTS)[number];

/**
 * Allowed link actions. v1 ships ONLY `open_url` (user-tapped, host shown).
 * `contact_provider` / `start_checkout` are deferred (no silent commerce).
 */
export const LINK_ACTIONS = ['open_url'] as const;
export type LinkAction = (typeof LINK_ACTIONS)[number];

/** The closed set of block kinds a conformant renderer understands. */
export const CARD_BLOCK_KINDS = [
  'title',
  'section',
  'divider',
  'stat',
  'keyValue',
  'body',
  'badge',
  'bar',
  'rating',
  'chips',
  'list',
  'timeline',
  'map',
  'link',
  'media',
] as const;
export type CardBlockKind = (typeof CARD_BLOCK_KINDS)[number];

// ── Block interfaces ─────────────────────────────────────────────────────

export interface TitleBlock {
  kind: 'title';
  text: string;
  icon?: CardIcon;
  tone?: CardTone;
}

export interface SectionBlock {
  kind: 'section';
  label: string;
}

export interface DividerBlock {
  kind: 'divider';
}

export interface StatBlock {
  kind: 'stat';
  value: string;
  unit?: string;
  caption?: string;
  tone?: CardTone;
}

export interface KeyValueBlock {
  kind: 'keyValue';
  label: string;
  value: string;
  tone?: CardTone;
}

export interface BodyBlock {
  kind: 'body';
  /** Plain text only — no markdown is parsed or rendered. */
  text: string;
}

/** Dina-owned trust pill. Only survives `validateCardSpec(v,{trusted:true})`. */
export interface BadgeBlock {
  kind: 'badge';
  text: string;
  tone?: CardTone;
}

export interface BarBlock {
  kind: 'bar';
  label?: string;
  /** Fill fraction, clamped to [0,1]. */
  ratio: number;
  valueLabel?: string;
  tone?: CardTone;
}

export interface RatingBlock {
  kind: 'rating';
  /** Star value, clamped to [0,5]. */
  value: number;
  count?: number;
  tone?: CardTone;
}

export interface ChipsBlock {
  kind: 'chips';
  items: { text: string; tone?: CardTone }[];
}

export interface ListRow {
  text: string;
  sub?: string;
  trailing?: string;
  tone?: CardTone;
}
export interface ListBlock {
  kind: 'list';
  rows: ListRow[];
}

export interface TimelineStep {
  label: string;
  state: TimelineState;
}
export interface TimelineBlock {
  kind: 'timeline';
  steps: TimelineStep[];
}

/**
 * Maps affordance carrying STRUCTURED location — never a URL. The client
 * builds the deep-link from `lat`/`lng` (preferred) or `query`.
 */
export interface MapBlock {
  kind: 'map';
  label: string;
  lat?: number;
  lng?: number;
  query?: string;
}

/**
 * Safe external link. `url` is https-only + hardened; `action` is `open_url`;
 * the renderer shows the real destination host beside `label`.
 */
export interface LinkBlock {
  kind: 'link';
  label: string;
  url: string;
  action: LinkAction;
}

/**
 * Image referenced by AT-Proto blob CID + owning DID (never a URL). Render
 * deferred until the Dina image proxy exists; specified now so the wire
 * format is ready.
 */
export interface MediaBlock {
  kind: 'media';
  did: string;
  cid: string;
  alt: string;
  aspect?: MediaAspect;
}

export type CardBlock =
  | TitleBlock
  | SectionBlock
  | DividerBlock
  | StatBlock
  | KeyValueBlock
  | BodyBlock
  | BadgeBlock
  | BarBlock
  | RatingBlock
  | ChipsBlock
  | ListBlock
  | TimelineBlock
  | MapBlock
  | LinkBlock
  | MediaBlock;

export interface CardSpec {
  version: 1;
  blocks: CardBlock[];
  /** ISO-8601 — when the provider generated the underlying result. */
  generatedAt?: string;
  /** ISO-8601 — hard expiry of the result. */
  expiresAt?: string;
  /** Relative expiry (seconds from generatedAt), clamped. */
  ttlSeconds?: number;
  /** Short provenance label, e.g. "15-min delayed". */
  sourceLabel?: string;
}

// ── Limits ───────────────────────────────────────────────────────────────

export const CARD_MAX_BLOCKS = 32;
export const CARD_MAX_TEXT = 2000;
export const CARD_MAX_ITEMS = 24;
export const CARD_MAX_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ── Validation ───────────────────────────────────────────────────────────

export interface ValidateCardSpecOptions {
  /**
   * When true, the producer is trusted (Dina / PeerLens) and `badge` blocks
   * are kept. Default false: badges are dropped (provider/LLM can't fake
   * trust UI).
   */
  trusted?: boolean;
}

/**
 * Validate + normalize an untrusted value into a safe `CardSpec`, or `null`
 * if it can't be made into one. Never throws.
 *
 * Forward-compat: unknown block kinds and unknown top-level fields are
 * dropped/ignored, not rejected. A card with zero surviving blocks returns
 * `null` so the caller can fall back to generic key-value rendering.
 */
export function validateCardSpec(value: unknown, opts: ValidateCardSpecOptions = {}): CardSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (!Array.isArray(obj.blocks)) return null;

  const trusted = opts.trusted === true;
  const blocks: CardBlock[] = [];
  for (const raw of obj.blocks) {
    if (blocks.length >= CARD_MAX_BLOCKS) break;
    const block = normalizeBlock(raw, trusted);
    if (block !== null) blocks.push(block);
  }
  if (blocks.length === 0) return null;

  const spec: CardSpec = { version: 1, blocks };
  const generatedAt = cleanIsoTimestamp(obj.generatedAt);
  if (generatedAt !== null) spec.generatedAt = generatedAt;
  const expiresAt = cleanIsoTimestamp(obj.expiresAt);
  if (expiresAt !== null) spec.expiresAt = expiresAt;
  const ttl = cleanTtlSeconds(obj.ttlSeconds);
  if (ttl !== null) spec.ttlSeconds = ttl;
  const sourceLabel = cleanText(obj.sourceLabel);
  if (sourceLabel !== null) spec.sourceLabel = sourceLabel;
  return spec;
}

function normalizeBlock(raw: unknown, trusted: boolean): CardBlock | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  switch (b.kind) {
    case 'title': {
      const text = cleanText(b.text);
      if (text === null) return null;
      return withOptional<TitleBlock>({ kind: 'title', text }, { icon: cleanIcon(b.icon), tone: cleanTone(b.tone) });
    }
    case 'section': {
      const label = cleanText(b.label);
      if (label === null) return null;
      return { kind: 'section', label };
    }
    case 'divider':
      return { kind: 'divider' };
    case 'stat': {
      const valueStr = cleanText(b.value);
      if (valueStr === null) return null;
      return withOptional<StatBlock>(
        { kind: 'stat', value: valueStr },
        { unit: cleanText(b.unit) ?? undefined, caption: cleanText(b.caption) ?? undefined, tone: cleanTone(b.tone) },
      );
    }
    case 'keyValue': {
      const label = cleanText(b.label);
      const v = cleanText(b.value);
      if (label === null || v === null) return null;
      return withOptional<KeyValueBlock>({ kind: 'keyValue', label, value: v }, { tone: cleanTone(b.tone) });
    }
    case 'body': {
      const text = cleanText(b.text);
      if (text === null) return null;
      return { kind: 'body', text };
    }
    case 'badge': {
      // Dina-owned: dropped on the untrusted path.
      if (!trusted) return null;
      const text = cleanText(b.text);
      if (text === null) return null;
      return withOptional<BadgeBlock>({ kind: 'badge', text }, { tone: cleanTone(b.tone) });
    }
    case 'bar': {
      const ratio = cleanRatio(b.ratio);
      if (ratio === null) return null;
      return withOptional<BarBlock>(
        { kind: 'bar', ratio },
        { label: cleanText(b.label) ?? undefined, valueLabel: cleanText(b.valueLabel) ?? undefined, tone: cleanTone(b.tone) },
      );
    }
    case 'rating': {
      const ratingValue = cleanBoundedNumber(b.value, 0, 5);
      if (ratingValue === null) return null;
      return withOptional<RatingBlock>(
        { kind: 'rating', value: ratingValue },
        { count: cleanCount(b.count) ?? undefined, tone: cleanTone(b.tone) },
      );
    }
    case 'chips': {
      if (!Array.isArray(b.items)) return null;
      const items: ChipsBlock['items'] = [];
      for (const it of b.items) {
        if (items.length >= CARD_MAX_ITEMS) break;
        if (typeof it !== 'object' || it === null) continue;
        const itObj = it as Record<string, unknown>;
        const text = cleanText(itObj.text);
        if (text === null) continue;
        const tone = cleanTone(itObj.tone);
        items.push(tone !== undefined ? { text, tone } : { text });
      }
      if (items.length === 0) return null;
      return { kind: 'chips', items };
    }
    case 'list': {
      if (!Array.isArray(b.rows)) return null;
      const rows: ListRow[] = [];
      for (const r of b.rows) {
        if (rows.length >= CARD_MAX_ITEMS) break;
        if (typeof r !== 'object' || r === null) continue;
        const rObj = r as Record<string, unknown>;
        const text = cleanText(rObj.text);
        if (text === null) continue;
        rows.push(
          withOptional<ListRow>(
            { text },
            { sub: cleanText(rObj.sub) ?? undefined, trailing: cleanText(rObj.trailing) ?? undefined, tone: cleanTone(rObj.tone) },
          ),
        );
      }
      if (rows.length === 0) return null;
      return { kind: 'list', rows };
    }
    case 'timeline': {
      if (!Array.isArray(b.steps)) return null;
      const steps: TimelineStep[] = [];
      for (const s of b.steps) {
        if (steps.length >= CARD_MAX_ITEMS) break;
        if (typeof s !== 'object' || s === null) continue;
        const sObj = s as Record<string, unknown>;
        const label = cleanText(sObj.label);
        const state = cleanTimelineState(sObj.state);
        if (label === null || state === null) continue;
        steps.push({ label, state });
      }
      if (steps.length === 0) return null;
      return { kind: 'timeline', steps };
    }
    case 'map': {
      const label = cleanText(b.label);
      if (label === null) return null;
      const lat = cleanLatLng(b.lat, 90);
      const lng = cleanLatLng(b.lng, 180);
      const query = cleanText(b.query);
      const hasCoords = lat !== null && lng !== null;
      if (!hasCoords && query === null) return null; // need coords or a query
      const out: MapBlock = { kind: 'map', label };
      if (hasCoords) {
        out.lat = lat;
        out.lng = lng;
      }
      if (query !== null) out.query = query;
      return out;
    }
    case 'link': {
      const label = cleanText(b.label);
      const url = cleanHttpsUrl(b.url);
      if (label === null || url === null) return null;
      // action coerced to the only allowed v1 value.
      return { kind: 'link', label, url, action: 'open_url' };
    }
    case 'media': {
      const did = cleanText(b.did);
      const cid = cleanText(b.cid);
      const alt = cleanText(b.alt);
      if (did === null || cid === null || alt === null) return null;
      if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(did)) return null;
      const out: MediaBlock = { kind: 'media', did, cid, alt };
      const aspect = cleanAspect(b.aspect);
      if (aspect !== undefined) out.aspect = aspect;
      return out;
    }
    default:
      return null; // unknown kind — dropped (forward-compat)
  }
}

// ── Field cleaners ───────────────────────────────────────────────────────

/**
 * Attach the defined entries of `optionals` onto `base`, returning `base`
 * typed as `T`. Casts via `unknown` because the concrete block interfaces
 * have no string index signature.
 */
function withOptional<T extends CardBlock | ListRow>(base: T, optionals: Record<string, unknown>): T {
  const out = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(optionals)) {
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as T;
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > CARD_MAX_TEXT ? trimmed.slice(0, CARD_MAX_TEXT) : trimmed;
}

function cleanIcon(v: unknown): CardIcon | undefined {
  return typeof v === 'string' && (CARD_ICONS as readonly string[]).includes(v) ? (v as CardIcon) : undefined;
}

function cleanTone(v: unknown): CardTone | undefined {
  return typeof v === 'string' && (CARD_TONES as readonly string[]).includes(v) ? (v as CardTone) : undefined;
}

function cleanTimelineState(v: unknown): TimelineState | null {
  return typeof v === 'string' && (TIMELINE_STATES as readonly string[]).includes(v) ? (v as TimelineState) : null;
}

function cleanAspect(v: unknown): MediaAspect | undefined {
  return typeof v === 'string' && (MEDIA_ASPECTS as readonly string[]).includes(v) ? (v as MediaAspect) : undefined;
}

/** A finite number clamped to [0,1], or null if not a finite number. */
function cleanRatio(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** A finite number clamped to [min,max], or null if not a finite number. */
function cleanBoundedNumber(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** A non-negative integer count, or null. */
function cleanCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

/** A finite lat/lng within ±limit, or null. */
function cleanLatLng(v: unknown, limit: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < -limit || v > limit) return null;
  return v;
}

/** An ISO-8601 timestamp string that Date.parse accepts, or null. */
function cleanIsoTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

/** A positive ttl in seconds, clamped to the max, or null. */
function cleanTtlSeconds(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(Math.floor(v), CARD_MAX_TTL_SECONDS);
}

/**
 * Validate a URL as a SAFE https link, returning the trimmed URL or null.
 * Hardened beyond https-only: rejects embedded credentials, localhost /
 * .local / IP-literal / private-range hosts, and non-standard ports. Uses
 * the runtime `URL` parser when available, with a strict regex fallback.
 * The single security-load-bearing check (link is the only block that opens
 * a URL).
 */
function cleanHttpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0 || s.length > CARD_MAX_TEXT) return null;

  // Fast structural reject before parsing.
  if (!/^https:\/\//i.test(s)) return null;
  if (/[@\s]/.test(s.slice(0, s.indexOf('/', 8) === -1 ? s.length : s.indexOf('/', 8)))) {
    // credentials (@) or whitespace in the authority — reject.
    return null;
  }

  let host: string | null = null;
  let port = '';
  try {
    if (typeof URL === 'function') {
      const u = new URL(s);
      if (u.protocol !== 'https:') return null;
      if (u.username !== '' || u.password !== '') return null;
      host = u.hostname;
      port = u.port;
    }
  } catch {
    return null;
  }

  if (host === null) {
    // Fallback parse: scheme://authority/...
    const m = /^https:\/\/([^/?#]+)/i.exec(s);
    if (m === null || m[1] === undefined) return null;
    const authority = m[1];
    if (authority.includes('@')) return null;
    const portIdx = authority.lastIndexOf(':');
    if (portIdx > authority.lastIndexOf(']')) {
      // a port is present (and not part of an IPv6 literal)
      host = authority.slice(0, portIdx);
      port = authority.slice(portIdx + 1);
    } else {
      host = authority;
    }
  }

  if (!isSafeHost(host)) return null;
  if (port !== '' && port !== '443') return null;
  return s;
}

/** Reject localhost / .local / IP-literals / private + link-local ranges. */
function isSafeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '' || h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) {
    return false;
  }
  // IPv6 literal (e.g. [::1]) — reject all bracketed-literal hosts.
  if (h.startsWith('[')) return false;
  // IPv4 literal?
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const o = v4.slice(1).map((n) => Number(n));
    if (o.some((n) => n > 255)) return false;
    const a = o[0] ?? 0;
    const b = o[1] ?? 0;
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // loopback
    if (a === 0) return false; // 0.0.0.0/8
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
    if (a === 192 && b === 168) return false; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true; // a public IPv4 literal — allowed (rare but not unsafe)
  }
  // A real hostname must contain a dot (reject bare single-label hosts).
  return h.includes('.');
}

/**
 * Extract the display host from a validated https URL for the safe-link
 * renderer (so the UI can show where a tap actually goes). Lowercased,
 * leading `www.` stripped; `''` if unparseable. Pure string parse.
 */
export function linkDisplayHost(url: string): string {
  const m = /^https:\/\/([^/?#\s]+)/i.exec(url.trim());
  const host = m?.[1];
  if (host === undefined) return '';
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Whether a card's underlying result is stale at `nowMs` (epoch ms). True
 * when `expiresAt` is in the past, or `generatedAt + ttlSeconds` is in the
 * past. False when there's no expiry information. Pure — the caller passes
 * the clock so it stays testable.
 */
export function isCardStale(spec: CardSpec, nowMs: number): boolean {
  if (spec.expiresAt !== undefined) {
    const t = Date.parse(spec.expiresAt);
    if (!Number.isNaN(t)) return nowMs >= t;
  }
  if (spec.generatedAt !== undefined && spec.ttlSeconds !== undefined) {
    const g = Date.parse(spec.generatedAt);
    if (!Number.isNaN(g)) return nowMs >= g + spec.ttlSeconds * 1000;
  }
  return false;
}
