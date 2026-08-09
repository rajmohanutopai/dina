/**
 * §16.5 — an update cannot silently widen (WS-4.5).
 *
 * THE SENTENCE THE SPEC WRITES IS THE WHOLE THREAT: "An update cannot silently
 * widen from catalog read to order submission." A supplier pack the owner
 * consented to as a price list ships version 1.1 that can also place orders.
 * Nothing in the manifest machinery objects — the new manifest is well-formed,
 * correctly signed, and content-addressed — and the owner's original consent,
 * given to a catalog reader, now covers a capability that commits money.
 *
 * SO THE COMPARISON IS THE CONSENT BOUNDARY, NOT A DIFF. Any change that
 * matters is a change to what the owner would have been agreeing to. That
 * makes the question one-directional: an update that NARROWS needs no fresh
 * consent, because nobody is surprised by a plugin doing less. Everything that
 * widens is refused until the owner is asked again.
 *
 * WHAT COUNTS AS WIDER, and why each one:
 *
 *   - A NEW capability. The clearest case, and the one §16.5 names.
 *   - A HIGHER action class. `read` → `payment` is the catalog-to-orders jump
 *     spelled out; the ladder below orders the vocabulary by what a mistake
 *     costs.
 *   - A HIGHER privacy class. A capability that read public catalog data now
 *     wants regulated data. Not about money, still not what was agreed.
 *   - A BIGGER data scope: more context items, or a category or persona the
 *     consented scope did not name.
 *   - WEAKENED idempotency. `supported` → `unsupported` means a retry may now
 *     double-charge, which changes the risk of a capability whose name and
 *     class did not move at all — the quietest widening of the five.
 *
 * PURE, AND SEPARATE FROM APPLYING THE UPDATE. It takes two manifests and
 * returns findings. The rebind coordinator decides what a refusal means; a
 * checker that also applied would be one nobody could run to ASK "would this
 * update need re-consent?" before pulling it, which is the question an owner
 * actually has.
 */

import { canonicalJson, scopeHashInput } from '@dina/protocol';

import type { PluginCapabilityDecl, PluginManifest } from '@dina/protocol';

/**
 * Action classes ordered by what a mistake costs, not alphabetically.
 *
 * `read` and `quote` observe. `write` changes the supplier's records.
 * `booking` and `payment` commit the owner to something a stranger can hold
 * them to. `agentic` sits highest because it is the open-ended one: a
 * capability that reasons chooses its own next step, so its ceiling is
 * whatever it can reach.
 */
const ACTION_RANK: Readonly<Record<string, number>> = {
  read: 0,
  quote: 1,
  write: 2,
  booking: 3,
  payment: 4,
  agentic: 5,
};

/** Privacy classes ordered by what leaking one costs. */
const PRIVACY_RANK: Readonly<Record<string, number>> = {
  public: 0,
  personal: 1,
  sensitive: 2,
  regulated: 3,
};

export type WideningKind =
  | 'new_capability'
  | 'action_class_raised'
  | 'privacy_class_raised'
  | 'context_items_raised'
  | 'category_added'
  | 'persona_added'
  | 'idempotency_weakened'
  /**
   * The CATCH-ALL, and the one that makes this list safe.
   *
   * The seven kinds above are the readable ones — an owner deciding whether to
   * re-consent needs a sentence, not a hash. But they cover seven dimensions
   * and the canonical consent projection covers twenty: interaction, kinds,
   * network domains, hosted endpoint, runtime issuer and artifacts, self-host
   * source, params and result schemas, config schema, intent phrases, host
   * operations, machine moves, ops used, verify budget, execution mode.
   *
   * An update could therefore add a network destination, swap the party that
   * receives the owner's data, or widen the brokered-operation allowlist, and
   * be classified as "no widening" — while the CONSENT HASH it is measured
   * against changed. That gap is the whole of §16.5.
   *
   * So the rule is inverted: anything that moves the consent projection and is
   * not already explained by a typed finding is a widening by default. Naming
   * the changed fields keeps the card honest without pretending to rank them.
   */
  | 'consent_scope_changed';

