/**
 * Topic repository (WM-CORE-03) — persists the per-persona
 * `topic_salience` + `topic_aliases` rows.
 *
 * Port of `core/internal/adapter/sqlite/topic_store.go` (SQLite) and
 * its Go port-contract `core/internal/port/memory.go` (interface).
 *
 * One repository per persona — each persona keeps its own SQLCipher
 * file, so the `topic_salience` table has no `persona` column. The
 * global accessor (`setTopicRepository` / `getTopicRepository`)
 * mirrors the `VaultRepository` shape (persona → repo map) so the
 * per-persona open/close lifecycle in `storage/init.ts::openPersonaDB`
 * can set/unset a repo alongside the vault one.
 *
 * Two implementations:
 *   - `SQLiteTopicRepository` — production, wraps a `DatabaseAdapter`
 *     (op-sqlite in the app, InMemoryDatabaseAdapter in tests).
 *   - `InMemoryTopicRepository` — pure JS, satisfies the interface
 *     without SQL. The existing InMemoryDatabaseAdapter is a fuzzy
 *     SQL parser (doesn't honour WHERE clauses correctly on arbitrary
 *     queries), so per-method coverage lives here; a thin
 *     smoke-test of the SQLite flavour belongs alongside op-sqlite.
 *
 * Design doc: §4 (data model), §5 (scoring), §6.2 (canonicalization).
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { Topic, TopicKind, TouchRequest } from './domain';
import { isTopicKind } from './domain';
import { computeSalience, stemLite } from './scoring';

/**
 * Per-persona repository for working-memory topics.
 *
 * **Phase 2.3 (task 2.3).** Methods return `Promise<T>` per the
 * async-everywhere port rule. SQLite under go-sqlcipher is sync
 * internally; each `async` method wraps the sync result in a
 * `Promise.resolve` with no microtask overhead beyond one promise per
 * call. The port signature is the async contract that alternate
 * storage backends (SQLite WASM, IndexedDB, network-backed stores)
 * can satisfy without a parallel async variant.
 */
export interface TopicRepository {
  /**
   * Apply EWMA decay to the stored counters, increment both by one,
   * and write back. On first sight of a topic, inserts a fresh row
   * with `s_short = s_long = 1.0` (not `0 + 1` — the "fresh insert"
   * path is distinct from the "decay then increment" path, per §5).
   *
   * Overwrite semantics for `liveCapability` / `liveProviderDid` /
   * `sampleItemId`: only merge NON-empty new values; empty strings
   * in the request MUST NOT clear existing stored values. Pinned by
   * the `live-capability persists` test.
   *
   * Throws on invalid input (empty topic, unknown kind, non-positive
   * `nowUnix`) — matches the Go port's defensive checks.
   */
  touch(req: TouchRequest): Promise<void>;

  /**
   * Return the top `limit` topics by decayed salience at `nowUnix`.
   * Empty array when `limit <= 0`.
   *
   * Implementation detail (not a contract): SQLite pre-filters the
   * top `limit*4 + 50` rows by `s_long DESC, s_short DESC` to bound
   * the scan, then computes salience in JS/TS. Aligns with the Go
   * port's rationale — SQLCipher v4.4.2 bundles SQLite < 3.35, so
   * `exp()` at the SQL layer isn't available.
   */
  top(limit: number, nowUnix: number): Promise<Topic[]>;

  /** Single-topic read by canonical name; null on miss. */
  get(topic: string): Promise<Topic | null>;

  /**
   * Resolve a variant to its canonical topic name.
   *
   * Three tiers (design doc §6.2):
   *   1. Exact-match lookup in `topic_aliases`.
   *   2. Stemmed lookup in `topic_aliases`.
   *   2b. If the stem matches an existing `topic_salience.topic`
   *       row, register the variant→canonical alias lazily AND
   *       return that canonical.
   *   3. Otherwise return the variant unchanged — on its next
   *      `touch` the variant becomes its own canonical.
   *
   * Empty input returns empty string (no I/O).
   *
   * V2 open question: embedding-similarity lookup as a tier-3 —
   * defer until we see fragmentation in real traces.
   */
  resolveAlias(variant: string): Promise<string>;

