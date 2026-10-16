/**
 * COMMITMENT_KERNEL §7 — where the value model is kept (step 2 of §15).
 *
 *   K-50  the Core form round-trips per kind, with its bigints, and every
 *         change bumps the model version;
 *   K-51  an entry tagged with a persona is written to that persona's own
 *         file, never to the identity store; the index there names what it
 *         covers and holds no value, limit or rule;
 *   K-52  a closed persona's entries are not read: the model leaves them out
 *         and names the persona when the deal touches what they cover; a
 *         write to a closed persona is refused;
 *   K-53  a never-rule kept in a closed persona sends the deal to the card,
 *         not to signing; once the persona is open the rule refuses;
 *   K-54  entries are keyed by kind and id: the same id under two kinds keeps
 *         both; re-tagging an entry into a persona moves it out of the
 *         identity store and its index follows; moving one out of a closed
 *         persona is refused;
 *   K-55  a move that fails after the new copy is written leaves the rule in
 *         force (the new copy is written before the old one is removed).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { checkVersion, type ModelVocabulary } from '../../src/commitment';
import { ValueModelStore, type ValueEntry } from '../../src/commitment/model_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';

const VOCAB: ModelVocabulary = {
  numbers: [{ name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' }],
  choices: {},
  flags: ['shares_health_data'],
  promises: {},
};

describe('the value model store', () => {
  let dir: string;
  let identity: NodeSQLiteAdapter;
  let health: NodeSQLiteAdapter;
  const open = new Set<string>();
  let store: ValueModelStore;

  const adapter = (name: string, migrations: typeof IDENTITY_MIGRATIONS) => {
    const db = new NodeSQLiteAdapter({
      path: path.join(dir, `${name}.sqlite`),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, migrations);
    return db;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-model-'));
    identity = adapter('identity', IDENTITY_MIGRATIONS);
    health = adapter('health', PERSONA_MIGRATIONS);
    open.clear();
    store = new ValueModelStore(identity, {
      db: (p) => (p === 'health' ? health : null),
      isOpen: (p) => open.has(p),
    });
  });
  afterEach(() => {
    identity.close();
    health.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const neverHealth: ValueEntry = {
    id: 'n1',
    kind: 'clinic.visit',
    persona: 'health',
    covers: ['shares_health_data', 'category:health'],
    body: {
      type: 'never',
      label: 'never share health data with a business',
      all: [{ part: 'shares_health_data', flag: true }],
    },
  };

  it('K-50: the form round-trips and each change bumps the version', () => {
    expect(store.form('slot.shelf').version).toBe(0);
    const form = {
      walkAway: 900n,
      autoSign: 1_200n,
      limits: { fee: { hard: 80_000n, auto: 100_000n } },
      totals: { overall: 5_000n },
      asking: { fee: '250000' },
      binding: 'card' as const,
    };
    expect(store.setForm('slot.shelf', form, 1)).toBe(1);
    expect(store.form('slot.shelf')).toEqual({ version: 1, form });
    const v = store.putEntry(
      {
        id: 'c1',
        kind: 'slot.shelf',
        covers: ['delivery_day'],
        body: { type: 'choice', part: 'delivery_day', option: 'wed', rupees: -50n },
      },
      2,
    );
    expect(v).toEqual({ ok: true, version: 2 });
    expect(store.load('slot.shelf', []).model).toMatchObject({
      version: 2,
      walkAway: 900n,
      choiceValues: { delivery_day: { wed: -50n } },
    });
  });

  it('K-51: a tagged entry lives in its persona’s file; the index holds no rule', () => {
    open.add('health');
    expect(store.putEntry(neverHealth, 1).ok).toBe(true);
    const inIdentity = JSON.stringify(identity.query('SELECT * FROM commitment_value_entries'));
    expect(inIdentity).toBe('[]');
    expect(JSON.stringify(health.query('SELECT * FROM commitment_value_entries'))).toContain(
      'never share health',
    );
    const index = identity.query(
      'SELECT persona, kind, entry_id, covers FROM commitment_value_index ORDER BY covers',
    );
    expect(index).toEqual([
      { persona: 'health', kind: 'clinic.visit', entry_id: 'n1', covers: 'category:health' },
      { persona: 'health', kind: 'clinic.visit', entry_id: 'n1', covers: 'shares_health_data' },
    ]);
    expect(JSON.stringify(identity.query('SELECT * FROM commitment_value_index'))).not.toMatch(
      /never share|flag/,
    );
  });

  it('K-52: a closed persona is not read, is named when touched, and refuses writes', () => {
    open.add('health');
    store.putEntry(neverHealth, 1);
    open.delete('health');
    const touched = store.load('clinic.visit', ['shares_health_data']);
    expect(touched.model.never).toEqual([]);
    expect(touched.closedPersonas).toEqual(['health']);
    expect(store.load('clinic.visit', ['fee']).closedPersonas).toEqual([]);
    expect(store.putEntry({ ...neverHealth, id: 'n2' }, 2)).toEqual({
      ok: false,
      refusal: 'persona_closed',
    });
    expect(store.removeEntry({ kind: 'clinic.visit', id: 'n1' }, 2)).toEqual({
      ok: false,
      refusal: 'persona_closed',
    });
  });

  it('K-53: a never-rule kept in a closed persona is carded, then refuses once open', () => {
    open.add('health');
    store.putEntry(neverHealth, 1);
    store.setForm(
      'clinic.visit',
      { limits: { fee: { hard: 0n, auto: 0n } }, totals: {}, asking: {}, binding: 'card' },
      2,
    );
    const version = {
      parts: [
        {
          kind: 'number' as const,
          name: 'fee',
          value: 50_000n,
          currency: 'INR',
          per: 'once' as const,
        },
        { kind: 'flag' as const, name: 'shares_health_data', set: true },
      ],
      months: 1,
    };
    open.delete('health');
    const closed = store.load('clinic.visit', ['fee', 'shares_health_data', 'category:health']);
    expect(
      checkVersion({
        model: closed.model,
        vocabulary: VOCAB,
        holder: 'seller',
        version,
        closedPersonas: closed.closedPersonas,
      }),
    ).toMatchObject({ outcome: 'card', reasons: expect.arrayContaining(['persona_closed']) });
    open.add('health');
    const opened = store.load('clinic.visit', ['fee', 'shares_health_data', 'category:health']);
    expect(
      checkVersion({
        model: opened.model,
        vocabulary: VOCAB,
        holder: 'seller',
        version,
        closedPersonas: opened.closedPersonas,
      }),
    ).toMatchObject({ outcome: 'refused', reason: 'never_rule' });
  });

  it('K-54: entries are keyed by kind and id, and a re-tagged entry moves', () => {
    const plain: ValueEntry = { ...neverHealth, persona: undefined, kind: 'clinic.visit' };
    delete (plain as { persona?: string }).persona;
    store.putEntry(plain, 1);
    store.putEntry({ ...plain, kind: 'shelf_space.host' }, 2);
    expect(store.load('clinic.visit', []).model.never).toHaveLength(1);
    expect(store.load('shelf_space.host', []).model.never).toHaveLength(1);
    // Moved into the health persona: nothing of it stays in the identity store.
    open.add('health');
    expect(store.putEntry({ ...plain, persona: 'health' }, 3).ok).toBe(true);
    const left = identity.query(
      "SELECT entry_json FROM commitment_value_entries WHERE kind = 'clinic.visit'",
    );
    expect(left).toEqual([]);
    expect(health.query('SELECT kind, entry_id FROM commitment_value_entries')).toEqual([
      { kind: 'clinic.visit', entry_id: 'n1' },
    ]);
    // Back out of a closed persona: refused, and nothing moves.
    open.delete('health');
    expect(store.putEntry(plain, 4)).toEqual({ ok: false, refusal: 'persona_closed' });
    expect(health.query('SELECT entry_id FROM commitment_value_entries')).toHaveLength(1);
  });

  it('K-55: a move that fails part-way never loses the rule', () => {
    const plain: ValueEntry = { ...neverHealth };
    delete (plain as { persona?: string }).persona;
    store.putEntry(plain, 1);
    open.add('health');
    // The identity store fails to delete the old copy: a crash at that point.
    const failing = new Proxy(identity, {
      get(target, prop, receiver) {
        if (prop === 'execute')
          return (sql: string, params?: unknown[]) => {
            if (/^DELETE FROM commitment_value_entries/.test(sql.trim())) throw new Error('crash');
            target.execute(sql, params);
          };
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const crashing = new ValueModelStore(failing, {
      db: (p) => (p === 'health' ? health : null),
      isOpen: (p) => open.has(p),
    });
    expect(() => crashing.putEntry({ ...plain, persona: 'health' }, 2)).toThrow('crash');
    // The old untagged copy is still there, but Brain sees no copy of an entry
    // now listed under a persona it may not read (open or not).
    const brainView = new ValueModelStore(identity, {
      db: (p) => (p === 'health' ? health : null),
      isOpen: (p) => open.has(p),
      brainMayRead: () => false,
    });
    expect(brainView.loadForBrain('clinic.visit').never).toEqual([]);
    // After the crash the rule is still read, and with health closed it still asks.
    expect(store.load('clinic.visit', ['shares_health_data']).model.never.length).toBeGreaterThan(
      0,
    );
    open.delete('health');
    const closed = store.load('clinic.visit', ['shares_health_data']);
    expect(closed.model.never.length + closed.closedPersonas.length).toBeGreaterThan(0);
    // Deleting it then crashes before the last step: the index row outlives
    // every copy, so the old copy stays withheld.
    const crashingIndex = new Proxy(identity, {
      get(target, prop, receiver) {
        if (prop === 'execute')
          return (sql: string, params?: unknown[]) => {
            if (/^DELETE FROM commitment_value_index/.test(sql.trim())) throw new Error('crash');
            target.execute(sql, params);
          };
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    open.add('health');
    const deleting = new ValueModelStore(crashingIndex, {
      db: (p) => (p === 'health' ? health : null),
      isOpen: (p) => open.has(p),
    });
    expect(() => deleting.removeEntry({ kind: 'clinic.visit', id: plain.id }, 3)).toThrow('crash');
    expect(brainView.loadForBrain('clinic.visit').never).toEqual([]);
  });

  it('K-56: Brain sees untagged entries and Brain-readable personas only', () => {
    open.add('health');
    store.putEntry(neverHealth, 1);
    store.putEntry({ ...neverHealth, id: 'n0', persona: undefined, covers: ['exclusive'] }, 2);
    // Open for the owner, but sensitive: Brain may not read it without approval.
    const brainView = new ValueModelStore(identity, {
      db: (p) => (p === 'health' ? health : null),
      isOpen: (p) => open.has(p),
      brainMayRead: () => false,
    });
    expect(
      store.load('clinic.visit', ['exclusive', 'shares_health_data']).model.never,
    ).toHaveLength(2);
    expect(brainView.loadForBrain('clinic.visit').never).toHaveLength(1);
    const approved = new ValueModelStore(identity, {
      db: (p) => (p === 'health' ? health : null),
      isOpen: (p) => open.has(p),
      brainMayRead: (p) => p === 'health',
    });
    expect(approved.loadForBrain('clinic.visit').never).toHaveLength(2);
    // Brain's view carries none of the owner's form.
    store.setForm(
      'clinic.visit',
      {
        walkAway: 900n,
        limits: { fee: { hard: 1n, auto: 1n } },
        totals: { overall: 5n },
        asking: {},
        binding: 'card',
      },
      3,
    );
    const view = approved.loadForBrain('clinic.visit');
    expect(view.walkAway).toBeUndefined();
    expect(view.limits).toEqual({});
    expect(view.totals).toEqual({});
    // Absent the check, Brain reads no persona at all.
    expect(store.loadForBrain('clinic.visit').never).toHaveLength(1);
  });

  it('K-57: replacing an entry after a cut-short move never exposes the old copy', () => {
    const work = adapter('work', PERSONA_MIGRATIONS);
    try {
      open.add('health');
      open.add('work');
      const access = (base: AdapterLike, workDb: AdapterLike = work) =>
        new ValueModelStore(base, {
          db: (p) => (p === 'health' ? health : p === 'work' ? workDb : null),
          isOpen: (p) => open.has(p),
          brainMayRead: (p) => p === 'work',
        });
      const old: ValueEntry = { ...neverHealth, persona: 'work', label: undefined } as ValueEntry;
      (old.body as { label: string }).label = 'old private words';
      access(identity).putEntry(old, 1);
      // Moving it into health is cut short: both copies stay, health indexed.
      expect(() =>
        access(identity, failOn(work, /^DELETE FROM commitment_value_entries/)).putEntry(
          { ...old, persona: 'health' },
          2,
        ),
      ).toThrow('crash');
      // The owner replaces it with new, untagged words; cleanup crashes while dropping the
      // old work copy, after the health copy (whose index row protected it) went first.
      const replacement: ValueEntry = {
        ...old,
        persona: undefined,
        body: { ...(old.body as object), label: 'new words' } as ValueEntry['body'],
      };
      expect(() =>
        access(identity, failOn(work, /^DELETE FROM commitment_value_entries/)).putEntry(
          replacement,
          3,
        ),
      ).toThrow('crash');
      expect(JSON.stringify(access(identity).loadForBrain('clinic.visit').never)).not.toContain(
        'old private words',
      );
    } finally {
      work.close();
    }
  });
});

type AdapterLike = NodeSQLiteAdapter;

/** The adapter, failing any statement that matches (a crash at that point). */
function failOn(target: NodeSQLiteAdapter, pattern: RegExp): NodeSQLiteAdapter {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'execute')
        return (sql: string, params?: unknown[]) => {
          if (pattern.test(sql.trim())) throw new Error('crash');
          t.execute(sql, params);
        };
      const value = Reflect.get(t, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}
