/**
 * THE CONTEXT PROJECTOR (PLUGIN_ARCHITECTURE.md §11, §13.5, FR-P3) — what a
 * plugin is told, for THIS task and nothing else.
 *
 * WHY THE PRODUCER MATTERS AS MUCH AS THE CHECK. `contextScopeViolation` in
 * `dispatch.ts` is a fail-closed BACKSTOP: it refuses a context that is too
 * large, too deep, or carries regulated content. Its own comment says a
 * projection producer must scrub and that it exists in case one skips it.
 * A backstop is the wrong place for a rule to live, and §11 says why in one
 * line: `checkEgress` "stays load-bearing because its input contract is met
 * by construction, not by claiming it handles shapes it doesn't". This module
 * is that construction.
 *
 * THE FOUR RULES IT ENFORCES, IN ORDER:
 *
 *   1. SCOPE IS PER CAPABILITY, NEVER A RUNNER UNION (FR-P3). The convenient
 *      implementation gathers everything the PLUGIN might need and sends it to
 *      whichever capability is running. That is a union, and a union grows
 *      silently: adding a capability that reads health data widens what the
 *      ordering capability receives, and nobody editing the manifest would see
 *      the connection. A capability that declared no scope receives nothing,
 *      not the leftovers.
 *   2. LOCKED PERSONAS ARE NEVER IN SCOPE, stricter than agents (whose
 *      approved grants can reach locked vaults). An agent is the owner's hands
 *      with per-request approval; a plugin is ambient automation, and ambient
 *      automation never touches the locked ring. A persona this node does not
 *      recognise is treated as locked — the strictest reading of a name we
 *      cannot resolve.
 *   3. FIELDS COME FROM DINA'S TEMPLATES, not from the manifest
 *      (`context_templates.ts`). Copy in by name; never copy-then-delete.
 *   4. NOTHING REGULATED TRAVELS. Every converted value is re-scanned with the
 *      SAME detector the envelope backstop uses, and a value it flags is
 *      dropped rather than substituted. Substitution would hand a runner a
 *      corrupted legal name and call it scrubbed; dropping tells the owner the
 *      field could not travel.
 *
 * WHY THERE IS NO SECOND, CORPUS-LEVEL GUARD HERE. The backstop's other three
 * refusals — depth, bytes, item count — cannot fire on this module's output,
 * and a guard that cannot fire is a guard nobody can test. A projected item is
 * three levels deep and never more; `max_context_items` is capped at 25 by the
 * manifest validator and each item holds at most seven 120-character fields,
 * so the largest projection this module can build is a fraction of the 64 KB
 * inspection ceiling. The regulated scan is the only one that could differ,
 * and it scans the corpus with field NAMES between the values, so two values
 * cannot join into one number. The invariant is asserted where it belongs:
 * `context_projection.test.ts` runs the real `contextScopeViolation` over real
 * projector output, so the day any of those bounds moves, a test says so.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import { getPersona } from '../persona/service';

import { getContextSource, type ContextCandidate, type InvocationSubject } from './context_sources';
import {
  convertField,
  templateFieldsFor,
  type ContextTemplateField,
} from './context_templates';
import { regulatedContentIn } from './dispatch';

import type { PluginCapabilityDecl, PluginDataScope } from '@dina/protocol';

/** Why something the sources offered did not travel. For the OWNER, never the runner. */
export type ProjectionRefusalReason =
  /** The candidate's category is outside this capability's consented scope. */
  | 'category_not_declared'
  /** Dina has no template for this category and action class — nothing to project. */
  | 'category_not_projectable'
  /** The item's persona is outside the declared list (a Tier-0 item included). */
  | 'persona_not_declared'
  /** The persona is locked, or this node does not recognise it. */
  | 'persona_locked'
  /** `max_context_items` was already full. */
  | 'over_item_cap'
  /** Every field the template allows was dropped — nothing left to send. */
  | 'no_projectable_fields';

export interface ProjectionRefusal {
  reason: ProjectionRefusalReason;
  category: string;
  /** The persona the candidate came from; `''` for a Tier-0 item. */
  persona: string;
}

