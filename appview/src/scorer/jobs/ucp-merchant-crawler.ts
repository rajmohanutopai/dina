/**
 * The UCP merchant index's crawler (docs/UCP_IMPLEMENTATION_PLAN.md §3.15, U5).
 *
 * Each run:
 *  1. **Which merchants.** Every origin that live PeerLens attestations name
 *     as an `organization` subject (D4: nothing about anyone's purchases is
 *     published or read), on its default port, and only when PeerLens looks
 *     that origin up as the same subject (`{type:'organization', uri}`, the
 *     reference Core's merchant trust uses): one rule for what comes in and
 *     where its trust is read. An origin no longer named leaves the index.
 *  2. **Reading.** Due merchants, a few at a time, each origin's public
 *     `/.well-known/ucp` through the vetted socket (`src/ucp/merchant_fetch.ts`),
 *     read by @dina/ucp's discovery rules, the same Core uses. At most once a
 *     day per origin, longer when the merchant's Cache-Control says so (up to
 *     a week); a conditional request when no leaf profile was involved.
 *  3. **Trust.** PeerLens's score, recommendation and review count for each
 *     merchant, copied for the ranking, with PeerLens's name for it and the
 *     categories it was reviewed under (the search text).
 *
 * A merchant that cannot be reached keeps an earlier usable read for up to a
 * week (retried with backoff), then reads as unusable; one whose profile
 * cannot be used reads as unusable at once, with the reason. Nothing the
 * merchant writes about itself is kept but what discovery validates.
 *
 * Logs carry counts only.
 */

import { sql, type SQL } from 'drizzle-orm';

import { createNodePolicySocket } from '@dina/net-socket-node';
import {
  UCP_VERSION,
  discoverMerchant,
  merchantOrigin,
  readProfileDocument,
  type DiscoveryFailure,
  type ProfileRead,
} from '@dina/ucp';

import type { DrizzleDB } from '@/db/connection.js';
import { loadSubjectTrustFacts, recommendFromFacts } from '@/db/queries/subject-trust.js';
import { canonicalizeUri } from '@/db/queries/subject_identifier.js';
import { resolveSubject } from '@/db/queries/subjects.js';
import { logger } from '@/shared/utils/logger.js';
import { metrics } from '@/shared/utils/metrics.js';
import { profileFetcher, type ProfileFetch } from '@/ucp/merchant_fetch.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Read at most this often per origin, and at least this often. */
export const CRAWL_MIN_INTERVAL_MS = DAY;
export const CRAWL_MAX_INTERVAL_MS = 7 * DAY;
/** An earlier usable read stands this long through failures to reach the merchant. */
export const USABLE_STANDS_MS = 7 * DAY;
/** Merchants read per run (hourly), and at once: up to 4800 a day. */
const BATCH = 200;
const CONCURRENCY = 8;
/**
 * The rules a stored read was made under: @dina/ucp's version and this
 * index's own. A read under other rules is made again unconditionally, so a
 * 304 never keeps a negotiation an older build made. Bump `INDEX_RULES` when
 * what discovery keeps changes.
 */
const INDEX_RULES = 'ucp-index-1';
export const READ_RULES = `${UCP_VERSION}|${INDEX_RULES}`;
/** Merchants whose trust is refreshed per run: the longest-unrefreshed first, so all in turn. */
const TRUST_BATCH = 2000;
/** Failures that pass: the merchant could not be reached (not a profile it serves wrongly). */
const PASSING: ReadonlySet<DiscoveryFailure> = new Set(['unreachable']);

export interface CrawlerDeps {
  fetch: (url: string, ifNoneMatch?: string) => Promise<ProfileFetch>;
  now: () => number;
}

let defaultFetch: CrawlerDeps['fetch'] | null = null;
function defaults(): CrawlerDeps {
  defaultFetch ??= profileFetcher(createNodePolicySocket());
  return { fetch: defaultFetch, now: Date.now };
}

interface MerchantRow {
  origin: string;
  state: string;
  etag: string | null;
  rules: string | null;
  failures: number;
  /** As the driver gives a timestamptz from a raw query: a string (or a Date). */
  usable_at: string | Date | null;
}

const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

/** A Postgres `text[]` of `values`, as one parameter (a bare JS array in `sql` would expand to a list). */
function textArray(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

export async function ucpMerchantCrawler(
  db: DrizzleDB,
  deps: CrawlerDeps = defaults(),
): Promise<void> {
  const synced = await syncOrigins(db, deps.now());
  const due = rowsOf<MerchantRow>(
    await db.execute(sql`
      SELECT origin, state, etag, rules, failures, usable_at FROM ucp_merchants
       WHERE next_check_at <= ${new Date(deps.now())}
       ORDER BY next_check_at, origin LIMIT ${BATCH}`),
  );
  let read = 0;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    await Promise.all(
      due.slice(i, i + CONCURRENCY).map(async (row) => {
        try {
          await crawlOne(db, row, deps);
          read++;
        } catch (err) {
          metrics.incr('ucp_merchant_crawl_errors');
          logger.warn({ errorClass: (err as Error).constructor.name }, 'ucp merchant read failed');
        }
      }),
    );
  }
  const trusted = await refreshTrust(db, deps.now());
  const [backlog] = rowsOf<{ n: number }>(
    await db.execute(
      sql`SELECT count(*)::int AS n FROM ucp_merchants WHERE next_check_at <= ${new Date(deps.now())}`,
    ),
  );
  metrics.gauge('ucp_merchants_indexed', synced.total);
  metrics.gauge('ucp_merchants_due', Number(backlog?.n ?? 0));
  logger.info(
    { added: synced.added, removed: synced.removed, read, trusted },
    'ucp merchant crawl',
  );
}

