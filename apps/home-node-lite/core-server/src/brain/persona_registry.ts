/**
 * Task 5.44 — persona registry.
 *
 * Cached metadata about installed personas. Answers: what personas
 * exist, what tier, is it locked, what's the classification hint.
 * Does NOT answer: where content should go (that's routing policy).
 *
 * **Ownership**:
 *   - Core is the source of truth — it owns the vault files + the
 *     config that declares tiers + lock state.
 *   - Brain queries Core at startup, caches the result, refreshes
 *     periodically (60s, task 5.13) or on demand after a 404 / event.
 *   - This module is Brain's local cache — it never touches SQLite.
 *
 * **Fallback**: if Core is unreachable on first load, fall back to
 * a conservative set that matches Core's bootstrap personas. This
 * lets the classifier run against the expected-minimum set while
 * Core comes up.
 *
 * **Refresh semantics** (pinned by tests):
 *   - `refresh()` failure after a successful load keeps the last
 *     known-good cache. A transient network blip doesn't flush the
 *     cache to empty.
 *   - First-load failure installs the fallback set.
 *   - Concurrent `refresh()` calls coalesce — only one fetch fires.
 *
 * **Prefix normalisation**: Core returns persona ids like
 * `persona-general`; the registry strips the `persona-` prefix
 * internally + exposes canonical names (`general`).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.44.
 */

export type PersonaTier = 'default' | 'standard' | 'sensitive' | 'locked';

export interface PersonaInfo {
  /** Core's id shape (e.g. "persona-general"). */
  id: string;
  /** Canonical name (prefix stripped). */
  name: string;
  tier: PersonaTier;
  locked: boolean;
  /** Optional classification hint for PersonaSelector. */
  description: string;
}

/** Raw persona description Core returns from `GET /v1/personas`. */
export interface RawPersonaDetail {
  id?: string;
  name?: string;
  tier?: string;
  locked?: boolean;
  description?: string;
}

/** Fetcher — Brain wires this to `coreClient.list_personas_detailed()`. */
export type PersonaFetchFn = () => Promise<RawPersonaDetail[]>;

export interface PersonaRegistryOptions {
  fetchFn: PersonaFetchFn;
  /** Diagnostic hook. */
  onEvent?: (event: PersonaRegistryEvent) => void;
}

export type PersonaRegistryEvent =
  | { kind: 'loaded'; count: number; names: string[] }
  | { kind: 'fallback_used'; error: string }
  | { kind: 'refresh_failed_kept_cache'; error: string; cachedCount: number }
  | { kind: 'lock_state_changed'; name: string; locked: boolean };

const PERSONA_PREFIX = 'persona-';
const VALID_TIERS: ReadonlySet<PersonaTier> = new Set([
  'default',
  'standard',
  'sensitive',
  'locked',
]);

/**
 * Conservative fallback used only when Core is unreachable on FIRST
 * load. Matches Core's bootstrap personas.
 */
export const FALLBACK_PERSONAS: ReadonlyArray<RawPersonaDetail> = [
  { id: 'persona-general', name: 'general', tier: 'default', locked: false },
  { id: 'persona-work', name: 'work', tier: 'standard', locked: false },
  { id: 'persona-health', name: 'health', tier: 'sensitive', locked: true },
  { id: 'persona-finance', name: 'finance', tier: 'sensitive', locked: true },
];

export class PersonaRegistry {
  private readonly fetchFn: PersonaFetchFn;
  private readonly onEvent?: (event: PersonaRegistryEvent) => void;
  private readonly personas: Map<string, PersonaInfo> = new Map();
  private loaded = false;
  /** Coalesces concurrent load/refresh calls to one underlying fetch. */
  private inFlight: Promise<void> | null = null;

  constructor(opts: PersonaRegistryOptions) {
    if (typeof opts.fetchFn !== 'function') {
      throw new TypeError('PersonaRegistry: fetchFn is required');
    }
    this.fetchFn = opts.fetchFn;
    this.onEvent = opts.onEvent;
  }

  /**
   * Initial load. Falls back to `FALLBACK_PERSONAS` only if nothing
   * was cached yet. Concurrent calls coalesce.
   */
  async load(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const promise = this.doLoad();
    this.inFlight = promise;
    try {
      await promise;
    } finally {
      this.inFlight = null;
    }
  }

  /** Synonym for `load()` — kept for call-site clarity. */
  async refresh(): Promise<void> {
    return this.load();
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await this.fetchFn();
      this.ingest(Array.isArray(raw) ? raw : []);
      this.loaded = true;
      this.emit({
        kind: 'loaded',
        count: this.personas.size,
        names: Array.from(this.personas.keys()),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.personas.size === 0) {
        // First load — install the fallback set so the system boots.
        this.ingest(FALLBACK_PERSONAS);
        this.emit({ kind: 'fallback_used', error: msg });
      } else {
        // Refresh failure after an earlier success — keep last known cache.
        this.emit({
          kind: 'refresh_failed_kept_cache',
          error: msg,
          cachedCount: this.personas.size,
        });
      }
      this.loaded = false;
    }
  }

  // ── Query surface ────────────────────────────────────────────────────

  /** Strip the `persona-` prefix Core attaches. */
  normalize(name: string): string {
    if (typeof name !== 'string') return '';
    return name.startsWith(PERSONA_PREFIX)
      ? name.slice(PERSONA_PREFIX.length)
      : name;
  }

  exists(name: string): boolean {
    return this.personas.has(this.normalize(name));
  }

  tier(name: string): PersonaTier | null {
    return this.personas.get(this.normalize(name))?.tier ?? null;
  }

  locked(name: string): boolean | null {
    const info = this.personas.get(this.normalize(name));
    return info ? info.locked : null;
  }

  description(name: string): string {
    return this.personas.get(this.normalize(name))?.description ?? '';
  }

  allNames(): string[] {
    return Array.from(this.personas.keys());
  }

  /**
   * Return every persona's full info snapshot. Copies so callers
   * can't mutate the cache.
   */
  snapshot(): PersonaInfo[] {
    return Array.from(this.personas.values()).map((p) => ({ ...p }));
  }

  /** True only when a real Core response has loaded — false for fallback. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Event-driven lock-state update — Core can push persona-lock
   * events on the WS; no need to refetch the whole list for a single
   * flag flip.
   */
  updateLocked(name: string, locked: boolean): void {
    const norm = this.normalize(name);
    const info = this.personas.get(norm);
    if (!info) return;
    this.personas.set(norm, { ...info, locked });
    this.emit({ kind: 'lock_state_changed', name: norm, locked });
  }

  // ── Internals ────────────────────────────────────────────────────────

  private ingest(raw: ReadonlyArray<RawPersonaDetail>): void {
    this.personas.clear();
    for (const d of raw) {
      const id = typeof d.id === 'string' ? d.id : '';
      let name = typeof d.name === 'string' ? d.name : '';
      if (name === '') {
        name = id.startsWith(PERSONA_PREFIX)
          ? id.slice(PERSONA_PREFIX.length)
          : id;
      }
      if (name === '') continue; // Anonymous entry — skip
      const tier: PersonaTier = VALID_TIERS.has(d.tier as PersonaTier)
        ? (d.tier as PersonaTier)
        : 'default';
      this.personas.set(name, {
        id: id !== '' ? id : `${PERSONA_PREFIX}${name}`,
        name,
        tier,
        locked: d.locked === true,
        description: typeof d.description === 'string' ? d.description : '',
      });
    }
  }

  private emit(event: PersonaRegistryEvent): void {
    this.onEvent?.(event);
  }
}
