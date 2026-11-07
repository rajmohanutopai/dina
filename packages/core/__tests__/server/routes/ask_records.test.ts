/**
 * `/v1/ask-records` (FIXES F11): Brain's live asks, kept in Core across a
 * restart. Driven through the real router and the in-process client against
 * SQLite, so the route, the wire mapping and the table are all exercised.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  setAskRecordRepository,
  SQLiteAskRecordRepository,
  type StoredAskRecord,
} from '../../../src/ask/ask_record_repository';
import { isAuthorized } from '../../../src/auth/authz';
import { InProcessTransport } from '../../../src/client/in-process-transport';
import { CoreRouter } from '../../../src/server/router';
import { registerAskRecordRoutes } from '../../../src/server/routes/ask_records';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

const RECORD: StoredAskRecord = {
  id: 'ask-1',
  question: 'When is my dentist appointment?',
  requesterDid: 'did:plc:owner',
  status: 'pending_approval',
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
  deadlineMs: 61_000,
  forcedSources: ['vault'],
  conversation: 'thread-1',
  approvalId: 'appr-1',
};

describe('/v1/ask-records', () => {
  let dir = '';
  let dbPath = '';
  const passphraseHex = randomBytes(32).toString('hex');
  let db: NodeSQLiteAdapter;
  let core: InProcessTransport;
  let router: CoreRouter;

  const open = (): void => {
    db = new NodeSQLiteAdapter({ path: dbPath, passphraseHex, journalMode: 'WAL', synchronous: 'NORMAL' });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    setAskRecordRepository(new SQLiteAskRecordRepository(db));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-ask-records-'));
    dbPath = path.join(dir, 'identity.sqlite');
    open();
    router = new CoreRouter();
    registerAskRecordRoutes(router);
    core = new InProcessTransport(router);
  });

  afterEach(() => {
    setAskRecordRepository(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a record across a restart, and gives it back as written', async () => {
    await core.askRecordPut(RECORD);
    db.close();
    open();
    expect(await core.askRecordList()).toEqual([RECORD]);
  });

  it('drops a paused state or an answer sent with the record', async () => {
    const res = await router.handle({
      method: 'POST',
      path: '/v1/ask-records',
      query: {},
      headers: {},
      body: {
        id: 'ask-2',
        question: 'q',
        requester_did: 'did:plc:owner',
        status: 'pending_approval',
        created_at_ms: 1,
        updated_at_ms: 1,
        deadline_ms: 2,
        paused_state_json: '{"messages":["vault content"]}',
        answer_json: '{"text":"vault content"}',
      },
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
    });
    expect(res.status).toBe(200);
    const rows = db.query('SELECT * FROM ask_records WHERE id = ?', ['ask-2']);
    expect(JSON.stringify(rows)).not.toContain('vault content');
  });

  it('refuses a record that has ended, and deletes on request', async () => {
    await expect(core.askRecordPut({ ...RECORD, status: 'complete' as never })).rejects.toThrow('400');
    await core.askRecordPut(RECORD);
    expect(await core.askRecordDelete('ask-1')).toBe(true);
    expect(await core.askRecordDelete('ask-1')).toBe(false);
    expect(await core.askRecordList()).toEqual([]);
  });

  it('is open to Brain and admin, not to a paired device', () => {
    expect(isAuthorized('brain', 'GET', '/v1/ask-records')).toBe(true);
    expect(isAuthorized('admin', 'POST', '/v1/ask-records/delete')).toBe(true);
    expect(isAuthorized('device', 'GET', '/v1/ask-records')).toBe(false);
    expect(isAuthorized('agent', 'GET', '/v1/ask-records')).toBe(false);
  });
});