export interface WideningFinding {
  kind: WideningKind;
  capabilityId: string;
  /** The consented value, absent for a wholly new capability. */
  from?: string;
  /** What the update asks for. */
  to: string;
}

export interface WideningVerdict {
  /** True when the owner must be asked again before this update applies. */
  widens: boolean;
  findings: WideningFinding[];
}

interface ComparableCapability {
  id: string;
  actionClass: string;
  privacyClass: string;
  maxContextItems: number;
  categories: readonly string[];
  personas: readonly string[] | undefined;
  idempotency: string;
}

/**
 * An UNKNOWN class ranks at the CEILING, not the floor.
 *
 * A manifest naming an action class this build has never heard of is either
 * from a newer protocol or is lying, and both readings say the same thing: we
 * cannot tell what it costs. Ranking it lowest would let `action_class:
 * "totally_safe"` sail past every comparison — an unknown value becoming a
 * bypass is how allow-by-default rules fail. The manifest validator rejects
 * unknown classes on the way in, so this is the second line, not the first.
 */
function rank(table: Readonly<Record<string, number>>, value: string, ceiling: number): number {
  return table[value] ?? ceiling;
}

function comparable(capability: unknown): ComparableCapability {
  const cap = capability as {
    id?: unknown;
    action_class?: unknown;
    privacy_class?: unknown;
    effects?: { idempotency?: unknown };
    data_scope?: { max_context_items?: unknown; categories?: unknown; personas?: unknown };
  };
  const scope = cap.data_scope ?? {};
  return {
    id: typeof cap.id === 'string' ? cap.id : '',
    // Absent reads as the WIDEST, for the same reason unknown does: a
    // capability that declines to say what it does has not said it is safe.
    actionClass: typeof cap.action_class === 'string' ? cap.action_class : 'agentic',
    privacyClass: typeof cap.privacy_class === 'string' ? cap.privacy_class : 'regulated',
    maxContextItems: typeof scope.max_context_items === 'number' ? scope.max_context_items : 0,
    categories: Array.isArray(scope.categories) ? (scope.categories as string[]) : [],
    // Absent personas means "no persona restriction declared", which is WIDER
    // than any list. Undefined is carried through rather than flattened to []
    // so the two stay distinguishable — the same distinction the context
    // projector makes.
    personas: Array.isArray(scope.personas) ? (scope.personas as string[]) : undefined,
    idempotency:
      typeof cap.effects?.idempotency === 'string' ? cap.effects.idempotency : 'unsupported',
  };
}

function index(manifest: PluginManifest): Map<string, ComparableCapability> {
  const map = new Map<string, ComparableCapability>();
  for (const capability of manifest.capabilities ?? []) {
    const entry = comparable(capability);
    if (entry.id !== '') map.set(entry.id, entry);
  }
  return map;
}

/**
 * Would applying `proposed` over `consented` widen what the owner agreed to?
 *
 * Reports EVERY widening, not the first: an owner deciding whether to
 * re-consent needs the shape of the change, and a re-consent card that named
 * one escalation while three others rode along would be worse than none.
 */
