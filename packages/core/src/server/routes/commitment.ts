/**
 * The owner's value model (COMMITMENT_KERNEL §7) — Core's own form, owner only.
 *
 *   GET    /v1/commitment/models/:kind            the form, the model version and the entries
 *   PUT    /v1/commitment/models/:kind/form       the form: walk-away point, auto-sign worth,
 *                                                 per-part limits, totals, asking terms, binding
 *   PUT    /v1/commitment/models/:kind/entries    one value or never-rule
 *   DELETE /v1/commitment/models/:kind/entries/:id
 *
 * The form needs the owner present, as the shelf floors do
 * (SHELF_SPACE_NEGOTIATION §7.4); Brain is refused every route here (the
 * authz table admits the owner only). Entries tagged with a persona need it
 * open: they are written into its own vault file.
 *
 * Figures are canonical integer strings: rupees a month for the walk-away
 * point, the auto-sign worth, totals and values; a part's own units (minor
 * units, basis points) for its limits and asking terms.
 */

import { dealKind, type DealKind, type FormField } from '../../commerce/deal_kinds';
import { ownerPresenceRefusal } from '../../commerce/owner_presence';
import { atLeastFor, MAX_RATIO_BPS, type NeverCondition } from '../../commitment';
import {
  getValueModelStore,
  type EntryBody,
  type ModelForm,
  type ValueEntry,
} from '../../commitment/model_store';
import { getStrategyStore } from '../../commitment/strategy_store';

import { makeOwnerGuard } from './owner_guard';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

