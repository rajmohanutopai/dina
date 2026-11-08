/**
 * docs/PROMISES_AND_WAITS.md §3–§4: one list joined from every source, and a
 * Talk promise tracked as a plan task, over a real SQLCipher identity database.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createGroupPlan, openRound } from '../../src/coordination/group_plan';
import { InMemoryGroupPlanRepository } from '../../src/coordination/group_plan_repository';
import { planDayStart } from '../../src/plan/day';
import { needsChase } from '../../src/plan/goal_rules';
import { PlanStore } from '../../src/plan/store';
import { trackTalkPromise } from '../../src/promises/track';
import {
  listPromisesAndWaits,
  talkContactDid,
  talkSourceRef,
  type PromisesDeps,
} from '../../src/promises/view';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CommerceRuntime } from '../../src/commerce/runtime';

const NOW = new Date(2026, 10, 8, 10, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const MIKE = 'did:plc:mike';
const ANA = 'did:plc:ana';
const NAMES: Record<string, string> = { [MIKE]: 'Mike', [ANA]: 'Ana' };

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'promises-'));
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

function deps(over: Partial<PromisesDeps> = {}): Partial<PromisesDeps> {
  return {
    plan: () => store,
    groupPlans: () => null,
    commerce: () => null,
    nameFor: (did) => NAMES[did] ?? null,
    ...over,
  };
}

describe('Talk sourceRef', () => {
  it('round-trips a DID with colons in it', () => {
    const ref = talkSourceRef('did:plc:abc', 'msg-1');
    expect(talkContactDid(ref)).toBe('did:plc:abc');
    expect(talkContactDid('agent:thing')).toBeNull();
    expect(talkContactDid('talk:nomessage')).toBeNull();
  });
});

describe('trackTalkPromise', () => {
  it('makes a promise owed to the owner a wait the day plan chases once late', () => {
    const task = trackTalkPromise(
      store,
      {
        contactDid: MIKE,
        contactName: 'Mike',
        messageId: 'm1',
        direction: 'owed_to_me',
        what: 'Send the deck',
        dueAt: NOW - 2 * DAY,
      },
      NOW,
    );
    expect(task).toMatchObject({ title: 'Send the deck', waitingOn: 'Mike', source: 'talk' });
    expect(needsChase(task, planDayStart(NOW))).toBe(true);
  });

  it('makes a promise the owner made a task due on its date', () => {
    const due = NOW + DAY;
    const task = trackTalkPromise(
      store,
      {
        contactDid: ANA,
        contactName: 'Ana',
        messageId: 'm2',
        direction: 'owed_by_me',
        what: 'Confirm dinner',
        dueAt: due,
      },
      NOW,
    );
    expect(task).toMatchObject({ waitingOn: '', dueAt: due, status: 'open' });
  });

  it('tracks one message once, however often it is asked', () => {
    const p = {
      contactDid: MIKE,
      contactName: 'Mike',
      messageId: 'm1',
      direction: 'owed_to_me' as const,
      what: 'Send the deck',
      dueAt: null,
    };
    const a = trackTalkPromise(store, p, NOW);
    const b = trackTalkPromise(store, { ...p, what: 'Something else' }, NOW + 1000);
    expect(b.id).toBe(a.id);
    expect(store.listTasks({ statuses: ['open'] })).toHaveLength(1);
  });

  it('refuses a promise with nothing in it', () => {
    expect(() =>
      trackTalkPromise(
        store,
        {
          contactDid: MIKE,
          contactName: 'Mike',
          messageId: 'm3',
          direction: 'owed_to_me',
          what: '   ',
          dueAt: null,
        },
        NOW,
      ),
    ).toThrow();
  });
});

describe('listPromisesAndWaits', () => {
  it('lists waits and Talk promises both ways, late first, then by date, then undated', () => {
    store.addOwnerTask({ title: 'Plain task, no wait' }, NOW);
    const wait = store.addOwnerTask({ title: 'Quote for the roof' }, NOW);
    store.updateTask(wait.id, { waitingOn: 'Builder', waitingUntil: NOW + 3 * DAY }, NOW);
    trackTalkPromise(
      store,
      {
        contactDid: MIKE,
        contactName: 'Mike',
        messageId: 'm1',
        direction: 'owed_to_me',
        what: 'Send the deck',
        dueAt: NOW - DAY,
      },
      NOW,
    );
    trackTalkPromise(
      store,
      {
        contactDid: ANA,
        contactName: 'Ana',
        messageId: 'm2',
        direction: 'owed_by_me',
        what: 'Confirm dinner',
        dueAt: null,
      },
      NOW,
    );

    const { items, missing } = listPromisesAndWaits(NOW, deps());
    expect(missing).toEqual([]);
    expect(items.map((i) => [i.source, i.direction, i.who, i.what, i.late])).toEqual([
      ['talk', 'owed_to_me', 'Mike', 'Send the deck', true],
      ['plan', 'owed_to_me', 'Builder', 'Quote for the roof', false],
      ['talk', 'owed_by_me', 'Ana', 'Confirm dinner', false],
    ]);
    expect(items[0].whoDid).toBe(MIKE);
    expect(items[1].whoDid).toBeNull();
  });

  it('leaves out finished tasks and those of an archived goal', () => {
    const goal = store.addGoal('Old goal', '', NOW);
    const t = store.addOwnerTask({ title: 'Wait in old goal', goalId: goal.id }, NOW);
    store.updateTask(t.id, { waitingOn: 'Sam' }, NOW);
    store.updateGoal(goal.id, { active: false }, NOW);
    const done = store.addOwnerTask({ title: 'Done wait' }, NOW);
    store.updateTask(done.id, { waitingOn: 'Lee' }, NOW);
    store.updateTask(done.id, { status: 'done' }, NOW);
    expect(listPromisesAndWaits(NOW, deps()).items).toEqual([]);
  });

  it('lists a group booking by the guests still to answer, due when its window closes', () => {
    const repo = new InMemoryGroupPlanRepository();
    const made = createGroupPlan({
      planId: 'gp1',
      intent: "Emma's birthday",
      guests: [
        { contactDid: MIKE, required: true },
        { contactDid: ANA, required: false },
      ],
      candidates: [{ start: 'Sat 26' }],
      windowSeconds: 300,
      nowMs: NOW,
    });
    if (!made.ok) throw new Error(made.refusal);
    const opened = openRound(made.plan, NOW);
    if (!opened.ok) throw new Error(opened.refusal);
    repo.put(opened.plan);

    const { items } = listPromisesAndWaits(NOW, deps({ groupPlans: () => repo }));
    expect(items).toEqual([
      expect.objectContaining({
        source: 'group_plan',
        direction: 'owed_to_me',
        who: 'Mike and Ana',
        whoDid: null,
        what: "An answer about Emma's birthday",
        dueAt: NOW + 300 * 1000,
        ref: 'gp1',
      }),
    ]);
  });

  it('lists tenders, unsettled orders and shelf promises each way', () => {
    const runtime = {
      tenders: {
        listTenders: () => [
          { tenderId: 't1', linesJson: '[]', expiresAt: NOW + DAY, createdAt: NOW },
          { tenderId: 'old', linesJson: '[]', expiresAt: NOW - 1, createdAt: NOW - DAY },
        ],
        listMembers: (id: string) =>
          id === 't1'
            ? [
                { tenderId: 't1', supplierDid: MIKE, quoteId: '' },
                { tenderId: 't1', supplierDid: ANA, quoteId: 'q1' },
              ]
            : [{ tenderId: 'old', supplierDid: ANA, quoteId: '' }],
      },
      buyerOrders: {
        listUnsettled: () => [{ supplierDid: ANA, record: { purchaseOrderId: 'po1' } }],
      },
      terms: {
        agreements: () => [
          {
            proposalDigest: 'd1',
            role: 'host',
            counterpartyDid: MIKE,
            state: 'accepted',
            promises: [
              { name: 'restock', by: 'buyer', dimensions: { every_days: '7' } },
              { name: 'shelf_kept_clean', by: 'seller', dimensions: {} },
            ],
          },
          {
            proposalDigest: 'd2',
            role: 'host',
            counterpartyDid: ANA,
            state: 'ended',
            promises: [{ name: 'x', by: 'buyer', dimensions: {} }],
          },
        ],
      },
    } as unknown as CommerceRuntime;

    const { items } = listPromisesAndWaits(NOW, deps({ commerce: () => runtime }));
    expect(items.map((i) => [i.source, i.direction, i.who, i.what])).toEqual([
      ['tender', 'owed_to_me', 'Mike', 'A quote for your items'],
      ['order', 'owed_to_me', 'Ana', 'An answer to your order'],
      ['agreement', 'owed_to_me', 'Mike', 'restock'],
      ['agreement', 'owed_by_me', 'Mike', 'shelf kept clean'],
    ]);
  });

  it('names a source it could not read and still lists the rest', () => {
    const t = store.addOwnerTask({ title: 'Quote for the roof' }, NOW);
    store.updateTask(t.id, { waitingOn: 'Builder' }, NOW);
    const broken = {
      tenders: {
        listTenders: () => {
          throw new Error('locked');
        },
      },
      buyerOrders: { listUnsettled: () => [] },
      terms: { agreements: () => [] },
    } as unknown as CommerceRuntime;
    const out = listPromisesAndWaits(NOW, deps({ commerce: () => broken }));
    expect(out.missing).toEqual(['tender']);
    expect(out.items.map((i) => i.who)).toEqual(['Builder']);
  });

  it('shows an unknown contact as Someone', () => {
    trackTalkPromise(
      store,
      {
        contactDid: 'did:plc:stranger',
        contactName: '',
        messageId: 'm9',
        direction: 'owed_by_me',
        what: 'Call back',
        dueAt: null,
      },
      NOW,
    );
    expect(listPromisesAndWaits(NOW, deps()).items[0].who).toBe('Someone');
  });
});
