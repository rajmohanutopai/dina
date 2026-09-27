/**
 * v50 — the outcome joins the tender notice key (NEGOTIATION_PLAN §4.6).
 * Driven through the real migration runner on a real SQLCipher file.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLiteBuyerNegotiationRepository } from '../../src/commerce/buyer_negotiation_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

function withVault(body: (adapter: NodeSQLiteAdapter) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-notice-migrate-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  try {
    body(adapter);
  } finally {
    adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('v50 migration — tender notices keyed by outcome', () => {
  it('keeps every notice written before it, as a not-awarded notice, and then holds both outcomes for one supplier', () => {
    withVault((adapter) => {
      applyMigrations(
        adapter,
        IDENTITY_MIGRATIONS.filter((m) => m.version < 50),
      );
      adapter.run(
        `INSERT INTO commerce_tender_notices
           (tender_id, supplier_did, request_id, quote_id, service_rkey, state, attempts, updated_at)
         VALUES ('tnd_1', 'did:plc:a', 'req_1', 'q_1', 'self', 'sent', 1, 100)`,
      );

      applyMigrations(adapter, IDENTITY_MIGRATIONS);

      const repo = new SQLiteBuyerNegotiationRepository(adapter);
      expect(repo.listNoticesForTender('tnd_1')).toEqual([
        {
          tenderId: 'tnd_1',
          supplierDid: 'did:plc:a',
          outcome: 'not_awarded',
          requestId: 'req_1',
          quoteId: 'q_1',
          serviceRkey: 'self',
          state: 'sent',
          attempts: 1,
          updatedAt: 100,
        },
      ]);
      repo.putNotice({
        tenderId: 'tnd_1',
        supplierDid: 'did:plc:a',
        outcome: 'negotiation_closed',
        requestId: 'req_1',
        quoteId: 'q_1',
        serviceRkey: 'self',
        state: 'pending',
        attempts: 0,
        updatedAt: 200,
      });
      repo.updateNotice('tnd_1', 'did:plc:a', 'negotiation_closed', 'sent', 1, 300);
      expect(
        repo.listNoticesForTender('tnd_1').map((n) => [n.outcome, n.state, n.updatedAt]),
      ).toEqual([
        ['negotiation_closed', 'sent', 300],
        ['not_awarded', 'sent', 100],
      ]);
      expect(repo.listNotices('pending')).toEqual([]);
    });
  });

  it('a vault that recorded v49 before v49 gained the notice table still migrates', () => {
    withVault((adapter) => {
      applyMigrations(
        adapter,
        IDENTITY_MIGRATIONS.filter((m) => m.version < 50),
      );
      // The bed's chairmaker, 2026-09-27: v49 recorded, this table absent.
      adapter.execute('DROP TABLE commerce_tender_notices');

      expect(applyMigrations(adapter, IDENTITY_MIGRATIONS)).toBe(1);
      expect(new SQLiteBuyerNegotiationRepository(adapter).listNotices('pending')).toEqual([]);
    });
  });
});