const INT = /^(0|-?[1-9]\d{0,17})$/;
const NON_NEGATIVE = /^(0|[1-9]\d{0,17})$/;
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function bad<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function num(v: unknown, what: string, re = NON_NEGATIVE): Parsed<bigint> {
  return typeof v === 'string' && re.test(v)
    ? { ok: true, value: BigInt(v) }
    : bad(`${what}: an integer string`);
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Validate the form against the kind's vocabulary. */
export function parseForm(kind: DealKind, raw: unknown): Parsed<ModelForm> {
  const body = record(raw);
  if (body === null) return bad('form: an object');
  const form: ModelForm = { limits: {}, totals: {}, asking: {}, binding: 'card' };
  // A field the kind's engine does not apply is refused, never kept unused.
  const sent: [string, boolean][] = [
    ['walk_away', body.walk_away !== undefined],
    ['auto_sign', body.auto_sign !== undefined],
    ['limits', Object.keys(record(body.limits) ?? {}).length > 0],
    ['totals', Object.keys(record(body.totals) ?? {}).length > 0],
    ['asking', Object.keys(record(body.asking) ?? {}).length > 0],
    ['firm', body.binding === 'firm'],
  ];
  for (const [field, present] of sent) {
    if (present && !kind.honours.has(field as FormField))
      return bad(`${field}: not applied to ${kind.id} deals yet`);
  }
  if (body.binding !== 'firm' && body.binding !== 'card') return bad("binding: 'firm' | 'card'");
  form.binding = body.binding;
  for (const [key, field] of [
    ['walk_away', 'walkAway'],
    ['auto_sign', 'autoSign'],
  ] as const) {
    if (body[key] === undefined) continue;
    const n = num(body[key], key, INT);
    if (!n.ok) return n;
    form[field] = n.value;
  }
  if (form.autoSign !== undefined && form.walkAway === undefined)
    return bad('auto_sign: needs a walk_away point');
  if (form.autoSign !== undefined && form.walkAway !== undefined && form.autoSign < form.walkAway)
    return bad('auto_sign: at or above the walk_away point');
  const limits = record(body.limits ?? {});
  if (limits === null) return bad('limits: an object');
  for (const [name, value] of Object.entries(limits)) {
    const spec = kind.vocabulary.numbers.find((s) => s.name === name);
    if (spec === undefined) return bad(`limits.${name}: not a part of this kind`);
    const pair = record(value);
    if (pair === null) return bad(`limits.${name}: { hard, auto }`);
    const hard = num(pair.hard, `limits.${name}.hard`);
    const auto = num(pair.auto ?? pair.hard, `limits.${name}.auto`);
    if (!hard.ok) return hard;
    if (!auto.ok) return auto;
    if (spec.kind === 'ratio_bps' && (hard.value > MAX_RATIO_BPS || auto.value > MAX_RATIO_BPS))
      return bad(`limits.${name}: at most 10000 basis points`);
    if (!atLeastFor(spec, kind.holder, auto.value, hard.value))
      return bad(`limits.${name}: the automatic limit is no worse for you than the hard one`);
    form.limits[name] = { hard: hard.value, auto: auto.value };
  }
  const totals = record(body.totals ?? {});
  if (totals === null) return bad('totals: an object');
  for (const [key, field] of [
    ['overall', 'overall'],
    ['per_counterparty', 'perCounterparty'],
  ] as const) {
    if (totals[key] === undefined) continue;
    const n = num(totals[key], `totals.${key}`);
    if (!n.ok) return n;
    form.totals[field] = n.value;
  }
  const asking = record(body.asking ?? {});
  if (asking === null) return bad('asking: an object');
  for (const [name, value] of Object.entries(asking)) {
    if (kind.vocabulary.numbers.every((s) => s.name !== name))
      return bad(`asking.${name}: not a part of this kind`);
    const n = num(value, `asking.${name}`);
    if (!n.ok) return n;
    form.asking[name] = n.value.toString(10);
  }
  return { ok: true, value: form };
}

function parseConditions(kind: DealKind, raw: unknown): Parsed<NeverCondition[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8)
    return bad('all: 1 to 8 conditions');
  const out: NeverCondition[] = [];
  for (const [i, item] of raw.entries()) {
    const c = record(item);
    const part = c?.part;
    if (c === null || typeof part !== 'string') return bad(`all[${String(i)}].part`);
    const known =
      kind.vocabulary.numbers.some((s) => s.name === part) ||
      part in kind.vocabulary.choices ||
      kind.vocabulary.flags.includes(part) ||
      part in kind.vocabulary.promises;
    if (!known) return bad(`all[${String(i)}].part: not a part of this kind`);
    // Each test only on the kind of part it means, and a choice only among
    // the part's own options: a rule that could never match is refused, not
    // stored to sit silent (a figure on a number, a flag on a flag, an option
    // of a choice; presence on any part).
    const isNumber = kind.vocabulary.numbers.some((s) => s.name === part);
    const options = kind.vocabulary.choices[part];
    const isFlag = kind.vocabulary.flags.includes(part);
    const at = `all[${String(i)}]`;
    if (c.present === true) out.push({ part, present: true });
    else if (typeof c.flag === 'boolean') {
      if (!isFlag) return bad(`${at}.flag: ${part} is not a flag`);
      out.push({ part, flag: c.flag });
    } else if (typeof c.choice === 'string') {
      if (options === undefined) return bad(`${at}.choice: ${part} is not a choice`);
      if (!options.includes(c.choice)) return bad(`${at}.choice: one of ${options.join(', ')}`);
      out.push({ part, choice: c.choice });
    } else if (c.below !== undefined || c.above !== undefined) {
      if (!isNumber) return bad(`${at}: below and above apply to a number part`);
      const n = num(c.below ?? c.above, `all[${String(i)}]`, INT);
      if (!n.ok) return n;
      out.push(c.below !== undefined ? { part, below: n.value } : { part, above: n.value });
    } else return bad(`all[${String(i)}]: present | flag | choice | below | above`);
  }
  return { ok: true, value: out };
}

