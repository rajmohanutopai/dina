/**
 * COMMITMENT_KERNEL §7, §15 step 5 — drawing out the value model with an agent.
 *
 *   M-01  Brain's changes become one card; nothing changes until the owner's
 *         yes, which applies them all;
 *   M-02  Brain may not propose a never-rule with a figure, file an entry under
 *         a persona it may not read, or name an entry outside its view (a
 *         hidden one answers as a missing one);
 *   M-03  a yes after an entry changed applies nothing (out of date);
 *   M-04  a no changes nothing;
 *   M-05  the card carries none of the Core form, figures show in their unit,
 *         and only the owner decides it;
 *   M-06  Brain's view: no never-rule with a figure, never-rules as parts only,
 *         no values or capacities with values off — and the same list bounds
 *         what Brain may name;
 *   M-07  one card per owner turn, kept across a restart; a later turn may
 *         propose again after a no;
 *   M-08  before any change lands, a closed destination ends the card with
 *         nothing written; once one has landed, a failed write leaves the
 *         card for the boot, which goes forward;
 *   M-09  a crash after the yes, before or during the run, is finished at boot,
 *         and running twice is harmless;
 *   M-10  recovery never ends a started batch: a closed destination waits; a
 *         crash inside a move leaves two copies, and going forward clears the
 *         stale one;
 *   M-11  a card already ended is never applied by a late run.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SHELF_VOCABULARY } from '../../src/commerce/deal_kinds';
import {
  brainEntryView,
  brainVisibleEntries,
  describeEntry,
  MAX_CHANGES_PER_CARD,
  reconcileModelChanges,
  makeModelChangeDecisionHandler,
  proposeModelChanges,
  type ModelChange,
} from '../../src/commitment/model_changes';
import { ValueModelStore, type ValueEntry } from '../../src/commitment/model_store';
import { CORE_MINTED_PAYLOAD_TYPES } from '../../src/server/routes/workflow';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';
import { WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

const KIND = 'shelf_space.vendor';
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const lorryRun = (rupees: bigint, id = 'run'): ValueEntry => ({
  id,
  kind: KIND,
  covers: ['stock_run'],
  body: {
    type: 'promise',
    part: 'stock_run',
    value: { dimensions: { crates: 2n, day: 'tue', every_days: 7n }, rupees },
  },
});

describe('drawing out the value model', () => {
  let dir: string;
  let identity: NodeSQLiteAdapter;
  let health: NodeSQLiteAdapter;
  let store: ValueModelStore;
  let repo: InMemoryWorkflowRepository;
  let workflow: WorkflowService;

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-changes-'));
    identity = adapter('identity', IDENTITY_MIGRATIONS);
    health = adapter('health', PERSONA_MIGRATIONS);
    // health is open for the owner, and sensitive: Brain may not read it.
    store = new ValueModelStore(identity, {
      db: (p) => (p === 'health' ? health : null),
      isOpen: (p) => p === 'health',
      brainMayRead: () => false,
    });
    repo = new InMemoryWorkflowRepository();
    let service: WorkflowService | null = null;
    workflow = new WorkflowService({
      repository: repo,
      approvalDecisionHandler: makeModelChangeDecisionHandler({
        store: async () => store,
        workflow: () => service,
        nowMs: () => 5_000,
      }),
    });
    service = workflow;
  });
  afterEach(() => {
    identity.close();
    health.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let turn = 0;
  const propose = (changes: ModelChange[], valuesOn = true, proven = true) => {
    turn += 1;
    return proposeModelChanges({
      store,
      workflow,
      kind: KIND,
      numbers: SHELF_VOCABULARY.numbers,
      valuesOn,
      changes,
      turn: { releaseSession: 'chat:main', turnId: `t${String(turn)}` },
      proveTurn: () => proven,
      nowMs: 1_000 + turn,
    });
  };
  const cardText = (taskId: string) => repo.getById(taskId)?.description ?? '';
  const entries = () => store.load(KIND, []).model.promiseValues.stock_run ?? [];

  it('M-01: one card for the changes; the owner’s yes applies them', async () => {
    const out = propose([{ action: 'put', entry: lorryRun(-300n), minted: true }]);
    if (!out.ok) throw new Error(out.error);
    expect(cardText(out.taskId)).toMatch(
      /stock_run \(crates 2, day tue, every_days 7\) is worth −₹300 a month/,
    );
    expect(entries()).toEqual([]);
    workflow.approve(out.taskId);
    await tick();
    expect(entries()).toEqual([
      { dimensions: { crates: 2n, day: 'tue', every_days: 7n }, rupees: -300n },
    ]);
    expect(repo.getById(out.taskId)?.status).toBe(WorkflowTaskState.Completed);
    expect(propose([])).toEqual({ ok: false, error: 'too_many' });
    expect(
      propose(
        Array.from({ length: MAX_CHANGES_PER_CARD + 1 }, (_, i) => ({
          action: 'put' as const,
          entry: lorryRun(1n, `r${String(i)}`),
        })),
      ),
    ).toEqual({ ok: false, error: 'too_many' });
  });

  it('M-02: no figures, no unreadable persona, nothing it cannot see', () => {
    expect(
      propose([
        {
          action: 'put',
          entry: {
            id: 'n1',
            kind: KIND,
            covers: ['fee'],
            body: {
              type: 'never',
              label: 'no rent above ₹2,200',
              all: [{ part: 'fee', above: 220_000n }],
            },
          },
        },
      ]),
    ).toEqual({ ok: false, error: 'numeric_never_rule' });
    expect(
      propose([{ action: 'put', entry: { ...lorryRun(1n), persona: 'health' }, minted: true }]),
    ).toEqual({
      ok: false,
      error: 'persona_not_readable',
    });
    // The owner keeps an entry in health: Brain can neither replace nor remove
    // it, and the answer is the one a missing entry gets.
    expect(store.putEntry({ ...lorryRun(-900n, 'secret'), persona: 'health' }, 1).ok).toBe(true);
    expect(propose([{ action: 'put', entry: lorryRun(0n, 'secret') }])).toEqual({
      ok: false,
      error: 'no_such_entry',
    });
    expect(propose([{ action: 'remove', kind: KIND, id: 'secret' }])).toEqual({
      ok: false,
      error: 'no_such_entry',
    });
    expect(propose([{ action: 'remove', kind: KIND, id: 'nothing' }])).toEqual({
      ok: false,
      error: 'no_such_entry',
    });
  });

  it('M-03: a yes after the entry changed applies nothing', async () => {
    const out = propose([{ action: 'put', entry: lorryRun(-300n), minted: true }]);
    if (!out.ok) throw new Error(out.error);
    store.putEntry(lorryRun(-500n), 2); // the owner changed it meanwhile
    workflow.approve(out.taskId);
    await tick();
    expect(entries()[0]?.rupees).toBe(-500n);
    expect(repo.getById(out.taskId)?.status).toBe(WorkflowTaskState.Failed);
  });

  it('M-04: a no changes nothing', async () => {
    const out = propose([{ action: 'put', entry: lorryRun(-300n), minted: true }]);
    if (!out.ok) throw new Error(out.error);
    workflow.cancel(out.taskId, 'owner said no');
    await tick();
    expect(entries()).toEqual([]);
  });

  it('M-05: the card carries none of the form, and only the owner decides it', () => {
    store.setForm(
      KIND,
      {
        walkAway: 987n,
        limits: { fee: { hard: 31_337n, auto: 27_182n } },
        totals: { overall: 44_444n },
        asking: { fee: '55555' },
        binding: 'card',
      },
      1,
    );
    const out = propose([{ action: 'put', entry: lorryRun(-300n), minted: true }]);
    if (!out.ok) throw new Error(out.error);
    const task = repo.getById(out.taskId);
    expect(`${task?.description ?? ''}${task?.payload ?? ''}`).not.toMatch(
      /987|31337|27182|44444|55555/,
    );
    expect(CORE_MINTED_PAYLOAD_TYPES.has('commitment_model_change')).toBe(true);
    // The owner's own rule, figure and all, reads in its unit on a card it appears on.
    expect(
      describeEntry(
        {
          id: 'n',
          kind: KIND,
          covers: ['fee'],
          body: {
            type: 'never',
            label: 'too dear',
            all: [
              { part: 'fee', above: 220_050n },
              { part: 'share_bps', above: 1_250n },
            ],
          },
        },
        SHELF_VOCABULARY.numbers,
      ),
    ).toBe('never agree when fee is above ₹2200.50 and share_bps is above 12.50% (“too dear”)');
  });

  const figureRule: ValueEntry = {
    id: 'cap',
    kind: KIND,
    covers: ['fee'],
    body: { type: 'never', label: 'no rent above ₹2,200', all: [{ part: 'fee', above: 220_000n }] },
  };
  const noRuns: ValueEntry = {
    id: 'noruns',
    kind: KIND,
    covers: ['stock_run'],
    body: {
      type: 'never',
      label: 'my words about runs',
      all: [{ part: 'stock_run', present: true }],
    },
  };

  it('M-06: Brain’s view, and what Brain may name, are one list', () => {
    store.putEntry(figureRule, 1);
    store.putEntry(noRuns, 2);
    store.putEntry(lorryRun(-300n), 3);
    const on = brainVisibleEntries(store, KIND, true).map(brainEntryView);
    expect(JSON.stringify(on)).not.toMatch(/220000|2,200|my words/);
    expect(on.find((e) => e.id === 'noruns')).toEqual({
      id: 'noruns',
      body: { type: 'never', parts: ['stock_run'] },
    });
    expect(brainVisibleEntries(store, KIND, false).map((e) => e.id)).toEqual(['noruns']);
    // Hidden ids answer as missing ones, figure rules and switched-off values alike.
    expect(propose([{ action: 'remove', kind: KIND, id: 'cap' }])).toEqual({
      ok: false,
      error: 'no_such_entry',
    });
    expect(propose([{ action: 'remove', kind: KIND, id: 'run' }], false)).toEqual({
      ok: false,
      error: 'no_such_entry',
    });
    expect(
      propose(
        [
          {
            action: 'put',
            entry: {
              ...noRuns,
              body: { type: 'capacity', part: 'stock_run', dimension: 'crates', amount: 4n },
            },
          },
        ],
        false,
      ),
    ).toEqual({
      ok: false,
      error: 'values_off',
    });
  });

  it('M-07: one card per owner turn, across a restart; a later turn may ask again', () => {
    const key = { releaseSession: 'chat:main', turnId: 'same' };
    const once = () =>
      proposeModelChanges({
        store,
        workflow,
        kind: KIND,
        numbers: [],
        valuesOn: true,
        changes: [
          {
            action: 'put',
            entry: lorryRun(-300n, `r${String(Math.random()).slice(2, 8)}`),
            minted: true,
          },
        ],
        turn: key,
        proveTurn: () => true, // as if the in-memory record of used proofs was lost
        nowMs: 9_000,
      });
    const first = once();
    if (!first.ok) throw new Error(first.error);
    // A restart: a new service over the same tasks.
    workflow = new WorkflowService({ repository: repo });
    expect(once()).toEqual({ ok: false, error: 'turn_already_used' });
    workflow.cancel(first.taskId, 'no');
    const later = propose([{ action: 'put', entry: lorryRun(-300n), minted: true }]);
    expect(later.ok).toBe(true);
    // A refused proposal spends no turn: the proof is checked last.
    let proved = 0;
    const refused = proposeModelChanges({
      store,
      workflow,
      kind: KIND,
      numbers: [],
      valuesOn: true,
      changes: [{ action: 'remove', kind: KIND, id: 'nothing' }],
      turn: { releaseSession: 'chat:main', turnId: 'x' },
      proveTurn: () => {
        proved += 1;
        return true;
      },
      nowMs: 9_500,
    });
    expect(refused).toEqual({ ok: false, error: 'no_such_entry' });
    expect(proved).toBe(0);
  });

  it('M-08: all or none', async () => {
    // A standard persona Brain may read, open when proposed, closed at the yes.
    let workOpen = true;
    const work = adapter('work', PERSONA_MIGRATIONS);
    try {
      store = new ValueModelStore(identity, {
        db: (p) => (p === 'work' && workOpen ? work : p === 'health' ? health : null),
        isOpen: (p) => (p === 'work' ? workOpen : p === 'health'),
        brainMayRead: (p) => p === 'work',
      });
      const out = propose([
        { action: 'put', entry: lorryRun(-300n, 'a'), minted: true },
        { action: 'put', entry: { ...lorryRun(-200n, 'b'), persona: 'work' }, minted: true },
      ]);
      if (!out.ok) throw new Error(out.error);
      workOpen = false;
      workflow.approve(out.taskId);
      await tick();
      expect(store.entryNow(KIND, 'a')).toBeNull(); // nothing written
      expect(repo.getById(out.taskId)?.status).toBe(WorkflowTaskState.Failed);
      // A write failing part-way: the first stands, the card waits for the boot.
      workOpen = true;
      const second = propose([
        { action: 'put', entry: lorryRun(-300n, 'c'), minted: true },
        { action: 'put', entry: lorryRun(-200n, 'd'), minted: true },
      ]);
      if (!second.ok) throw new Error(second.error);
      const real = store.putEntry.bind(store);
      store.putEntry = (entry, nowMs) => {
        if (entry.id === 'd') throw new Error('disk full');
        return real(entry, nowMs);
      };
      workflow.approve(second.taskId);
      await tick();
      expect(store.entryNow(KIND, 'c')).not.toBeNull();
      expect(repo.getById(second.taskId)?.status).toBe(WorkflowTaskState.Running);
      store.putEntry = real;
      expect(reconcileModelChanges(workflow, store, 9_000)).toBe(1);
      expect(store.entryNow(KIND, 'd')).not.toBeNull();
      expect(repo.getById(second.taskId)?.status).toBe(WorkflowTaskState.Completed);
    } finally {
      work.close();
    }
  });

  it('M-09: a crash after the yes is finished at boot; twice is harmless', () => {
    const quiet = new WorkflowService({ repository: repo }); // no handler: the crash
    workflow = quiet;
    const out = propose([{ action: 'put', entry: lorryRun(-300n), minted: true }]);
    if (!out.ok) throw new Error(out.error);
    quiet.approve(out.taskId);
    expect(entries()).toEqual([]);
    expect(reconcileModelChanges(quiet, store, 9_000)).toBe(1);
    expect(entries()).toHaveLength(1);
    expect(repo.getById(out.taskId)?.status).toBe(WorkflowTaskState.Completed);
    expect(reconcileModelChanges(quiet, store, 9_100)).toBe(0);
    // A crash mid-run: the card was claimed (running), nothing settled it.
    const mid = propose([{ action: 'put', entry: lorryRun(-100n, 'mid'), minted: true }]);
    if (!mid.ok) throw new Error(mid.error);
    quiet.approve(mid.taskId);
    quiet
      .store()
      .transition(mid.taskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, 9_200);
    expect(reconcileModelChanges(quiet, store, 9_300)).toBe(1);
    expect(store.entryNow(KIND, 'mid')).not.toBeNull();
    expect(repo.getById(mid.taskId)?.status).toBe(WorkflowTaskState.Completed);
  });

  it('M-10: recovery never ends a started batch, and clears what a crash left', async () => {
    let workOpen = true;
    const work = adapter('work10', PERSONA_MIGRATIONS);
    try {
      store = new ValueModelStore(identity, {
        db: (p) => (p === 'work' && workOpen ? work : p === 'health' ? health : null),
        isOpen: (p) => (p === 'work' ? workOpen : p === 'health'),
        brainMayRead: (p) => p === 'work',
      });
      // A landed, then a crash before B: B's persona is closed when the boot runs.
      const quiet = new WorkflowService({ repository: repo });
      workflow = quiet;
      const out = propose([
        { action: 'put', entry: lorryRun(-300n, 'a'), minted: true },
        { action: 'put', entry: { ...lorryRun(-200n, 'b'), persona: 'work' }, minted: true },
      ]);
      if (!out.ok) throw new Error(out.error);
      quiet.approve(out.taskId);
      // What the run did before the crash: marked the card started, wrote A.
      repo.setInternalStash(out.taskId, 'model_change_started', 8_000);
      store.putEntry(lorryRun(-300n, 'a'), 8_000);
      workOpen = false;
      expect(reconcileModelChanges(quiet, store, 9_000)).toBe(1);
      expect(repo.getById(out.taskId)?.status).toBe(WorkflowTaskState.Running);
      expect(store.entryNow(KIND, 'a')).not.toBeNull(); // never ended, never undone
      workOpen = true;
      expect(reconcileModelChanges(quiet, store, 9_100)).toBe(1);
      expect(store.entryNow(KIND, 'b')).not.toBeNull();
      expect(repo.getById(out.taskId)?.status).toBe(WorkflowTaskState.Completed);

      // A crash inside a move into work: the new copy is written, the old one stays.
      const move = propose([
        { action: 'put', entry: { ...lorryRun(-300n, 'a'), persona: 'work' } },
      ]);
      if (!move.ok) throw new Error(move.error);
      quiet.approve(move.taskId);
      repo.setInternalStash(move.taskId, 'model_change_started', 9_150);
      const failing = new ValueModelStore(
        failOn(identity, /^DELETE FROM commitment_value_entries/),
        {
          db: (p) => (p === 'work' ? work : null),
          isOpen: (p) => p === 'work',
          brainMayRead: (p) => p === 'work',
        },
      );
      expect(() => failing.putEntry({ ...lorryRun(-300n, 'a'), persona: 'work' }, 9_200)).toThrow(
        'crash',
      );
      expect(store.load(KIND, []).model.promiseValues.stock_run).toHaveLength(3); // a twice, and b
      expect(reconcileModelChanges(quiet, store, 9_300)).toBe(1);
      expect(store.load(KIND, []).model.promiseValues.stock_run).toHaveLength(2); // a and b
      expect(store.entryNow(KIND, 'a')).toMatchObject({ persona: 'work' });
      expect(repo.getById(move.taskId)?.status).toBe(WorkflowTaskState.Completed);

      // Reversed: A landed in work, B still to go; work is closed at recovery.
      // The row says the run began, so the card waits rather than ends.
      const rev = propose([
        { action: 'put', entry: { ...lorryRun(-50n, 'ra'), persona: 'work' }, minted: true },
        { action: 'put', entry: lorryRun(-60n, 'rb'), minted: true },
      ]);
      if (!rev.ok) throw new Error(rev.error);
      quiet.approve(rev.taskId);
      repo.setInternalStash(rev.taskId, 'model_change_started', 9_400);
      store.putEntry({ ...lorryRun(-50n, 'ra'), persona: 'work' }, 9_400);
      workOpen = false;
      expect(reconcileModelChanges(quiet, store, 9_500)).toBe(1);
      expect(repo.getById(rev.taskId)?.status).toBe(WorkflowTaskState.Running);
      workOpen = true;
      expect(reconcileModelChanges(quiet, store, 9_600)).toBe(1);
      expect(store.entryNow(KIND, 'rb')).not.toBeNull();
      expect(repo.getById(rev.taskId)?.status).toBe(WorkflowTaskState.Completed);
    } finally {
      work.close();
    }
  });

  it('M-11: a card already ended is never applied by a late run', async () => {
    const quiet = new WorkflowService({ repository: repo });
    workflow = quiet;
    const out = propose([{ action: 'put', entry: lorryRun(-300n), minted: true }]);
    if (!out.ok) throw new Error(out.error);
    quiet.approve(out.taskId);
    quiet
      .store()
      .transition(out.taskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, 9_000);
    quiet.fail(out.taskId, 'persona_closed');
    const late = makeModelChangeDecisionHandler({
      store: async () => store,
      workflow: () => quiet,
      nowMs: () => 9_100,
    });
    const ended = repo.getById(out.taskId);
    if (ended === null) throw new Error('task');
    late({ task: ended, decision: 'approved' });
    await tick();
    expect(entries()).toEqual([]);
    expect(reconcileModelChanges(quiet, store, 9_200)).toBe(0);
  });
});

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
