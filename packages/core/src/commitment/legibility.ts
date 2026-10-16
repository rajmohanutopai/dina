/**
 * Legibility on binding cards (COMMITMENT_KERNEL §9) — a kernel duty.
 *
 * Every card that binds a deal carries, from Core:
 *   - WHAT BINDS: every part, exactly, as signed. Core renders each part from
 *     its kernel kind, unit and direction ("₹1,600 a month, paid by you to the
 *     brand"); the pack's own label for it appears beside it in quotes, marked
 *     as the pack's words, so a pack cannot pass off share of sales as "a
 *     small admin fee";
 *   - WHAT IT IS WORTH TO YOU, when the model has values (for the owner's own
 *     copy only; Brain's copy leaves it out, §11);
 *   - WHERE THE RISK IS: promises the other side must keep, promises the
 *     owner makes, and how the deal ends;
 *   - WHAT CHANGED since the version the owner last saw.
 *
 * An agent may add an explanation, in its own block, marked as the agent's
 * words; it may carry no part's value (§9). Core can test that every bound
 * part is in its list and that the agent's block holds no part value; it
 * cannot test whether the agent's words are true, and the card says so.
 *
 * PURE: no I/O, no clock.
 */

import type { NumberPartSpec, PartyRole } from './parts';
import type { DealPart, DealVersion, ModelVocabulary } from './value_model';

/** A pack's own words for a part: shown in quotes, never as Core's. */
export type PackLabels = Readonly<Record<string, string>>;

export interface BindsLine {
  part: string;
  /** Core's rendering, from the part's kind, unit and direction. */
  core: string;
  /** The pack's label, quoted and marked as the pack's. */
  pack?: string;
}

export interface BindingCard {
  binds: BindsLine[];
  /** Rupees a month, when the model has values (owner's copy only). */
  worth?: string;
  risks: string[];
  changed: string[];
  /** Always present: Core cannot vouch for anything an agent wrote. */
  agentNotice: string;
  agentNote?: string;
}

const AGENT_NOTICE =
  'Anything below marked as the agent’s words is its explanation; Core checks the list above, not those words.';

