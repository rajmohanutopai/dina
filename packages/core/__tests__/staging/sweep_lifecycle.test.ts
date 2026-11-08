/**
 * REQ-01, REQ-04, REQ-09, REQ-S1: the staging sweep, its timer, and what it may
 * and may not do to a row. Runs on the same SQLite repository both hosts use.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createPersona, openPersona, resetPersonaState } from '../../src/persona/service';
import { listByPersona, resetReminderState } from '../../src/reminders/service';
import { resetDataScope } from '../../src/scope/data_scope';
import { SQLiteStagingRepository, setStagingRepository } from '../../src/staging/repository';
import {
  StaleStagingClaimError,
  claim,
  claimById,
  drainForPersona,
  extendLease,
  fail,
  getItem,
  ingest,
  resetStagingState,
  resolve,
  resolveMultiDetailed,
  sweep,
} from '../../src/staging/service';
import { StagingSweeper } from '../../src/staging/sweeper';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { clearVaults, listRecentItems } from '../../src/vault/crud';
import { SQLiteWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, getWorkflowService, setWorkflowService } from '../../src/workflow/service';

function openDB(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-staging-sweep-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return adapter;
}

const nowS = (): number => Math.floor(Date.now() / 1000);
const classified = { type: 'note', summary: 's', body: 'x' };

describe('staging sweep and timer', () => {
  beforeEach(() => {
    const db = openDB();
    setStagingRepository(new SQLiteStagingRepository(db));
    resetStagingState();
    resetPersonaState();
    resetDataScope();
    resetReminderState();
    clearVaults();
    const repo = new SQLiteWorkflowRepository(db);
    setWorkflowRepository(repo);
    setWorkflowService(new WorkflowService({ repository: repo }));
    createPersona('general', 'default');
    openPersona('general');
  });

  describe('REQ-01: no owner memory is deleted at TTL', () => {
    it('keeps an owner-direct pending_unlock memory past TTL', () => {
      createPersona('health', 'sensitive');
      const { id } = ingest({ source: 'user_remember', source_id: 'h1', data: { body: 'x' } });
      claim(1);
      resolve(id, 'health', true, classified);
      const before = getItem(id)!;
      expect(before.status).toBe('pending_unlock');

      sweep(before.expires_at + 1);

      expect(getItem(id)?.status).toBe('pending_unlock');
    });

    it.each(['user_remember', 'chat_auto'])('keeps a %s row in every unstored state', (source) => {
      const failed = ingest({ source, source_id: 'f' }).id;
      claim(1);
      fail(failed, 'llm outage');
      const held = ingest({ source, source_id: 'c' }).id;
      claim(1);
      const received = ingest({ source, source_id: 'r' }).id;

      sweep(getItem(received)!.expires_at + 1);

      for (const id of [received, failed, held]) expect(getItem(id)).not.toBeNull();
    });

    it('deletes a stored owner row and a connector row at TTL', () => {
      const stored = ingest({ source: 'user_remember', source_id: 's' }).id;
      claim(1);
      resolve(stored, 'general', true, classified);
      const connector = ingest({ source: 'gmail', source_id: 'g' }).id;
      const far = getItem(connector)!.expires_at + 1;

      const result = sweep(far);

      expect(getItem(stored)).toBeNull();
      expect(getItem(connector)).toBeNull();
      expect(result.expired).toBe(2);
    });

    it('a card for an owner memory never lapses on its own', () => {
      createPersona('health', 'sensitive');
      const { id } = ingest({ source: 'chat_auto', source_id: 'c1', data: { body: 'x' } });
      claim(1);
      resolve(id, 'health', false, classified);
      const card = getWorkflowService()!.store().getById(getItem(id)!.approval_id!);
      expect(card).not.toBeNull();
      expect(card?.expires_at).toBeUndefined();
    });
  });

  describe('REQ-01: revert and retry', () => {
    it('reverts a lapsed lease so the row can be claimed again', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      const claimed = claim(1)[0]!;

      const result = sweep(claimed.lease_until + 1);

      expect(result.leaseReverted).toBe(1);
      expect(getItem(id)?.status).toBe('received');
      expect(claim(1).map((row) => row.id)).toEqual([id]);
    });

    it('counts lease reverts, so a row that kills its worker cannot loop until TTL', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'poison' });
      let at = nowS();
      for (let i = 0; i < 4; i += 1) {
        const row = claim(1)[0];
        expect(row?.id).toBe(id);
        at = row!.lease_until + 1;
        sweep(at);
      }
      const dead = getItem(id)!;
      expect(dead.status).toBe('failed');
      expect(dead.retry_count).toBe(4);
      expect(claim(1)).toEqual([]);
      sweep(at + 86_400);
      expect(getItem(id)?.status).toBe('failed');
    });

    it('backs off a failed row, so an outage does not burn every retry in minutes', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'outage' });
      claim(1);
      fail(id, 'llm outage');
      const retryAt = getItem(id)!.lease_until;
      expect(retryAt).toBeGreaterThan(nowS());

      expect(sweep(retryAt - 1).requeued).toBe(0);
      expect(getItem(id)?.status).toBe('failed');

      expect(sweep(retryAt).requeued).toBe(1);
      expect(getItem(id)?.status).toBe('received');
    });
  });

  describe('REQ-S1: a stale worker cannot touch the next claim', () => {
    const staleAndLive = (): { id: string; stale: string; live: string } => {
      const { id } = ingest({ source: 'gmail', source_id: 'c1', data: { body: 'x' } });
      const a = claim(1)[0]!;
      sweep(a.lease_until + 1);
      const b = claim(1)[0]!;
      return { id, stale: a.claim_token!, live: b.claim_token! };
    };

    it('mints a new token per claim', () => {
      const { stale, live } = staleAndLive();
      expect(stale).toBeTruthy();
      expect(live).toBeTruthy();
      expect(stale).not.toBe(live);
    });

    it('refuses a stale fail, resolve and extend; the live claim then lands', () => {
      const { id, stale, live } = staleAndLive();

      expect(() => fail(id, 'stale', stale)).toThrow(StaleStagingClaimError);
      expect(() => extendLease(id, 60, stale)).toThrow(StaleStagingClaimError);
      expect(() => resolve(id, 'general', true, classified, stale)).toThrow(StaleStagingClaimError);
      expect(() =>
        resolveMultiDetailed(id, [{ persona: 'general', personaOpen: true }], classified, stale),
      ).toThrow(StaleStagingClaimError);
      expect(getItem(id)?.status).toBe('classifying');

      resolve(id, 'general', true, classified, live);
      expect(getItem(id)?.status).toBe('stored');
    });

    it('claimById mints one too, and it takes the expired claim from the old holder', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'c2' });
      const a = claim(1, -10)[0]!;
      const b = claimById(id, 900)!;
      expect(b.claim_token).toBeTruthy();
      expect(() => fail(id, 'stale', a.claim_token)).toThrow(StaleStagingClaimError);
    });
  });

  describe('REQ-04: parked memories drain', () => {
    it('parking clears the raw body and keeps the classified copy', () => {
      const { id } = ingest({ source: 'user_remember', source_id: 'r1', data: { body: 'raw text' } });
      claim(1);
      resolve(id, 'newvault', true, { ...classified, body: 'raw text' });
      const parked = getItem(id)!;
      expect(parked.status).toBe('pending_unlock');
      expect(parked.data.body).toBe('');
      expect(parked.classified_item?.body).toBe('raw text');
    });

    it('a parked row with nothing classified keeps its body, the only copy', () => {
      const { id } = ingest({ source: 'user_remember', source_id: 'r2', data: { body: 'raw text' } });
      claim(1);
      resolve(id, 'newvault', true);
      expect(getItem(id)?.data.body).toBe('raw text');
    });

    it('the sweeper stores a parked memory once its persona exists and is open', async () => {
      const { id } = ingest({ source: 'user_remember', source_id: 'r3', data: { body: 'x' } });
      claim(1);
      resolve(id, 'newvault', true, classified);
      const sweeper = new StagingSweeper({ setInterval: () => 1, clearInterval: () => undefined });

      await sweeper.runTick(); // no persona yet
      expect(getItem(id)?.status).toBe('pending_unlock');

      createPersona('newvault', 'standard');
      openPersona('newvault', true);
      clearVaults(['general', 'newvault']);
      await sweeper.runTick();

      const stored = getItem(id)!;
      expect(stored.status).toBe('stored');
      expect(stored.error).toBeUndefined();
      expect(listRecentItems('newvault', 10)).toHaveLength(1);
    });

    it('leaves a row behind a card alone: only the owner answers those', async () => {
      createPersona('health', 'sensitive');
      const { id } = ingest({ source: 'gmail', source_id: 'g1', data: { body: 'x' } });
      claim(1);
      resolve(id, 'health', false, classified);
      openPersona('health', true);
      clearVaults(['general', 'health']);

      await new StagingSweeper({ setInterval: () => 1, clearInterval: () => undefined }).runTick();

      expect(getItem(id)?.status).toBe('pending_unlock');
      expect(listRecentItems('health', 10)).toHaveLength(0);
    });

    it('creates the reminders a drained memory planned', async () => {
      const { id } = ingest({ source: 'user_remember', source_id: 'r4', data: { body: 'x' } });
      claim(1);
      resolve(id, 'newvault', true, {
        ...classified,
        metadata: JSON.stringify({
          remember: {
            reminders: [
              { message: 'dentist', dueAtMs: Date.now() + 60_000, persona: 'newvault', timezone: 'UTC' },
            ],
          },
        }),
      });
      createPersona('newvault', 'standard');
      openPersona('newvault', true);
      clearVaults(['general', 'newvault']);

      await new StagingSweeper({ setInterval: () => 1, clearInterval: () => undefined }).runTick();

      expect(listByPersona('newvault').map((r) => r.message)).toEqual(['dentist']);
    });
  });

  describe('REQ-09: a partial multi-persona resolve', () => {
    const partial = (): { id: string; result: ReturnType<typeof resolveMultiDetailed> } => {
      createPersona('b', 'standard');
      openPersona('b', true);
      clearVaults(['general']); // `b` is open in the registry, its vault DB is not
      const { id } = ingest({ source: 'gmail', source_id: 'm1', data: { body: 'x' } });
      claim(1);
      const result = resolveMultiDetailed(
        id,
        [
          { persona: 'b', personaOpen: true },
          { persona: 'general', personaOpen: true },
        ],
        classified,
      );
      return { id, result };
    };

    it('names a vault that stored, and keeps a row for the one that failed', () => {
      const { id, result } = partial();
      expect(result.failedPersonas).toEqual(['b']);
      expect(getItem(id)?.status).toBe('stored');
      expect(getItem(id)?.persona).toBe('general');
      expect(getItem(`${id}-b`)?.status).toBe('pending_unlock');
    });

    it('the failed target reaches stored once its vault opens', () => {
      const { id } = partial();
      expect(drainForPersona('b')).toBe(0);
      clearVaults(['general', 'b']);
      expect(drainForPersona('b')).toBe(1);
      expect(getItem(`${id}-b`)?.status).toBe('stored');
      expect(listRecentItems('b', 10)).toHaveLength(1);
    });
  });

  describe('StagingSweeper', () => {
    it('sweeps at start and on its interval, and stops', async () => {
      const ticks: (() => void)[] = [];
      let cleared = 0;
      const { id } = ingest({ source: 'gmail', source_id: 't1' });
      claim(1, -10);
      const sweeper = new StagingSweeper({
        setInterval: (fn) => {
          ticks.push(fn);
          return 1;
        },
        clearInterval: () => {
          cleared += 1;
        },
      });

      sweeper.start();
      await sweeper.flush();
      expect(getItem(id)?.status).toBe('received');

      claim(1, -10);
      ticks[0]!();
      await sweeper.flush();
      expect(getItem(id)?.status).toBe('received');

      sweeper.stop();
      expect(cleared).toBe(1);
    });

    it('reports a failed tick and goes on', async () => {
      const errors: unknown[] = [];
      setStagingRepository({
        ...new SQLiteStagingRepository(openDB()),
        sweep: () => {
          throw new Error('disk');
        },
      } as never);
      const sweeper = new StagingSweeper({
        setInterval: () => 1,
        clearInterval: () => undefined,
        onError: (err) => errors.push(err),
      });
      await sweeper.runTick();
      expect(errors).toHaveLength(1);
    });
  });
});
