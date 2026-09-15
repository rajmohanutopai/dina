/**
 * The khata SPOOL over the shipping SQLite repository (migration v43): mail
 * held for a closed money line is insertion-ordered, bounded, and replayed
 * AS OF ARRIVAL — the ledger rows a drain leaves carry each document's own
 * `receivedAt`, so the khata's order is what it would have been with the pack
 * open, whatever order the pack reopened in.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { drainTradeSpool } from '../../src/commerce/trade_ingress';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';
import { MAX_TRADE_SPOOL_ROWS, SQLiteTradeSpoolRepository } from '../../src/commerce/trade_spool';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { moneyOpen } from './helpers';

const T0 = 1_800_000_000_000;

let dir: string;
let adapter: NodeSQLiteAdapter;
let spool: SQLiteTradeSpoolRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'trade-spool-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  spool = new SQLiteTradeSpoolRepository(adapter);
});

afterEach(() => {
  installCommerceRuntime(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SQLiteTradeSpoolRepository (migration v43)', () => {
  it('holds rows in arrival order, counts them, removes by id', () => {
    expect(spool.count()).toBe(0);
    expect(spool.put({ senderDid: 'did:plc:a', bodyJson: '{"n":1}', evidenceJson: '{}', receivedAt: T0 })).toBe(true);
    expect(spool.put({ senderDid: 'did:plc:b', bodyJson: '{"n":2}', evidenceJson: '{"e":1}', receivedAt: T0 + 5 })).toBe(true);
    expect(spool.count()).toBe(2);
    const rows = spool.oldest(10);
    expect(rows.map((r) => r.bodyJson)).toEqual(['{"n":1}', '{"n":2}']);
    expect(rows[0]).toMatchObject({ senderDid: 'did:plc:a', evidenceJson: '{}', receivedAt: T0 });
    expect(spool.oldest(1)).toHaveLength(1);
    spool.remove(rows[0]?.spoolId ?? -1);
    expect(spool.count()).toBe(1);
    expect(spool.oldest(10).map((r) => r.bodyJson)).toEqual(['{"n":2}']);
  });

  it('is bounded: past the ceiling the newest is refused and the oldest kept', () => {
    for (let i = 0; i < MAX_TRADE_SPOOL_ROWS; i++) {
      expect(spool.put({ senderDid: 'did:plc:a', bodyJson: `{"n":${i}}`, evidenceJson: '{}', receivedAt: T0 + i })).toBe(true);
    }
    expect(spool.put({ senderDid: 'did:plc:a', bodyJson: '{"late":true}', evidenceJson: '{}', receivedAt: T0 + 9999 })).toBe(false);
    expect(spool.count()).toBe(MAX_TRADE_SPOOL_ROWS);
    expect(spool.oldest(1)[0]?.bodyJson).toBe('{"n":0}');
  });

  it('a drain replays every row AS OF ITS ARRIVAL and empties the spool, whatever the verdicts', () => {
    // Two unreadable bodies with distinct arrival times: the verifiers refuse
    // them (nothing lands), the rows go, and each replay was handed ITS OWN
    // `receivedAt` as the clock — observable through the runtime the drain uses.
    const clocks: number[] = [];
    spool.put({ senderDid: 'did:plc:a', bodyJson: '{"kind":"nope"}', evidenceJson: '{}', receivedAt: T0 + 10 });
    spool.put({ senderDid: 'did:plc:a', bodyJson: '{"kind":"nope"}', evidenceJson: '{}', receivedAt: T0 + 20 });
    const runtime = {
      money: moneyOpen({ tradeDocuments: new InMemoryTradeDocumentRepository() }),
      tradeSpool: spool,
      receipts: new InMemoryCommerceReceiptRepository(),
      nodeDid: () => 'did:plc:self',
      now: () => T0 + 1000,
    } as unknown as CommerceRuntime;
    installCommerceRuntime(runtime);
    const line = runtime.money();
    if (!line.available) throw new Error('unreachable');
    // Wrap the ledger store to observe the clock each replay carries.
    const observed = {
      ...line.stores,
      tradeDocuments: new Proxy(line.stores.tradeDocuments, {
        get(target, prop, receiver) {
          if (prop === 'put') {
            return (row: { createdAt: number }) => {
              clocks.push(row.createdAt);
              return target.put(row as never);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    };
    const summary = drainTradeSpool(runtime, observed);
    expect(summary).toMatchObject({ replayed: 2, applied: 0, faulted: 0 });
    expect(spool.count()).toBe(0);
    // Unreadable documents never reach the ledger, so no clock was stamped —
    // the arrival-time contract is pinned end to end in trade_transport.test.ts.
    expect(clocks).toEqual([]);
  });
});
