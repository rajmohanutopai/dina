/**
 * docs/STATE_MACHINES.md PLAN-2, PLAN-3, PLAN-6, PLAN-8: rules of the plan's
 * state that live in the store, over a real SQLCipher identity database.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  reconcileRevokedDeviceAuthority,
  registerDevice,
  resetDeviceRegistry,
  revokeDevice,
} from '../../src/devices/registry';
import { decideFeed, parseBatch, receiveBatch } from '../../src/plan/intake';
import { PlanStore, setPlanStore } from '../../src/plan/store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = Date.parse('2026-11-03T07:00:00Z');
const AGENT = 'did:key:zAgent';

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;

function openDb(file = 'identity.sqlite'): NodeSQLiteAdapter {
  return new NodeSQLiteAdapter({
    path: path.join(dir, file),
    passphraseHex: randomBytes(32).toString('hex'),
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plan-state-'));
  db = openDb();
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new PlanStore(db);
  setPlanStore(store);
  resetDeviceRegistry();
});

afterEach(() => {
  resetDeviceRegistry();
  setPlanStore(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function push(did: string, id: string, items: unknown[], now: number) {
  return receiveBatch(store, did, 'a', parseBatch({ batch_id: id, items }, now), now);
}

describe('PLAN-2: a held item its agent closes leaves nothing behind', () => {
  const item = { source_ref: 'r1', title: 'Wire 9000 to X', observed_at: T0 };
  const closed = { ...item, state: 'closed', observed_at: T0 + 1000 };

  it('closed while held: no row is left for a block to miss or chat to reopen', () => {
    push(AGENT, 'b1', [item], T0);
    expect(store.listTasks({ origin: AGENT }).map((t) => t.status)).toEqual(['held']);
    push(AGENT, 'b2', [closed], T0 + 2000);
    expect(store.listTasks({ origin: AGENT })).toEqual([]);
  });

  it('reopened at the source before any decision: held again, so the owner still decides', () => {
    push(AGENT, 'b1', [item], T0);
    push(AGENT, 'b2', [closed], T0 + 2000);
    push(AGENT, 'b3', [{ ...item, observed_at: T0 + 3000 }], T0 + 4000);
    expect(store.listTasks({ origin: AGENT }).map((t) => t.status)).toEqual(['held']);
    decideFeed(store, AGENT, 'general', false, T0 + 5000);
    expect(store.listTasks({ origin: AGENT })).toEqual([]);
  });

  it('an open task its agent closes still goes to done', () => {
    push(AGENT, 'b1', [item], T0);
    decideFeed(store, AGENT, 'general', true, T0 + 1);
    push(AGENT, 'b2', [closed], T0 + 2000);
    expect(store.listTasks({ origin: AGENT }).map((t) => t.status)).toEqual(['done']);
  });

  it('the migration removes old rows of this kind and nothing else', () => {
    const old = openDb('old.sqlite');
    const migration = IDENTITY_MIGRATIONS.find((m) => m.name === 'plan_drop_closed_held_tasks');
    expect(migration).toBeDefined();
    applyMigrations(
      old,
      IDENTITY_MIGRATIONS.filter((m) => m.version < (migration?.version ?? 0)),
    );
    const oldStore = new PlanStore(old);
    const seed = (origin: string, ref: string, status: string, openedAt: number, doneAt: number | null) =>
      old.execute(
        `INSERT INTO plan_tasks (id, persona, title, origin, source_ref, status, opened_at, done_at, created_at, updated_at, observed_at)
         VALUES (?, 'general', ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
        [ref, ref, origin, ref, status, openedAt, doneAt],
      );
    seed(AGENT, 'closed-held', 'dropped', 0, 5);
    seed(AGENT, 'owner-dropped', 'dropped', 7, null);
    seed(AGENT, 'old-owner-dropped', 'dropped', 0, null);
    seed('owner', 'own', 'dropped', 0, 5);
    seed(AGENT, 'done', 'done', 0, 5);
    applyMigrations(old, IDENTITY_MIGRATIONS);
    expect(
      oldStore
        .listTasks()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['done', 'old-owner-dropped', 'own', 'owner-dropped']);
    old.close();
  });
});

describe('PLAN-3: a revoked device holds no permission to add tasks', () => {
  const item = (ref: string) => ({ source_ref: ref, title: ref, observed_at: T0 });

  it.each(['rich', 'cli', 'agent'] as const)('%s device: revoke forgets its feed and held tasks', (role) => {
    const dev = registerDevice('CLI', `z6MkKeyFor${role}`, role);
    push(dev.did, 'b1', [item('r1')], T0);
    decideFeed(store, dev.did, 'general', true, T0);
    push(dev.did, 'b2', [item('r2')], T0);
    push(dev.did, 'b3', [{ ...item('h'), persona: 'work' }], T0);
    revokeDevice(dev.deviceId);
    expect(store.getFeed(dev.did, 'general')).toBeNull();
    // What the owner already took on stays.
    expect(store.listTasks({ origin: dev.did }).every((t) => t.status === 'open')).toBe(true);
  });

  it('the same key paired again starts over: its next batch waits for the owner', () => {
    const dev = registerDevice('CLI', 'z6MkRepairKey', 'rich');
    push(dev.did, 'b1', [item('r1')], T0);
    decideFeed(store, dev.did, 'general', true, T0);
    revokeDevice(dev.deviceId);
    const again = registerDevice('CLI', 'z6MkRepairKey', 'rich');
    expect(again.did).toBe(dev.did);
    expect(push(dev.did, 'b2', [item('r3')], T0 + 1)).toMatchObject({ accepted: 0, held: 1 });
  });

  it('a revoke with no store open is caught by the boot reconcile', () => {
    const dev = registerDevice('Agent', 'z6MkNoStoreKey', 'agent');
    push(dev.did, 'b1', [item('r1')], T0);
    decideFeed(store, dev.did, 'general', true, T0);
    setPlanStore(null);
    revokeDevice(dev.deviceId);
    setPlanStore(store);
    reconcileRevokedDeviceAuthority();
    expect(store.getFeed(dev.did, 'general')).toBeNull();
  });

  it('the boot reconcile leaves a re-paired device alone', () => {
    const dev = registerDevice('CLI', 'z6MkKeepKey', 'rich');
    revokeDevice(dev.deviceId);
    registerDevice('CLI', 'z6MkKeepKey', 'rich');
    push(dev.did, 'b1', [item('r1')], T0);
    decideFeed(store, dev.did, 'general', true, T0);
    reconcileRevokedDeviceAuthority();
    expect(store.getFeed(dev.did, 'general')?.state).toBe('allowed');
  });
});

describe('PLAN-6: a draft only lands on a goal with no phases', () => {
  const draft = { phases: [{ title: 'Model', notes: '', targetAt: null, tasks: [] }], by: 'model' as const };

  it('refuses to save a draft once the goal has a phase', () => {
    const g = store.addGoal('House', '', T0);
    store.addPhase(g.id, 'By hand', '', null, T0);
    expect(store.setGoalDraft(g.id, draft, T0 + 1)).toBe(false);
    expect(store.getGoal(g.id)?.draft).toBeNull();
  });

  it('adding a phase clears a draft already waiting, so none is left stuck', () => {
    const g = store.addGoal('House', '', T0);
    expect(store.setGoalDraft(g.id, draft, T0 + 1)).toBe(true);
    store.addPhase(g.id, 'By hand', '', null, T0 + 2);
    expect(store.getGoal(g.id)?.draft).toBeNull();
  });

  it('a discard still works on a goal with phases', () => {
    const g = store.addGoal('House', '', T0);
    store.setGoalDraft(g.id, draft, T0 + 1);
    expect(store.setGoalDraft(g.id, null, T0 + 2)).toBe(true);
    expect(store.getGoal(g.id)?.draft).toBeNull();
  });
});

describe('PLAN-8: done ends a wait on every path', () => {
  it('owner tick: reopening brings back no chase', () => {
    const t = store.addOwnerTask({ title: 't' }, T0);
    store.updateTask(t.id, { waitingOn: 'Mike', waitingUntil: T0 + 1000 }, T0);
    store.updateTask(t.id, { status: 'done' }, T0 + 1);
    const r = store.updateTask(t.id, { status: 'open' }, T0 + 2);
    expect(r?.waitingOn).toBe('');
    expect(r?.waitingUntil).toBeNull();
    expect(store.getTask(t.id)?.waitingOn).toBe('');
  });

  it('agent close: the same', () => {
    const item = { source_ref: 'r', title: 'r', observed_at: T0 };
    push(AGENT, 'b1', [item], T0);
    decideFeed(store, AGENT, 'general', true, T0);
    const [t] = store.listTasks({ origin: AGENT });
    store.updateTask(t.id, { waitingOn: 'Mike', waitingUntil: T0 + 1000 }, T0);
    push(AGENT, 'b2', [{ ...item, state: 'closed', observed_at: T0 + 1 }], T0 + 2);
    const done = store.getTask(t.id);
    expect(done?.status).toBe('done');
    expect(done?.waitingOn).toBe('');
    expect(done?.waitingUntil).toBeNull();
  });

  it('a drop keeps the wait: the owner may reopen it and still be waiting', () => {
    const t = store.addOwnerTask({ title: 't' }, T0);
    store.updateTask(t.id, { waitingOn: 'Mike' }, T0);
    store.updateTask(t.id, { status: 'dropped' }, T0 + 1);
    expect(store.getTask(t.id)?.waitingOn).toBe('Mike');
  });
});
