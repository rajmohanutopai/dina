/**
 * Run once per time zone by `zones` in routines.test.ts, in a jest process
 * started with TZ set: dates and clock changes on the owner's own clock.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { parsePlanDate, planDayEnd, planDayKey, shiftCalendarDays } from '../../../src/plan/day';
import { daysLate, cleanGoalDraft, latePhase } from '../../../src/plan/goal_rules';
import { parseBatch } from '../../../src/plan/intake';
import { routineTurnOn, weekStart } from '../../../src/plan/routines';
import { PlanStore, type PlanRoutine } from '../../../src/plan/store';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plan-zone-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ab'.repeat(32),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new PlanStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('runs in the zone it was started for', () => {
  // By offset: one zone can go by two names (Asia/Kolkata, Asia/Calcutta).
  const offset = (timeZone?: string): string =>
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).format(
      new Date(2027, 0, 15),
    );
  expect(offset()).toBe(offset(process.env.EXPECT_ZONE));
});

it('a bare date is that day on the owner clock, from each way in', () => {
  const ms = parsePlanDate('2027-03-01') as number;
  expect(planDayKey(ms)).toBe('2027-03-01');
  expect(new Date(ms).getHours()).toBe(23);

  const draft = cleanGoalDraft(
    { phases: [{ title: 'A', target: '2027-03-01' }] },
    new Date(2026, 10, 3).getTime(),
    null,
    'model',
  );
  expect(planDayKey(draft?.phases[0].targetAt as number)).toBe('2027-03-01');

  const batch = parseBatch(
    { batch_id: 'b', items: [{ title: 'T', due_at: '2027-03-01' }] },
    new Date(2026, 10, 3).getTime(),
  );
  expect(planDayKey(batch.items[0].dueAt as number)).toBe('2027-03-01');
});

it('keeps an explicit time, and refuses a date that does not exist', () => {
  expect(parsePlanDate('2027-03-01T10:00:00Z')).toBe(Date.UTC(2027, 2, 1, 10));
  expect(parsePlanDate('2027-02-31')).toBeNull();
});

it.each([
  // Spring and autumn changes in the US and in New Zealand.
  [2027, 2, 13],
  [2027, 10, 6],
  [2027, 3, 3],
  [2027, 8, 25],
])('a date moves by calendar days across a clock change near %i-%i-%i', (y, m, d) => {
  const target = new Date(y, m, d, 23, 59).getTime();
  for (const days of [1, 2, 12]) {
    const moved = shiftCalendarDays(target, days);
    expect(planDayKey(moved)).toBe(planDayKey(new Date(y, m, d + days, 12).getTime()));
    expect(new Date(moved).getHours()).toBe(23);
  }
  const g = store.addGoal('House', '', target - 1000, { targetAt: target });
  const p = store.addPhase(g.id, 'Roof', '', target, target - 1000);
  const now = new Date(y, m, d + 2, 9).getTime();
  const late = latePhase(store.listPhases(g.id), now);
  expect(late?.days).toBe(2);
  store.shiftDates(g.id, [p.id], late?.days ?? 0, true, now);
  expect(latePhase(store.listPhases(g.id), now)).toBeNull();
  expect(planDayKey(store.getGoal(g.id)?.targetAt as number)).toBe(planDayKey(now));
  expect(daysLate(store.getPhase(p.id)!, now)).toBe(0);
});

it('a wait set late on the night before a clock change ends on the right day', () => {
  const friday = new Date(2027, 2, 12, 23, 30).getTime();
  const until = planDayEnd(shiftCalendarDays(friday, 2)) - 1;
  expect(planDayKey(until)).toBe('2027-03-14');
});

it('routines keep to the owner weeks and months', () => {
  const r: PlanRoutine = {
    id: 'r',
    goalId: '',
    title: 'Run',
    persona: 'general',
    effortMin: null,
    kind: 'days',
    weekdays: [1],
    timesPerWeek: 0,
    dayOfMonth: 0,
    active: true,
    createdAt: 0,
    updatedAt: 0,
  };
  // Monday 8 March 2027, late at night: still Monday here, whatever UTC says.
  expect(routineTurnOn(r, [], new Date(2027, 2, 8, 23, 30).getTime()).due).toBe(true);
  expect(routineTurnOn(r, [], new Date(2027, 2, 8, 0, 30).getTime()).due).toBe(true);
  expect(weekStart(new Date(2027, 2, 14, 23, 30).getTime())).toBe(new Date(2027, 2, 8).getTime());
});
