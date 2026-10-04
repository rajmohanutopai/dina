/**
 * The release-context log (A2A design §4.2, §12 M1b done-when): the vault
 * read functions record what they release into a conversation, on both
 * boots — the server's routes and the phone's direct calls log identically;
 * a read with no conversation records nothing and never enters a read set;
 * a release that cannot be logged fails the read; the owner's words are
 * recorded once per turn; rows expire; a deleted persona's rows go.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

import {
  A2AReleaseLog,
  RELEASE_LOG_TTL_MS,
  installA2AReleaseLog,
  releasedContentDigest,
  restrictedReads,
  utteranceDigest,
} from '../../src/a2a';
import { createPersona, deletePersona, resetPersonaState } from '../../src/persona/service';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';
import { registerVaultRoutes } from '../../src/server/routes/vault';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  MAX_LIST_OFFSET,
  browseRecent,
  clearVaults,
  getItem,
  getItemsForPerson,
  listRecentItems,
  listRecentPage,
  queryVault,
  storeItem,
} from '../../src/vault/crud';
import { setVaultReleaseRecorder, type ReleaseContext } from '../../src/vault/release';

const NOW = 1_800_000_000_000;
const CHAT: ReleaseContext = { sessionId: 'chat:main', audience: 'brain' };

let dir: string;
let db: NodeSQLiteAdapter;
let log: A2AReleaseLog;
let clock: number;

beforeEach(() => {
  resetFactoryCounters();
  clearVaults();
  resetPersonaState();
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-release-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'ab'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  clock = NOW;
  log = new A2AReleaseLog(db, () => clock);
  installA2AReleaseLog(log);
});

afterEach(() => {
  installA2AReleaseLog(null);
  resetPersonaState();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const note = makeVaultItem({ summary: 'Dentist is Dr. Rao', body: 'Call Dr. Rao at the clinic on Tuesday.' });
  const scan = makeVaultItem({ summary: 'Blood test', body: 'Cholesterol 190.' });
  storeItem('general', note);
  storeItem('health', scan);
  return { note, scan };
}

const rows = () =>
  log.readSet('chat:main').map((r) => [r.persona, r.persona_tier, r.item_id, r.content_digest]);

describe('the read functions record a release into a conversation', () => {
  it('search, get, list, browse and subject recall each record what they return', () => {
    const { note, scan } = seed();
    expect(queryVault('general', { mode: 'fts5', text: 'dentist', limit: 5 }, CHAT).map((i) => i.id)).toEqual([note.id]);
    expect(getItem('health', scan.id, CHAT)?.id).toBe(scan.id);
    expect(listRecentItems('general', 5, undefined, CHAT)).toHaveLength(1);
    expect(browseRecent('health', 0, Number.MAX_SAFE_INTEGER, 5, CHAT)).toHaveLength(1);
    expect(getItemsForPerson('general', 'nobody', 5, CHAT)).toEqual([]);
    expect(rows()).toEqual([
      ['general', 'default', note.id, releasedContentDigest(note)],
      ['health', 'sensitive', scan.id, releasedContentDigest(scan)],
    ]);
  });

  it('a read with no conversation records nothing (the owner’s browser, a briefing)', () => {
    const { note } = seed();
    queryVault('general', { mode: 'fts5', text: 'dentist', limit: 5 });
    getItem('general', note.id);
    listRecentItems('general', 5);
    browseRecent('general', 0, Number.MAX_SAFE_INTEGER, 5);
    expect(db.query('SELECT COUNT(*) AS n FROM a2a_disclosures')[0]).toEqual({ n: 0 });
  });

  it('one conversation’s reads never enter another’s read set', () => {
    const { note } = seed();
    getItem('general', note.id, { sessionId: 'chat:other', audience: 'brain' });
    expect(log.readSet('chat:main')).toEqual([]);
    expect(log.readSet('chat:other')).toHaveLength(1);
  });

  it('records a changed item as a new release, so a proof checks the content Brain saw', () => {
    const { note } = seed();
    getItem('general', note.id, CHAT);
    storeItem('general', { ...note, body: 'Call Dr. Rao on Friday.' });
    getItem('general', note.id, CHAT);
    expect(log.releasesOf('chat:main', 'general', note.id)).toHaveLength(2);
  });

  it('fails the read when the release cannot be logged: taint is never under-counted', () => {
    const { note } = seed();
    setVaultReleaseRecorder({
      items: () => {
        throw new Error('disk full');
      },
      topics: () => undefined,
    });
    expect(() => getItem('general', note.id, CHAT)).toThrow('disk full');
    setVaultReleaseRecorder(null);
    expect(() => getItem('general', note.id, CHAT)).toThrow(/no release log/);
    expect(getItem('general', note.id)?.id).toBe(note.id);
  });

  it('records a topic list as a release that taints, under an id no item has', () => {
    log.recordTopics(CHAT, 'health', ['diabetes', 'cholesterol']);
    expect(log.readSet('chat:main').map((r) => [r.persona, r.persona_tier, r.item_id])).toEqual([['health', 'sensitive', '#topics']]);
  });

  it('expires releases after the window', () => {
    const { note } = seed();
    getItem('general', note.id, CHAT);
    clock += RELEASE_LOG_TTL_MS;
    expect(log.readSet('chat:main')).toEqual([]);
    expect(log.purgeExpired()).toBe(1);
  });

  it('a deleted persona leaves a marker that keeps the conversation tainted and proves nothing', () => {
    const { scan } = seed();
    getItem('health', scan.id, CHAT);
    deletePersona('health');
    expect(log.readSet('chat:main').map((r) => [r.persona, r.persona_tier, r.item_id])).toEqual([['health', 'sensitive', '#forgotten']]);
    expect(log.releasesOf('chat:main', 'health', scan.id)).toEqual([]);
    expect(restrictedReads(log, 'chat:main')).toEqual(['health']);
  });

  it('a read of a persona the registry no longer knows counts as private', () => {
    const { note } = seed();
    getItem('general', note.id, CHAT);
    expect(restrictedReads(log, 'chat:main')).toEqual([]);
    resetPersonaState(); // the registry forgets every persona; the rows still say "default"
    expect(restrictedReads(log, 'chat:main')).toEqual(['general']);
  });
});

describe('both boots log identically', () => {
  function router(): CoreRouter {
    const r = new CoreRouter();
    registerVaultRoutes(r);
    registerA2ARoutes(r);
    return r;
  }

  const request = (over: Partial<CoreRequest>): CoreRequest => ({
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    ...over,
  });

  /** Seven general items, newest last, so a page and its look-ahead differ. */
  function seedMany() {
    const items = Array.from({ length: 7 }, (_, i) => makeVaultItem({ summary: `Dentist note ${i}`, body: `Visit ${i}.`, timestamp: 1000 + i }));
    for (const item of items) storeItem('general', item);
    return items;
  }

  async function routeReads(caller: Partial<CoreRequest>) {
    const r = router();
    await r.handle(request({ ...caller, method: 'POST', path: '/v1/vault/query', query: { persona: 'general' }, body: { text: 'dentist', limit: 3, release_session: 'chat:main' } }));
    await r.handle(request({ ...caller, path: '/v1/vault/list', query: { persona: 'general', limit: '2', offset: '1', release_session: 'chat:main' } }));
  }

  it('the server’s Brain, the phone’s in-process router calls and its direct calls record the same rows', async () => {
    seedMany();
    await routeReads({ callerType: 'brain', callerDID: 'did:key:brain', trustedInProcess: true });
    const server = rows();
    // A page of 2 at offset 1 releases exactly those 2, never the look-ahead item.
    expect(server).toHaveLength(5);
    db.run('DELETE FROM a2a_disclosures');
    await routeReads({ trustedInProcess: true });
    expect(rows()).toEqual(server);
    db.run('DELETE FROM a2a_disclosures');
    queryVault('general', { mode: 'fts5', text: 'dentist', limit: 3 }, CHAT);
    listRecentPage('general', { offset: 1, limit: 2 }, CHAT);
    expect(rows()).toEqual(server);
  });

  it('an offset past the cap answers an empty page, never another page', () => {
    for (let i = 0; i < MAX_LIST_OFFSET + 3; i += 1) {
      storeItem('general', makeVaultItem({ id: `bulk-${i}`, summary: `Item ${i}`, timestamp: i }));
    }
    expect(listRecentPage('general', { offset: MAX_LIST_OFFSET, limit: 1 }, CHAT).items).toHaveLength(1);
    expect(listRecentPage('general', { offset: MAX_LIST_OFFSET + 1, limit: 1 }, CHAT)).toEqual({ items: [], more: false });
    expect(log.readSet('chat:main')).toHaveLength(1);
  });

  it('refuses a release session from anyone but Brain, and a malformed one', async () => {
    const { note } = seed();
    const r = router();
    const agent = await r.handle(
      request({ path: `/v1/vault/item/${note.id}`, query: { persona: 'general', release_session: 'chat:main' }, callerType: 'device', callerDID: 'did:key:dev', trustedInProcess: true }),
    );
    expect(agent).toMatchObject({ status: 403, body: { error: 'release_session_brain_only' } });
    const bad = await r.handle(
      request({ path: `/v1/vault/item/${note.id}`, query: { persona: 'general', release_session: 'chat:%' }, trustedInProcess: true }),
    );
    expect(bad).toMatchObject({ status: 400, body: { error: 'release_session_invalid' } });
    expect(log.readSet('chat:main')).toEqual([]);
  });

  it('records the owner’s turn once, through Brain’s door only', async () => {
    const r = router();
    const turn = (caller: Partial<CoreRequest>, text: string) =>
      r.handle(request({ ...caller, method: 'POST', path: '/v1/a2a/turns', body: { release_session: 'chat:main', turn_id: 'turn-1', text } }));
    expect((await turn({ trustedInProcess: true }, 'Book Dr. Rao for Tuesday')).body).toEqual({ recorded: true });
    expect((await turn({ trustedInProcess: true }, 'something else')).body).toEqual({ recorded: false });
    expect((await turn({ callerType: 'device', callerDID: 'did:key:d', trustedInProcess: true }, 'x')).status).toBe(403);
    // Core keeps the digest of the turn's message, never the words.
    expect(log.utterances('chat:main').map((u) => u.digest)).toEqual([utteranceDigest('Book Dr. Rao for Tuesday')]);
    expect(log.latestUtterance('chat:main')?.turn_id).toBe('turn-1');
  });

  it('answers 503 for turns on a host with no release log', async () => {
    installA2AReleaseLog(null);
    const resp = await router().handle(
      request({ method: 'POST', path: '/v1/a2a/turns', body: { release_session: 'chat:main', turn_id: 't', text: 'x' }, trustedInProcess: true }),
    );
    expect(resp.status).toBe(503);
  });
});
