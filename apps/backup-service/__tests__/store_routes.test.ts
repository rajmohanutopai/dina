/**
 * The store, driven by `@dina/core`'s own client (USER_BACKUP.md §4.3, §5):
 * the signer and this checker must agree byte for byte, so this is the
 * contract test between them. Core is imported by path: the service's image
 * carries only `@dina/protocol`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import {
  BackupStoreClient,
  BackupStoreError,
  deriveBackupIdentity,
  signBackupRequest,
  type BackupFetch,
} from '../../../packages/core/src';
import { countersToKeep } from '../src/retention';
import { buildServer } from '../src/server';
import { CopyStore } from '../src/store';

import type { BackupConfig } from '../src/config';
import type { FastifyInstance } from 'fastify';

const DAY = 86_400_000;

function config(over: Partial<BackupConfig> = {}): BackupConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: '',
    maxCopyBytes: 1024 * 1024,
    rateLimit: { max: 1000, windowMs: 60_000 },
    ...over,
  };
}

/** `fetch` over Fastify's inject, so the client's real requests reach the real routes. */
function injectFetch(app: FastifyInstance): BackupFetch {
  return async (url, init) => {
    const u = new URL(url);
    const res = await app.inject({
      method: init.method as 'GET',
      url: u.pathname + u.search,
      headers: init.headers,
      ...(init.body !== undefined ? { payload: Buffer.from(init.body) } : {}),
    });
    return {
      status: res.statusCode,
      arrayBuffer: async () => new Uint8Array(res.rawPayload).buffer,
      text: async () => res.payload,
    };
  };
}