  /** Register a variant→canonical mapping. Idempotent; noop when
   *  variant === canonical. Throws on empty variant or canonical. */
  putAlias(variant: string, canonical: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-persona accessor — mirrors `vault/repository.ts::setVaultRepository`.
// ---------------------------------------------------------------------------

const repos = new Map<string, TopicRepository>();

/** Register (or clear, on null) the topic repository for a persona. */
export function setTopicRepository(persona: string, r: TopicRepository | null): void {
  if (r === null) {
    repos.delete(persona);
  } else {
    repos.set(persona, r);
  }
}

/** Retrieve the topic repository for a persona, or null when unset
 *  (persona locked / never opened). */
export function getTopicRepository(persona: string): TopicRepository | null {
  return repos.get(persona) ?? null;
}

/** List every persona that currently has a topic repository wired.
 *  Used by the ToC service to iterate across unlocked personas. */
export function listTopicRepositoryPersonas(): string[] {
  return Array.from(repos.keys()).sort();
}

/** Drop every wired repository. Tests use this between cases. */
export function resetTopicRepositories(): void {
  repos.clear();
}

// ---------------------------------------------------------------------------
// Shared validation / normalization helpers (used by both backends).
// ---------------------------------------------------------------------------

function validateTouch(req: TouchRequest): void {
  if (!req.topic) {
    throw new Error('TopicRepository.touch: empty topic');
  }
  if (!isTopicKind(req.kind)) {
    throw new Error(`TopicRepository.touch: invalid kind "${String(req.kind)}"`);
  }
  if (!Number.isFinite(req.nowUnix) || req.nowUnix <= 0) {
    throw new Error(`TopicRepository.touch: invalid nowUnix ${req.nowUnix}`);
  }
}

function applyDecayIncrement(
  current: { s_short: number; s_long: number; last_update: number } | null,
  nowUnix: number,
): { s_short: number; s_long: number } {
  if (current === null) {
    // Fresh insert — both counters start at 1.0 (not 0+1=1).
    // Mirrors the Go port's `sql.ErrNoRows` branch exactly.
    return { s_short: 1.0, s_long: 1.0 };
  }
  const dtDays = Math.max(0, (nowUnix - current.last_update) / 86_400);
  return {
    s_short: current.s_short * Math.exp(-dtDays / 14) + 1.0,
    s_long: current.s_long * Math.exp(-dtDays / 180) + 1.0,
  };
}

/**
 * Merge optional fields: new non-empty value wins; empty new value
 * preserves the existing stored value. Shared between SQLite and
 * InMemory so the "do not overwrite with empty" invariant has ONE
 * authoritative implementation.
 */
function mergeOptionalField(existing: string, incoming: string | undefined): string {
  return incoming !== undefined && incoming !== '' ? incoming : existing;
}

// ---------------------------------------------------------------------------
// SQLite implementation.
// ---------------------------------------------------------------------------

// Capability bindings live on contacts (`Contact.preferredFor`), not
// topic rows — see docs/WORKING_MEMORY_DESIGN.md §6.1.
const TOPIC_COLUMNS = 'topic, kind, last_update, s_short, s_long, sample_item_id';

export class SQLiteTopicRepository implements TopicRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async touch(req: TouchRequest): Promise<void> {
    validateTouch(req);

    // The transaction callback stays sync: internal reads via
    // `this.getSync()` avoid the async hop inside the critical section.
    // DatabaseAdapter's sync transaction() contract is unchanged — this
    // port's async wrapper is the outer contract; inside is synchronous
    // SQLite. Task 2.3 pattern.
    this.db.transaction(() => {
      const existing = this.getSync(req.topic);
      const counters = applyDecayIncrement(existing, req.nowUnix);
      const sample = mergeOptionalField(existing?.sample_item_id ?? '', req.sampleItemId);

      this.db.run(
        `INSERT INTO topic_salience
            (topic, kind, last_update, s_short, s_long, sample_item_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET
            kind           = excluded.kind,
            last_update    = excluded.last_update,
            s_short        = excluded.s_short,
            s_long         = excluded.s_long,
            sample_item_id = excluded.sample_item_id`,
        [req.topic, req.kind, req.nowUnix, counters.s_short, counters.s_long, sample],
      );
    });
  }

  async top(limit: number, nowUnix: number): Promise<Topic[]> {
    if (limit <= 0) return [];

    // Prefilter: pull the top `candidateLimit` by stored s_long. A
    // bursty topic with high s_short and low s_long may rank above
    // some of these after decay, so the candidate pool is
    // deliberately wider than `limit` — 4× + 50 matches the Go port.
    const candidateLimit = limit * 4 + 50;
    const rows = this.db.query(
      `SELECT ${TOPIC_COLUMNS} FROM topic_salience
       ORDER BY s_long DESC, s_short DESC
       LIMIT ?`,
      [candidateLimit],
    );
    const topics = rows.map(rowToTopic);

    // Rank by decayed salience; stable sort keeps storage order as
    // the tie-breaker so identical salience values (rare) are
    // deterministic.
    const scored = topics.map((t) => ({ t, s: computeSalience(t, nowUnix) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.t);
  }

  async get(topic: string): Promise<Topic | null> {
    return this.getSync(topic);
  }

  /** Sync-only internal read, used inside the `touch` transaction
   *  callback where awaiting would break atomicity. */
  private getSync(topic: string): Topic | null {
    if (topic === '') return null;
    const rows = this.db.query(
      `SELECT ${TOPIC_COLUMNS} FROM topic_salience WHERE topic = ? LIMIT 1`,
      [topic],
    );
    return rows.length > 0 ? rowToTopic(rows[0]) : null;
  }

  async resolveAlias(variant: string): Promise<string> {
    if (variant === '') return '';

    // Tier 1: exact alias hit.
    const exact = this.lookupAlias(variant);
    if (exact !== null) return exact;

    // Tier 2: stemmed alias hit.
    const stem = stemLite(variant);
    if (stem !== variant) {
      const stemmed = this.lookupAlias(stem);
      if (stemmed !== null) return stemmed;
    }

    // Tier 2b: stem matches an existing canonical — register the
    // alias lazily and return the canonical.
    const canonicalRows = this.db.query(
      `SELECT topic FROM topic_salience WHERE topic = ? LIMIT 1`,
      [stem],
    );
    if (canonicalRows.length > 0) {
      const canonical = String(canonicalRows[0].topic);
      if (stem !== variant) {
        // Don't register variant == canonical aliases — they're noise.
        try {
          await this.putAlias(variant, canonical);
        } catch {
          /* unreachable for non-empty canonical */
        }
      }
      return canonical;
    }

    // Tier 3: variant becomes its own canonical on the next touch.
    return variant;
  }

  async putAlias(variant: string, canonical: string): Promise<void> {
    if (variant === '' || canonical === '') {
      throw new Error('TopicRepository.putAlias: empty variant or canonical');
    }
    if (variant === canonical) return;
    this.db.run(
      `INSERT INTO topic_aliases (variant, canonical) VALUES (?, ?)
       ON CONFLICT(variant) DO UPDATE SET canonical = excluded.canonical`,
      [variant, canonical],
    );
  }

  private lookupAlias(variant: string): string | null {
    const rows = this.db.query(`SELECT canonical FROM topic_aliases WHERE variant = ? LIMIT 1`, [
      variant,
    ]);
    return rows.length > 0 ? String(rows[0].canonical) : null;
  }
}

function rowToTopic(row: DBRow): Topic {
  const out: Topic = {
    topic: String(row.topic),
    kind: String(row.kind) as TopicKind,
    last_update: Number(row.last_update),
    s_short: Number(row.s_short),
    s_long: Number(row.s_long),
  };
  const sample = stringOrEmpty(row.sample_item_id);
  if (sample !== '') out.sample_item_id = sample;
  return out;
}

function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// In-memory implementation (test + non-sqlite fallback).
// ---------------------------------------------------------------------------

interface InMemoryTopicRow {
  topic: string;
  kind: TopicKind;
  last_update: number;
  s_short: number;
  s_long: number;
  sample_item_id: string;
}

export class InMemoryTopicRepository implements TopicRepository {
  private readonly topics = new Map<string, InMemoryTopicRow>();
  private readonly aliases = new Map<string, string>();

  async touch(req: TouchRequest): Promise<void> {
    validateTouch(req);
    const existing = this.topics.get(req.topic) ?? null;
    const counters = applyDecayIncrement(existing, req.nowUnix);
    const next: InMemoryTopicRow = {
      topic: req.topic,
      kind: req.kind,
      last_update: req.nowUnix,
      s_short: counters.s_short,
      s_long: counters.s_long,
      sample_item_id: mergeOptionalField(existing?.sample_item_id ?? '', req.sampleItemId),
    };
    this.topics.set(req.topic, next);
  }

  async top(limit: number, nowUnix: number): Promise<Topic[]> {
    if (limit <= 0) return [];
    const candidates: Topic[] = Array.from(this.topics.values()).map(rowToDomain);
    const scored = candidates.map((t) => ({ t, s: computeSalience(t, nowUnix) }));
    // Stable descending sort — matches the SQLite impl.
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.t);
  }

  async get(topic: string): Promise<Topic | null> {
    const row = this.topics.get(topic);
    return row !== undefined ? rowToDomain(row) : null;
  }

  async resolveAlias(variant: string): Promise<string> {
    if (variant === '') return '';

    const exact = this.aliases.get(variant);
    if (exact !== undefined) return exact;

    const stem = stemLite(variant);
    if (stem !== variant) {
      const stemmed = this.aliases.get(stem);
      if (stemmed !== undefined) return stemmed;
    }

    if (this.topics.has(stem)) {
      const canonical = stem;
      if (stem !== variant) await this.putAlias(variant, canonical);
      return canonical;
    }

    return variant;
  }

  async putAlias(variant: string, canonical: string): Promise<void> {
    if (variant === '' || canonical === '') {
      throw new Error('TopicRepository.putAlias: empty variant or canonical');
    }
    if (variant === canonical) return;
    this.aliases.set(variant, canonical);
  }

  /** Test helper: erase every topic + alias. Not on the interface. */
  reset(): void {
    this.topics.clear();
    this.aliases.clear();
  }
}

function rowToDomain(r: InMemoryTopicRow): Topic {
  const out: Topic = {
    topic: r.topic,
    kind: r.kind,
    last_update: r.last_update,
    s_short: r.s_short,
    s_long: r.s_long,
  };
  if (r.sample_item_id !== '') out.sample_item_id = r.sample_item_id;
  return out;
}
