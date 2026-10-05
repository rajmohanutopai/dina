/**
 * A merchant search (UCP plan §3.11, §3.16): the query checked by Core, sent
 * to each merchant, and every product returned as Brain may read it, with
 * its text behind the guard.
 *
 *  - The query leaves only through the projection (`checkSearch`), or under
 *    an owner-approved `ucp_search_review` card bound to exactly it.
 *  - Each merchant is asked once, in parallel; one that cannot be reached,
 *    or cannot serve the search, is reported, never fatal to the rest. A
 *    node without its UCP identity (sealed) searches nothing.
 *  - Every product reaches Brain as handles and checked fields. Its text is
 *    guarded for at most 20 products per merchant answer and 40 per search,
 *    taken in turn from each merchant in the merchant's own order; the rest's
 *    text stays withheld. One guard job per product.
 *    Counted by place in the answer, and an id the answer repeats is used
 *    once, so a merchant cannot widen the guard's work by repeating itself.
 *  - The merchants share one deadline (8 s, inside Brain's wait for Core); a
 *    merchant still working then is reported, never waited for.
 *  - The search's jobs share a 10-second budget: a job not started by then,
 *    and a claim with no verdict, are abandoned (and stay so), and a verdict
 *    that arrives after it is not used. Brain then reads the search: passed
 *    text, or a fixed "merchant text withheld" for anything blocked,
 *    abandoned or never checked.
 */

import { a2aDisplayText, parseStrictJson, type JsonObject } from '@dina/a2a';
import {
  brainView,
  hasShownPrices,
  buildSearchRequest,
  readProductDetail,
  readProductList,
  buildGetProductRequest,
  type BrainProduct,
  type GuardText,
  type Product,
} from '@dina/ucp';

import { canonicalDigest } from '../../a2a/digest';
import { OWNER_TURN_LIVE_MS } from '../../a2a/proposal';

import { linkAnswers } from './merchant_client';
import {
  checkSearch,
  raiseSearchReview,
  useSearchReview,
  type RaiseReview,
  type ReviewReason,
  type SearchCheckDeps,
  type SearchRequest,
  type UseReview,
} from './search_projection';
import { UcpSearchStore, type UcpGuardJobRow } from './search_store';
import { chooseMerchants, type MerchantChoice, type UcpSettings } from './settings';

import type { CallResult, MerchantConnection, UcpMerchantClient } from './merchant_client';
import type { WorkflowService } from '../../workflow/service';

export const GUARD_BUDGET_MS = 10_000;
export const GUARDED_PER_ANSWER = 20;
export const GUARDED_PER_SEARCH = 40;
/**
 * Products kept from one merchant answer, in its order. A merchant decides
 * how many it sends (up to the 2 MiB answer cap, thousands of small ones);
 * Brain cannot weigh thousands, and each kept product costs handles and a
 * stored row. The rest are counted as skipped.
 */
export const PRODUCTS_PER_ANSWER = 100;
/** Products kept from one search, taken in turn from each merchant; the rest are counted as skipped. */
export const PRODUCTS_PER_SEARCH = 200;
/**
 * How long Core waits for the merchants, all together. Under the 10 seconds
 * a server's Brain waits for any Core call, so Brain always gets the search
 * back; a merchant still working then is reported `timed_out` and its
 * answer, if it comes, is not used.
 */
export const SEARCH_MERCHANT_DEADLINE_MS = 8_000;
/** A search, its products and its jobs are kept this long; handles stay with the conversation. */
export const SEARCH_RETENTION_MS = 24 * 60 * 60_000;
/** What Brain reads in place of text that did not pass the guard. */
export const MERCHANT_TEXT_WITHHELD = 'merchant text withheld';

export interface SearchDeps {
  store: UcpSearchStore;
  client: Pick<UcpMerchantClient, 'open' | 'notReady'>;
  check: SearchCheckDeps;
  workflow: WorkflowService;
  nowMs: () => number;
  newId: () => string;
  /** The owner's settings: the merchants Dina may use, and the `context` fields that leave. */
  settings: () => UcpSettings;
  /** Tests shorten the merchants' deadline. */
  merchantDeadlineMs?: number;
}

