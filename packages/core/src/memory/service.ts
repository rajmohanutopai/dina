/**
 * MemoryService (WM-CORE-06) — cross-persona Table of Contents (ToC)
 * aggregator.
 *
 * Port of `core/internal/service/memory.go::MemoryService`. Walks the
 * repositories of the unlocked personas, asks each for its top
 * topics at the current wall-clock, merges + stable-sorts the
 * combined list by decayed salience, truncates to the caller's limit.
 *
 * Resolution strategy is intentional (mirrors the Go port):
 *   - Ask each persona for up to `limit` topics, NOT `limit / N` —
 *     gives the merge step headroom when one persona dominates.
 *   - Recompute salience at the service layer rather than trust the
 *     value the repository returned, so a single `nowUnix` drives
 *     every comparison in the merged result (avoids drift across
 *     per-repo `computeSalience` calls).
 *
 * Defensive behaviour:
 *   - Missing persona (unlocked → locked race) is a skip, not an
 *     error.
 *   - "no such table" errors (e.g. a persona opened before the
 *     schema migration landed) surface as a skip + log, not a 500.
 *     Matches the Go port's string-match guard.
 *
 * Design doc: §4 (data model), §5 (scoring), §8 (ToC render), §12
 * (edge cases — locked personas, cross-persona topics).
 */

import { computeSalience } from './scoring';
import {
  getTopicRepository,
  listTopicRepositoryPersonas,
  type TopicRepository,
} from './repository';
import type { TocEntry, Topic } from './domain';

const MISSING_TABLE_MARKER = 'no such table: topic_salience';

/**
 * Lookup function from persona name → repository. Indirection keeps
 * the service testable: production wires `getTopicRepository`
 * directly; tests pass a `Map.get`-style resolver.
 */
export type TopicRepositoryResolver = (persona: string) => TopicRepository | null;

/**
 * Listing function for the personas the ToC should walk by default
 * (when the caller doesn't pass an explicit list). The Go port gets
 * this from `sqlite.Pool.OpenPersonas()`; here it's injectable so
 * tests don't need a real pool.
 */
export type OpenPersonaLister = () => string[];

export interface MemoryServiceOptions {
  /**
   * Repository resolver — defaults to the module-global
   * `getTopicRepository` per-persona map. Tests pass their own.
   */
  resolve?: TopicRepositoryResolver;
  /**
   * Lister for the "all unlocked personas" default. When omitted the
   * service falls back to `listTopicRepositoryPersonas()` (the keys
   * of the module-global repo map). Tests pass their own.
   */
  listPersonas?: OpenPersonaLister;
  /**
   * Injectable wall-clock (unix seconds). Defaults to
   * `Math.floor(Date.now() / 1000)`. Tests pin it for deterministic
   * salience numerics.
   */
  nowSecFn?: () => number;
  /**
   * Warning sink. Called on a persona-level error (missing repo,
   * missing table, repo threw). Kept as a callback — no hard
   * console dep; production wires a logger adapter.
   */
  onWarning?: (event: Record<string, unknown>) => void;
}

/**
 * Tier-0 persona — identity lives in its own SQLCipher file with NO
 * `topic_salience` table. Walking it crashes. Main-dina's ToC
 * handler + service both skip it explicitly; we do the same, at the
 * SERVICE level so route handlers don't have to know about it.
 */
const IDENTITY_PERSONA = 'identity';

export class MemoryService {
  private readonly resolve: TopicRepositoryResolver;
  private readonly listPersonas: OpenPersonaLister;
  private readonly nowSecFn: () => number;
  private readonly onWarning: (event: Record<string, unknown>) => void;

  constructor(options: MemoryServiceOptions = {}) {
    this.resolve = options.resolve ?? getTopicRepository;
    this.listPersonas = options.listPersonas ?? listTopicRepositoryPersonas;
    this.nowSecFn = options.nowSecFn ?? (() => Math.floor(Date.now() / 1000));
    this.onWarning =
      options.onWarning ??
      (() => {
        /* no-op */
      });
  }

  /**
   * Merge the top-N topics from each unlocked persona into a single
   * ranked `TocEntry` list.
   *
   * @param personas explicit list of personas to include. Empty /
   *   undefined = "all unlocked" (via `listPersonas`).
   * @param limit max entries in the returned list (capping applied
   *   after the merge). Values ≤ 0 yield `[]`.
   */
  async toc(personas: string[] | undefined, limit: number): Promise<TocEntry[]> {
    if (limit <= 0) return [];

    const requested =
      personas !== undefined && personas.length > 0 ? personas : this.listPersonas();

    const nowUnix = this.nowSecFn();
    const merged: TocEntry[] = [];

    for (const persona of requested) {
      if (persona === IDENTITY_PERSONA) continue;
      const repo = this.resolve(persona);
      if (repo === null) {
        this.onWarning({
          event: 'memory.toc.persona_locked',
          persona,
        });
        continue;
      }

      let top: Topic[];
      try {
        // `limit` on each persona — NOT `limit/N`. The merge step
        // picks the final top-N; per-persona headroom prevents a
        // dominant persona from crowding others out when N is
        // small.
        top = await repo.top(limit, nowUnix);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const eventKind = msg.includes(MISSING_TABLE_MARKER)
          ? 'memory.toc.missing_table'
          : 'memory.toc.persona_failed';
        this.onWarning({ event: eventKind, persona, error: msg });
        continue;
      }

      for (const t of top) {
        merged.push(toTocEntry(t, persona, nowUnix));
      }
    }

    // Stable descending sort by decayed salience. Array#sort is
    // stable in ES2019+, so ties preserve per-persona insertion
    // order — keeps results deterministic across process runs.
    merged.sort((a, b) => b.salience - a.salience);
    return merged.slice(0, limit);
  }
}

/**
 * Adapt a `Topic` (persona-scoped, storage shape) into a `TocEntry`
 * (service return shape). The salience is recomputed here with the
 * caller's `nowUnix` so every row in the merged list is comparable
 * at the same instant — the repository's `top` already applied
 * decay, but we redo it to neutralise any float-skew across
 * per-repo calls.
 */
function toTocEntry(t: Topic, persona: string, nowUnix: number): TocEntry {
  const entry: TocEntry = {
    persona,
    topic: t.topic,
    kind: t.kind,
    salience: computeSalience(t, nowUnix),
    last_update: t.last_update,
  };
  // PC-CORE-07: capability fields retired from the ToC projection —
  // see docs/WORKING_MEMORY_DESIGN.md §6.1.
  if (t.sample_item_id !== undefined && t.sample_item_id !== '') {
    entry.sample_item_id = t.sample_item_id;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Module-global accessor — mirrors the pattern used by workflow,
// staging, etc. The bootstrap wires it once at startup; the memory
// route handlers read it to dispatch.
// ---------------------------------------------------------------------------

let service: MemoryService | null = null;

export function setMemoryService(s: MemoryService | null): void {
  service = s;
}

export function getMemoryService(): MemoryService | null {
  return service;
}