/**
 * A uri PeerLens files a subject under, read as a merchant origin: PeerLens's
 * own canonical form (host case, the default port, tracking parameters and the
 * root slash folded), which must be exactly an origin, on the default port.
 */
export function indexedOrigin(uri: string): string | null {
  const canonical = canonicalizeUri(uri);
  const origin = merchantOrigin(canonical);
  if (origin === null || origin !== canonical) return null;
  return new URL(origin).port === '' ? origin : null;
}

/**
 * The origins live attestations name as organization subjects, into the index; the rest out.
 * A new merchant is first seen, and due, at `nowMs`: the crawler's clock, never the
 * database's, so the two cannot disagree about what is due.
 */
export async function syncOrigins(
  db: DrizzleDB,
  nowMs: number,
): Promise<{ total: number; added: number; removed: number }> {
  const named = rowsOf<{ uri: string }>(
    await db.execute(sql`
      SELECT DISTINCT e->>'uri' AS uri
        FROM subjects s, jsonb_array_elements(s.identifiers_json) e
       WHERE s.subject_type = 'organization' AND s.tombstoned_at IS NULL
         AND jsonb_typeof(e) = 'object' AND e ? 'uri' AND e->>'uri' ILIKE 'https://%'
         AND EXISTS (SELECT 1 FROM attestations a
                      WHERE a.subject_id = s.id AND a.is_revoked IS NOT TRUE
                        AND a.is_takedown_by_moderator = false)`),
  );
  const candidates = [...new Set(named.flatMap(({ uri }) => indexedOrigin(uri) ?? []))].sort();
  // Only an origin PeerLens resolves as itself: where Core, and the trust refresh, look it up.
  const origins: string[] = [];
  for (const origin of candidates)
    if ((await resolveSubject(db, { type: 'organization', uri: origin })) !== null)
      origins.push(origin);
  // One array parameter each way, whatever the number of origins.
  const list = sql.param(origins);
  const added =
    (
      (await db.execute(sql`
        INSERT INTO ucp_merchants (origin, first_seen_at, next_check_at)
        SELECT o, ${new Date(nowMs)}, ${new Date(nowMs)} FROM unnest(${list}::text[]) AS o
        ON CONFLICT (origin) DO NOTHING`)) as {
        rowCount?: number;
      }
    ).rowCount ?? 0;
  const removed =
    (
      (await db.execute(
        sql`DELETE FROM ucp_merchants WHERE NOT (origin = ANY(${list}::text[]))`,
      )) as {
        rowCount?: number;
      }
    ).rowCount ?? 0;
  return { total: origins.length, added, removed };
}

/**
 * After a read that could not reach the merchant: a day, doubling with each
 * failure in a row, up to a week. Never sooner than a day (§3.15: at most
 * one read per origin per day).
 */