export interface MerchantOutcome {
  handle: string;
  origin: string;
  /**
   * `ok`, or why this merchant gave nothing: not reached (`unreachable`), not
   * done in time (`timed_out`), answered past the size cap (`too_large`),
   * cannot serve search (`unavailable`: no UCP profile, no shared version, no
   * usable search), would
   * not take Dina's request as its schema reads it (`request_invalid`), asked
   * Dina to slow down (`rate_limited`), refused Dina's identity or scope
   * (`refused`), could not read or accept Dina's buyer profile
   * (`profile_rejected`: the spec's negotiation errors), failed with another error (`merchant_error`, or a UCP
   * `error_response`), or answered outside its schema (`answer_invalid`,
   * `malformed`).
   */
  state:
    | 'ok'
    | 'unreachable'
    | 'timed_out'
    | 'too_large'
    | 'unavailable'
    | 'request_invalid'
    | 'rate_limited'
    | 'refused'
    /** The shop asks for a linked account (a Bearer challenge, §3.17): offered to the owner. */
    | 'link_required'
    | 'profile_rejected'
    | 'merchant_error'
    | 'error_response'
    | 'answer_invalid'
    | 'malformed';
  products: number;
  /** Products in the answer that were not used: unreadable, or an id the answer repeats. */
  skipped: number;
}

export type SearchStart =
  | { ok: true; searchId: string; merchants: MerchantOutcome[]; provenance: 'quoted' | 'derived' }
  | { ok: false; reason: 'needs_review'; why: ReviewReason[] }
  | { ok: false; reason: 'bad_query' | 'no_owner_turn' | 'ucp_not_ready' | 'ucp_key_pending' }
  | { ok: false; reason: Exclude<MerchantChoice, { ok: true }>['reason']; allowed?: string[] }
  | { ok: false; reason: 'review'; review: Exclude<UseReview, { ok: true }>['reason'] };

interface Answer {
  origin: string;
  state: MerchantOutcome['state'];
  products: Product[];
  skipped: number;
}

/** Start a search: check, send to each merchant, keep the results and queue the guard. */
export async function startSearch(
  asked: SearchRequest & { reviewId?: string },
  deps: SearchDeps,
): Promise<SearchStart> {
  const settings = deps.settings();
  const choice = chooseMerchants(asked.merchants, settings);
  if (!choice.ok) return merchantRefusal(choice.reason, settings);
  const req = { ...asked, merchants: choice.merchants };
  const check = checkSearch(req, deps.check);
  if (!check.ok && check.reason !== 'needs_review' && check.reason !== 'no_owner_turn')
    return { ok: false, reason: check.reason };
  // Checked before a card is used: a sealed node must not spend the owner's approval.
  const notReady = deps.client.notReady();
  if (notReady !== null) return { ok: false, reason: notReady };
  // A held search, or one with no owner turn in the last half hour, goes only under the
  // owner's approved card for exactly it: the approval is also the owner's presence.
  if (!check.ok) {
    if (req.reviewId === undefined)
      return check.reason === 'needs_review'
        ? { ok: false, reason: 'needs_review', why: check.why }
        : { ok: false, reason: 'no_owner_turn' };
    const used = useSearchReview(req.reviewId, check.search, req.sessionId, {
      workflow: deps.workflow,
      nowMs: deps.nowMs,
    });
    if (!used.ok) return { ok: false, reason: 'review', review: used.reason };
  }
  const search = check.search;
  const context = settings.context;
  const body = buildSearchRequest({ query: search.query, context });

  const answers = await withinDeadline(
    search.merchants.map(async (origin): Promise<Answer> => {
      const opened = await deps.client.open(origin);
      if (!opened.ok) {
        // Not reached at all, or reached but its profile offers no search Dina can use.
        const state = opened.reason === 'unreachable' ? 'unreachable' : 'unavailable';
        return { origin, state, products: [], skipped: 0 };
      }
      return {
        origin,
        ...(await askMerchant(opened.connection, 'search_catalog', body, readList)),
      };
    }),
    search.merchants.map(
      (origin): Answer => ({ origin, state: 'timed_out', products: [], skipped: 0 }),
    ),
    deps.merchantDeadlineMs ?? SEARCH_MERCHANT_DEADLINE_MS,
  );

  const { searchId, merchants } = storeAnswers(
    req.sessionId,
    search.binding,
    search.merchants,
    answers,
    deps,
  );
  return { ok: true, searchId, merchants, provenance: search.provenance };
}

