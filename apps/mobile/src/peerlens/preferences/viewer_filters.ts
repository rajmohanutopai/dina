/**
 * Viewer-profile filter predicates (TN-V2-RANK-005 / V2 actionability).
 *
 * Pure data layer for the search-screen filter chips. Each filter
 * exposes `{ id, label, isApplicable, predicate }`. The chip-row
 * component renders applicable filters; tapping toggles a chip;
 * toggled-ON predicates run over the search results.
 *
 * **Design — "missing field = pass."** Each predicate's contract
 * is: if the result row carries the field AND the field doesn't
 * match the viewer's preference, exclude the row. If the field is
 * absent on the row, the row passes — V1 attestations + early-V2
 * data don't carry every metadata field, and penalising "unknown"
 * would erase legitimate results.
 *
 * **Loyalty Law.** Filtering happens client-side. The search xRPC
 * returns un-personalised data; the mobile client applies the lens.
 * No viewer preference ever crosses the wire.
 *
 * Today only the `languages` predicate is fully functional (because
 * `subjects.language` is the only viewer-relevant field already on
 * the wire — see TN-V2-P1-002). Other predicates are stubbed with
 * `isApplicable: false` until their corresponding META-* server
 * tasks land. Adding a new functional predicate is an "edit one
 * file" change.
 */

import type { SubjectCardDisplay } from '../subject_card';
import type { UserPreferences } from '../../services/user_preferences';

/**
 * One filter chip's full contract: identity, label, when to render,
 * and how to filter. Pure functions — no React, no I/O.
 */
export interface ViewerFilter {
  /** Stable id used for testID + chip-state key. */
  readonly id: ViewerFilterId;
  /** Human-readable label rendered on the chip. */
  readonly label: string;
  /**
   * Is this filter applicable for the current viewer profile? Returns
   * `true` when (a) the profile carries the relevant preference and
   * (b) we have wire-side data to filter on. When `false`, the chip
   * is hidden — it would be a no-op or a confusing "this doesn't do
   * anything yet" affordance.
   */
  readonly isApplicable: (profile: UserPreferences) => boolean;
  /**
   * Predicate run over each search result. Return `true` to include
   * the result, `false` to exclude. Missing fields on the result
   * MUST return `true` — see the file header.
   */
  readonly predicate: (display: SubjectCardDisplay, profile: UserPreferences) => boolean;
}

export type ViewerFilterId =
  | 'languages'
  | 'region'
  | 'budget'
  | 'devices'
  | 'dietary'
  | 'accessibility';

// ─── Filter table ─────────────────────────────────────────────────────────

const LANGUAGE_FILTER: ViewerFilter = {
  id: 'languages',
  label: 'In my languages',
  // Render the chip when the viewer has at least one language set AND
  // the wire format actually surfaces language. The wire-availability
  // check is implicit — TN-V2-P1-002 added `display.language`, which
  // is null for unenriched subjects but populated for enriched ones.
  isApplicable: (profile) => profile.languages.length > 0,
  predicate: (display, profile) => {
    if (display.language === null) return true; // unknown = pass
    if (profile.languages.length === 0) return true; // no preference = pass
    // The viewer's languages are stored as BCP-47 (`en-US`, `pt-BR`).
    // The wire `display.language` is also BCP-47-ish but uppercased
    // by the data layer (`EN`, `PT-BR` — see subject_card.ts). Match
    // case-insensitively. Compare BOTH on the language SUBTAG (the
    // first component before the dash) AND the full tag — a viewer
    // setting `en-US` should still match a subject with language=`EN`.
    const subjectTag = display.language.toLowerCase();
    const subjectLang = subjectTag.split('-')[0];
    for (const viewerTag of profile.languages) {
      const v = viewerTag.toLowerCase();
      if (v === subjectTag) return true;
      if (v.split('-')[0] === subjectLang) return true;
    }
    return false;
  },
};

