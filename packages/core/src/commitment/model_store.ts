/**
 * Where the owner's value model is kept (COMMITMENT_KERNEL §7).
 *
 *   - THE CORE FORM, per deal kind, in the identity store: the walk-away
 *     point, the auto-sign worth, per-part limits, totals, asking terms and
 *     whether a yes binds (firm) or raises a final card. Entered only by the
 *     owner, present; Brain never reads it.
 *   - ENTRIES (values for choices, flags and promises; never-rules). One
 *     tagged with a persona is stored in that persona's own vault file, so it
 *     is sealed while the persona is locked and read only while it is open.
 *     Untagged entries live in the identity store.
 *   - THE INDEX, in the identity store: for each persona, which parts and data
 *     categories its entries cover — never a value, limit or rule — so a deal
 *     touching a closed persona's entries can go to the owner's card.
 *
 * Every change bumps the kind's model version, which each deal records.
 */

import { getPersonaTier, isPersonaOpen } from '../persona/service';
import { getIdentityDB } from '../storage/db_provider';

import type { PartBounds } from './limits';
import type { NeverCondition, PromiseValue, ValueModel } from './value_model';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** Whether a yes binds by itself, or raises a final card (§8, "Signing and binding"). */
export type BindingRule = 'firm' | 'card';

/** The Core form for one deal kind. Every figure is the owner's own entry. */
export interface ModelForm {
  walkAway?: bigint;
  autoSign?: bigint;
  limits: Record<string, PartBounds>;
  totals: { overall?: bigint; perCounterparty?: bigint };
  /** Private starting point per part (term deals), as canonical integer strings. */
  asking: Record<string, string>;
  binding: BindingRule;
}

export type EntryBody =
  | { type: 'choice'; part: string; option: string; rupees: bigint }
  | { type: 'flag'; part: string; set: bigint; unset: bigint }
  | { type: 'promise'; part: string; value: PromiseValue }
  | { type: 'never'; label: string; all: NeverCondition[] }
  /** What the owner can promise in all, across live deals (§8 step 9). */
  | { type: 'capacity'; part: string; dimension: string; amount: bigint };

export interface ValueEntry {
  id: string;
  kind: string;
  /** The persona it draws on; absent for entries no persona holds. */
  persona?: string;
  /** Parts and data categories (`category:<name>`) it covers, for the index. */
  covers: string[];
  body: EntryBody;
}

export const EMPTY_FORM: ModelForm = { limits: {}, totals: {}, asking: {}, binding: 'card' };

// ---------------------------------------------------------------------------
// JSON with bigints: every bigint is written as {"$n":"<digits>"}.
// ---------------------------------------------------------------------------

/** JSON for entries, with bigints kept exact. */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? { $n: v.toString(10) } : v,
  );
}

export function decode<T>(json: string): T {
  return JSON.parse(json, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && '$n' in v) {
      const n = (v as { $n: unknown }).$n;
      if (typeof n === 'string' && /^-?\d+$/.test(n)) return BigInt(n);
    }
    return v;
  }) as T;
}

// ---------------------------------------------------------------------------
// Persona stores, registered as each persona's vault file opens.
// ---------------------------------------------------------------------------

const personaDBs = new Map<string, DatabaseAdapter>();

/** Wire (or clear) a persona's own database; called where its vault opens. */
export function setCommitmentPersonaDB(persona: string, db: DatabaseAdapter | null): void {
  if (db === null) personaDBs.delete(persona);
  else personaDBs.set(persona, db);
}

export interface PersonaAccess {
  /** The persona's own database, if its vault file is open in this process. */
  db: (persona: string) => DatabaseAdapter | null;
  /** Is the persona open now (sensitive confirmed, locked unlocked)? */
  isOpen: (persona: string) => boolean;
  /**
   * May Brain read this persona's entries now (the 4-tier gatekeeper)? A
   * default or standard persona that is open; never a sensitive one without
   * the owner's approval, never a locked one. Absent: Brain reads none.
   */
  brainMayRead?: (persona: string) => boolean;
}