/**
 * Keep what the merchants answered, as one search: Brain's views with their
 * handles, a guard job for each guarded product, and the guard's budget from
 * now. Searches and product fetches both end here.
 */
function storeAnswers(
  sessionId: string,
  binding: string,
  origins: readonly string[],
  answers: readonly Answer[],
  deps: SearchDeps,
): { searchId: string; merchants: MerchantOutcome[]; kept: Product[][] } {
  const kept = keptProducts(answers);
  const now = deps.nowMs();
  const searchId = `ucp-search-${deps.newId()}`;
  const merchants: MerchantOutcome[] = [];
  deps.store.transaction(() => {
    deps.store.purgeBefore(now - SEARCH_RETENTION_MS);
    deps.store.insertSearch({
      search_id: searchId,
      session_id: sessionId,
      query_digest: binding,
      // Each merchant's outcome, set below once known; the origins until then.
      merchants_json: JSON.stringify(origins),
      state: 'running',
      created_at: now,
      guard_until: now + GUARD_BUDGET_MS,
    });
    // Views first, per merchant, in the merchant's order.
    const perMerchant = answers.map((a, m) => {
      const mHandle = deps.store.handle(
        sessionId,
        { kind: 'merchant', merchantOrigin: a.origin, value: a.origin },
        now,
      );
      const unique = kept[m] ?? [];
      merchants.push({
        handle: mHandle,
        origin: a.origin,
        state: a.state,
        products: unique.length,
        skipped: a.skipped + (a.products.length - unique.length),
      });
      // The stored job is `{merchant, text}`: the text is cut to leave room for the rest.
      const reserve = byteLength({ merchant: a.origin, text: null }) - byteLength(null);
      return unique.map((p) =>
        brainView(
          p,
          mHandle,
          {
            product: (id) =>
              deps.store.handle(
                sessionId,
                { kind: 'product', merchantOrigin: a.origin, value: id },
                now,
              ),
            variant: (ph, id) =>
              deps.store.handle(
                sessionId,
                // Both ids are merchant strings: a JSON pair cannot be read two ways.
                { kind: 'variant', merchantOrigin: a.origin, value: JSON.stringify([p.id, id]) },
                now,
                ph,
              ),
            unit: (code) =>
              deps.store.handle(
                sessionId,
                { kind: 'unit', merchantOrigin: a.origin, value: code },
                now,
              ),
          },
          reserve,
        ),
      );
    });
    // Guarded in turn from each merchant: the first product of each, then the second, …,
    // at most 20 from one answer and 40 in all. Counted by place in the answer.
    const guarded = new Set<string>();
    for (let i = 0; i < GUARDED_PER_ANSWER && guarded.size < GUARDED_PER_SEARCH; i++) {
      perMerchant.forEach((views, m) => {
        if (i < views.length && guarded.size < GUARDED_PER_SEARCH) guarded.add(`${m}:${i}`);
      });
    }
    let position = 0;
    answers.forEach((a, m) => {
      (perMerchant[m] ?? []).forEach((v, i) => {
        const isGuarded = guarded.has(`${m}:${i}`);
        deps.store.insertResult({
          search_id: searchId,
          position,
          product_handle: v.product.handle,
          merchant_origin: a.origin,
          record_json: JSON.stringify({ product: v.product, guarded: isGuarded }),
          owner_json: JSON.stringify(ownerText(kept[m]?.[i], a.origin)),
        });
        if (isGuarded) {
          const content = { merchant: a.origin, text: v.text };
          deps.store.insertJob({
            job_id: `ucp-guard-${deps.newId()}`,
            search_id: searchId,
            position,
            merchant_origin: a.origin,
            content_json: JSON.stringify(content),
            digest: canonicalDigest(content),
            created_at: now,
          });
        }
        position += 1;
      });
    });
    const outcomes: OwnerMerchantOutcome[] = merchants.map((m) => ({
      origin: m.origin,
      state: m.state,
      products: m.products,
    }));
    deps.store.setOutcomes(searchId, JSON.stringify(outcomes));
  });
  return { searchId, merchants, kept };
}

/** A merchant's outcome as the owner's view reports it: no handles (those are Brain's). */
export interface OwnerMerchantOutcome {
  origin: string;
  state: MerchantOutcome['state'];
  products: number;
}

