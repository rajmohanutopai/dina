/**
 * Topic Table-of-Contents store — EWMA-weighted (GAP.md row #27
 * follow-up, working-memory M1/M2 gate).
 *
 * The **extractor** (`topic_extractor.ts`) turns one document into
 * topics. This store aggregates those topics over TIME into a
 * living table of contents (ToC). Two half-lives run in parallel:
 *
 *   - **Short** (default 1h) — "what the user is thinking about
 *     right now". Drives prompt-time context windows; rapid rise +
 *     rapid decay.
 *   - **Long** (default 30d) — "what the user cares about". Slow
 *     rise, slow decay; drives background retrieval + profile
 *     building.
 *
 * Both are exponentially-weighted moving averages (EWMA) over the
 * topic's per-ingest weight. Each `observe()` call applies decay
 * from the last-seen timestamp, then adds the new weight:
 *
 *     short' = short * exp(-Δt / τ_short) + w
 *     long'  = long  * exp(-Δt / τ_long)  + w
 *
 * where τ_{short,long} = half-life / ln(2) is the time constant.
 *
 * **Why EWMA**: no fixed window; no buffer; O(1) per observe + O(N)
 * snapshot where N is the distinct topic count. Tuned by one
 * parameter per track.
 *
 * **Inject the clock.** Tests step the clock forward to assert
 * decay + ordering. Production passes `Date.now`. The store never
 * reads `Date.now` directly.
 *
 * **Concurrency**: single-threaded in Node; the map-based backing
 * is safe under the sequential observe/snapshot pattern the Brain
 * uses. If future callers need concurrency they wrap the whole
 * primitive in a mutex — not this store's job.
 *
 * **Eviction**: when the distinct-topic count exceeds `maxTopics`,
 * the lowest-long-weight entry is dropped. Short spikes can't evict
 * long-standing interests.
 *
 * **Rendering**: `snapshot()` returns the current ToC sorted by a
 * configurable score combinator. Defaults to `short + long` which
 * surfaces both recent spikes + enduring interests. Callers that
 * want only recent topics sort by `short`; callers doing profile
 * summary sort by `long`.
 *
 * Source: GAP.md (task 5.46 follow-up) — M1 memory-flows +
 * briefing-context gate.
 */

export interface TopicTocEntry {
  /** Canonical topic label (matches `Topic.label` from extractor). */
  label: string;
  /** Short-horizon EWMA weight. Decays quickly (half-life ~1h by default). */
  short: number;
  /** Long-horizon EWMA weight. Decays slowly (half-life ~30d by default). */
  long: number;
  /** Unix ms when the entry was last observed. */
  lastSeenMs: number;
  /** Cumulative count of observations — useful for audit, not for decay. */
  observations: number;
}

export interface TopicObservation {
  label: string;
  /** Weight to accumulate. Typical values 0.1–1.0 (phrase vs word). */
  weight: number;
}

export interface TocSnapshotEntry extends TopicTocEntry {
  /** Combined score used to order the snapshot. */
  score: number;
}

export interface TopicTocStoreOptions {
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Short half-life in ms. Default 1h. */
  shortHalfLifeMs?: number;
  /** Long half-life in ms. Default 30 days. */
  longHalfLifeMs?: number;
  /** Max distinct topics retained. Default 500. */
  maxTopics?: number;
}

export interface SnapshotOptions {
  /** Max entries to return. Default: unlimited. */
  limit?: number;
  /** Combinator to produce the snapshot score. Default: `short + long`. */
  score?: (entry: TopicTocEntry) => number;
  /** Drop entries below this threshold on the combined score. Default 0. */
  minScore?: number;
}

export const DEFAULT_SHORT_HALF_LIFE_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_LONG_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_MAX_TOPICS = 500;

/**
 * Create a new topic ToC store. State is in-memory + single-instance;
 * production may wrap persistence on top (flush snapshot to vault on
 * shutdown, re-hydrate on boot) — this primitive is deliberately
 * stateless-on-disk.
 */
export class TopicTocStore {
  private readonly entries = new Map<string, TopicTocEntry>();
  private readonly nowMsFn: () => number;
  private readonly shortTau: number;
  private readonly longTau: number;
  private readonly maxTopics: number;

