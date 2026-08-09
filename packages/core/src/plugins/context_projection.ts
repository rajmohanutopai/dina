/**
 * Per-task context projection (§13.5, §11.3, FR-P3) — what a plugin is told,
 * for THIS task and nothing else.
 *
 * WHY THE PRODUCER MATTERS AS MUCH AS THE CHECK. `contextScopeViolation` in
 * `dispatch.ts` is a fail-closed BACKSTOP: it refuses a context that is too
 * large, too deep, or carries regulated content. Its own comment says a
 * projection producer must scrub and that it exists in case one skips it.
 * Until now there was no producer — every caller assembled context by hand,
 * which means the backstop was the only thing between the vault and a runner,
 * and a backstop is the wrong place for a rule to live.
 *
 * THE RULE FR-P3 STATES: PROJECT PER TASK, NEVER A RUNNER UNION.
 *
 * The convenient implementation gathers everything the PLUGIN might need and
 * sends it to whichever capability is running. That is a union, and a union is
 * wrong in a way that grows silently: adding a capability that reads health
 * data widens what the plugin's ordering capability receives, and nobody
 * editing the manifest would see the connection. So the projection is built
 * from the DECLARED SCOPE OF ONE CAPABILITY and the task at hand — a
 * capability that declared no scope receives no context, not the leftovers.
 *
 * AND IT IS A DENY-LIST-FREE DESIGN. Fields are copied in by name from the
 * declared categories; nothing is copied and then removed. A scrubber that
 * deletes known-bad keys leaks every key nobody thought of, and the keys
 * nobody thinks of are exactly the ones a new vault feature adds.
 */

import type { PluginDataScope } from '@dina/protocol';

/**
 * A vault item as the projector sees it. Deliberately narrow: the projector
 * takes what a caller has ALREADY decided is relevant to the task, and its job
 * is to bound and shape it, not to search.
 */
export interface ProjectableItem {
  /** Which declared category this item belongs to. */
  category: string;
  /** Persona the item came from, for the persona filter. */
  persona: string;
  /**
   * Already-scrubbed fields. The projector copies by NAME from
   * `allowedFields`; anything not named is not copied.
   */
  fields: Record<string, unknown>;
}

export interface ProjectionRefusal {
  reason: 'category_not_declared' | 'persona_not_declared' | 'over_item_cap';
  category: string;
  persona: string;
}

export interface ContextProjection {
  /** The bounded, shaped item list an envelope may carry. */
  items: { category: string; fields: Record<string, unknown> }[];
  /**
   * What was excluded and why. Not for the runner — for the OWNER, who is
   * entitled to know that a capability asked for something its consent does
   * not cover.
   */
  excluded: ProjectionRefusal[];
}

/**
 * Project context for ONE capability's task.
 *
 * `allowedFields` is the field allow-list for this capability. It is a
 * required argument with no default: a default would be a decision about what
 * a plugin may read, made once, far from any manifest, and applied to every
 * capability that forgot to pass one.
 */
export function projectContextForCapability(args: {
  scope: PluginDataScope | undefined;
  allowedFields: readonly string[];
  candidates: readonly ProjectableItem[];
}): ContextProjection {
  const items: ContextProjection['items'] = [];
  const excluded: ProjectionRefusal[] = [];

  // A capability that declared NO scope receives NO context. Not "everything
  // that happens to be lying around" and not "a safe default" — the manifest
  // is where a plugin says what it needs, and silence there is an answer.
  if (args.scope === undefined) {
    for (const candidate of args.candidates) {
      excluded.push({
        reason: 'category_not_declared',
        category: candidate.category,
        persona: candidate.persona,
      });
    }
    return { items, excluded };
  }

  const categories = new Set(args.scope.categories);
  const personas = args.scope.personas;
  // `max_context_items` absent means ZERO, matching the backstop's reading:
  // an undeclared ceiling is not an unlimited one.
  const cap = args.scope.max_context_items ?? 0;
  const allowed = new Set(args.allowedFields);

  for (const candidate of args.candidates) {
    if (!categories.has(candidate.category)) {
      excluded.push({
        reason: 'category_not_declared',
        category: candidate.category,
        persona: candidate.persona,
      });
      continue;
    }
    // An absent persona list means "no persona restriction was declared",
    // which the manifest validator permits. An EMPTY list is a declaration of
    // none — the two are different and the second must not read as the first.
    if (personas !== undefined && !personas.includes(candidate.persona)) {
      excluded.push({
        reason: 'persona_not_declared',
        category: candidate.category,
        persona: candidate.persona,
      });
      continue;
    }
    if (items.length >= cap) {
      excluded.push({
        reason: 'over_item_cap',
        category: candidate.category,
        persona: candidate.persona,
      });
      continue;
    }
    // COPY IN BY NAME. Never copy-then-delete: a scrubber that removes known
    // keys leaks every key nobody thought of, and those are precisely the ones
    // a new vault feature adds next month.
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(candidate.fields)) {
      if (allowed.has(key)) fields[key] = candidate.fields[key];
    }
    items.push({ category: candidate.category, fields });
  }

  return { items, excluded };
}