/**
 * The products each answer keeps, decided before any is stored: an id an
 * answer repeats is used once; at most `PRODUCTS_PER_ANSWER` from one answer
 * and `PRODUCTS_PER_SEARCH` in all, taken in turn from each merchant in its
 * own order. This bounds Core's work after the merchants' deadline (handles
 * and rows for at most 200 products of at most 10 variants each), whatever
 * the merchants send.
 */
function keptProducts(answers: readonly Answer[]): Product[][] {
  const unique = answers.map((a) => {
    const seen = new Set<string>();
    const out: Product[] = [];
    for (const p of a.products) {
      if (out.length >= PRODUCTS_PER_ANSWER) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      // A price past what Dina can show: skipped, as an unreadable product is.
      if (!hasShownPrices(p)) continue;
      out.push(p);
    }
    return out;
  });
  const take = unique.map(() => 0);
  let total = 0;
  for (let i = 0; total < PRODUCTS_PER_SEARCH; i++) {
    let any = false;
    unique.forEach((u, m) => {
      if (i < u.length && total < PRODUCTS_PER_SEARCH) {
        take[m] = (take[m] ?? 0) + 1;
        total += 1;
        any = true;
      }
    });
    if (!any) break;
  }
  return unique.map((u, m) => u.slice(0, take[m]));
}

/** The longest product title the owner's card shows. */
export const OWNER_TITLE_MAX = 200;

/**
 * What the owner's card shows of a product (plan §3.7: card text comes from
 * Core, from the merchant's answer, sanitised; the guard filters what Brain
 * reads, not what the owner reads): its title, with invisible characters
 * removed and bounded, and its page, https with no credentials.
 */
function ownerText(product: Product | undefined, merchant: string): OwnerProductText {
  if (product === undefined) return { title: '' };
  const url = product.url;
  const page =
    url !== undefined && new TextEncoder().encode(url).length <= OWNER_URL_MAX_BYTES
      ? { url, ...(leadsElsewhere(url, merchant) ? { url_elsewhere: true as const } : {}) }
      : {};
  return { title: a2aDisplayText(product.title, OWNER_TITLE_MAX), ...page };
}

/** The longest product page link the owner's card offers (plan §3.9's bound on owner links). */
export const OWNER_URL_MAX_BYTES = 2048;

/**
 * Whether a merchant's product page leads off the merchant's own host (plan
 * §3.8): anything but the host itself or a subdomain of it. The card then
 * shows the whole address and says so before it opens.
 */
export function leadsElsewhere(url: string, merchant: string): boolean {
  try {
    const host = new URL(url).hostname;
    const own = new URL(merchant).hostname;
    return host !== own && !host.endsWith(`.${own}`);
  } catch {
    return true;
  }
}

export interface OwnerProductText {
  title: string;
  url?: string;
  /** The page is not on the merchant's own host (or a subdomain of it). */
  url_elsewhere?: true;
}

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Each task's result, or its stand-in for any not settled by the deadline.
 * A late task is not stopped, only not waited for; its result is dropped.
 */
