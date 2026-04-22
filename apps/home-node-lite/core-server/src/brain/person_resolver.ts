/**
 * Task 5.36 — person resolver + link extractor.
 *
 * Two primitives bundled into one module because they share the
 * "person" domain object + life cycle:
 *
 *   - `PersonResolver` — at query time, finds person mentions in
 *     free text using confirmed surface forms + returns the synonym
 *     set for recall expansion ("Mom", "mother", "Sarah Johnson"
 *     all point to the same person_id).
 *   - `PersonLinkExtractor` — at ingest time, asks the LLM to extract
 *     identity links from note content + returns a structured
 *     extraction result the caller applies to Core.
 *
 * **Resolver vs ContactMatcher (5.35)**:
 *   - ContactMatcher uses the Contacts directory (DID-anchored).
 *   - PersonResolver uses the Person record (surface-set anchored,
 *     may or may not link to a contact DID).
 *   - A person can have several surfaces ("Mom", "Mother", "Sarah")
 *     and only one DID — resolving "Mom" via the resolver gives the
 *     full surface set for recall-expansion search queries.
 *   - Both use longest-match-first + span-claim dedup because the
 *     word-boundary regex engine logic is the same; only the source
 *     data differs.
 *
 * **Confirmed-only**: the resolver matches ONLY `status: 'confirmed'`
 * surfaces. Suggested surfaces (from extraction that didn't pass a
 * confidence threshold) are excluded — otherwise a false-positive
 * merge at ingest would silently expand recall and poison search.
 *
 * **Pluggable fetcher**: the resolver takes a `PersonFetchFn` so
 * production wires to Core's `GET /v1/people` + tests pass a
 * scripted fixture. `refresh()` is idempotent + safe under failure
 * (keeps last-known-good cache; same pattern as PersonaRegistry).
 *
 * **Extractor is LLM-only** — no regex fallback. Regex attempts were
 * too noisy in the Python reference; confidence-tiered LLM extraction
 * keeps false positives to a dull roar. On LLM failure we emit
 * `{ok: false, reason: 'llm_failed'}` and the caller can retry or
 * skip.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.36.
 */

export type SurfaceStatus = 'confirmed' | 'suggested' | 'rejected';
export type SurfaceType = 'name' | 'role_phrase' | 'alias';
export type PersonStatus = 'active' | 'rejected' | 'merged';
export type SurfaceConfidence = 'high' | 'medium' | 'low';

export interface PersonSurface {
  surface: string;
  surfaceType?: SurfaceType;
  status: SurfaceStatus;
  confidence?: SurfaceConfidence;
}

export interface PersonRecord {
  personId: string;
  canonicalName: string;
  surfaces: PersonSurface[];
  contactDid?: string;
  relationshipHint?: string;
  status?: PersonStatus;
}

export interface ResolvedPerson {
  personId: string;
  canonicalName: string;
  /** All confirmed surfaces for this person. */
  surfaces: string[];
  contactDid: string;
  relationshipHint: string;
}

/** Fetcher — Brain wires this to `coreClient.listPeople()`. */
export type PersonFetchFn = () => Promise<PersonRecord[]>;

export interface PersonResolverOptions {
  fetchFn: PersonFetchFn;
  /** Minimum surface length to index. Defaults to 2. */
  minSurfaceLength?: number;
  /** Diagnostic hook. */
  onEvent?: (event: PersonResolverEvent) => void;
}

export type PersonResolverEvent =
  | { kind: 'loaded'; peopleCount: number; patternCount: number }
  | { kind: 'refresh_failed_kept_cache'; error: string }
  | { kind: 'resolved'; personId: string; span: [number, number] };

