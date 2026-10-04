/**
 * Idempotency receipts and per-principal budgets (design §4.1, §7.2 steps
 * 5–6): a receipt answers the same call with the same task and refuses a
 * reused message id with a different request; budgets are per principal,
 * new calls and replays counted apart, over a sliding minute.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  A2A_PRINCIPAL_BUDGET_PER_MINUTE,
  A2A_REPLAY_CEILING_PER_MINUTE,
  PrincipalBudgets,
  checkReceipt,
  insertReceipt,
} from '../../src/a2a/receipts';
import { A2AStore } from '../../src/a2a/store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

let dir: string;
let db: NodeSQLiteAdapter;
let store: A2AStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-receipts-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'bb'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new A2AStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const KEY = { principal: 'a2a:ac_1', operation: 'SendMessage', messageId: 'm-1' };

describe('receipts', () => {
  it('a miss, then the same call replays, and a different request under the same id conflicts', () => {
    expect(checkReceipt(store, KEY, 'h1')).toEqual({ kind: 'miss' });
    insertReceipt(store, {
      principal: KEY.principal,
      operation: KEY.operation,
      message_id: KEY.messageId,
      request_hash_pre: 'h1',
      request_hash_post: 'p1',
      mapped_external_id: 'task-1',
      status: 'accepted',
      created_at: 1,
    });
    const replay = checkReceipt(store, KEY, 'h1');
    expect(replay.kind === 'replay' && replay.receipt.mapped_external_id).toBe('task-1');
    expect(checkReceipt(store, KEY, 'h2')).toEqual({ kind: 'conflict' });
  });

  it('keys by principal and operation too', () => {
    insertReceipt(store, {
      principal: KEY.principal,
      operation: KEY.operation,
      message_id: KEY.messageId,
      request_hash_pre: 'h1',
      request_hash_post: null,
      mapped_external_id: 'task-1',
      status: 'rejected',
      created_at: 1,
    });
    expect(checkReceipt(store, { ...KEY, principal: 'a2a:ac_2' }, 'h1')).toEqual({ kind: 'miss' });
    expect(checkReceipt(store, { ...KEY, operation: 'CancelTask' }, 'h1')).toEqual({ kind: 'miss' });
  });
});

describe('per-principal budgets', () => {
  it('spends a principal’s own budget only, and refills after a minute', () => {
    const budgets = new PrincipalBudgets();
    for (let i = 0; i < A2A_PRINCIPAL_BUDGET_PER_MINUTE; i += 1) expect(budgets.chargeMiss('a2a:ac_1', 1_000)).toBe(true);
    expect(budgets.chargeMiss('a2a:ac_1', 1_000)).toBe(false);
    // Another client is untouched: more than 60 calls in aggregate pass.
    expect(budgets.chargeMiss('a2a:ac_2', 1_000)).toBe(true);
    expect(budgets.chargeMiss('a2a:ac_1', 61_000)).toBe(true);
  });

  it('counts replays apart, under a ceiling ten times the budget', () => {
    const budgets = new PrincipalBudgets();
    for (let i = 0; i < A2A_PRINCIPAL_BUDGET_PER_MINUTE; i += 1) budgets.chargeMiss('a2a:ac_1', 1_000);
    expect(budgets.chargeReplay('a2a:ac_1', 1_000)).toBe(true);
    for (let i = 1; i < A2A_REPLAY_CEILING_PER_MINUTE; i += 1) budgets.chargeReplay('a2a:ac_1', 1_000);
    expect(budgets.chargeReplay('a2a:ac_1', 1_000)).toBe(false);
  });
});