async function withinDeadline<T>(tasks: Promise<T>[], late: T[], ms: number): Promise<T[]> {
  const settled: (T | undefined)[] = tasks.map(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([
      Promise.all(
        tasks.map((t, i) =>
          t.then((value) => {
            settled[i] = value;
          }),
        ),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return settled.map((v, i) => (v === undefined ? (late[i] as T) : v));
}

/** UCP codes a merchant uses to refuse the caller rather than fail. */
/**
 * The spec's negotiation errors (overview, "Error Codes"): the merchant could
 * not read Dina's buyer profile, or does not support its version. Dina's
 * profile, or its host, is at fault, not the shop.
 */
const PROFILE_CODES = new Set([
  'invalid_profile_url',
  'profile_unreachable',
  'profile_malformed',
  'version_unsupported',
]);

const REFUSAL_CODES = new Set([
  'identity_required',
  'insufficient_scope',
  'unauthorized',
  'forbidden',
]);

/**
 * A merchant choice refused. When Brain must choose (more allowed shops than
 * one search may ask), the refusal names them all: they are the owner's own
 * list, not a merchant's words, and Brain cannot choose without them.
 */
function merchantRefusal(
  reason: Exclude<MerchantChoice, { ok: true }>['reason'],
  settings: UcpSettings,
): { ok: false; reason: Exclude<MerchantChoice, { ok: true }>['reason']; allowed?: string[] } {
  return reason === 'choose_merchants'
    ? { ok: false, reason, allowed: settings.merchants }
    : { ok: false, reason };
}

/**
 * Raise the owner's card for a held search, under the same merchant rule a
 * search applies: the card names exactly the merchants the search would go to.
 */
export function raiseUcpSearchReview(
  asked: SearchRequest,
  deps: SearchDeps,
):
  | RaiseReview
  | { ok: false; reason: Exclude<MerchantChoice, { ok: true }>['reason']; allowed?: string[] } {
  const settings = deps.settings();
  const choice = chooseMerchants(asked.merchants, settings);
  if (!choice.ok) return merchantRefusal(choice.reason, settings);
  return raiseSearchReview(
    { ...asked, merchants: choice.merchants },
    {
      ...deps.check,
      workflow: deps.workflow,
      reviews: deps.store,
      newId: deps.newId,
      nowMs: deps.nowMs,
    },
  );
}

interface Asked {
  state: MerchantOutcome['state'];
  products: Product[];
  skipped: number;
}

/** What a merchant call that failed means for its part in a search. */
export function failedCallState(r: Exclude<CallResult, { ok: true }>): MerchantOutcome['state'] {
  let state: MerchantOutcome['state'];
  if (r.kind === 'network')
    state =
      r.error === 'too_large'
        ? 'too_large'
        : r.error === 'timeout'
          ? 'timed_out'
          : // An answer signed with a key the profile does not list, or not signed as it says.
            r.error === 'signature_invalid'
            ? 'answer_invalid'
            : 'unreachable';
  else if (r.kind === 'transport') {
    // The UCP code first; the HTTP status where the merchant named no code.
    const { httpStatus, code } = r.error;
    state =
      code === 'rate_limited' || httpStatus === 429
        ? 'rate_limited'
        : PROFILE_CODES.has(code)
          ? 'profile_rejected'
          : (httpStatus === 401 || httpStatus === 403) && linkAnswers(r.error.challenge)
            ? 'link_required'
            : REFUSAL_CODES.has(code) || httpStatus === 401 || httpStatus === 403
              ? 'refused'
              : 'merchant_error';
  } else if (r.kind === 'not_sent')
    state =
      r.reason === 'request_invalid'
        ? 'request_invalid'
        : // A linked account whose token could not be had just now.
          r.reason === 'link_unavailable'
          ? 'unreachable'
          : 'unavailable';
  else state = r.kind;
  return state;
}

/** One merchant call, its answer read by `read`, or why there is none. */
async function askMerchant(
  connection: MerchantConnection,
  operation: 'search_catalog' | 'lookup_catalog' | 'get_product',
  body: JsonObject,
  read: (value: unknown) => { ok: true; products: Product[]; unreadable: number } | { ok: false },
): Promise<Asked> {
  const r = await connection.call(operation, { payload: body });
  if (!r.ok) {
    const state = failedCallState(r);
    return { state, products: [], skipped: 0 };
  }
  const got = read(r.value);
  return got.ok
    ? { state: 'ok', products: got.products, skipped: got.unreadable }
    : { state: 'malformed', products: [], skipped: 0 };
}

const readList = (value: unknown) => {
  const list = readProductList(value);
  return list.ok
    ? { ok: true as const, products: list.value.products, unreadable: list.value.unreadable }
    : { ok: false as const };
};

const readDetail = (value: unknown) => {
  const one = readProductDetail(value);
  return one.ok
    ? { ok: true as const, products: [one.value], unreadable: 0 }
    : { ok: false as const };
};

// ------------------------------------------------------------ products by handle

/** Products one fetch may name. */
export const FETCH_MAX_PRODUCTS = 10;

export interface FetchRequest {
  sessionId: string;
  /** Product handles (`p3`) Brain saw in this conversation. */
  products: readonly string[];
}

export type FetchStart =
  /** `missing`: handles asked for that no merchant answered with. */
  | { ok: true; searchId: string; merchants: MerchantOutcome[]; missing: string[] }
  | {
      ok: false;
      reason:
        | 'bad_products'
        | 'unknown_product'
        | 'no_owner_turn'
        | 'ucp_not_ready'
        | 'ucp_key_pending'
        | 'merchant_not_allowed';
    };

/**
 * Fetch products Brain names by handle, afresh from their merchants (UCP plan
 * §3.11): one with `get_product`, several from one merchant with
 * `lookup_catalog` (a merchant without the lookup capability serves neither,
 * and is reported `unavailable`). Brain sends no text: the request carries the merchant's own ids,
 * mapped back from the handles, and the owner's context. It serves a
 * conversation the owner is in now, and only merchants the owner still
 * allows. The answers are kept and guarded exactly as a search's are, under
 * the same handles; Brain reads them with `searchView`.
 */
export async function fetchUcpProducts(req: FetchRequest, deps: SearchDeps): Promise<FetchStart> {
  const handles = [...new Set(req.products)];
  if (handles.length === 0 || handles.length > FETCH_MAX_PRODUCTS)
    return { ok: false, reason: 'bad_products' };
  const byMerchant = new Map<string, string[]>();
  const handleOf = new Map<string, string>();
  for (const h of handles) {
    const target = deps.store.resolveHandle(req.sessionId, h);
    if (target === null || target.kind !== 'product')
      return { ok: false, reason: 'unknown_product' };
    byMerchant.set(target.merchantOrigin, [
      ...(byMerchant.get(target.merchantOrigin) ?? []),
      target.value,
    ]);
    handleOf.set(`${target.merchantOrigin}\n${target.value}`, h);
  }
  const turn = deps.check.log.latestUtterance(req.sessionId);
  if (turn === null || deps.nowMs() - turn.recorded_at > OWNER_TURN_LIVE_MS)
    return { ok: false, reason: 'no_owner_turn' };
  const settings = deps.settings();
  const allowed = new Set(settings.merchants);
  const origins = [...byMerchant.keys()].sort();
  if (origins.some((o) => !allowed.has(o))) return { ok: false, reason: 'merchant_not_allowed' };
  const notReady = deps.client.notReady();
  if (notReady !== null) return { ok: false, reason: notReady };
  // Used now: the purge that runs when the answers are stored must not take them.
  deps.store.touchHandles(req.sessionId, handles, deps.nowMs());

  const answers = await withinDeadline(
    origins.map(async (origin): Promise<Answer> => {
      const opened = await deps.client.open(origin);
      if (!opened.ok) {
        const state = opened.reason === 'unreachable' ? 'unreachable' : 'unavailable';
        return { origin, state, products: [], skipped: 0 };
      }
      // Each product with get_product, at once: a fetch wants each product whole, and
      // lookup_catalog answers one featured variant per product (catalog/lookup.md).
      const ids = byMerchant.get(origin) ?? [];
      const each = await Promise.all(
        ids.map((id) =>
          askMerchant(
            opened.connection,
            'get_product',
            buildGetProductRequest(id, settings.context),
            readDetail,
          ),
        ),
      );
      // Only the product asked for: a merchant may answer get_product with another.
      const products = each.flatMap((a, i) =>
        a.products.filter((p) => p.id === ids[i]).slice(0, 1),
      );
      const skipped = each.reduce((n, a) => n + a.skipped + a.products.length, 0) - products.length;
      // The shop's state is ok when any product came back (the rest are reported missing),
      // or why the first of them failed.
      const state = each.some((a) => a.state === 'ok')
        ? 'ok'
        : (each[0]?.state ?? 'merchant_error');
      return { origin, state, products, skipped };
    }),
    origins.map((origin): Answer => ({ origin, state: 'timed_out', products: [], skipped: 0 })),
    deps.merchantDeadlineMs ?? SEARCH_MERCHANT_DEADLINE_MS,
  );
  // A fetch's binding names what it asked for, as a search's names its query.
  const binding = canonicalDigest({ session: req.sessionId, fetch: [...handles].sort() });
  const { searchId, merchants, kept } = storeAnswers(
    req.sessionId,
    binding,
    origins,
    answers,
    deps,
  );
  // Missing: asked for and not stored, whether the shop did not answer with it or Core
  // could not keep it (a price past what Dina can show).
  const answered = new Set(
    answers.flatMap((a, m) =>
      (kept[m] ?? []).map((p) => handleOf.get(`${a.origin}\n${p.id}`) ?? ''),
    ),
  );
  return { ok: true, searchId, merchants, missing: handles.filter((h) => !answered.has(h)) };
}

// ------------------------------------------------------------ reading a search

export interface SearchProduct {
  product: BrainProduct;
  /** The guarded text, or null with why. */
  text: GuardText | null;
  /**
   * `passed`: the guard passed the text. `pending`: it is still checking.
   * `withheld`: it did not pass it, or ran out of time. `unchecked`: past the
   * guard's caps (20 an answer, 40 a search), so never offered to it.
   */
  text_state: 'passed' | 'pending' | 'withheld' | 'unchecked';
}

export interface SearchView {
  search_id: string;
  /** No job is left to wait for: every one decided, or the budget passed. */
  complete: boolean;
  products: SearchProduct[];
  withheld_marker: typeof MERCHANT_TEXT_WITHHELD;
}

/** The search as Brain reads it; null when it is not this conversation's. */
export function searchView(
  store: UcpSearchStore,
  searchId: string,
  sessionId: string,
  now: number,
): SearchView | null {
  const search = store.getSearch(searchId);
  if (search === null || search.session_id !== sessionId) return null;
  store.abandonLapsed(now);
  const jobs = new Map<number, UcpGuardJobRow>(store.jobs(searchId).map((j) => [j.position, j]));
  const budgetOver = now >= search.guard_until;
  const products: SearchProduct[] = [];
  let waiting = false;
  for (const r of store.results(searchId)) {
    const parsed = parseStrictJson(r.record_json);
    // Core's own row; one that does not read is shown as nothing rather than guessed at.
    if (!parsed.ok) continue;
    const record = parsed.value as unknown as { product: BrainProduct; guarded: boolean };
    const job = jobs.get(r.position);
    if (job === undefined) {
      products.push({ product: record.product, text: null, text_state: 'unchecked' });
      continue;
    }
    if (job.state === 'passed') {
      const content = UcpSearchStore.jobContent(job) as { text: GuardText } | null;
      products.push({
        product: record.product,
        text: content?.text ?? null,
        text_state: content === null ? 'withheld' : 'passed',
      });
    } else if ((job.state === 'pending' || job.state === 'claimed') && !budgetOver) {
      waiting = true;
      products.push({ product: record.product, text: null, text_state: 'pending' });
    } else {
      products.push({ product: record.product, text: null, text_state: 'withheld' });
    }
  }
  return {
    search_id: searchId,
    complete: !waiting,
    products,
    withheld_marker: MERCHANT_TEXT_WITHHELD,
  };
}

// ------------------------------------------------------------ the owner's view

export interface OwnerSearchProduct {
  /** The handle Brain uses for this product, so a card can follow Brain's order. */
  handle: string;
  /** The merchant's origin. */
  merchant: string;
  title: string;
  /** The product's page at the merchant, https. */
  url?: string;
  /** The page is off the merchant's own host: show it whole and say so. */
  url_elsewhere?: true;
  price_range: BrainProduct['price_range'];
  variants: {
    handle: string;
    price: BrainProduct['variants'][number]['price'];
    available?: boolean;
  }[];
}

export interface OwnerSearchView {
  search_id: string;
  created_at: number;
  /** Each merchant asked, and how it answered: the card names those that did not. */
  merchants: OwnerMerchantOutcome[];
  products: OwnerSearchProduct[];
}

/**
 * A search as the owner sees it: every kept product with its merchant, its
 * title and its page, whatever the guard decided for Brain. The owner reads
 * the merchant's words; Brain never does unguarded. Null when there is no
 * such search (or it has been purged).
 */
export function ownerSearchView(store: UcpSearchStore, searchId: string): OwnerSearchView | null {
  const search = store.getSearch(searchId);
  if (search === null) return null;
  const products: OwnerSearchProduct[] = [];
  for (const r of store.results(searchId)) {
    const record = parseStrictJson(r.record_json);
    const owner = parseStrictJson(r.owner_json);
    // Core's own rows; one that does not read is shown as nothing rather than guessed at.
    if (!record.ok || !owner.ok) continue;
    const product = (record.value as unknown as { product: BrainProduct }).product;
    const text = owner.value as unknown as OwnerProductText;
    products.push({
      handle: product.handle,
      merchant: r.merchant_origin,
      title: text.title,
      ...(text.url !== undefined ? { url: text.url } : {}),
      ...(text.url_elsewhere === true ? { url_elsewhere: true as const } : {}),
      price_range: product.price_range,
      variants: product.variants.map((v) => ({
        handle: v.handle,
        price: v.price,
        ...(v.available !== undefined ? { available: v.available } : {}),
      })),
    });
  }
  const outcomes = parseStrictJson(search.merchants_json);
  const merchants: OwnerMerchantOutcome[] = [];
  if (outcomes.ok && Array.isArray(outcomes.value)) {
    for (const o of outcomes.value) {
      const m = o as Partial<OwnerMerchantOutcome> | null;
      if (
        m !== null &&
        typeof m === 'object' &&
        typeof m.origin === 'string' &&
        typeof m.state === 'string'
      )
        merchants.push({
          origin: m.origin,
          state: m.state,
          products: typeof m.products === 'number' ? m.products : 0,
        });
    }
  }
  return { search_id: searchId, created_at: search.created_at, merchants, products };
}

// ------------------------------------------------------------ the guard's two routes

export interface UcpGuardClaim {
  job_id: string;
  claim_id: string;
  claimed_until: number;
  digest: string;
  merchant: string;
  content: unknown;
}

/** Claim the next guard job, in turn across searches; null when there is none. */
export function claimUcpGuardJob(
  store: UcpSearchStore,
  now: number,
  newId: () => string,
): UcpGuardClaim | null {
  return store.transaction(() => {
    store.abandonLapsed(now);
    const job = store.nextClaimable(now);
    if (job === null) return null;
    const search = store.getSearch(job.search_id);
    if (search === null) return null;
    const claimId = newId();
    // The claim lasts to the end of the search's budget: a verdict after that is not used.
    const until = search.guard_until;
    if (!store.claimJob(job, claimId, until)) return null;
    const content = UcpSearchStore.jobContent(job);
    return {
      job_id: job.job_id,
      claim_id: claimId,
      claimed_until: until,
      digest: job.digest,
      merchant: job.merchant_origin,
      content,
    };
  });
}

export const UCP_GUARD_VERDICT_CODES: ReadonlySet<string> = new Set([
  'instruction_pattern',
  'model_pass',
  'model_block',
  'guard_unparseable',
]);

export interface UcpGuardVerdictInput {
  jobId: string;
  claimId: string;
  digest: string;
  verdict: unknown;
  code: unknown;
}

export type UcpGuardVerdictOutcome =
  | { ok: true; state: 'passed' | 'blocked' }
  | { ok: false; reason: 'not_found' | 'bad_verdict' | 'digest_mismatch' | 'claim_lost' | 'late' };

/** A verdict on the exact text handed out, under the live claim, within the search's budget. */
export function submitUcpGuardVerdict(
  store: UcpSearchStore,
  input: UcpGuardVerdictInput,
  now: number,
): UcpGuardVerdictOutcome {
  if (input.verdict !== 'passed' && input.verdict !== 'blocked')
    return { ok: false, reason: 'bad_verdict' };
  if (typeof input.code !== 'string' || !UCP_GUARD_VERDICT_CODES.has(input.code))
    return { ok: false, reason: 'bad_verdict' };
  if ((input.verdict === 'passed') !== (input.code === 'model_pass'))
    return { ok: false, reason: 'bad_verdict' };
  const verdict = input.verdict;
  const code = input.code;
  return store.transaction((): UcpGuardVerdictOutcome => {
    const job = store.getJob(input.jobId);
    if (job === null) return { ok: false, reason: 'not_found' };
    if (input.digest !== job.digest) return { ok: false, reason: 'digest_mismatch' };
    if (job.state !== 'claimed' || job.claim_id !== input.claimId)
      return { ok: false, reason: 'claim_lost' };
    const search = store.getSearch(job.search_id);
    // The same edge as the view's and the store's: at guard_until the budget is over.
    if (search === null || now >= search.guard_until) {
      // In flight past the budget: finished, but not used.
      store.resolveJob(
        job.job_id,
        input.claimId,
        'abandoned',
        JSON.stringify({ reason: 'late', verdict, code }),
        now,
      );
      return { ok: false, reason: 'late' };
    }
    if (
      !store.resolveJob(job.job_id, input.claimId, verdict, JSON.stringify({ verdict, code }), now)
    ) {
      return { ok: false, reason: 'claim_lost' };
    }
    return { ok: true, state: verdict };
  });
}