interface CompiledPattern {
  pattern: RegExp;
  personId: string;
  surfaceLength: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class PersonResolver {
  private readonly fetchFn: PersonFetchFn;
  private readonly minSurfaceLength: number;
  private readonly onEvent?: (event: PersonResolverEvent) => void;
  private people: Map<string, PersonRecord> = new Map();
  private patterns: readonly CompiledPattern[] = [];
  private inFlight: Promise<void> | null = null;

  constructor(opts: PersonResolverOptions) {
    if (typeof opts.fetchFn !== 'function') {
      throw new TypeError('PersonResolver: fetchFn is required');
    }
    this.fetchFn = opts.fetchFn;
    this.minSurfaceLength = opts.minSurfaceLength ?? 2;
    this.onEvent = opts.onEvent;
  }

  /**
   * Fetch the person list from Core + rebuild the pattern table.
   * On failure, keeps the last-known-good cache + fires
   * `refresh_failed_kept_cache`. Concurrent calls coalesce.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const promise = this.doRefresh();
    this.inFlight = promise;
    try {
      await promise;
    } finally {
      this.inFlight = null;
    }
  }

  private async doRefresh(): Promise<void> {
    let people: PersonRecord[];
    try {
      people = (await this.fetchFn()) ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'refresh_failed_kept_cache', error: msg });
      return;
    }
    this.buildFrom(people);
    this.emit({
      kind: 'loaded',
      peopleCount: this.people.size,
      patternCount: this.patterns.length,
    });
  }

  /**
   * Find person mentions in `text`. Returns one `ResolvedPerson`
   * per distinct `personId` (de-duped across multiple surface
   * matches). Overlapping spans resolved longest-first — the shorter
   * pattern yields.
   */
  resolve(text: string): ResolvedPerson[] {
    if (typeof text !== 'string' || text.length === 0) return [];
    if (this.patterns.length === 0) return [];

    const byId = new Map<string, ResolvedPerson>();
    const claimed: Array<[number, number]> = [];

    for (const { pattern, personId } of this.patterns) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const start = m.index ?? 0;
        const end = start + m[0]!.length;
        if (overlapsClaimed(start, end, claimed)) continue;
        claimed.push([start, end]);
        this.emit({ kind: 'resolved', personId, span: [start, end] });
        if (byId.has(personId)) continue;
        const person = this.people.get(personId);
        if (!person) continue;
        byId.set(personId, {
          personId,
          canonicalName: person.canonicalName,
          surfaces: person.surfaces
            .filter((s) => s.status === 'confirmed')
            .map((s) => s.surface),
          contactDid: person.contactDid ?? '',
          relationshipHint: person.relationshipHint ?? '',
        });
      }
    }
    return Array.from(byId.values());
  }

  /**
   * Returns the synonym expansion terms for a query. For each person
   * mentioned, adds every confirmed surface NOT already in the query
   * text (case-insensitive) — feeds search-time recall expansion.
   */
  expandSearchTerms(text: string): string[] {
    const resolved = this.resolve(text);
    const lower = text.toLowerCase();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of resolved) {
      for (const s of p.surfaces) {
        const key = s.toLowerCase();
        if (lower.includes(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
      }
    }
    return out;
  }

  /** Count of loaded persons. */
  peopleCount(): number {
    return this.people.size;
  }

  /** Count of compiled patterns. */
  patternCount(): number {
    return this.patterns.length;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private buildFrom(records: PersonRecord[]): void {
    const people = new Map<string, PersonRecord>();
    type Entry = { surface: string; personId: string };
    const entries: Entry[] = [];
    for (const p of records) {
      if (!p || typeof p !== 'object') continue;
      if (p.status === 'rejected' || p.status === 'merged') continue;
      if (typeof p.personId !== 'string' || p.personId.length === 0) continue;
      people.set(p.personId, p);
      for (const s of p.surfaces ?? []) {
        if (!s || s.status !== 'confirmed') continue;
        const surface = typeof s.surface === 'string' ? s.surface.trim() : '';
        if (surface.length < this.minSurfaceLength) continue;
        entries.push({ surface, personId: p.personId });
      }
    }
    entries.sort((a, b) => b.surface.length - a.surface.length);
    // Dedup: same (personId, lowered-surface) → one pattern.
    const seen = new Set<string>();
    const patterns: CompiledPattern[] = [];
    for (const e of entries) {
      const key = `${e.personId}::${e.surface.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      patterns.push({
        pattern: new RegExp(`\\b${escapeRegex(e.surface)}\\b`, 'gi'),
        personId: e.personId,
        surfaceLength: e.surface.length,
      });
    }
    this.people = people;
    this.patterns = patterns;
  }

  private emit(event: PersonResolverEvent): void {
    this.onEvent?.(event);
  }
}

function overlapsClaimed(
  start: number,
  end: number,
  claimed: ReadonlyArray<[number, number]>,
): boolean {
  for (const [cs, ce] of claimed) {
    if ((cs <= start && start < ce) || (cs < end && end <= ce)) return true;
  }
  return false;
}

// ═══ Link extractor ════════════════════════════════════════════════════

export const PERSON_LINK_EXTRACTOR_VERSION = 'llm-v1';

export interface IdentityLinkInput {
  name?: string;
  rolePhrase?: string;
  relationship?: string;
  confidence?: SurfaceConfidence;
  evidence?: string;
}

export interface ExtractedIdentityLink {
  canonicalName: string;
  relationshipHint: string;
  surfaces: PersonSurface[];
  sourceExcerpt: string;
}

export interface PersonExtractionResult {
  sourceItemId: string;
  extractorVersion: string;
  results: ExtractedIdentityLink[];
}

export type PersonExtractionOutcome =
  | { ok: true; result: PersonExtractionResult }
  | { ok: false; reason: 'empty_input' }
  | { ok: false; reason: 'llm_failed'; error: string }
  | { ok: false; reason: 'parse_failed'; detail: string }
  | { ok: false; reason: 'no_usable_links' };

/** Shape the LLM is expected to return. */
export type PersonLinkLlmFn = (text: string) => Promise<{ content: string }>;

export interface PersonLinkExtractorOptions {
  llmCallFn: PersonLinkLlmFn;
  onEvent?: (event: PersonLinkExtractorEvent) => void;
}

export type PersonLinkExtractorEvent =
  | { kind: 'extracted'; linkCount: number }
  | { kind: 'llm_failed'; error: string }
  | { kind: 'parse_failed'; detail: string }
  | { kind: 'no_usable_links' };

export class PersonLinkExtractor {
  private readonly llmCallFn: PersonLinkLlmFn;
  private readonly onEvent?: (event: PersonLinkExtractorEvent) => void;

  constructor(opts: PersonLinkExtractorOptions) {
    if (typeof opts.llmCallFn !== 'function') {
      throw new TypeError('PersonLinkExtractor: llmCallFn is required');
    }
    this.llmCallFn = opts.llmCallFn;
    this.onEvent = opts.onEvent;
  }

  /**
   * Extract identity links from `text`. Returns a structured
   * extraction result the caller passes to Core's
   * `/v1/people/apply-extraction`. Never throws.
   */
  async extract(
    text: string,
    sourceItemId: string,
  ): Promise<PersonExtractionOutcome> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, reason: 'empty_input' };
    }
    let rawContent: string;
    try {
      const resp = await this.llmCallFn(text);
      rawContent = typeof resp?.content === 'string' ? resp.content : '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'llm_failed', error: msg });
      return { ok: false, reason: 'llm_failed', error: msg };
    }
    const parsed = parseIdentityLinks(rawContent);
    if (parsed === null) {
      const detail = rawContent.slice(0, 80);
      this.emit({ kind: 'parse_failed', detail });
      return { ok: false, reason: 'parse_failed', detail };
    }
    const results: ExtractedIdentityLink[] = [];
    for (const link of parsed) {
      const normalised = normaliseLink(link, text);
      if (normalised) results.push(normalised);
    }
    if (results.length === 0) {
      this.emit({ kind: 'no_usable_links' });
      return { ok: false, reason: 'no_usable_links' };
    }
    const result: PersonExtractionResult = {
      sourceItemId: typeof sourceItemId === 'string' ? sourceItemId : '',
      extractorVersion: PERSON_LINK_EXTRACTOR_VERSION,
      results,
    };
    this.emit({ kind: 'extracted', linkCount: results.length });
    return { ok: true, result };
  }

  private emit(event: PersonLinkExtractorEvent): void {
    this.onEvent?.(event);
  }
}

function parseIdentityLinks(raw: string): IdentityLinkInput[] | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text === '') return null;
  if (text.startsWith('```')) {
    const nl = text.indexOf('\n');
    if (nl === -1) return null;
    text = text.slice(nl + 1);
    const closeIdx = text.lastIndexOf('```');
    if (closeIdx !== -1) text = text.slice(0, closeIdx);
    text = text.trim();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as { identity_links?: unknown };
    const links = obj.identity_links;
    if (!Array.isArray(links)) return [];
    return links.filter(
      (l): l is IdentityLinkInput => l !== null && typeof l === 'object',
    );
  } catch {
    return null;
  }
}

const VALID_CONFIDENCE: ReadonlySet<SurfaceConfidence> = new Set([
  'high',
  'medium',
  'low',
]);

function normaliseLink(
  raw: IdentityLinkInput,
  fullText: string,
): ExtractedIdentityLink | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const rolePhrase =
    typeof raw.rolePhrase === 'string' ? raw.rolePhrase.trim() : '';
  if (name === '' && rolePhrase === '') return null;
  const rawConfidence =
    typeof raw.confidence === 'string'
      ? (raw.confidence.toLowerCase() as SurfaceConfidence)
      : 'medium';
  const confidence: SurfaceConfidence = VALID_CONFIDENCE.has(rawConfidence)
    ? rawConfidence
    : 'medium';
  const relationship =
    typeof raw.relationship === 'string' && raw.relationship.trim().length > 0
      ? raw.relationship.trim()
      : 'other';
  const evidence =
    typeof raw.evidence === 'string' && raw.evidence.trim().length > 0
      ? raw.evidence.trim().slice(0, 200)
      : fullText.slice(0, 100);
  const surfaces: PersonSurface[] = [];
  if (name !== '') {
    surfaces.push({
      surface: name,
      surfaceType: 'name',
      status: 'suggested',
      confidence,
    });
  }
  if (rolePhrase !== '') {
    surfaces.push({
      surface: rolePhrase,
      surfaceType: 'role_phrase',
      status: 'suggested',
      confidence,
    });
  }
  return {
    canonicalName: name !== '' ? name : rolePhrase,
    relationshipHint: relationship,
    surfaces,
    sourceExcerpt: evidence,
  };
}
