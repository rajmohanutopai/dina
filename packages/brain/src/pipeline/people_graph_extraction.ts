/**
 * People-graph extraction step — bridges the LLM identity-link
 * extractor (`extractPersonLinks` in `../person/linking.ts`) into the
 * new `PeopleRepository` (`@dina/core/people/repository`).
 *
 * Why this module exists separately from `identity_extraction.ts`:
 *   - `identity_extraction.ts` produces `IdentityLink[]` keyed by a
 *     *relationship category* ("sibling", "spouse"). It loses the
 *     verbatim role phrase ("my brother") that the LLM saw, which
 *     means the people graph can't enforce role-phrase exclusivity
 *     ("only one 'my brother' per user").
 *   - `extractPersonLinks` keeps the `role_phrase` channel intact and
 *     is the parity-equivalent of main Dina's `PERSON_IDENTITY_EXTRACTION`
 *     output. Hooking THAT into the people graph preserves the
 *     extractor invariants the repo expects.
 *
 * Pipeline shape:
 *
 *   text
 *     ──▶ extractPersonLinks (LLM, registered via
 *         `registerPersonLinkProvider`)
 *     ──▶ PersonLink[] (name + role_phrase + relationship + confidence
 *         + evidence)
 *     ──▶ linksToExtractionResult (pure conversion)
 *     ──▶ ExtractionResult { sourceItemId, extractorVersion, results }
 *     ──▶ peopleRepo.applyExtraction(result)
 *     ──▶ ApplyExtractionResponse { created, updated, conflicts, skipped }
 *
 * Idempotency contract — `peopleRepo.applyExtraction` keys off
 * `(sourceItemId, extractorVersion, fingerprint)`. So calling this
 * function twice with the same `sourceItemId` and an identical link
 * set is a no-op (returns `skipped: true`). Re-running because the
 * LLM changed its mind under the same version DOES write again
 * because the surface fingerprint changes; that's the desired
 * incremental-update behaviour.
 *
 * Fail-soft — never throws. The drain calls this AFTER a successful
 * vault store, so the vault item is durable regardless of what
 * happens here. Outcomes are tagged for telemetry.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase E (people-graph drain hook).
 */

import {
  getPeopleRepository,
  type ApplyExtractionResponse,
  type ExtractionPersonLink,
  type ExtractionResult,
  type ExtractionSurfaceEntry,
  type PeopleRepository,
  type SurfaceConfidence,
} from '@dina/core';

import { extractPersonLinks, type PersonLink } from '../person/linking';

/**
 * Extractor version stamp. Bump when the wire shape of the LLM
 * prompt or the conversion logic changes; the repo uses this as part
 * of the idempotency key, so re-running an old item under a new
 * version triggers a fresh apply (instead of skip).
 */
export const PEOPLE_GRAPH_EXTRACTOR_VERSION = 'llm-v1';

/** Caps for the source-excerpt the repo stores — matches Python's
 *  `person_link_extractor.py` (`evidence[:200] if evidence else text[:100]`).
 *  Two different limits:
 *    - When the LLM emits explicit `evidence` text, it's capped at 200.
 *    - When evidence is empty and we fall back to the full text, the
 *      fallback is capped at 100 (a tighter limit because we have no
 *      signal that any specific span is the relevant one). */
const EVIDENCE_MAX_CHARS = 200;
const FULLTEXT_FALLBACK_MAX_CHARS = 100;

/** Outcome tags so callers can record telemetry without inspecting
 *  the response shape. */
export type ApplyPeopleGraphOutcome =
  | { ok: true; applied: ApplyExtractionResponse; linkCount: number }
  | { ok: false; reason: 'empty_text' }
  | { ok: false; reason: 'no_repo' }
  | { ok: false; reason: 'no_links' }
  | { ok: false; reason: 'extractor_failed'; error: string }
  | { ok: false; reason: 'apply_failed'; error: string };

