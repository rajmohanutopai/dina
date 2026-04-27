/**
 * People-graph domain types — port of `core/internal/domain/person.go`
 * (main Dina). The Lite stack adopts the same shapes verbatim so the
 * extractor, resolver, and conflict-detection semantics behave
 * identically to main Dina; the parity tests in Phase G assert this.
 *
 * Why a separate type from `Contact`:
 *   - A `Person` is a HUMAN entity Dina knows about. The DID is
 *     optional (`contactDid` defaults to ''), so people without a
 *     Dina account (kids, late relatives, public figures) participate
 *     in the same graph as paired contacts.
 *   - `Contact` is the DID-specific record that pins trust level,
 *     sharing tier, preferences, etc. A `Person` may or may not be
 *     bound to one — `LinkContact` (in the repository) creates the
 *     binding when the user pairs a previously-extracted person.
 *
 * `Surface` (also called "alias" in some Python code) is any string
 * the LLM (or user) emits as a way of referring to the person:
 *   - `name`        — proper name ("Sancho", "Sancho Garcia")
 *   - `nickname`    — informal ("Sanch", "S")
 *   - `role_phrase` — relationship reference ("my brother", "my doctor")
 *   - `alias`       — anything else (a handle, an email prefix)
 *
 * `surface_type === 'role_phrase'` is special: only ONE confirmed
 * person may own a given role phrase at a time (you have one "my
 * doctor"). The repository's `applyExtraction` enforces this.
 */

/** Lifecycle states for a `Person` row. */
export type PersonStatus = 'suggested' | 'confirmed' | 'rejected';

/** Lifecycle states for a `PersonSurface` row. */
export type SurfaceStatus = 'suggested' | 'confirmed' | 'rejected';

/** LLM-assessed confidence for an extracted surface. */
export type SurfaceConfidence = 'high' | 'medium' | 'low';

/** Provenance for both `Person` and `PersonSurface` rows. */
export type CreatedFrom = 'llm' | 'manual' | 'imported';

/**
 * Type categories for a surface form. Drives the conflict rule
 * (`role_phrase` is exclusive across confirmed people; `name`,
 * `nickname`, `alias` are not).
 */
export type SurfaceType = 'name' | 'nickname' | 'role_phrase' | 'alias';

/** Constants — matches the Go side's `domain.PersonStatus*` etc. */
export const PERSON_STATUS_SUGGESTED: PersonStatus = 'suggested';
export const PERSON_STATUS_CONFIRMED: PersonStatus = 'confirmed';
export const PERSON_STATUS_REJECTED: PersonStatus = 'rejected';

export const SURFACE_STATUS_SUGGESTED: SurfaceStatus = 'suggested';
export const SURFACE_STATUS_CONFIRMED: SurfaceStatus = 'confirmed';
export const SURFACE_STATUS_REJECTED: SurfaceStatus = 'rejected';

/** Surface types the repository recognises. */
export const VALID_SURFACE_TYPES: ReadonlySet<string> = new Set<SurfaceType>([
  'name',
  'nickname',
  'role_phrase',
  'alias',
]);

/** Confidence values the repository accepts. */
export const VALID_SURFACE_CONFIDENCE: ReadonlySet<string> = new Set<SurfaceConfidence>([
  'high',
  'medium',
  'low',
]);

/** Provenance values. */
export const VALID_CREATED_FROM: ReadonlySet<string> = new Set<CreatedFrom>([
  'llm',
  'manual',
  'imported',
]);

/**
 * Canonical person record. `surfaces` is hydrated by `getPerson` /
 * `listPeople`; raw row reads (rare — repository internals only) may
 * leave it absent.
 */
export interface Person {
  personId: string;
  canonicalName: string;
  /** Empty string when no DID is bound. */
  contactDid: string;
  /** Free-form relationship hint ("brother", "doctor"). Empty when unset. */
  relationshipHint: string;
  status: PersonStatus;
  createdFrom: CreatedFrom;
  createdAt: number;
  updatedAt: number;
  /** Hydrated by `getPerson` / `listPeople`. Not set on raw row reads. */
  surfaces?: PersonSurface[];
}

/**
 * One surface form linked to a person. Multiple surfaces per person
 * are normal (a name + a nickname + a role phrase). The
 * `(person_id, normalized_surface)` pair is enforced unique by the
 * repository's upsert logic.
 */
export interface PersonSurface {
  id: number;
  personId: string;
  /** Verbatim form as stored — may have casing / whitespace. */
  surface: string;
  /** Lower-cased + trimmed form used for lookups. */
  normalizedSurface: string;
  surfaceType: SurfaceType;
  status: SurfaceStatus;
  confidence: SurfaceConfidence;
  /** Empty string when not sourced to a vault item (manual entry). */
  sourceItemId: string;
  /** Verbatim text the LLM used to justify the link. Empty when unset. */
  sourceExcerpt: string;
  /** Extractor version stamp — used for idempotency in `applyExtraction`. */
  extractorVersion: string;
  createdFrom: CreatedFrom;
  createdAt: number;
  updatedAt: number;
}

/**
 * Atomic write unit produced by the LLM extractor. One source item
 * yields one `ExtractionResult` containing all the people the LLM
 * found in that item; the repository's `applyExtraction` is
 * idempotent per `(sourceItemId, extractorVersion, fingerprint)` so
 * re-running the same extractor on the same content is safe.
 */
export interface ExtractionResult {
  sourceItemId: string;
  extractorVersion: string;
  results: ExtractionPersonLink[];
}

/** One person link inside an `ExtractionResult`. */
export interface ExtractionPersonLink {
  canonicalName: string;
  /** Empty string when the LLM didn't propose a relationship. */
  relationshipHint: string;
  surfaces: ExtractionSurfaceEntry[];
  /** Verbatim source phrase the LLM cited — capped at 200 chars per the
   *  Python parser's policy. Empty when unset. */
  sourceExcerpt: string;
}

/** One surface form proposed by the LLM. */
export interface ExtractionSurfaceEntry {
  surface: string;
  surfaceType: SurfaceType;
  confidence: SurfaceConfidence;
}

/**
 * Result of `applyExtraction`. `skipped` is true when the
 * `(item, extractor_version, fingerprint)` already exists in the log
 * (idempotent re-run). `conflicts` lists role_phrase surfaces the
 * extractor wanted to claim that already belong to a different
 * confirmed person — these are surfaced for operator review rather
 * than written.
 */
export interface ApplyExtractionResponse {
  created: number;
  updated: number;
  conflicts: string[];
  skipped: boolean;
}