/** Validate one entry against the kind's vocabulary; `covers` is derived, never sent. */
export function parseEntry(kind: DealKind, raw: unknown): Parsed<Omit<ValueEntry, 'kind'>> {
  const e = record(raw);
  if (e === null) return bad('entry: an object');
  if (typeof e.id !== 'string' || !ID.test(e.id))
    return bad('id: lowercase letters, digits, _ . -');
  if (e.persona !== undefined && (typeof e.persona !== 'string' || !ID.test(e.persona)))
    return bad('persona: a persona name');
  const b = record(e.body);
  if (b === null) return bad('body: an object');
  if (
    (b.type === 'choice' || b.type === 'flag' || b.type === 'promise') &&
    !kind.honours.has('values')
  )
    return bad(`body.type: values are not applied to ${kind.id} deals yet`);
  if (b.type === 'capacity' && !kind.honours.has('capacity'))
    return bad(`body.type: capacity is not applied to ${kind.id} deals`);
  let body: EntryBody;
  let covers: string[];
  if (b.type === 'choice') {
    const part = String(b.part);
    if (!(kind.vocabulary.choices[part] ?? []).includes(String(b.option)))
      return bad('body: an allowed option of a choice part');
    // The share of a saving the seller passes on is one setting, not a
    // weighed choice: one entry under a fixed id, held by no persona, so a
    // newer choice replaces the older and the card the owner confirms is the
    // share that applies (goods_seller_alternatives.ts, chosenShare).
    if (part === 'saving_share' && (e.id !== 'saving_share' || e.persona !== undefined))
      return bad('saving_share: one entry, id "saving_share", held by no persona');
    const r = num(b.rupees, 'rupees', INT);
    if (!r.ok) return r;
    body = { type: 'choice', part, option: String(b.option), rupees: r.value };
    covers = [part];
  } else if (b.type === 'flag') {
    const part = String(b.part);
    if (!kind.vocabulary.flags.includes(part)) return bad('body.part: a flag of this kind');
    const set = num(b.set, 'set', INT);
    const unset = num(b.unset, 'unset', INT);
    if (!set.ok) return set;
    if (!unset.ok) return unset;
    body = { type: 'flag', part, set: set.value, unset: unset.value };
    covers = [part];
  } else if (b.type === 'never') {
    if (typeof b.label !== 'string' || b.label.length === 0 || b.label.length > 200)
      return bad('label: the owner’s words, up to 200 characters');
    const all = parseConditions(kind, b.all);
    if (!all.ok) return all;
    body = { type: 'never', label: b.label, all: all.value };
    covers = [...new Set(all.value.map((c) => c.part))];
  } else if (b.type === 'promise') {
    // What a kind of promise is worth to the owner: every dimension the
    // vocabulary declares, counted ones as whole numbers (§7).
    const part = String(b.part);
    const orders = kind.vocabulary.promises[part];
    const dims = record(b.dimensions);
    if (orders === undefined || dims === null)
      return bad('body: a promise of this kind and its dimensions');
    const declared = Object.keys(orders);
    if (Object.keys(dims).length !== declared.length || declared.some((d) => !(d in dims)))
      return bad(`body.dimensions: exactly ${declared.join(', ')}`);
    const dimensions: Record<string, string | bigint> = {};
    for (const d of declared) {
      const v = dims[d];
      if (typeof v !== 'string' || !/^[a-z0-9_.-]{1,64}$/.test(v))
        return bad(`body.dimensions.${d}: a word`);
      if (orders[d] !== 'exact') {
        if (!/^[1-9]\d{0,5}$/.test(v)) return bad(`body.dimensions.${d}: a whole number`);
        dimensions[d] = BigInt(v);
      } else {
        const words = kind.promiseWords[part]?.[d];
        if (words !== undefined && !words.includes(v))
          return bad(`body.dimensions.${d}: ${words.join(' | ')}`);
        dimensions[d] = v;
      }
    }
    const rupees = num(b.rupees, 'rupees', INT);
    if (!rupees.ok) return rupees;
    body = { type: 'promise', part, value: { dimensions, rupees: rupees.value } };
    covers = [part];
  } else if (b.type === 'capacity') {
    const part = String(b.part);
    const dimension = String(b.dimension);
    const order = kind.vocabulary.promises[part]?.[dimension];
    if (order === undefined || order === 'exact')
      return bad('body: a promise of this kind and one of its counted dimensions');
    const amount = num(b.amount, 'amount');
    if (!amount.ok) return amount;
    body = { type: 'capacity', part, dimension, amount: amount.value };
    covers = [part];
  } else {
    return bad("body.type: 'choice' | 'flag' | 'promise' | 'never' | 'capacity'");
  }
  return {
    ok: true,
    value: {
      id: e.id,
      ...(typeof e.persona === 'string' ? { persona: e.persona } : {}),
      covers,
      body,
    },
  };
}

const str = (n: bigint | undefined): string | undefined =>
  n === undefined ? undefined : n.toString(10);

function formView(form: ModelForm): Record<string, unknown> {
  return {
    ...(form.walkAway !== undefined ? { walk_away: str(form.walkAway) } : {}),
    ...(form.autoSign !== undefined ? { auto_sign: str(form.autoSign) } : {}),
    limits: Object.fromEntries(
      Object.entries(form.limits).map(([k, v]) => [k, { hard: str(v.hard), auto: str(v.auto) }]),
    ),
    totals: {
      ...(form.totals.overall !== undefined ? { overall: str(form.totals.overall) } : {}),
      ...(form.totals.perCounterparty !== undefined
        ? { per_counterparty: str(form.totals.perCounterparty) }
        : {}),
    },
    asking: form.asking,
    binding: form.binding,
  };
}

/**
 * What turning Brain on shows the owner, in plain words (COMMITMENT_KERNEL §11):
 * which numbers Brain, and its cloud provider, will then see, and which never.
 */