/**
 * Stub filters — declared so the framework knows the full set, but
 * `isApplicable: () => false` keeps them off the chip row until the
 * matching META-* server task lands. When that lands, replace the
 * stub with a real `isApplicable` check + a real `predicate`.
 *
 * Keeping the stubs as code (not as comments) means a developer
 * adding the corresponding META-* task only edits this file —
 * no wider refactor.
 */
const STUB_NEVER_APPLIES = (): boolean => false;
const STUB_PASS_ALL = (): boolean => true;

const REGION_FILTER: ViewerFilter = {
  id: 'region',
  label: 'In my region',
  // Pending TN-V2-META-001 (subjects.metadata.availability.regions) +
  // TN-V2-META-007 (host_to_region enricher). Hidden today.
  isApplicable: STUB_NEVER_APPLIES,
  predicate: STUB_PASS_ALL,
};

const BUDGET_FILTER: ViewerFilter = {
  id: 'budget',
  label: 'In my budget',
  // Pending TN-V2-META-002 (subjects.metadata.price). Hidden today.
  isApplicable: STUB_NEVER_APPLIES,
  predicate: STUB_PASS_ALL,
};

const DEVICES_FILTER: ViewerFilter = {
  id: 'devices',
  label: 'Compatible with my devices',
  // Pending TN-V2-META-003 (subjects.metadata.compat.tags). Hidden today.
  isApplicable: STUB_NEVER_APPLIES,
  predicate: STUB_PASS_ALL,
};

const DIETARY_FILTER: ViewerFilter = {
  id: 'dietary',
  label: 'Matches my dietary',
  // Pending TN-V2-META-005 (subjects.metadata.compliance.tags). Hidden today.
  isApplicable: STUB_NEVER_APPLIES,
  predicate: STUB_PASS_ALL,
};

const ACCESSIBILITY_FILTER: ViewerFilter = {
  id: 'accessibility',
  label: 'Matches my accessibility',
  // Pending TN-V2-META-006 (subjects.metadata.accessibility.tags). Hidden today.
  isApplicable: STUB_NEVER_APPLIES,
  predicate: STUB_PASS_ALL,
};

/**
 * Full ordered filter list. Order matches the visual chip-row
 * order. Edit this when adding new filters or shuffling.
 */
export const ALL_VIEWER_FILTERS: ReadonlyArray<ViewerFilter> = Object.freeze([
  LANGUAGE_FILTER,
  REGION_FILTER,
  BUDGET_FILTER,
  DEVICES_FILTER,
  DIETARY_FILTER,
  ACCESSIBILITY_FILTER,
]);

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Pick the filters that should render as chips for the given viewer
 * profile. Filters whose `isApplicable` returns `false` are hidden
 * — either because the viewer has no preference for that field OR
 * the wire data isn't yet there to filter on.
 */
export function applicableFilters(profile: UserPreferences): ReadonlyArray<ViewerFilter> {
  return ALL_VIEWER_FILTERS.filter((f) => f.isApplicable(profile));
}

/**
 * Apply a set of toggled-ON filter ids to the result list. Each
 * predicate runs in the chip-row order; a result is included only
 * if EVERY active filter's predicate returns `true`.
 *
 * Pure: same input always produces the same output. The screen
 * memoises this with `useMemo` over `(results, profile, activeIds)`.
 */
export function applyFilters<T extends { display: SubjectCardDisplay }>(
  results: ReadonlyArray<T>,
  profile: UserPreferences,
  activeIds: ReadonlySet<ViewerFilterId>,
): ReadonlyArray<T> {
  if (activeIds.size === 0) return results;
  const activeFilters = ALL_VIEWER_FILTERS.filter((f) => activeIds.has(f.id));
  return results.filter((r) =>
    activeFilters.every((f) => f.predicate(r.display, profile)),
  );
}

/**
 * Test helper — exposed for unit tests that want to drive the
 * language predicate directly without going through the full filter
 * table. Re-export from the constant rather than re-deriving so test
 * + production code can't drift.
 */
export const _LANGUAGE_FILTER_FOR_TEST = LANGUAGE_FILTER;