export const DEFAULT_PERSONA_ACCESS: PersonaAccess = {
  db: (persona) => personaDBs.get(persona) ?? null,
  isOpen: (persona) => isPersonaOpen(persona),
  brainMayRead: (persona) => {
    try {
      const tier = getPersonaTier(persona);
      return (tier === 'default' || tier === 'standard') && isPersonaOpen(persona);
    } catch {
      return false;
    }
  },
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export class ValueModelStore {
  constructor(
    private readonly identity: DatabaseAdapter,
    private readonly personas: PersonaAccess = DEFAULT_PERSONA_ACCESS,
  ) {}

  /** The kind's form and model version; the empty form at version 0 if none was set. */
  form(kind: string): { version: number; form: ModelForm } {
    const row = this.identity.query(`SELECT * FROM commitment_model_forms WHERE kind = ?`, [
      kind,
    ])[0];
    if (row === undefined) return { version: 0, form: EMPTY_FORM };
    return { version: Number(row.version), form: decode<ModelForm>(str(row.form_json)) };
  }

  /** Replace the kind's form; returns the new model version. */
  setForm(kind: string, form: ModelForm, nowMs: number): number {
    const version = this.form(kind).version + 1;
    this.identity.execute(
      `INSERT OR REPLACE INTO commitment_model_forms (kind, version, form_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      [kind, version, encode(form), nowMs],
    );
    return version;
  }

  private bump(kind: string, nowMs: number): number {
    const { form } = this.form(kind);
    return this.setForm(kind, form, nowMs);
  }

  /**
   * Every place an entry (kind, id) is kept now: the identity store, and each
   * persona the index names for it. More than one only after a crash during
   * a move; every copy is the owner's rule, so none is ignored.
   */
  private holdersOf(kind: string, id: string): (string | undefined)[] {
    const out: (string | undefined)[] = this.identity
      .query(
        `SELECT DISTINCT persona FROM commitment_value_index WHERE kind = ? AND entry_id = ?`,
        [kind, id],
      )
      .map((r) => str(r.persona));
    const plain = this.identity.query(
      `SELECT 1 FROM commitment_value_entries WHERE kind = ? AND entry_id = ?`,
      [kind, id],
    )[0];
    if (plain !== undefined) out.push(undefined);
    return out;
  }

  /**
   * Keep an entry, replacing any earlier one with the same (kind, id). The
   * new copy is written first — its index rows, then the entry — and only
   * then are copies kept elsewhere removed: a crash at any point leaves at
   * least one copy of the rule, and every copy the index knows. One tagged
   * with a persona needs that persona open, and so does every persona an old
   * copy sits in. Returns the new model version.
   */
  putEntry(
    entry: ValueEntry,
    nowMs: number,
  ): { ok: true; version: number } | { ok: false; refusal: 'persona_closed' } {
    const db = this.dbFor(entry.persona);
    const old = this.holdersOf(entry.kind, entry.id);
    if (db === null || old.some((p) => this.dbFor(p) === null))
      return { ok: false, refusal: 'persona_closed' };
    if (entry.persona !== undefined) {
      for (const covers of new Set(entry.covers)) {
        this.identity.execute(
          `INSERT OR REPLACE INTO commitment_value_index (persona, kind, entry_id, covers) VALUES (?, ?, ?, ?)`,
          [entry.persona, entry.kind, entry.id, covers],
        );
      }
    }
    db.execute(
      `INSERT OR REPLACE INTO commitment_value_entries (kind, entry_id, entry_json, created_at)
       VALUES (?, ?, ?, ?)`,
      [entry.kind, entry.id, encode(entry), nowMs],
    );
    // Index rows the new copy no longer covers.
    if (entry.persona !== undefined) {
      const keep = new Set(entry.covers);
      for (const row of this.identity.query(
        `SELECT covers FROM commitment_value_index WHERE persona = ? AND kind = ? AND entry_id = ?`,
        [entry.persona, entry.kind, entry.id],
      )) {
        if (!keep.has(str(row.covers)))
          this.identity.execute(
            `DELETE FROM commitment_value_index WHERE persona = ? AND kind = ? AND entry_id = ? AND covers = ?`,
            [entry.persona, entry.kind, entry.id, str(row.covers)],
          );
      }
    }
    // Old copies elsewhere: every copy goes before any of their index rows,
    // so a crash part-way leaves each surviving copy still marked protected.
    const stale = old.filter((p) => p !== entry.persona);
    for (const persona of stale)
      this.dbFor(persona)?.execute(
        `DELETE FROM commitment_value_entries WHERE kind = ? AND entry_id = ?`,
        [entry.kind, entry.id],
      );
    for (const persona of stale)
      if (persona !== undefined)
        this.identity.execute(
          `DELETE FROM commitment_value_index WHERE persona = ? AND kind = ? AND entry_id = ?`,
          [persona, entry.kind, entry.id],
        );
    return { ok: true, version: this.bump(entry.kind, nowMs) };
  }

  /** Drop an entry wherever it is kept; a copy kept in a persona needs the persona open. */
  removeEntry(
    args: { kind: string; id: string },
    nowMs: number,
  ): { ok: true; version: number } | { ok: false; refusal: 'persona_closed' } {
    const old = this.holdersOf(args.kind, args.id);
    if (old.some((p) => this.dbFor(p) === null)) return { ok: false, refusal: 'persona_closed' };
    // Every copy goes before any index row: while a copy is left, the index
    // still says which persona it was filed under, so a crash part-way never
    // hands Brain a copy that lost its protection.
    for (const persona of old)
      this.dbFor(persona)?.execute(
        `DELETE FROM commitment_value_entries WHERE kind = ? AND entry_id = ?`,
        [args.kind, args.id],
      );
    this.identity.execute(`DELETE FROM commitment_value_index WHERE kind = ? AND entry_id = ?`, [
      args.kind,
      args.id,
    ]);
    return { ok: true, version: this.bump(args.kind, nowMs) };
  }

  /**
   * The model for a kind, from the form, the untagged entries and the entries
   * of every persona open now; and the personas, closed now, whose indexed
   * entries cover any part or category the deal touches (`touches`).
   */
  load(kind: string, touches: readonly string[]): { model: ValueModel; closedPersonas: string[] } {
    const { version, form } = this.form(kind);
    const entries: ValueEntry[] = this.readEntries(this.identity, kind);
    const closed = new Set<string>();
    const indexed = this.identity.query(
      `SELECT DISTINCT persona, covers FROM commitment_value_index WHERE kind = ?`,
      [kind],
    );
    const personas = new Set(indexed.map((r) => str(r.persona)));
    for (const persona of personas) {
      const db = this.personas.isOpen(persona) ? this.personas.db(persona) : null;
      if (db === null) {
        const covered = indexed.some(
          (r) => str(r.persona) === persona && touches.includes(str(r.covers)),
        );
        if (covered) closed.add(persona);
        continue;
      }
      entries.push(...this.readEntries(db, kind));
    }
    return { model: assemble(kind, version, form, entries), closedPersonas: [...closed].sort() };
  }

  /**
   * The model as Brain may see it (COMMITMENT_KERNEL §11): untagged entries,
   * and entries of personas Brain may read now. Sensitive and locked personas'
   * entries never reach a brief from here.
   */
  loadForBrain(kind: string): ValueModel {
    // The owner's form (walk-away point, limits, totals, asking terms) never
    // reaches Brain's view, whatever the caller then projects.
    const { version } = this.form(kind);
    const form: ModelForm = { limits: {}, totals: {}, asking: {}, binding: 'card' };
    return assemble(kind, version, form, this.entriesForBrain(kind));
  }

  /**
   * The entries Brain may see now: untagged ones and those of open personas
   * Brain may read; an entry also listed under any other persona is withheld
   * in every copy.
   */
  entriesForBrain(kind: string): ValueEntry[] {
    const rows = this.identity.query(
      `SELECT DISTINCT persona, entry_id FROM commitment_value_index WHERE kind = ?`,
      [kind],
    );
    // An entry listed under a persona Brain may not read is withheld in every
    // copy: a move into that persona cut short leaves its old copy behind.
    const withheld = new Set<string>();
    const readable = new Set<string>();
    for (const row of rows) {
      const persona = str(row.persona);
      if (this.personas.brainMayRead?.(persona) === true) readable.add(persona);
      else withheld.add(str(row.entry_id));
    }
    const entries: ValueEntry[] = this.readEntries(this.identity, kind);
    for (const persona of readable) {
      const db = this.personas.isOpen(persona) ? this.personas.db(persona) : null;
      if (db !== null) entries.push(...this.readEntries(db, kind));
    }
    return entries.filter((e) => !withheld.has(e.id));
  }

  /** Can an entry be written to this persona now (its vault open)? */
  personaWritable(persona: string): boolean {
    return this.dbFor(persona) !== null;
  }

  /** May Brain read this persona's entries now? */
  brainMayRead(persona: string): boolean {
    return this.personas.brainMayRead?.(persona) === true;
  }

  /**
   * The entry with this id as it stands now, wherever it is kept; null when
   * there is none; 'closed' when a copy sits in a persona that is closed.
   */
  entryNow(kind: string, id: string): ValueEntry | null | 'closed' {
    const holders = this.holdersOf(kind, id);
    let found: ValueEntry | null = null;
    for (const persona of holders) {
      const db = this.dbFor(persona);
      if (db === null) return 'closed';
      const row = db.query(
        `SELECT entry_json FROM commitment_value_entries WHERE kind = ? AND entry_id = ?`,
        [kind, id],
      )[0];
      // The copy the index names wins over an untagged leftover.
      if (row !== undefined && (found === null || persona !== undefined))
        found = decode<ValueEntry>(str(row.entry_json));
    }
    return found;
  }

  private dbFor(persona: string | undefined): DatabaseAdapter | null {
    if (persona === undefined) return this.identity;
    return this.personas.isOpen(persona) ? this.personas.db(persona) : null;
  }

  private readEntries(db: DatabaseAdapter, kind: string): ValueEntry[] {
    return db
      .query(`SELECT entry_json FROM commitment_value_entries WHERE kind = ? ORDER BY entry_id`, [
        kind,
      ])
      .map((r: DBRow) => decode<ValueEntry>(str(r.entry_json)));
  }
}

/** The kernel's model from the form and the entries in force. */
export function assemble(
  kind: string,
  version: number,
  form: ModelForm,
  entries: readonly ValueEntry[],
): ValueModel {
  const choiceValues: Record<string, Record<string, bigint>> = {};
  const flagValues: Record<string, { set: bigint; unset: bigint }> = {};
  const promiseValues: Record<string, PromiseValue[]> = {};
  const never: ValueModel['never'][number][] = [];
  const capacities: Record<string, { dimension: string; amount: bigint }> = {};
  for (const { body } of entries) {
    if (body.type === 'choice') (choiceValues[body.part] ??= {})[body.option] = body.rupees;
    else if (body.type === 'flag') flagValues[body.part] = { set: body.set, unset: body.unset };
    else if (body.type === 'promise') (promiseValues[body.part] ??= []).push(body.value);
    else if (body.type === 'capacity')
      capacities[body.part] = { dimension: body.dimension, amount: body.amount };
    else never.push({ label: body.label, all: body.all });
  }
  return {
    kind,
    version,
    ...(form.walkAway !== undefined ? { walkAway: form.walkAway } : {}),
    ...(form.autoSign !== undefined ? { autoSign: form.autoSign } : {}),
    limits: form.limits,
    choiceValues,
    flagValues,
    promiseValues,
    never,
    totals: form.totals,
    ...(Object.keys(capacities).length > 0 ? { capacities } : {}),
  };
}

let installed: ValueModelStore | null = null;

/** Install a store (tests); null goes back to the identity database. */
export function installValueModelStore(store: ValueModelStore | null): void {
  installed = store;
}

/** The node's store over its identity database, or null before persistence is up. */
export async function getValueModelStore(): Promise<ValueModelStore | null> {
  if (installed !== null) return installed;
  const identity = await getIdentityDB();
  return identity === null ? null : new ValueModelStore(identity);
}
