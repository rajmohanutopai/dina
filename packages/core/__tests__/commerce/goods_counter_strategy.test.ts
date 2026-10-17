/**
 * COMMITMENT_KERNEL §15 step 11 — Brain bargains a goods tender's counters.
 *
 *   GC-01  with Brain chosen, the round waits for Brain; the brief holds the
 *          quote, never the owner's target or ceiling; Brain's target goes,
 *          one verdict charged;
 *   GC-02  Brain's target is raised to the owner's target; one over the
 *          ceiling, or at or over the quote, lets the owner's target go, so
 *          no counter carries the ceiling;
 *   GC-03  no answer within the wait, too little time left, no budget, the
 *          fixed style, or a move that is not a total: the owner's target;
 *   GC-04  each round is its own turn; a replayed commit changes nothing.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  commitGoodsCounterMove,
  GOODS_COUNTER_WAIT_MS,
  goodsCounterTarget,
  goodsNegotiationId,
  installGoodsCounterStrategy,
} from '../../src/commerce/goods_counter_strategy';
import { StrategyTurnStore } from '../../src/commitment/strategy_turns';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { makeQuoteRequest, makeSignedQuote } from './helpers';

import type { SentCounter, TenderNegotiation } from '../../src/commerce/buyer_negotiation_store';
import type { NegotiationBrief } from '../../src/commitment/strategy_submit';

const NOW = Date.parse('2026-08-10T09:00:00.000Z');

let dir: string;
let db: NodeSQLiteAdapter;
let briefs: NegotiationBrief[];
let settings: { strategy: 'fixed' | 'brain'; valuesOn: boolean };
let budget: number;

const tender: TenderNegotiation = {
  tenderId: 'tnd-1',
  currency: 'INR',
  targetTotalMinor: '42000',
  budgetCeilingMinor: '48000',
  maxRounds: 3,
  deadlineAt: NOW + 90_000,
  state: 'negotiating',
  awardedSupplierDid: '',
  approvalId: '',
  updatedAt: NOW,
};
// The supplier's quote: 100 × ₹500.
const head = makeSignedQuote(makeQuoteRequest());

const counter = (round: number): SentCounter => ({
  counterId: `c-${String(round)}`,
  tenderId: tender.tenderId,
  supplierDid: head.supplier_did,
  quoteId: head.quote_id,
  round,
  state: 'revised',
  counterJson: '{}',
  answerDigest: '',
  sentAt: NOW,
  answeredAt: NOW,
  attempts: 1,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-goods-counter-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  briefs = [];
  settings = { strategy: 'brain', valuesOn: true };
  budget = 5;
  installGoodsCounterStrategy({
    settings: () => settings,
    canSpend: () => budget > 0,
    charge: () => {
      if (budget <= 0) return false;
      budget -= 1;
      return true;
    },
    turns: new StrategyTurnStore(db),
    submit: (brief) => {
      briefs.push(brief);
      return { taskId: `task-${String(briefs.length)}` };
    },
    brainModel: () => null,
    nowMs: () => NOW,
  });
});

afterEach(() => {
  installGoodsCounterStrategy(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = (counters: SentCounter[] = [], nowMs = NOW) =>
  goodsCounterTarget({ tender, head, counters, nowMs });
const move = (round: number, total: string) =>
  commitGoodsCounterMove({
    input: {
      kind: 'goods.buyer',
      ref: { negotiationId: goodsNegotiationId(tender.tenderId, head.quote_id), turn: round },
    },
    result: { move: { kind: 'propose', versions: [{ terms: [{ name: 'total', value: total }] }] } },
  });

describe('Brain bargains goods counters (§15 step 11)', () => {
  it('GC-01: the round waits for Brain, whose brief holds no target or ceiling; its target goes', () => {
    expect(target()).toBe('wait');
    const brief = briefs[0];
    expect(brief?.ref).toEqual({ negotiationId: 'tnd-1|q-1', turn: 1 });
    expect(brief?.table).toMatchObject({ terms: [{ name: 'total', value: '50000' }] });
    expect(JSON.stringify(brief)).not.toMatch(/42000|48000/);
    expect(move(1, '45000').receipt).toEqual({ outcome: 'answered' });
    expect(target()).toBe('45000');
    expect(budget).toBe(4);
  });

  it('GC-02: raised to the owner’s target; over the ceiling or the quote, the owner’s target', () => {
    target();
    move(1, '30000');
    expect(target()).toBe('42000');
    target([counter(1)]);
    move(2, '49000');
    // Over the ceiling: the owner's target goes, never the ceiling itself.
    expect(target([counter(1)])).toBe('42000');
    const high = { ...head, total: { currency: 'INR', minor_units: '46000' } };
    goodsCounterTarget({ tender, head: high, counters: [counter(1), counter(2)], nowMs: NOW });
    move(3, '47000');
    expect(
      goodsCounterTarget({ tender, head: high, counters: [counter(1), counter(2)], nowMs: NOW }),
    ).toBe('42000');
  });

  it('GC-03: no answer in time, too little time, no budget, the fixed style, or no total: the owner’s target', () => {
    expect(target()).toBe('wait');
    expect(target([], NOW + GOODS_COUNTER_WAIT_MS - 1)).toBe('wait');
    expect(target([], NOW + GOODS_COUNTER_WAIT_MS)).toBe('42000');
    expect(move(1, '45000').receipt).toEqual({ outcome: 'already_applied' });
    expect(target([counter(1)], tender.deadlineAt - 10_000)).toBe('42000');
    budget = 0;
    expect(target([counter(1)])).toBe('42000');
    budget = 5;
    settings = { strategy: 'fixed', valuesOn: true };
    expect(target([counter(1)])).toBe('42000');
    settings = { strategy: 'brain', valuesOn: true };
    expect(target([counter(1)])).toBe('wait');
    expect(
      commitGoodsCounterMove({
        input: { kind: 'goods.buyer', ref: { negotiationId: 'tnd-1|q-1', turn: 2 } },
        result: { move: { kind: 'stop' } },
      }).receipt,
    ).toEqual({ outcome: 'fixed_style' });
    expect(target([counter(1)])).toBe('42000');
  });

  it('GC-04: each round is its own turn; a replayed commit changes nothing', () => {
    target();
    expect(move(1, '45000').receipt).toEqual({ outcome: 'answered' });
    expect(move(1, '43000').receipt).toEqual({ outcome: 'already_applied' });
    expect(target()).toBe('45000');
    expect(target([counter(1)])).toBe('wait');
    expect(briefs.map((b) => b.ref.turn)).toEqual([1, 2]);
  });
});