function rupees(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const paise = abs % 100n;
  const text =
    paise === 0n
      ? `₹${whole.toString(10)}`
      : `₹${whole.toString(10)}.${paise.toString(10).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

function bps(value: bigint): string {
  const whole = value / 100n;
  const rest = value % 100n;
  return rest === 0n
    ? `${whole.toString(10)}%`
    : `${whole.toString(10)}.${rest.toString(10).padStart(2, '0')}%`;
}

function partyWord(role: PartyRole, holder: PartyRole, other: string): string {
  return role === holder ? 'you' : other;
}

function renderNumber(
  spec: NumberPartSpec,
  part: Extract<DealPart, { kind: 'number' }>,
  holder: PartyRole,
  other: string,
): string {
  const payer = partyWord(spec.payer, holder, other);
  const payee = partyWord(spec.payee, holder, other);
  if (spec.kind === 'ratio_bps') return `${bps(part.value)} of sales, paid by ${payer} to ${payee}`;
  const amount =
    part.currency === 'INR' || part.currency === undefined
      ? rupees(part.value)
      : `${part.currency} ${(Number(part.value) / 100).toFixed(2)}`;
  const per = part.per === 'week' ? ' a week' : part.per === 'once' ? ' once' : ' a month';
  return `${amount}${per}, paid by ${payer} to ${payee}`;
}

function renderDimensions(dimensions: Readonly<Record<string, string | bigint>>): string {
  return Object.keys(dimensions)
    .sort()
    .map((k) => `${k}: ${String(dimensions[k])}`)
    .join(', ');
}

/** Core's line for one part. */
export function renderPart(
  vocabulary: ModelVocabulary,
  part: DealPart,
  holder: PartyRole,
  other: string,
  promiser?: PartyRole,
): string {
  switch (part.kind) {
    case 'number': {
      const spec = vocabulary.numbers.find((s) => s.name === part.name);
      return spec === undefined
        ? `${part.name}: ${part.value.toString(10)} (a part Core does not know)`
        : renderNumber(spec, part, holder, other);
    }
    case 'choice':
      return `${part.name}: ${part.option}`;
    case 'flag':
      return `${part.name}: ${part.set ? 'yes' : 'no'}`;
    case 'promise': {
      const who = promiser === undefined ? 'a party' : partyWord(promiser, holder, other);
      return `a promise ${who} must keep: ${part.name} (${renderDimensions(part.dimensions)})`;
    }
    case 'price_to_non_party':
      return `${part.name}: a price for someone outside the deal (never allowed)`;
  }
}

/**
 * The binding card's Core-made sections for one version. `promisers` names
 * who keeps each promise part; `previous` is the version the owner last saw.
 */
export function bindingCard(args: {
  vocabulary: ModelVocabulary;
  labels: PackLabels;
  holder: PartyRole;
  /** How the card names the other side ("the brand", "the store"). */
  other: string;
  version: DealVersion;
  promisers?: Readonly<Record<string, PartyRole>>;
  previous?: DealVersion;
  /** Rupees a month; only on the owner's own copy. */
  worth?: bigint;
  /** The model's walk-away point, rupees a month; owner's copy only. */
  walkAway?: bigint;
  /** A part has no value in the model: its worth is not known (§7). */
  worthUnknown?: true;
  /** How the deal ends, in Core's words (exit notice, its end date). */
  ending?: string;
  agentNote?: string;
}): BindingCard {
  const promisers = args.promisers ?? {};
  const line = (part: DealPart): string =>
    renderPart(args.vocabulary, part, args.holder, args.other, promisers[part.name]);
  const binds = args.version.parts.map((part): BindsLine => {
    const label = args.labels[part.name];
    return {
      part: part.name,
      core: line(part),
      ...(label !== undefined ? { pack: `“${label}” (the pack’s words)` } : {}),
    };
  });
  const risks: string[] = [];
  for (const part of args.version.parts) {
    if (part.kind !== 'promise') continue;
    const who = promisers[part.name];
    risks.push(
      who === args.holder
        ? `You promise: ${part.name} (${renderDimensions(part.dimensions)}).`
        : `${args.other} promises: ${part.name} (${renderDimensions(part.dimensions)}); it is theirs to keep.`,
    );
  }
  if (args.ending !== undefined) risks.push(args.ending);
  const changed: string[] = [];
  if (args.previous !== undefined) {
    const before = new Map(args.previous.parts.map((p) => [p.name, line(p)]));
    const after = new Map(args.version.parts.map((p) => [p.name, line(p)]));
    for (const [name, text] of after) {
      const was = before.get(name);
      if (was === undefined) changed.push(`added: ${text}`);
      else if (was !== text) changed.push(`${name}: was ${was}; now ${text}`);
    }
    for (const [name, text] of before) if (!after.has(name)) changed.push(`removed: ${text}`);
  }
  const card: BindingCard = { binds, risks, changed, agentNotice: AGENT_NOTICE };
  if (args.worthUnknown === true)
    card.worth = 'worth not known: part of this deal has no value in your model';
  else if (args.worth !== undefined)
    card.worth =
      `worth ${rupees(args.worth * 100n)} a month to you` +
      (args.walkAway !== undefined ? `; you walk away below ${rupees(args.walkAway * 100n)}` : '');
  if (args.agentNote !== undefined) card.agentNote = args.agentNote;
  return card;
}

/** Does Core's list name every part of the version, once? */
export function bindsEveryPart(card: BindingCard, version: DealVersion): boolean {
  const named = card.binds.map((b) => b.part);
  return (
    named.length === version.parts.length &&
    version.parts.every((p) => named.filter((n) => n === p.name).length === 1)
  );
}

/**
 * An agent's note may carry no part's value: no amount, no figure that
 * appears in a part, in any common spelling. Null when clean, else why not.
 */
export function agentNoteProblem(note: string, version: DealVersion): string | null {
  if (note.length > 1000) return 'the agent’s note is too long';
  const digits = note.replace(/[,\s]/g, '');
  for (const part of version.parts) {
    if (part.kind !== 'number') continue;
    const minor = part.value < 0n ? -part.value : part.value;
    const forms = [minor.toString(10)];
    if (part.currency !== undefined) {
      forms.push((minor / 100n).toString(10));
    }
    for (const form of forms) {
      if (form.length >= 2 && digits.includes(form))
        return `the agent’s note names a value of ${part.name}`;
    }
  }
  for (const part of version.parts) {
    if (part.kind !== 'number' || part.currency !== undefined) continue;
    // A ratio as people read it: 600 bps is "6%", "6 percent", "6.00%".
    const whole = (part.value / 100n).toString(10);
    const rest = (part.value % 100n).toString(10).padStart(2, '0');
    const forms =
      rest === '00'
        ? [whole, `${whole}.00`]
        : [`${whole}.${rest}`, `${whole}.${rest.replace(/0$/, '')}`];
    for (const form of forms)
      if (
        new RegExp(`(^|[^0-9.])${form.replace('.', '\\.')}\\s*(%|percent|per cent)`, 'i').test(note)
      )
        return `the agent’s note names a value of ${part.name}`;
  }
  if (/₹|rs\.?\s*\d|inr\s*\d/i.test(note)) return 'the agent’s note names an amount';
  return null;
}