/** One context item as it rides the envelope: flat, and strings all the way down. */
export interface ProjectedItem {
  category: string;
  fields: Record<string, string>;
}

export interface ContextProjection {
  /** The bounded, shaped item list the envelope carries. */
  items: ProjectedItem[];
  /**
   * What was excluded and why. Not for the runner — for the OWNER, who is
   * entitled to know that a capability asked for something its consent does
   * not cover.
   */
  excluded: ProjectionRefusal[];
  /** Consented categories with no registered source: Dina has no store to read. */
  unsourced: string[];
  /**
   * Individual field values the templates or the regulated scan dropped.
   * A count, never the values — this rides the audit line.
   */
  droppedFields: number;
}

/**
 * The projection's pure half: shape and bound candidates a caller has already
 * gathered. Exported for the boot paths and tests that want the rules without
 * the stores; production reaches it through `projectInvocationContext`.
 *
 * `actionClass` is required with no default. A default would be a decision
 * about what a plugin may read, made once, far from any manifest, and applied
 * to every capability that forgot to pass one.
 */
export function projectContextForCapability(args: {
  scope: PluginDataScope | undefined;
  actionClass: string;
  candidates: readonly ContextCandidate[];
  nowMs: number;
}): ContextProjection {
  const items: ProjectedItem[] = [];
  const excluded: ProjectionRefusal[] = [];
  let droppedFields = 0;

  // A capability that declared NO scope receives NO context. Not "everything
  // that happens to be lying around" and not "a safe default" — the manifest
  // is where a plugin says what it needs, and silence there is an answer.
  if (args.scope === undefined) {
    for (const candidate of args.candidates) {
      excluded.push(refusal('category_not_declared', candidate));
    }
    return { items, excluded, unsourced: [], droppedFields };
  }

  const categories = new Set(args.scope.categories);
  const personas = args.scope.personas;
  // `max_context_items` absent means ZERO, matching the backstop's reading:
  // an undeclared ceiling is not an unlimited one.
  const cap = args.scope.max_context_items ?? 0;

  for (const candidate of args.candidates) {
    if (!categories.has(candidate.category)) {
      excluded.push(refusal('category_not_declared', candidate));
      continue;
    }
    const fields = templateFieldsFor(candidate.category, args.actionClass);
    if (fields.length === 0) {
      excluded.push(refusal('category_not_projectable', candidate));
      continue;
    }
    const personaVerdict = personaAdmits(candidate.persona, personas);
    if (personaVerdict !== null) {
      excluded.push(refusal(personaVerdict, candidate));
      continue;
    }
    // The cap is checked AFTER the scope filters so a rejected candidate never
    // spends a slot, and BEFORE the projection so a full context does no work.
    if (items.length >= cap) {
      excluded.push(refusal('over_item_cap', candidate));
      continue;
    }
    const projected = projectFields(fields, candidate.fields, args.nowMs);
    droppedFields += projected.dropped;
    if (Object.keys(projected.fields).length === 0) {
      excluded.push(refusal('no_projectable_fields', candidate));
      continue;
    }
    items.push({ category: candidate.category, fields: projected.fields });
  }

  return { items, excluded, unsourced: [], droppedFields };
}

/**
 * The production entry point: gather, shape and bound the context for ONE
 * invocation of ONE capability.
 *
 * Every consented category is gathered SEPARATELY and told its own category,
 * so a source cannot answer a question it was not asked — the per-capability
 * rule applied one level down.
 */
