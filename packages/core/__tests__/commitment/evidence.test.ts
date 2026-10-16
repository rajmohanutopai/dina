/**
 * COMMITMENT_KERNEL §13, §15 step 8 — evidence for promises and broken links.
 *
 *   E-01  a promise on a weekday falls due on that day, from the deal's start,
 *         every `every_days` (7 by default), until its end or now, only within
 *         the last 14 days and once the day is over; one with no day falls due
 *         once, at the deal's end;
 *   E-02  the first record for a thing due stands; the owner may amend their
 *         own answer, never what the protocol established;
 *   E-03  the summary counts kept of answered, no-fault lapses neither way,
 *         and is shareable only when both owners said yes — the counts alone;
 *   E-04  a promise reads in its own words, nothing priced.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { deliveryDayOf } from '../../src/commerce/deal_kinds';
import {
  describePromise,
  EvidenceStore,
  occurrencesDue,
  promiseSummary,
  type Evidence,
} from '../../src/commitment/evidence';
import { localDateOf } from '../../src/commitment/options';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const D = 24 * 3600_000;
const dayOf = (at: number) => deliveryDayOf(at, 'UTC');
const dateOf = (at: number) => localDateOf(at, 'UTC');
const START = Date.parse('2026-11-02T00:00:00Z'); // a Monday
const BRAND = 'did:plc:brand';

let dir: string;
let db: NodeSQLiteAdapter;
let store: EvidenceStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-evidence-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new EvidenceStore(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const answer = (
  occurrence: string,
  outcome: 'kept' | 'broken',
  source: 'owner' | 'protocol' = 'owner',
) =>
  store.record({
    counterpartyDid: BRAND,
    dealRef: 'deal-1',
    subject: 'promise',
    item: 'stock_run',
    occurrence,
    outcome,
    fault: outcome === 'broken' ? 'counterparty' : 'none',
    source,
    note: '',
    facts: {},
    recordedAt: START,
  });

describe('evidence', () => {
  it('E-01: when a promise falls due', () => {
    const weekly = { day: 'wed' };
    // Two Wednesdays have passed by Friday the 13th; the 11th's is over.
    expect(
      occurrencesDue({
        dimensions: weekly,
        startMs: START,
        endMs: START + 60 * D,
        nowMs: START + 11 * D,
        dayOf,
        dateOf,
      }),
    ).toEqual(['2026-11-04', '2026-11-11']);
    // The day itself is not over yet.
    expect(
      occurrencesDue({
        dimensions: weekly,
        startMs: START,
        endMs: START + 60 * D,
        nowMs: START + 2.5 * D,
        dayOf,
        dateOf,
      }),
    ).toEqual([]);
    // Every 14 days: the 4th, then the 18th (not over yet on the 17th).
    expect(
      occurrencesDue({
        dimensions: { day: 'wed', every_days: '14' },
        startMs: START,
        endMs: START + 60 * D,
        nowMs: START + 15 * D,
        dayOf,
        dateOf,
      }),
    ).toEqual(['2026-11-04']);
    // Only the last 14 days are asked about.
    expect(
      occurrencesDue({
        dimensions: weekly,
        startMs: START,
        endMs: START + 90 * D,
        nowMs: START + 40 * D,
        dayOf,
        dateOf,
      }),
    ).toEqual(['2026-12-02', '2026-12-09']);
    // A promise with no day: once, after the deal's end.
    expect(
      occurrencesDue({
        dimensions: { crates: '2' },
        startMs: START,
        endMs: START + 10 * D,
        nowMs: START + 12 * D,
        dayOf,
        dateOf,
      }),
    ).toEqual(['whole']);
    expect(
      occurrencesDue({
        dimensions: { crates: '2' },
        startMs: START,
        endMs: START + 10 * D,
        nowMs: START + 5 * D,
        dayOf,
        dateOf,
      }),
    ).toEqual([]);
  });

  it('E-02: first record stands; the owner amends their own answer only', () => {
    const first = answer('2026-11-04', 'kept');
    expect(answer('2026-11-04', 'broken').outcome).toBe('kept');
    expect(
      store.amend(
        first.evidenceId,
        { outcome: 'broken', note: 'they came the next day' },
        START + D,
      ),
    ).toMatchObject({
      outcome: 'broken',
      fault: 'counterparty',
      note: 'they came the next day',
      amendedAt: START + D,
    });
    const lapse = store.record({
      counterpartyDid: BRAND,
      dealRef: 'q-1',
      subject: 'run',
      item: 'opt-1',
      occurrence: '2026-11-10',
      outcome: 'no_fault',
      fault: 'none',
      source: 'protocol',
      note: '',
      facts: { answer: 'arrived_after_grace' },
      recordedAt: START,
    });
    expect(store.amend(lapse.evidenceId, { outcome: 'broken', note: '' }, START)).toBeNull();
  });

  it('E-03: the summary, and when it may be shared', () => {
    answer('2026-11-04', 'kept');
    answer('2026-11-11', 'kept');
    answer('2026-11-18', 'broken');
    answer('2026-11-25', 'kept', 'protocol');
    const all: Evidence[] = store.forCounterparty(BRAND);
    expect(promiseSummary(all, store.consent(BRAND))).toEqual({
      kept: 3,
      of: 4,
      noFault: 0,
      shareable: false,
    });
    store.setOwnConsent(BRAND, true, START);
    expect(promiseSummary(all, store.consent(BRAND)).shareable).toBe(false);
    store.setPeerConsent(BRAND, true, 1, '', START);
    expect(promiseSummary(all, store.consent(BRAND)).shareable).toBe(true);
    store.setOwnConsent(BRAND, false, START);
    // An older word from the other side never undoes a newer one.
    expect(store.setPeerConsent(BRAND, false, 1, '', START)).toBe(false);
    expect(store.consent(BRAND)).toEqual({ self: false, peer: true });
    // A change is numbered by its own time: one made after a restore from an
    // older backup is still newer than any the other side kept.
    db.execute(`UPDATE commitment_evidence_consent SET self_rev = 2 WHERE counterparty_did = ?`, [BRAND]);
    store.setOwnConsent(BRAND, true, START + 9 * D);
    expect(store.untold()[0]?.rev).toBe(START + 9 * D);
  });

  it('E-04: a promise in its own words', () => {
    expect(
      describePromise({
        name: 'stock_run',
        dimensions: { crates: '2', day: 'wed', every_days: '7' },
      }),
    ).toBe('stock run (crates 2, day wed)');
  });
});