  constructor(opts: TopicTocStoreOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    const shortHalfLife = opts.shortHalfLifeMs ?? DEFAULT_SHORT_HALF_LIFE_MS;
    const longHalfLife = opts.longHalfLifeMs ?? DEFAULT_LONG_HALF_LIFE_MS;
    if (!Number.isFinite(shortHalfLife) || shortHalfLife <= 0) {
      throw new RangeError('shortHalfLifeMs must be > 0');
    }
    if (!Number.isFinite(longHalfLife) || longHalfLife <= 0) {
      throw new RangeError('longHalfLifeMs must be > 0');
    }
    if (shortHalfLife >= longHalfLife) {
      throw new RangeError(
        'shortHalfLifeMs must be less than longHalfLifeMs',
      );
    }
    // τ = halfLife / ln(2) so weight = 0.5 at t = halfLife.
    this.shortTau = shortHalfLife / Math.LN2;
    this.longTau = longHalfLife / Math.LN2;
    this.maxTopics = opts.maxTopics ?? DEFAULT_MAX_TOPICS;
    if (!Number.isInteger(this.maxTopics) || this.maxTopics < 1) {
      throw new RangeError('maxTopics must be a positive integer');
    }
  }

  /** Count of distinct topics currently retained. */
  size(): number {
    return this.entries.size;
  }

  /** Record a batch of topic observations at the current clock tick. */
  observe(observations: ReadonlyArray<TopicObservation>): void {
    if (observations.length === 0) return;
    const now = this.nowMsFn();
    for (const obs of observations) {
      if (typeof obs.label !== 'string' || obs.label === '') continue;
      if (!Number.isFinite(obs.weight) || obs.weight <= 0) continue;
      const current = this.entries.get(obs.label);
      if (current === undefined) {
        this.entries.set(obs.label, {
          label: obs.label,
          short: obs.weight,
          long: obs.weight,
          lastSeenMs: now,
          observations: 1,
        });
      } else {
        const dt = Math.max(0, now - current.lastSeenMs);
        const shortDecay = Math.exp(-dt / this.shortTau);
        const longDecay = Math.exp(-dt / this.longTau);
        current.short = current.short * shortDecay + obs.weight;
        current.long = current.long * longDecay + obs.weight;
        current.lastSeenMs = now;
        current.observations += 1;
      }
    }
    this.evictIfOverflowing();
  }

  /**
   * Decay every entry to the current clock tick WITHOUT adding new
   * weight. Useful before rendering a snapshot after a long idle
   * period. Rarely needed externally — `snapshot()` decays on-read.
   */
  decayToNow(): void {
    const now = this.nowMsFn();
    for (const entry of this.entries.values()) {
      this.decayEntryInPlace(entry, now);
    }
  }

  /**
   * Return a snapshot of the ToC decayed to the current clock tick,
   * ordered by the configured score combinator descending. Read-only.
   */
  snapshot(opts: SnapshotOptions = {}): TocSnapshotEntry[] {
    const now = this.nowMsFn();
    const combinator = opts.score ?? ((e) => e.short + e.long);
    const minScore = opts.minScore ?? 0;
    const out: TocSnapshotEntry[] = [];
    for (const entry of this.entries.values()) {
      const snapshot = this.decayEntry(entry, now);
      const score = combinator(snapshot);
      if (score < minScore) continue;
      out.push({ ...snapshot, score });
    }
    out.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.label.localeCompare(b.label);
    });
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  /** Drop every entry — useful for tests or persona-switch wipes. */
  reset(): void {
    this.entries.clear();
  }

  /**
   * Return the raw entry for a label without decay applied — useful
   * for debugging + for tests that want the un-decayed form.
   */
  rawEntry(label: string): TopicTocEntry | undefined {
    const entry = this.entries.get(label);
    return entry === undefined ? undefined : { ...entry };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private decayEntry(entry: TopicTocEntry, now: number): TopicTocEntry {
    const dt = Math.max(0, now - entry.lastSeenMs);
    if (dt === 0) return { ...entry };
    const shortDecay = Math.exp(-dt / this.shortTau);
    const longDecay = Math.exp(-dt / this.longTau);
    return {
      ...entry,
      short: entry.short * shortDecay,
      long: entry.long * longDecay,
      lastSeenMs: now,
    };
  }

  private decayEntryInPlace(entry: TopicTocEntry, now: number): void {
    const dt = Math.max(0, now - entry.lastSeenMs);
    if (dt === 0) return;
    entry.short *= Math.exp(-dt / this.shortTau);
    entry.long *= Math.exp(-dt / this.longTau);
    entry.lastSeenMs = now;
  }

  private evictIfOverflowing(): void {
    const overflow = this.entries.size - this.maxTopics;
    if (overflow <= 0) return;
    // Evict by lowest long weight — short spikes shouldn't kick out
    // long-standing interests.
    const ranked = Array.from(this.entries.values()).sort(
      (a, b) => a.long - b.long,
    );
    for (let i = 0; i < overflow; i++) {
      this.entries.delete(ranked[i]!.label);
    }
  }
}