export function strategyDisclosure(valuesOn: boolean): string {
  return valuesOn
    ? 'Brain, and the AI provider you chose, will see the deal so far and what parts are worth to you. They never see your walk-away point, your limits or your totals.'
    : 'Brain, and the AI provider you chose, will see the deal so far, but not what parts are worth to you. They never see your walk-away point, your limits or your totals.';
}

export function registerCommitmentRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may read or change the value model',
  );
  const present = (req: CoreRequest, detail: string): CoreResponse | null =>
    ownerOnlyGuard(req) ?? ownerPresenceRefusal(req, Date.now(), detail);
  const kindOf = (req: CoreRequest): DealKind | null => dealKind(req.params?.kind ?? '');
  const UNKNOWN: CoreResponse = { status: 404, body: { error: 'unknown_kind' } };
  const NO_STORE: CoreResponse = { status: 503, body: { error: 'model_store_unavailable' } };

  router.get('/v1/commitment/models/:kind', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const store = await getValueModelStore();
    if (store === null) return NO_STORE;
    const { version, form } = store.form(kind.id);
    const { model, closedPersonas } = store.load(kind.id, []);
    return {
      status: 200,
      body: {
        kind: kind.id,
        version,
        form: formView(form),
        never: model.never.map((r) => r.label),
        closed_personas: closedPersonas,
      },
    };
  });

  router.get('/v1/commitment/strategy/:kind', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const store = await getStrategyStore();
    if (store === null) return NO_STORE;
    const settings = store.settings(kind.id);
    return {
      status: 200,
      body: {
        kind: kind.id,
        strategy: settings.strategy,
        values_on: settings.valuesOn,
        disclosure: strategyDisclosure(settings.valuesOn),
      },
    };
  });

  // Who fills the strategy slot, and whether Brain's brief carries values.
  // Turning Brain on needs the owner present (§11: a card that says plainly
  // which numbers Brain, and its cloud provider, will then see).
  router.put('/v1/commitment/strategy/:kind', async (req): Promise<CoreResponse> => {
    const denied = present(req, 'choosing who bargains for you needs a person present');
    if (denied !== null) return denied;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.strategy !== 'fixed' && body.strategy !== 'brain')
      return {
        status: 400,
        body: { error: 'invalid_strategy', detail: "strategy: 'fixed' | 'brain'" },
      };
    if (body.values_on !== undefined && typeof body.values_on !== 'boolean')
      return { status: 400, body: { error: 'invalid_strategy', detail: 'values_on: a boolean' } };
    const store = await getStrategyStore();
    if (store === null) return NO_STORE;
    const valuesOn = body.values_on ?? true;
    store.setSettings(kind.id, { strategy: body.strategy, valuesOn }, Date.now());
    return { status: 200, body: { ok: true, disclosure: strategyDisclosure(valuesOn) } };
  });

  router.put('/v1/commitment/models/:kind/form', async (req): Promise<CoreResponse> => {
    const denied = present(
      req,
      'changing the walk-away point, limits or totals needs a person present',
    );
    if (denied !== null) return denied;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const parsed = parseForm(kind, (req.body as Record<string, unknown> | null)?.form);
    if (!parsed.ok) return { status: 400, body: { error: 'invalid_form', detail: parsed.error } };
    const store = await getValueModelStore();
    if (store === null) return NO_STORE;
    const version = store.setForm(kind.id, parsed.value, Date.now());
    return { status: 200, body: { ok: true, version } };
  });

  router.put('/v1/commitment/models/:kind/entries', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const parsed = parseEntry(kind, (req.body as Record<string, unknown> | null)?.entry);
    if (!parsed.ok) return { status: 400, body: { error: 'invalid_entry', detail: parsed.error } };
    const store = await getValueModelStore();
    if (store === null) return NO_STORE;
    const put = store.putEntry({ ...parsed.value, kind: kind.id }, Date.now());
    if (!put.ok) return { status: 409, body: { error: 'persona_closed' } };
    return { status: 200, body: { ok: true, version: put.version } };
  });

  router.delete('/v1/commitment/models/:kind/entries/:id', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const id = req.params?.id ?? '';
    const store = await getValueModelStore();
    if (store === null) return NO_STORE;
    const removed = store.removeEntry({ kind: kind.id, id }, Date.now());
    if (!removed.ok) return { status: 409, body: { error: 'persona_closed' } };
    return { status: 200, body: { ok: true, version: removed.version } };
  });
}
