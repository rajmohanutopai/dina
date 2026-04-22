/**
 * Working-memory domain types.
 *
 * Source of truth: `docs/WORKING_MEMORY_PORT_TASKS.md` (WM-CORE-05) and
 * the main-dina reference file `core/internal/domain/topic.go`. The
 * design doc lives at `docs/WORKING_MEMORY_DESIGN.md` if copied in,
 * otherwise at `../../../docs/WORKING_MEMORY_DESIGN.md` (relative to
 * the repo root). All §-anchored comments below refer to that doc.
 *
 * Topics are the salience-ranked handles that feed Dina's Table of
 * Contents (ToC) — the thing the intent classifier reads to decide
 * whether a query needs vault context, trust-network opinions, or a
 * live provider-service call. See §4 (data model), §5 (scoring),
 * §6 (what is a topic).
 *
 * Wire contract: snake_case field names on structs, mirroring the Go
 * tags so the JSON round-trip with Core matches on the wire and
 * matches the existing style of `packages/core/src/workflow/domain.ts`.
 */

/**
 * Distinguishes entity topics (named proper nouns — people, places,
 * organisations) from theme topics (recurring domains or common-noun
 * phrases).
 *
 * The classifier prompt uses the kind to pick the right routing
 * affordance; entities are typically unambiguous while themes may need
 * canonicalisation to merge near-duplicates.
 */
export type TopicKind = 'entity' | 'theme';

const VALID_TOPIC_KINDS: ReadonlySet<TopicKind> = new Set<TopicKind>(['entity', 'theme']);

/**
 * Narrow a `string` to `TopicKind` when it matches one of the defined
 * kinds. Used by the service layer to reject bad payloads before they
 * reach SQL — mirrors `TopicKind.IsValid()` in the Go port.
 */
export function isTopicKind(s: unknown): s is TopicKind {
  return typeof s === 'string' && VALID_TOPIC_KINDS.has(s as TopicKind);
}

/**
 * One row of the per-persona salience index.
 *
 * The persona identity is IMPLICIT — each persona keeps its own
 * SQLCipher database, so there is no `persona` column here. Callers
 * that need to carry the persona (e.g. the cross-persona ToC merger)
 * use `TocEntry` instead.
 *
 * Capability bindings used to live here (`live_capability`,
 * `live_provider_did`) but have been moved onto the Contact row
 * (`preferredFor`, PC-CORE-01). Memory stores "what the user has
 * talked about"; contacts store "who the user goes to for what."
 * AppView remains the source of truth for a DID's currently-published
 * capabilities. See docs/WORKING_MEMORY_DESIGN.md §6.1.
 *
 * `sample_item_id` points at one recent vault item that mentions the
 * topic — makes the ToC row inspectable ("what did the user actually
 * say about Sancho?") without forcing a full search.
 */
export interface Topic {
  /** Canonical topic name — the form that salience is tracked under. */
  topic: string;
  /** 'entity' | 'theme' — see TopicKind. */
  kind: TopicKind;
  /** Unix seconds of the most recent `touch` that updated this row. */
  last_update: number;
  /** EWMA counter, tau = 14 days. "What's spiked recently." */
  s_short: number;
  /** EWMA counter, tau = 180 days. "What's been present long-term." */
  s_long: number;
  /** Opaque reference to one recent vault item — for inspection. */
  sample_item_id?: string;
}

/**
 * Return shape of `GET /v1/memory/toc`.
 *
 * `TocEntry` is a `Topic` augmented with the persona the topic came
 * from (the service layer adds it after merging across unlocked
 * personas) and the current salience value (decay applied at read
 * time; does NOT live in storage).
 *
 * See §8 (ToC render) for the UI consumer format. Brain's intent
 * classifier reads this JSON directly; the reasoning agent receives
 * only the classifier's distilled output, not the raw ToC (§9).
 */
export interface TocEntry {
  persona: string;
  topic: string;
  kind: TopicKind;
  /** Decayed salience at the moment the ToC was read. */
  salience: number;
  last_update: number;
  sample_item_id?: string;
}

/**
 * Variant → canonical mapping. Lookup happens at extraction time —
 * before `touch` — so "tax plan" and "tax planning" collapse into a
 * single salience row. Populated lazily by `ResolveAlias` (see
 * repository).
 */
export interface TopicAlias {
  variant: string;
  canonical: string;
}

/**
 * Inputs to `repo.touch()`. `sampleItemId` follows the "do NOT
 * overwrite with empty" rule: later touches that leave it unset (or
 * pass an empty string) must NOT clear the stored value — only a new
 * non-empty value wins.
 *
 * Capability fields (`liveCapability`, `liveProviderDid`) were
 * removed in PC-CORE-05/06 — capability bindings live on the Contact
 * row now, not the topic row.
 */
export interface TouchRequest {
  topic: string;
  kind: TopicKind;
  /** Unix seconds at which this touch is being recorded. */
  nowUnix: number;
  sampleItemId?: string;
}

// ---------------------------------------------------------------------------
// Scoring constants (§5 of the design doc).
//
// These are load-bearing — changing them changes the shape of working
// memory, and any such change should come with a doc update. Kept as
// module-level consts (not a config struct) to make that coupling
// loud.
// ---------------------------------------------------------------------------

/** EWMA timescale for "this week/fortnight" — rapid response to bursts. */
export const TOPIC_TAU_SHORT_DAYS = 14;

/** EWMA timescale for "this half-year" — slow, long-anchored signal. */
export const TOPIC_TAU_LONG_DAYS = 180;

/** Weight applied to the short-term counter in the combined salience. */
export const TOPIC_SHORT_MIX = 0.3;