describe('backup store', () => {
  let dir: string;
  let store: CopyStore;
  let app: FastifyInstance;
  let clock: number;

  const alonso = deriveBackupIdentity(new Uint8Array(32).fill(1));
  const sancho = deriveBackupIdentity(new Uint8Array(32).fill(2));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-backup-store-'));
    store = new CopyStore(path.join(dir, 'backups.sqlite'));
    clock = Date.now();
    app = await buildServer({ config: config(), store, now: () => clock, logLevel: 'silent' });
  });
  afterEach(async () => {
    await app.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const client = (id = alonso) => new BackupStoreClient('https://backup.test', id, injectFetch(app), () => clock);

  it('keeps copies byte-identical, lists them and returns the latest', async () => {
    const c = client();
    expect(await c.list()).toEqual([]);
    await c.put(1, new Uint8Array([1, 2, 3]));
    clock += DAY; // one copy a day is kept; the second is the next day's
    await c.put(2, new Uint8Array([4, 5]));
    expect((await c.list()).map((x) => [x.counter, x.size])).toEqual([
      [1, 3],
      [2, 2],
    ]);
    expect(Array.from((await c.get('latest')) ?? [])).toEqual([4, 5]);
    expect(Array.from((await c.get(1)) ?? [])).toEqual([1, 2, 3]);
    expect(await c.get(9)).toBeNull();
  });

  it('refuses a counter it holds, or one below the newest', async () => {
    const c = client();
    await c.put(5, new Uint8Array([1]));
    await expect(c.put(5, new Uint8Array([2]))).rejects.toMatchObject({ status: 409 });
    await expect(c.put(4, new Uint8Array([2]))).rejects.toBeInstanceOf(BackupStoreError);
    expect(Array.from((await c.get(5)) ?? [])).toEqual([1]);
  });

  it('one backup id cannot reach another’s copies', async () => {
    await client(alonso).put(1, new Uint8Array([9]));
    // Sancho's key, signing a call to Alonso's id.
    const p = `/v1/backups/${alonso.backupId}/1`;
    const res = await app.inject({
      method: 'GET',
      url: p,
      headers: signBackupRequest(sancho, 'GET', p, '', new Uint8Array()),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'key_does_not_match_id' });
    expect(await client(sancho).list()).toEqual([]);
  });

  it('refuses a replayed nonce, an old timestamp, a changed body and a missing signature', async () => {
    const p = `/v1/backups/${alonso.backupId}/1`;
    const body = new Uint8Array([1, 2]);
    const headers = {
      ...signBackupRequest(alonso, 'PUT', p, '', body),
      'content-type': 'application/octet-stream',
    };
    const put = (h: Record<string, string>, payload: Uint8Array = body) =>
      app.inject({ method: 'PUT', url: p, headers: h, payload: Buffer.from(payload) });
    expect((await put(headers)).statusCode).toBe(201);
    const replay = await put(headers);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: 'replayed_nonce' });

    const old = {
      ...signBackupRequest(alonso, 'PUT', `/v1/backups/${alonso.backupId}/2`, '', body, new Date(clock - 6 * 60_000)),
      'content-type': 'application/octet-stream',
    };
    const stale = await app.inject({
      method: 'PUT',
      url: `/v1/backups/${alonso.backupId}/2`,
      headers: old,
      payload: Buffer.from(body),
    });
    expect(stale.json()).toEqual({ error: 'bad_timestamp' });

    const p3 = `/v1/backups/${alonso.backupId}/3`;
    const changed = await app.inject({
      method: 'PUT',
      url: p3,
      headers: { ...signBackupRequest(alonso, 'PUT', p3, '', body), 'content-type': 'application/octet-stream' },
      payload: Buffer.from([7, 7]),
    });
    expect(changed.json()).toEqual({ error: 'bad_signature' });

    const bare = await app.inject({ method: 'GET', url: `/v1/backups/${alonso.backupId}/list` });
    expect(bare.json()).toEqual({ error: 'missing_headers' });
  });

  it('a replayed nonce stays refused after a restart', async () => {
    const p = `/v1/backups/${alonso.backupId}/list`;
    const headers = signBackupRequest(alonso, 'GET', p, '', new Uint8Array());
    expect((await app.inject({ method: 'GET', url: p, headers })).statusCode).toBe(200);
    await app.close();
    store.close();
    store = new CopyStore(path.join(dir, 'backups.sqlite'));
    app = await buildServer({ config: config(), store, now: () => clock, logLevel: 'silent' });
    expect((await app.inject({ method: 'GET', url: p, headers })).json()).toEqual({
      error: 'replayed_nonce',
    });
  });

  it('delete removes every copy, and only this id’s', async () => {
    await client(alonso).put(1, new Uint8Array([1]));
    clock += DAY;
    await client(alonso).put(2, new Uint8Array([2]));
    await client(sancho).put(1, new Uint8Array([3]));
    expect(await client(alonso).deleteAll()).toBe(true);
    expect(await client(alonso).list()).toEqual([]);
    expect(await client(alonso).deleteAll()).toBe(false);
    expect((await client(sancho).list()).map((c) => c.counter)).toEqual([1]);
    // After a delete, counting starts again.
    await client(alonso).put(1, new Uint8Array([4]));
  });

  it('refuses a copy over the size limit', async () => {
    await app.close();
    app = await buildServer({
      config: config({ maxCopyBytes: 16 }),
      store,
      now: () => clock,
      logLevel: 'silent',
    });
    await expect(client().put(1, new Uint8Array(17))).rejects.toMatchObject({ status: 413 });
  });

  it('refuses a copy whose stored bytes changed', async () => {
    await client().put(1, new Uint8Array([1, 2, 3]));
    const db = new Database(path.join(dir, 'backups.sqlite'));
    db.prepare('UPDATE copies SET bytes = ?').run(Buffer.from([9, 9, 9]));
    db.close();
    await expect(client().get(1)).rejects.toMatchObject({ status: 500 });
  });

  it('keeps 7 daily and 4 weekly copies, and always the newest', async () => {
    const c = client();
    const start = Math.floor(clock / DAY) * DAY - 59 * DAY;
    // Two copies a day for 60 days.
    for (let d = 0; d < 60; d++) {
      for (let k = 0; k < 2; k++) {
        clock = start + d * DAY + k * 3_600_000;
        await c.put(d * 2 + k + 1, new Uint8Array([d, k]));
      }
    }
    const kept = (await c.list()).map((x) => x.counter);
    expect(kept).toEqual([...countersToKeep(store.list(alonso.backupId))].sort((a, b) => a - b));
    // The last 7 days' second copies: counters 108, 110, …, 120.
    for (let d = 53; d < 60; d++) expect(kept).toContain(d * 2 + 2);
    expect(kept).not.toContain(119); // a day's first copy goes
    expect(kept.length).toBeLessThanOrEqual(11);
    expect(Math.max(...kept)).toBe(120);
  });
});