export function detectUpdateWidening(
  consented: PluginManifest,
  proposed: PluginManifest,
): WideningVerdict {
  const before = index(consented);
  const findings: WideningFinding[] = [];

  for (const [id, after] of index(proposed)) {
    const prior = before.get(id);
    if (prior === undefined) {
      // §16.5's named case. A capability the owner never saw is not covered by
      // consent they gave to a different one, however similar.
      findings.push({ kind: 'new_capability', capabilityId: id, to: after.actionClass });
      continue;
    }

    const actionCeiling = ACTION_RANK.agentic;
    if (
      rank(ACTION_RANK, after.actionClass, actionCeiling) >
      rank(ACTION_RANK, prior.actionClass, actionCeiling)
    ) {
      findings.push({
        kind: 'action_class_raised',
        capabilityId: id,
        from: prior.actionClass,
        to: after.actionClass,
      });
    }

    const privacyCeiling = PRIVACY_RANK.regulated;
    if (
      rank(PRIVACY_RANK, after.privacyClass, privacyCeiling) >
      rank(PRIVACY_RANK, prior.privacyClass, privacyCeiling)
    ) {
      findings.push({
        kind: 'privacy_class_raised',
        capabilityId: id,
        from: prior.privacyClass,
        to: after.privacyClass,
      });
    }

    if (after.maxContextItems > prior.maxContextItems) {
      findings.push({
        kind: 'context_items_raised',
        capabilityId: id,
        from: String(prior.maxContextItems),
        to: String(after.maxContextItems),
      });
    }

    const knownCategories = new Set(prior.categories);
    for (const category of after.categories) {
      if (!knownCategories.has(category)) {
        findings.push({ kind: 'category_added', capabilityId: id, to: category });
      }
    }

    // Personas: absent means no restriction, which is wider than any list.
    // Going from a list to absent is therefore a widening, and adding a name
    // to an existing list is too. Absent → absent changes nothing.
    if (prior.personas !== undefined) {
      if (after.personas === undefined) {
        findings.push({ kind: 'persona_added', capabilityId: id, to: '*' });
      } else {
        const known = new Set(prior.personas);
        for (const persona of after.personas) {
          if (!known.has(persona)) {
            findings.push({ kind: 'persona_added', capabilityId: id, to: persona });
          }
        }
      }
    }

    // The quietest widening of the named ones: the name and the class do not
    // move, but a retry may now double-charge.
    if (prior.idempotency === 'supported' && after.idempotency !== 'supported') {
      findings.push({
        kind: 'idempotency_weakened',
        capabilityId: id,
        from: prior.idempotency,
        to: after.idempotency,
      });
    }

    // ANYTHING ELSE THE CONSENT PROJECTION SEES.
    //
    // Compared through `scopeHashInput` — the same projection the consent hash
    // is computed over — so this cannot drift from what the owner actually
    // agreed to. A field added to that projection is covered here the day it
    // lands, without anyone remembering to widen a list.
    const moved = changedConsentFields(consented, proposed, id);
    if (moved.length > 0) {
      findings.push({
        kind: 'consent_scope_changed',
        capabilityId: id,
        to: moved.join(', '),
      });
    }
  }

  return { widens: findings.length > 0, findings };
}

/**
 * Which consent-bearing fields differ for one capability.
 *
 * Reads BOTH manifests rather than the `ComparableCapability` projection,
 * because the point is to see the fields that projection leaves out.
 * Compared by canonical JSON so field order and equivalent spellings cannot
 * read as a change — the same canonicalization the hash itself uses.
 */
function changedConsentFields(
  consented: PluginManifest,
  proposed: PluginManifest,
  capabilityId: string,
): string[] {
  const find = (m: PluginManifest): PluginCapabilityDecl | undefined =>
    (m.capabilities ?? []).find((c) => c.id === capabilityId);
  const before = find(consented);
  const after = find(proposed);
  if (before === undefined || after === undefined) return [];

  const a = scopeHashInput(consented, before);
  const b = scopeHashInput(proposed, after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const moved: string[] = [];
  for (const key of [...keys].sort()) {
    // FIELDS THE TYPED RULES OWN ARE SKIPPED, and only those. Each of them has
    // a DIRECTION — a lower action class, a smaller context ceiling, a shorter
    // category list are all narrowings, and the comparisons above decide that
    // correctly in both directions. Reporting them here as well would turn
    // every narrowing into a re-consent prompt, which trains an owner to click
    // through the prompts that matter.
    //
    // Everything else has no direction this code can reason about — a new
    // network domain, a different runtime issuer, a changed result schema —
    // so a change IS a widening. That asymmetry is the point: known and
    // ranked, or unknown and refused.
    if (TYPED_CONSENT_FIELDS.has(key)) continue;
    if (SCHEMA_FIELDS.has(key)) {
      // RANKED, not excluded. See `SCHEMA_FIELDS`.
      if (schemaWidened(a[key], b[key])) moved.push(key);
      continue;
    }
    if (canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null)) moved.push(key);
  }
  return moved;
}