export function projectInvocationContext(args: {
  capability: PluginCapabilityDecl;
  subject: InvocationSubject;
  nowMs: number;
}): ContextProjection {
  const scope = args.capability.data_scope;
  if (scope === undefined) {
    return { items: [], excluded: [], unsourced: [], droppedFields: 0 };
  }
  const candidates: ContextCandidate[] = [];
  const unsourced: string[] = [];
  for (const category of scope.categories) {
    const source = getContextSource(category);
    if (source === null) {
      unsourced.push(category);
      continue;
    }
    // A source that throws must never sink an invocation the owner asked for:
    // the category simply contributes nothing, and says so.
    let gathered: readonly ContextCandidate[] = [];
    try {
      gathered = source({
        category,
        actionClass: args.capability.action_class,
        subject: args.subject,
        nowMs: args.nowMs,
      });
    } catch {
      unsourced.push(category);
      continue;
    }
    // A source answering with somebody else's category is a source bug, and
    // the projector refuses it rather than trusting the label: the category
    // decides the template, so a mislabelled candidate would be shaped by the
    // wrong rules.
    for (const candidate of gathered) {
      if (candidate.category === category) candidates.push(candidate);
    }
  }
  const projection = projectContextForCapability({
    scope,
    actionClass: args.capability.action_class,
    candidates,
    nowMs: args.nowMs,
  });
  return { ...projection, unsourced: [...new Set(unsourced)].sort() };
}

/** The categories a projection actually carried — the audit line names them. */
export function projectedCategories(projection: ContextProjection): string[] {
  return [...new Set(projection.items.map((i) => i.category))].sort();
}

function refusal(reason: ProjectionRefusalReason, candidate: ContextCandidate): ProjectionRefusal {
  return { reason, category: candidate.category, persona: candidate.persona ?? '' };
}

/**
 * Does the persona ring let this item travel? Null means yes; anything else is
 * the reason it does not.
 *
 * An ABSENT persona list on the manifest means "no persona restriction was
 * declared", which the validator permits. An EMPTY list is a declaration of
 * none — the two are different and the second must not read as the first.
 */
function personaAdmits(
  persona: string | undefined,
  declared: readonly string[] | undefined,
): ProjectionRefusalReason | null {
  if (persona === undefined) {
    // A Tier-0 item (contact directory, business settings) belongs to no
    // persona. A manifest that names personas is asking for persona-vault
    // data, and this is not that — fail closed rather than reading "any
    // persona" into a list that named some.
    return declared === undefined ? null : 'persona_not_declared';
  }
  if (declared !== undefined && !declared.includes(persona)) return 'persona_not_declared';
  const state = getPersona(persona);
  // An unrecognised persona reads as locked: the strictest answer to a name
  // this node cannot resolve, and the same direction the gate takes elsewhere.
  if (state === null || state.tier === 'locked') return 'persona_locked';
  return null;
}

/**
 * Copy in by name, convert by class, drop anything regulated. The returned
 * object can only hold strings, which is what keeps a raw vault row out of a
 * payload structurally rather than by inspection.
 */
function projectFields(
  template: readonly ContextTemplateField[],
  raw: Readonly<Record<string, unknown>>,
  nowMs: number,
): { fields: Record<string, string>; dropped: number } {
  const fields: Record<string, string> = {};
  let dropped = 0;
  for (const field of template) {
    if (!Object.prototype.hasOwnProperty.call(raw, field.name)) continue;
    // A store that holds NOTHING here is not a field being held back, so it is
    // not counted as one: `droppedFields` is what could not travel, and an
    // owner reading the audit line should not see an optional second address
    // line reported as something Dina refused to send.
    const rawValue = raw[field.name];
    if (rawValue === undefined || rawValue === null) continue;
    const value = convertField(field, rawValue, nowMs);
    if (value === null) {
      dropped += 1;
      continue;
    }
    // The same detector the envelope backstop runs. A PAN registration, a
    // card number a store happens to hold — flagged here, dropped here, so
    // the builder downstream never has a reason to refuse the whole task.
    if (regulatedContentIn(value).length > 0) {
      dropped += 1;
      continue;
    }
    fields[field.name] = value;
  }
  return { fields, dropped };
}

/**
 * A stable digest of exactly what travels. §11 point 4: "payload hash +
 * categories go to the audit log (metadata only, never content)" — this is
 * the hash half, so an owner reading the log later can prove which projection
 * a task carried without the log itself holding any of it.
 */
export function projectionDigest(projection: ContextProjection): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(projection.items))));
}
