/**
 * The owner's UCP settings (UCP plan §4.2 U1): which merchants Dina may use,
 * and which `context` fields leave with a search.
 *
 *  - Merchants are origins (`https://host`), normalised and de-duplicated; a
 *    search may only go to them. A search that names none goes to all of
 *    them, when there are at most `SEARCH_MAX_MERCHANTS`; with more, Brain
 *    must choose.
 *  - Context is the owner's own, field by field: country, region, language,
 *    and a postal code only if the owner entered one (that entry is the
 *    opt-in, T-U1-13). Never coordinates; `signals` are never sent.
 * One row on the identity database, read synchronously by a search; it
 * travels in archives (it is the owner's configuration, not this device's).
 */

import { parseStrictJson } from '@dina/a2a';

import { merchantOrigin } from './discovery';
import { SEARCH_MAX_MERCHANTS } from './search_projection';

import type { DatabaseAdapter } from '../../storage/db_adapter';
import type { IntentContext } from '@dina/ucp';

/** Merchants the owner may allow at most. */
export const ALLOWED_MERCHANTS_MAX = 50;

export interface UcpSettings {
  /** Allowed merchant origins, sorted. */
  merchants: string[];
  context: IntentContext;
  /**
   * Whether a server with a public domain lists its own order `webhook_url`
   * (S8: on by default). Off, it lists the drop-box and relies on polling.
   * A node with no public domain lists the drop-box whatever this says.
   * Absent means on.
   */
  order_webhooks?: boolean;
}

export const EMPTY_UCP_SETTINGS: UcpSettings = { merchants: [], context: {}, order_webhooks: true };

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,63}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const POSTAL = /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/;

export type SettingsRead =
  | { ok: true; settings: UcpSettings }
  | {
      ok: false;
      field:
        | 'merchants'
        | 'address_country'
        | 'address_region'
        | 'language'
        | 'postal_code'
        | 'order_webhooks'
        | 'shape';
    };

/** The settings as the owner sends them, checked field by field; unknown members are refused. */
export function readUcpSettings(value: unknown): SettingsRead {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, field: 'shape' };
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'merchants' && k !== 'context' && k !== 'order_webhooks'))
    return { ok: false, field: 'shape' };
  if (v.order_webhooks !== undefined && typeof v.order_webhooks !== 'boolean')
    return { ok: false, field: 'order_webhooks' };
  if (!Array.isArray(v.merchants) || v.merchants.length > ALLOWED_MERCHANTS_MAX)
    return { ok: false, field: 'merchants' };
  const origins: string[] = [];
  for (const m of v.merchants) {
    const origin = typeof m === 'string' ? merchantOrigin(m) : null;
    if (origin === null) return { ok: false, field: 'merchants' };
    origins.push(origin);
  }
  const c = v.context ?? {};
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return { ok: false, field: 'shape' };
  const ctx = c as Record<string, unknown>;
  const rules: [keyof IntentContext, RegExp][] = [
    ['address_country', COUNTRY],
    ['address_region', REGION],
    ['language', LANGUAGE],
    ['postal_code', POSTAL],
  ];
  if (Object.keys(ctx).some((k) => !rules.some(([name]) => name === k)))
    return { ok: false, field: 'shape' };
  const context: IntentContext = {};
  for (const [name, re] of rules) {
    const field = ctx[name];
    if (field === undefined || field === '') continue;
    if (typeof field !== 'string' || !re.test(field)) return { ok: false, field: name };
    context[name] = field;
  }
  return {
    ok: true,
    settings: {
      merchants: [...new Set(origins)].sort(),
      context,
      order_webhooks: v.order_webhooks !== false,
    },
  };
}

export class UcpSettingsStore {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * The owner's settings; none saved (or a row that no longer reads) is no
   * merchants and no context. A single shop that no longer qualifies is dropped.
   */
  get(): UcpSettings {
    const row = this.db.query(`SELECT settings_json FROM ucp_owner_settings WHERE id = 1`)[0];
    if (row === undefined) return EMPTY_UCP_SETTINGS;
    const parsed = parseStrictJson(String(row.settings_json));
    if (!parsed.ok) return EMPTY_UCP_SETTINGS;
    // A shop saved under an older, looser rule (a bare local name) is dropped on its own;
    // the owner's other shops and context stay.
    const stored = parsed.value;
    const kept =
      stored !== null &&
      typeof stored === 'object' &&
      !Array.isArray(stored) &&
      Array.isArray((stored as { merchants?: unknown }).merchants)
        ? {
            ...stored,
            merchants: (stored as { merchants: unknown[] }).merchants.filter(
              (m) => typeof m === 'string' && merchantOrigin(m) !== null,
            ),
          }
        : stored;
    const read = readUcpSettings(kept);
    return read.ok ? read.settings : EMPTY_UCP_SETTINGS;
  }

  set(settings: UcpSettings, now: number): void {
    this.db.run(
      `INSERT INTO ucp_owner_settings (id, settings_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      [JSON.stringify(settings), now],
    );
  }
}

let installedStore: UcpSettingsStore | null = null;
let changed: (() => void) | null = null;

/** Called after the owner saves settings: a host re-uploads its profile when they change it. */
export function installUcpSettingsListener(fn: (() => void) | null): void {
  changed = fn;
}

/** Tell the host the owner saved settings. */
export function ucpSettingsChanged(): void {
  changed?.();
}

/** The settings store for the owner's routes, installed with the identity database (UCP on or off). */
export function installUcpSettingsStore(store: UcpSettingsStore | null): void {
  installedStore = store;
}

export function getUcpSettingsStore(): UcpSettingsStore | null {
  return installedStore;
}

export type MerchantChoice =
  | { ok: true; merchants: string[] }
  | {
      ok: false;
      reason:
        | 'no_merchants_allowed'
        | 'choose_merchants'
        | 'merchant_not_allowed'
        | 'bad_merchants'
        | 'too_many_merchants';
    };

/**
 * The merchants a search goes to: those Brain named, each one the owner
 * allows; or, when Brain named none, every allowed merchant if there are at
 * most `SEARCH_MAX_MERCHANTS`.
 */
export function chooseMerchants(named: readonly string[], settings: UcpSettings): MerchantChoice {
  if (settings.merchants.length === 0) return { ok: false, reason: 'no_merchants_allowed' };
  if (named.length === 0) {
    return settings.merchants.length <= SEARCH_MAX_MERCHANTS
      ? { ok: true, merchants: settings.merchants }
      : { ok: false, reason: 'choose_merchants' };
  }
  const allowed = new Set(settings.merchants);
  const out: string[] = [];
  for (const m of named) {
    const origin = merchantOrigin(m);
    if (origin === null) return { ok: false, reason: 'bad_merchants' };
    if (!allowed.has(origin)) return { ok: false, reason: 'merchant_not_allowed' };
    if (!out.includes(origin)) out.push(origin);
  }
  // Named shops are allowed ones, but one search asks at most ten of them.
  if (out.length > SEARCH_MAX_MERCHANTS) return { ok: false, reason: 'too_many_merchants' };
  return { ok: true, merchants: out };
}