/**
 * The wire-shape fields, which get a RANKED rule rather than a blanket pass.
 *
 * These were excluded outright, on the reasoning that §9.13 makes MINOR
 * "strictly additive (new optional fields only)" and the drain mechanism
 * absorbs the ordinary minor release — so prompting on every schema tweak
 * would train an owner to tap through the prompts that matter.
 *
 * THAT WAS HALF RIGHT AND THE EXCLUSION WAS WRONG. Both schemas are inside
 * `scopeHashInput` (`protocol/src/plugins/digests.ts`), and the generic plugin
 * rule is that a changed per-capability scope hash requires re-consent.
 * Draining and consent are not substitutes: the drain governs tasks ALREADY
 * created against their pinned schemas, while consent governs what the install
 * may be asked to do NEXT. Excluding the field let an install adopt a new data
 * contract — new required inputs, a different result shape — under an approval
 * the owner gave for a different one.
 *
 * The distinction §9.13 actually draws is not "changed" versus "unchanged", it
 * is ADDITIVE versus not. So that is the rule: a strictly additive change is
 * the ordinary minor the drain exists for and passes silently; anything else
 * is a new contract and asks.
 */
const SCHEMA_FIELDS: ReadonlySet<string> = new Set(['params_schema', 'result_schema']);

/**
 * True unless `next` is a strictly additive superset of `prev`.
 *
 * FAILS CLOSED, matching the rest of this module: a shape this code cannot
 * prove additive is treated as a widening. "Known and ranked, or unknown and
 * refused" — a schema using constructs not modelled here (oneOf, $ref,
 * conditionals) is refused rather than guessed at, because the cost of a
 * needless prompt is an annoyed owner and the cost of a missed one is an
 * install acting under terms nobody approved.
 */
export function schemaWidened(prev: unknown, next: unknown): boolean {
  if (canonicalJson(prev ?? null) === canonicalJson(next ?? null)) return false;
  // Appearing from nothing, or vanishing, is not additive in any useful sense.
  if (!isPlainObject(prev) || !isPlainObject(next)) return true;

  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (key === 'properties' || key === 'required') continue;
    // `type`, `items`, `additionalProperties`, `enum`, anything else: an
    // unchanged value is fine and a changed one is a new contract.
    if (canonicalJson(prev[key] ?? null) !== canonicalJson(next[key] ?? null)) return true;
  }

  const prevRequired = readStringArray(prev.required);
  const nextRequired = readStringArray(next.required);
  // A NEW REQUIRED FIELD IS THE ONE THAT BITES: it makes every previously
  // valid call invalid, which is the opposite of additive. Dropping one is
  // also refused — it relaxes an input contract the owner approved.
  if (canonicalJson([...prevRequired].sort()) !== canonicalJson([...nextRequired].sort())) {
    return true;
  }

  const prevProps = isPlainObject(prev.properties) ? prev.properties : {};
  const nextProps = isPlainObject(next.properties) ? next.properties : {};
  for (const name of Object.keys(prevProps)) {
    // A property that changed shape, or disappeared, is not an addition.
    if (!(name in nextProps)) return true;
    if (schemaWidened(prevProps[name], nextProps[name])) return true;
  }
  // Everything left is a property `next` has and `prev` did not. Those are
  // additive exactly when they are OPTIONAL, which the required-set check
  // above has already established.
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Consent-projection keys whose direction the typed comparisons above decide.
 *
 * `data_scope` carries `max_context_items`, `categories` and `personas`, all
 * three of which have their own ranked rule; the others are one-to-one.
 */
const TYPED_CONSENT_FIELDS: ReadonlySet<string> = new Set([
  'action_class',
  'privacy_class',
  'data_scope',
  'effects_idempotency',
  // `params_schema` and `result_schema` used to sit here. They are ranked
  // instead now — see `SCHEMA_FIELDS`.
]);