export interface ApplyPeopleGraphOptions {
  /**
   * Override the repository the result is applied to. Defaults to
   * the singleton registered via `setPeopleRepository`. Tests pass
   * an explicit instance; production wires the singleton at boot.
   */
  repo?: PeopleRepository;
  /**
   * Override the extractor version stamp recorded on every surface +
   * the idempotency log. Tests use this to force a fresh apply on
   * an item the previous test already wrote.
   */
  extractorVersion?: string;
}

/**
 * Run the LLM identity extractor on `text` and apply the result to
 * the people graph. Never throws.
 *
 * Returns a tagged outcome so the staging drain can record telemetry
 * without inspecting the repo's response shape.
 */
export async function applyPeopleGraphExtraction(
  text: string,
  sourceItemId: string,
  options: ApplyPeopleGraphOptions = {},
): Promise<ApplyPeopleGraphOutcome> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty_text' };
  }
  const repo = options.repo ?? getPeopleRepository();
  if (repo === null) {
    return { ok: false, reason: 'no_repo' };
  }
  const extractorVersion = options.extractorVersion ?? PEOPLE_GRAPH_EXTRACTOR_VERSION;

  let links: PersonLink[];
  try {
    links = await extractPersonLinks(text);
  } catch (err) {
    return {
      ok: false,
      reason: 'extractor_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (links.length === 0) {
    return { ok: false, reason: 'no_links' };
  }

  const result = linksToExtractionResult(links, sourceItemId, extractorVersion, text);
  if (result.results.length === 0) {
    // Every link normalised to an empty surface set — nothing to apply.
    return { ok: false, reason: 'no_links' };
  }

  let applied: ApplyExtractionResponse;
  try {
    applied = repo.applyExtraction(result);
  } catch (err) {
    return {
      ok: false,
      reason: 'apply_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, applied, linkCount: result.results.length };
}

/**
 * Pure conversion — `PersonLink[]` (LLM output) → people-repo
 * `ExtractionResult`. Mirrors Python's `person_link_extractor.py`
 * (`brain/src/service/person_link_extractor.py:73-104`):
 *
 *   - Skip links with both `name` and `role_phrase` empty.
 *   - Default confidence: `'medium'` (matches Python's
 *     `link.get("confidence", "medium")`). Unknown values coerce to
 *     `'medium'`, NOT `'low'` — `'low'` is a real signal in the
 *     extractor and must not be the default for parsing failure.
 *   - Default relationship: `'other'` (matches Python's
 *     `link.get("relationship", "other")`).
 *   - Source excerpt: evidence trimmed to 200 chars; falls back to
 *     the first 100 chars of the full text when evidence is empty.
 */
export function linksToExtractionResult(
  links: PersonLink[],
  sourceItemId: string,
  extractorVersion: string,
  fullText = '',
): ExtractionResult {
  const results: ExtractionPersonLink[] = [];
  for (const link of links) {
    const name = link.name?.trim() ?? '';
    const rolePhrase = (link.role_phrase ?? link.role ?? '').trim();
    if (name === '' && rolePhrase === '') continue;

    const confidence: SurfaceConfidence =
      link.confidence === 'high' || link.confidence === 'medium' || link.confidence === 'low'
        ? link.confidence
        : 'medium';

    const surfaces: ExtractionSurfaceEntry[] = [];
    if (name !== '') {
      surfaces.push({ surface: name, surfaceType: 'name', confidence });
    }
    if (rolePhrase !== '') {
      surfaces.push({ surface: rolePhrase, surfaceType: 'role_phrase', confidence });
    }
    if (surfaces.length === 0) continue;

    const sourceExcerpt =
      typeof link.evidence === 'string' && link.evidence.trim().length > 0
        ? link.evidence.trim().slice(0, EVIDENCE_MAX_CHARS)
        : fullText.slice(0, FULLTEXT_FALLBACK_MAX_CHARS);

    const relationshipHint =
      typeof link.relationship === 'string' && link.relationship.trim().length > 0
        ? link.relationship.trim()
        : 'other';

    results.push({
      canonicalName: name !== '' ? name : rolePhrase,
      relationshipHint,
      surfaces,
      sourceExcerpt,
    });
  }

  return {
    sourceItemId,
    extractorVersion,
    results,
  };
}
