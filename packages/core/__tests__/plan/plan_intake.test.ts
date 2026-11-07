/**
 * DAILY_PLAN.md §5–§6 — the plan store and agent intake over a real
 * SQLCipher identity database: a new agent's tasks wait for the owner, Allow
 * and Block do what they say, replays change nothing, and an agent never
 * reopens what the owner finished.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  PlanIntakeError,
  PLAN_MAX_BATCH_ITEMS,
  decideFeed,
  parseBatch,
  receiveBatch,
} from '../../src/plan/intake';
import { PlanStore } from '../../src/plan/store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = Date.parse('2026-11-03T07:00:00Z');
const OFFICE = 'did:key:z6MkOfficeClaude';
const HOME = 'did:key:z6MkPersonalClaude';

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plan-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new PlanStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function item(ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'outlook',
    source_ref: ref,
    title: `Reply about ${ref}`,
    summary: 'Needs the revised numbers.',
    link: `https://outlook.office.com/mail/${ref}`,
    due_at: '2026-11-05T17:00:00Z',
    effort_min: 20,
    project: 'Q4 budget',
    observed_at: '2026-11-03T06:55:00Z',
    ...extra,
  };
}

function send(did: string, batchId: string, items: unknown[], persona = 'work', now = T0) {
  return receiveBatch(
    store,
    did,
    did === OFFICE ? 'Office Claude' : 'Personal Claude',
    parseBatch({ batch_id: batchId, persona, items }, now),
    now,
  );
}

describe('agent intake', () => {
  it("holds a new agent's tasks until the owner allows the feed", () => {
    expect(send(OFFICE, 'b1', [item('m1'), item('m2')])).toEqual({
      accepted: 0,
      held: 2,
      duplicate_batch: false,
    });
    expect(store.getFeed(OFFICE, 'work')).toMatchObject({ state: 'pending', agentName: 'Office Claude' });
    expect(store.listTasks({ statuses: ['open'] })).toHaveLength(0);

    expect(decideFeed(store, OFFICE, 'work', true, T0 + 1)).toEqual({ released: 2, removed: 0 });
    const open = store.listTasks({ statuses: ['open'] });
    expect(open.map((t) => t.sourceRef)).toEqual(['m1', 'm2']);
    expect(open[0]).toMatchObject({
      persona: 'work',
      origin: OFFICE,
      dueAt: Date.parse('2026-11-05T17:00:00Z'),
      effortMin: 20,
    });

    // Allowed from now on: the next batch goes straight in.
    expect(send(OFFICE, 'b2', [item('m3')])).toEqual({ accepted: 1, held: 0, duplicate_batch: false });
  });

  it('Block deletes the held tasks and drops later batches without saying so', () => {
    send(OFFICE, 'b1', [item('m1')]);
    expect(decideFeed(store, OFFICE, 'work', false, T0 + 1)).toEqual({ released: 0, removed: 1 });
    expect(send(OFFICE, 'b2', [item('m2')])).toEqual({ accepted: 0, held: 0, duplicate_batch: false });
    expect(store.listTasks()).toHaveLength(0);
  });

  it('a permission covers one persona only', () => {
    send(OFFICE, 'b1', [item('m1')]);
    decideFeed(store, OFFICE, 'work', true, T0 + 1);
    expect(send(OFFICE, 'b2', [item('p1')], 'general')).toMatchObject({ accepted: 0, held: 1 });
    expect(store.getFeed(OFFICE, 'general')?.state).toBe('pending');
  });

  it('refuses a second copy of a batch, and an old item changes nothing', () => {
    send(OFFICE, 'b1', [item('m1')]);
    decideFeed(store, OFFICE, 'work', true, T0 + 1);
    expect(send(OFFICE, 'b1', [item('m1', { title: 'changed' })])).toEqual({
      accepted: 0,
      held: 0,
      duplicate_batch: true,
    });
    // Same item, new batch id, but seen no later than the stored copy.
    expect(send(OFFICE, 'b3', [item('m1', { title: 'older copy' })]).accepted).toBe(0);
    expect(store.listTasks()[0].title).toBe('Reply about m1');
    // Seen later: the update lands.
    send(OFFICE, 'b4', [item('m1', { title: 'Reply to Priya', observed_at: '2026-11-03T09:00:00Z' })]);
    expect(store.listTasks()[0].title).toBe('Reply to Priya');
  });

  it('closed at the source marks an open task done; the agent never reopens it', () => {
    send(OFFICE, 'b1', [item('m1')]);
    decideFeed(store, OFFICE, 'work', true, T0 + 1);
    send(OFFICE, 'b2', [item('m1', { state: 'closed', observed_at: '2026-11-03T08:00:00Z' })], 'work', T0 + 2);
    const [t] = store.listTasks();
    expect(t.status).toBe('done');
    send(OFFICE, 'b3', [item('m1', { state: 'open', observed_at: '2026-11-03T09:00:00Z' })], 'work', T0 + 3);
    expect(store.listTasks()[0].status).toBe('done');
  });

  it('keeps the owner’s drop when the agent sends the item again', () => {
    send(OFFICE, 'b1', [item('m1')]);
    decideFeed(store, OFFICE, 'work', true, T0 + 1);
    const [t] = store.listTasks();
    store.updateTask(t.id, { status: 'dropped' }, T0 + 2);
    send(OFFICE, 'b2', [item('m1', { observed_at: '2026-11-03T10:00:00Z' })], 'work', T0 + 3);
    expect(store.getTask(t.id)?.status).toBe('dropped');
  });

  it('two agents keep separate tasks, and status lists only the caller’s own', () => {
    send(OFFICE, 'b1', [item('m1')]);
    send(HOME, 'b1', [item('m1')], 'general');
    expect(store.listTasks({ origin: OFFICE })).toHaveLength(1);
    expect(store.listTasks({ origin: HOME })[0].persona).toBe('general');
  });

  it('unpairing forgets the feeds and the held tasks, not the ones taken on', () => {
    send(OFFICE, 'b1', [item('m1')]);
    decideFeed(store, OFFICE, 'work', true, T0 + 1);
    send(OFFICE, 'b2', [item('p1')], 'general');
    store.forgetAgent(OFFICE);
    expect(store.listFeeds()).toHaveLength(0);
    expect(store.listTasks().map((t) => t.sourceRef)).toEqual(['m1']);
  });

  it('checks the batch', () => {
    expect(() => parseBatch({ persona: 'work', items: [] }, T0)).toThrow(PlanIntakeError);
    expect(() =>
      parseBatch({ batch_id: 'b', items: [item('m1', { link: 'javascript:alert(1)' })] }, T0),
    ).toThrow(/https/);
    expect(() => parseBatch({ batch_id: 'b', persona: '../x', items: [] }, T0)).toThrow(/persona/);
    expect(() =>
      parseBatch({ batch_id: 'b', items: Array.from({ length: PLAN_MAX_BATCH_ITEMS + 1 }, (_, i) => item(`m${i}`)) }, T0),
    ).toThrow(/at most/);
    expect(() => parseBatch({ batch_id: 'b', items: [item('m1', { title: ' ' })] }, T0)).toThrow(/title/);
    // A time from the future is capped at now.
    const parsed = parseBatch({ batch_id: 'b', items: [item('m1', { observed_at: '2030-01-01T00:00:00Z' })] }, T0);
    expect(parsed.items[0].observedAt).toBe(T0);
    expect(parsed.persona).toBe('general');
  });
});

describe('goals and days', () => {
  it('saves a plan and marks each chosen task for that day', () => {
    const a = store.addOwnerTask({ title: 'Renew car insurance' }, T0);
    const b = store.addOwnerTask({ title: 'Book the dentist' }, T0);
    const goal = store.addGoal('Stay on top of admin', '', T0);
    store.putDay('2026-11-03', [{ taskId: a.id, reason: 'Due Friday', goalId: goal.id }], '', T0 + 1);
    expect(store.getTask(a.id)).toMatchObject({ plannedFor: '2026-11-03', goalId: goal.id });
    expect(store.getTask(b.id)?.plannedFor).toBe('');

    // Re-planning moves the day to the new choice.
    store.putDay('2026-11-03', [{ taskId: b.id, reason: 'Quick' }], '', T0 + 2);
    expect(store.getTask(a.id)?.plannedFor).toBe('');
    expect(store.getDay('2026-11-03')?.entries).toEqual([{ taskId: b.id, reason: 'Quick' }]);
    expect(store.markReviewed('2026-11-03', T0 + 3)).toBe(true);
    expect(store.getDay('2026-11-03')?.reviewedAt).toBe(T0 + 3);
  });

  it('archives a goal', () => {
    const g = store.addGoal('Run three times a week', '', T0);
    store.updateGoal(g.id, { active: false }, T0 + 1);
    expect(store.listGoals(true)).toHaveLength(0);
    expect(store.listGoals()).toHaveLength(1);
  });
});