export function retryAfter(failures: number): number {
  return Math.min(CRAWL_MIN_INTERVAL_MS * 2 ** failures, CRAWL_MAX_INTERVAL_MS);
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** When to read a merchant next after a usable read: a day at least, a week at most, its Cache-Control between. */
export function nextReadAfterUsable(now: number, maxAgeMs: number | null): number {
  const wanted = maxAgeMs ?? 0;
  return now + Math.min(Math.max(wanted, CRAWL_MIN_INTERVAL_MS), CRAWL_MAX_INTERVAL_MS);
}

/** One merchant read, and what it means for its row. */
export async function crawlOne(db: DrizzleDB, row: MerchantRow, deps: CrawlerDeps): Promise<void> {
  const now = deps.now();
  const at = new Date(now);
  const rootUrl = `${row.origin}/.well-known/ucp`;
  let rootEtag: string | null = null;
  let rootMaxAge: number | null = null;
  let leafUsed = false;
  // A conditional request only while the read stands on the root profile alone, under these rules.
  const conditional =
    row.state === 'usable' && row.etag !== null && row.rules === READ_RULES ? row.etag : undefined;
  let unchanged = false;
  let unchangedMaxAge: number | null = null;
  let leafOutOfReach = false;
  const read = async (url: string): Promise<ProfileRead> => {
    const root = url === rootUrl;
    if (!root) leafUsed = true;
    // A leaf profile only under the merchant's own origin: the index reads nothing elsewhere.
    if (!root && !sameOrigin(url, row.origin))
      return { ok: false, reason: 'not_found', detail: 'off_origin' };
    const got = await deps.fetch(url, root ? conditional : undefined);
    if (got.kind === 'not_modified') {
      unchanged = true;
      unchangedMaxAge = got.maxAgeMs;
      return { ok: false, reason: 'unreachable', detail: 'not_modified' };
    }
    if (got.kind === 'failed') {
      // A leaf out of reach is the merchant out of reach, not a profile it serves wrongly.
      if (!root && got.reason === 'unreachable') leafOutOfReach = true;
      return {
        ok: false,
        reason: got.reason,
        ...(got.detail !== undefined ? { detail: got.detail } : {}),
      };
    }
    if (root) {
      rootEtag = got.etag;
      rootMaxAge = got.maxAgeMs;
    }
    const doc = readProfileDocument(got.bytes);
    return doc.ok ? { ok: true, profile: doc.profile, stale: false } : doc;
  };
  const found = await discoverMerchant(row.origin, read);

  if (unchanged) {
    metrics.incr('ucp_merchant_reads', { outcome: 'unchanged' });
    await db.execute(sql`
      UPDATE ucp_merchants SET checked_at = ${at}, usable_at = ${at}, failures = 0,
             next_check_at = ${new Date(nextReadAfterUsable(now, unchangedMaxAge))}
       WHERE origin = ${row.origin}`);
    return;
  }
  if (found.ok) {
    const m = found.merchant;
    metrics.incr('ucp_merchant_reads', { outcome: 'usable' });
    const capabilities = [...m.negotiated.keys()].sort();
    await db.execute(sql`
      UPDATE ucp_merchants SET state = 'usable', reason = NULL, version = ${m.profile.version},
             transport = ${m.transport}, endpoint = ${m.endpoint}, capabilities = ${textArray(capabilities)},
             etag = ${leafUsed ? null : rootEtag}, rules = ${READ_RULES}, failures = 0, checked_at = ${at},
             usable_at = ${at},
             next_check_at = ${new Date(nextReadAfterUsable(now, rootMaxAge))}
       WHERE origin = ${row.origin}`);
    return;
  }
  metrics.incr('ucp_merchant_reads', { outcome: found.reason });
  const passing = PASSING.has(found.reason) || (found.reason === 'leaf_unusable' && leafOutOfReach);
  const usableAt = row.usable_at === null ? null : new Date(row.usable_at).getTime();
  const stands =
    passing && row.state === 'usable' && usableAt !== null && now - usableAt < USABLE_STANDS_MS;
  if (stands) {
    // Out of reach for now: the earlier read stands; tried again no sooner than a day.
    await db.execute(sql`
      UPDATE ucp_merchants SET failures = failures + 1, checked_at = ${at},
             next_check_at = ${new Date(now + retryAfter(row.failures))}
       WHERE origin = ${row.origin}`);
    return;
  }
  await db.execute(sql`
    UPDATE ucp_merchants SET state = 'unusable', reason = ${found.reason}, version = NULL, transport = NULL,
           endpoint = NULL, capabilities = '{}'::text[], etag = NULL, rules = NULL,
           failures = ${passing ? row.failures + 1 : 0}, checked_at = ${at},
           next_check_at = ${new Date(now + (passing ? retryAfter(row.failures) : CRAWL_MIN_INTERVAL_MS))}
     WHERE origin = ${row.origin}`);
}

/** PeerLens's trust for each merchant, its name for it and the categories it was reviewed under. */
export async function refreshTrust(
  db: DrizzleDB,
  now: number,
  batch: number = TRUST_BATCH,
): Promise<number> {
  const rows = rowsOf<{ origin: string }>(
    await db.execute(sql`
      SELECT origin FROM ucp_merchants
       ORDER BY trust_checked_at ASC NULLS FIRST, origin LIMIT ${batch}`),
  );
  for (const row of rows) {
    const facts = await loadSubjectTrustFacts(db, { type: 'organization', uri: row.origin });
    const recommendation = recommendFromFacts(facts).action;
    const score = facts.tombstoned ? 0 : (facts.scores?.weightedScore ?? null);
    const reviews = facts.scores?.totalAttestations ?? 0;
    let name: string | null = null;
    let categories: string[] = [];
    if (facts.subjectId !== null) {
      const [subject] = rowsOf<{ name: string }>(
        await db.execute(sql`SELECT name FROM subjects WHERE id = ${facts.subjectId} LIMIT 1`),
      );
      name = subject?.name ?? null;
      categories = rowsOf<{ category: string }>(
        await db.execute(sql`
          SELECT DISTINCT category FROM attestations
           WHERE subject_id = ${facts.subjectId} AND is_revoked IS NOT TRUE AND is_takedown_by_moderator = false
           ORDER BY category LIMIT 10`),
      ).map((c) => c.category);
    }
    const searchText = [name ?? '', new URL(row.origin).hostname, ...categories].join(' ').trim();
    await db.execute(sql`
      UPDATE ucp_merchants SET trust_score = ${score}, recommendation = ${recommendation},
             review_count = ${reviews}, name = ${name}, search_text = ${searchText},
             trust_checked_at = ${new Date(now)}
       WHERE origin = ${row.origin}`);
  }
  return rows.length;
}
