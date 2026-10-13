/** REAL_LIFE_FIXES_2 §14 — standing replies: always a card; then the owner's words, to named contacts, once a day. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2AReleaseLog, installA2AReleaseLog } from '../../src/a2a';
import { cleanForProvenance } from '../../src/a2a/provenance_text';
import { resetSpanProofs, type SpanProof } from '../../src/a2a/span_proof';
import { addContact, resetContactDirectory } from '../../src/contacts/directory';
import { resetKVStore } from '../../src/kv/store';
import { SQLitePeopleRepository, setPeopleRepository } from '../../src/people/repository';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import {
  activateStandingReply,
  answerWithStandingReply,
  proposeStandingReply,
  revokeStandingReply,
} from '../../src/standing/standing_replies';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, getWorkflowService, setWorkflowService } from '../../src/workflow/service';

const SESSION = 'chat:main';
let dir: string;
let db: NodeSQLiteAdapter;
let log: A2AReleaseLog;
let n = 0;
const sent: { to: string; type: string; body: Record<string, unknown> }[] = [];

async function turn(text: string): Promise<SpanProof> {
  // Turns in the same millisecond cannot be told apart.
  await new Promise((r) => setTimeout(r, 3));
  const id = `t${++n}`;
  log.recordUtterance(SESSION, id, text);
  return { releaseSession: SESSION, turnId: id, turnText: text, start: 0, end: cleanForProvenance(text).length };
}

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'standing-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'id.sqlite'), passphraseHex: 'cd'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  log = new A2AReleaseLog(db, () => Date.now(), { chatLivesIn: 'brain' });
  installA2AReleaseLog(log);
  resetSpanProofs();
  resetKVStore();
  resetContactDirectory();
  setPeopleRepository(new SQLitePeopleRepository(db));
  addContact('did:plc:oskar000', 'Oskar Lind');
  addContact('did:plc:marta000', 'Marta');
  setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  sent.length = 0;
  setD2DSender(async (to, type, body) => {
    sent.push({ to, type, body });
  });
});

afterEach(() => {
  setD2DSender(null);
  installA2AReleaseLog(null);
  setPeopleRepository(null);
  db.close?.();
  rmSync(dir, { recursive: true, force: true });
});

async function liveRule(): Promise<string> {
  const out = await proposeStandingReply({
    proof: await turn("I'm away until the 20th. If Oskar asks, tell him I'll reply when I'm back"),
    contacts: ['Oskar'],
    replyText: "I'll reply when I'm back",
    until: inDays(10),
  });
  if (out.status !== 'confirm_pending') throw new Error(JSON.stringify(out));
  expect(sent).toHaveLength(0);
  expect(out.summary).toMatch(/Oskar Lind/);
  expect(await activateStandingReply(getWorkflowService()!.approve(out.task_id))).toBe(true);
  return out.task_id;
}

it("answers a named contact with the owner's words, once a day", async () => {
  await liveRule();
  expect(await answerWithStandingReply('did:plc:oskar000')).toBe(true);
  expect(sent).toEqual([
    { to: 'did:plc:oskar000', type: 'coordination.response', body: { text: "I'll reply when I'm back", auto: true } },
  ]);
  expect(await answerWithStandingReply('did:plc:oskar000')).toBe(false);
  expect(await answerWithStandingReply('did:plc:oskar000', Date.now() + DAY + 1)).toBe(true);
});

it('never answers another contact, after expiry, or after revocation', async () => {
  const id = await liveRule();
  expect(await answerWithStandingReply('did:plc:marta000')).toBe(false);
  expect(await answerWithStandingReply('did:plc:oskar000', Date.now() + 11 * DAY)).toBe(false);
  await revokeStandingReply(id);
  expect(await answerWithStandingReply('did:plc:oskar000')).toBe(false);
  expect(sent).toHaveLength(0);
});

it('refuses words the owner did not say, no named contact, a stranger, and an expiry past 30 days', async () => {
  const words = await proposeStandingReply({
    proof: await turn('if Oskar asks say back soon'),
    contacts: ['Oskar'],
    replyText: 'Alonso is on holiday in Goa',
    until: inDays(5),
  });
  expect(words.status).toBe('refused');
  const none = await proposeStandingReply({
    proof: await turn('if colleagues ask say back soon'),
    contacts: [],
    replyText: 'back soon',
    until: inDays(5),
  });
  expect(none.status).toBe('refused');
  const long = await proposeStandingReply({
    proof: await turn('if Oskar asks say back soon'),
    contacts: ['Oskar'],
    replyText: 'back soon',
    until: inDays(45),
  });
  expect(long.status).toBe('refused');
  const stranger = await proposeStandingReply({
    proof: await turn('if Zed asks say back soon'),
    contacts: ['Zed'],
    replyText: 'back soon',
    until: inDays(5),
  });
  expect(stranger.status).toBe('refused');
});

it('two arrivals at once send one reply, and a send never undoes a revoke', async () => {
  const id = await liveRule();
  const [a, b] = await Promise.all([answerWithStandingReply('did:plc:oskar000'), answerWithStandingReply('did:plc:oskar000')]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  expect(sent).toHaveLength(1);
  // A send for another contact's day racing a revoke: the revoke stands.
  await Promise.all([answerWithStandingReply('did:plc:oskar000', Date.now() + DAY + 1), revokeStandingReply(id)]);
  expect(await answerWithStandingReply('did:plc:oskar000', Date.now() + 2 * DAY + 2)).toBe(false);
});
