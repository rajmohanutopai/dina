/**
 * REAL_LIFE_FIXES_2 §4 — forgetting: Core plans from its own data, always
 * raises a card, and a durable job clears every copy it can reach.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2AReleaseLog, installA2AReleaseLog } from '../../src/a2a';
import { cleanForProvenance } from '../../src/a2a/provenance_text';
import { resetSpanProofs, type SpanProof } from '../../src/a2a/span_proof';
import { InMemoryChatMessageRepository, setChatMessageRepository } from '../../src/chat/repository';
import {
  approveForget,
  cancelForget,
  finishPendingForgets,
  forgetEpoch,
  mentionsWholeWord,
  planForget,
  proposeForget,
  resumeForgetJobs,
} from '../../src/forget/forget';
import { kvList, resetKVStore } from '../../src/kv/store';
import { InMemoryTopicRepository, setTopicRepository, getTopicRepository } from '../../src/memory/repository';
import { SQLitePeopleRepository, setPeopleRepository, getPeopleRepository } from '../../src/people/repository';
import { closePersona, createPersona, openPersona, resetPersonaState } from '../../src/persona/service';
import { createReminder, listByPersona, resetReminderState } from '../../src/reminders/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { getItem, storeItem } from '../../src/vault/crud';
import { InMemoryVaultRepository, setVaultRepository, getVaultRepository } from '../../src/vault/repository';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService, getWorkflowService } from '../../src/workflow/service';

const SESSION = 'chat:main';
let dir: string;
let db: NodeSQLiteAdapter;
let log: A2AReleaseLog;
let chat: InMemoryChatMessageRepository;
let n = 0;

function turn(text: string): SpanProof {
  const id = `t${++n}`;
  log.recordUtterance(SESSION, id, text);
  return { releaseSession: SESSION, turnId: id, turnText: text, start: 0, end: cleanForProvenance(text).length };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'forget-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'id.sqlite'), passphraseHex: 'ab'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  log = new A2AReleaseLog(db, () => Date.now(), { chatLivesIn: 'brain' });
  installA2AReleaseLog(log);
  resetSpanProofs();
  resetKVStore();
  resetPersonaState();
  resetReminderState();
  setPeopleRepository(new SQLitePeopleRepository(db));
  setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  chat = new InMemoryChatMessageRepository();
  setChatMessageRepository(chat);
  for (const [name, tier] of [['general', 'default'], ['health', 'sensitive']] as const) {
    createPersona(name, tier);
    openPersona(name, true);
    setVaultRepository(name, new InMemoryVaultRepository());
  }
});

afterEach(() => {
  installA2AReleaseLog(null);
  setChatMessageRepository(null);
  setPeopleRepository(null);
  db.close?.();
  rmSync(dir, { recursive: true, force: true });
});

function person(name: string, itemId: string): string {
  getPeopleRepository()!.applyExtraction({
    sourceItemId: itemId,
    extractorVersion: 't',
    results: [{ canonicalName: name, relationshipHint: '', surfaces: [{ surface: name, surfaceType: 'name', confidence: 'high' } as never], sourceExcerpt: name }],
  });
  return getPeopleRepository()!.listPeople().find((p) => p.canonicalName === name)!.personId;
}

it('matches whole words only: "Anna" never plans "Annabel"', () => {
  expect(mentionsWholeWord('Annabel likes jazz', ['anna'])).toBe(false);
  expect(mentionsWholeWord("Anna's bike", ['anna'])).toBe(true);
});

it('plans items, reminders and chat about the person, and lists closed personas', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Mira lent me her tent', body: 'Mira lent me her tent' });
  storeItem('general', { type: 'note', summary: 'Miranda runs the cafe', body: 'Miranda runs the cafe' });
  person('Mira', a);
  createReminder({ message: 'Give Mira her tent back', due_at: Date.now() + 86_400_000, persona: 'general', kind: 'manual', source_item_id: '' } as never);
  await chat.append({ id: 'm1', threadId: 'main', type: 'user', content: 'Mira is coming Sunday', metadata: {}, sources: [], timestamp: 1 });
  await chat.append({ id: 'm2', threadId: 'main', type: 'user', content: 'Miranda is too', metadata: {}, sources: [], timestamp: 2 });
  closePersona('health');
  const out = await planForget({ person: 'Mira' });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.plan.items.map((i) => i.id)).toEqual([a]);
  expect(out.plan.reminders).toHaveLength(1);
  expect(out.plan.chatMessages.map((m) => m.id)).toEqual(['m1']);
  expect(out.plan.closedPersonas).toEqual(['health']);
});

it('refuses a turn with no forget instruction, and always raises a card otherwise', async () => {
  storeItem('general', { type: 'note', summary: 'Teo plays chess', body: 'Teo plays chess' });
  expect((await proposeForget({ proof: turn('what does Teo play?'), request: { person: 'Teo' } })).status).toBe('refused');
  // Turns recorded in the same millisecond cannot be told apart.
  await new Promise((r) => setTimeout(r, 5));
  const ok = await proposeForget({ proof: turn('please forget everything about Teo'), request: { person: 'Teo' } });
  expect(ok.status).toBe('confirm_pending');
  expect(getItem('general', (await planForget({ person: 'Teo' }) as { ok: true; plan: { items: { id: string }[] } }).plan.items[0]!.id)).not.toBeNull();
});

it('approval forgets every copy, raises the epoch and leaves the card with counts only', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Zane owes me 400', body: 'Zane owes me 400' });
  const pid = person('Zane', a);
  createReminder({ message: 'Ask Zane for the 400', due_at: Date.now() + 86_400_000, persona: 'general', kind: 'manual', source_item_id: a } as never);
  await chat.append({ id: 'm3', threadId: 'main', type: 'user', content: 'tell Zane hi', metadata: { receipts: [{ action: 'send', status: 'done', targets: ['Zane'], object: 'hi' }] }, sources: [], timestamp: 3 });
  const before = await forgetEpoch();
  const proposed = await proposeForget({ proof: turn('forget everything about Zane'), request: { person: 'Zane' } });
  if (proposed.status !== 'confirm_pending') throw new Error('no card');
  const task = getWorkflowService()!.approve(proposed.task_id);
  expect(await approveForget(task)).toBe('done');
  const item = getVaultRepository('general')!.getItemIncludeDeletedSync(a)!;
  expect([item.summary, item.body, item.deleted]).toEqual(['', '', 1]);
  expect(listByPersona('general').filter((r) => /Zane/.test(r.message))).toHaveLength(0);
  expect((await chat.listByThread('main')).some((m) => /Zane/.test(m.content))).toBe(false);
  expect(getPeopleRepository()!.getPerson(pid)?.status).toBe('rejected');
  // Erased, not only marked: no name or surface survives in the people rows.
  expect(getPeopleRepository()!.getPerson(pid)?.canonicalName).toBe('');
  expect(getPeopleRepository()!.getPerson(pid)?.surfaces ?? []).toHaveLength(0);
  expect(JSON.stringify(db.query("SELECT * FROM person_surfaces WHERE person_id = ?", [pid]))).not.toMatch(/Zane/);
  // The finished job record keeps counts only.
  expect(JSON.stringify(await kvList('forget_jobs'))).not.toMatch(/Zane|owes me/);
  expect(await forgetEpoch()).toBe(before + 1);
  expect(getWorkflowService()!.store().getById(proposed.task_id)!.description).not.toMatch(/Zane/);
});

it('a persona that closes is finished inside its next unlock, before it opens', async () => {
  const h = storeItem('health', { type: 'note', summary: 'Quill takes ibuprofen', body: 'Quill takes ibuprofen' });
  person('Quill', h);
  const proposed = await proposeForget({ proof: turn('forget Quill'), request: { person: 'Quill' } });
  if (proposed.status !== 'confirm_pending') throw new Error('no card');
  closePersona('health');
  expect(await approveForget(getWorkflowService()!.approve(proposed.task_id))).toBe('waiting_on_unlock');
  expect(getVaultRepository('health')!.getItemIncludeDeletedSync(h)!.body).toBe('Quill takes ibuprofen');
  expect(await finishPendingForgets('health')).toBe(true);
  expect(getVaultRepository('health')!.getItemIncludeDeletedSync(h)!.body).toBe('');
});

it('a job a restart interrupted resumes from its first unfinished step', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Yusuf parks at gate 2', body: 'Yusuf parks at gate 2' });
  person('Yusuf', a);
  const proposed = await proposeForget({ proof: turn('forget Yusuf'), request: { person: 'Yusuf' } });
  if (proposed.status !== 'confirm_pending') throw new Error('no card');
  getWorkflowService()!.approve(proposed.task_id);
  // The vault is "still loading" when the job first runs.
  setVaultRepository('general', null as never);
  await expect(approveForget(getWorkflowService()!.store().getById(proposed.task_id)!)).rejects.toThrow();
  const repo = new InMemoryVaultRepository();
  setVaultRepository('general', repo);
  expect(await resumeForgetJobs()).toBe(1);
  expect(getWorkflowService()!.store().getById(proposed.task_id)!.status).toBe('completed');
});

it('an approved card Core acted on settles as completed (the queued → running → completed path)', async () => {
  const { settleApprovedCard } = await import('../../src/server/routes/workflow');
  const { WorkflowTaskKind, WorkflowTaskState } = await import('../../src/workflow/domain');
  const service = getWorkflowService()!;
  service.create({
    id: 'card-1',
    kind: WorkflowTaskKind.Approval,
    description: 'x',
    payload: '{}',
    expiresAtSec: Math.floor(Date.now() / 1000) + 600,
    origin: 'system',
    initialState: WorkflowTaskState.PendingApproval,
  });
  service.approve('card-1');
  expect(settleApprovedCard(service, 'card-1', '{}', 'done').status).toBe('completed');
});

async function card(text: string, request: Parameters<typeof proposeForget>[0]['request']): Promise<string> {
  await new Promise((r) => setTimeout(r, 3));
  const out = await proposeForget({ proof: turn(text), request });
  if (out.status !== 'confirm_pending') throw new Error(JSON.stringify(out));
  return out.task_id;
}

it('forgetting items removes the topics drawn from them, not only for a person', async () => {
  const topics = new InMemoryTopicRepository();
  setTopicRepository('general', topics);
  const a = storeItem('general', { type: 'note', summary: 'Kayak trip to Gokarna in March', body: 'Kayak trip to Gokarna in March' });
  await topics.touch({ topic: 'gokarna kayak trip', kind: 'theme', nowUnix: Math.floor(Date.now() / 1000), sampleItemId: a });
  const id = await card('delete that kayak note', { item_ids: [a] });
  expect(await approveForget(getWorkflowService()!.approve(id))).toBe('done');
  expect(await getTopicRepository('general')!.get('gokarna kayak trip')).toBeNull();
  setTopicRepository('general', null);
});

it('a declined card, and a waiting card the approved one covers, keep no names', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Ilse borrowed the drill', body: 'Ilse borrowed the drill' });
  person('Ilse', a);
  const first = await card('forget Ilse', { person: 'Ilse' });
  const second = await card('forget about Ilse please', { person: 'Ilse' });
  const third = await card('forget everything about Ilse', { person: 'Ilse' });
  await cancelForget(getWorkflowService()!.store().getById(first)!);
  expect(await approveForget(getWorkflowService()!.approve(third))).toBe('done');
  for (const id of [first, second, third]) {
    expect(getWorkflowService()!.store().getById(id)!.description).not.toMatch(/Ilse|drill/);
  }
  expect(getWorkflowService()!.store().getById(second)!.status).toBe('cancelled');
  expect(JSON.stringify(await kvList('forget_jobs'))).not.toMatch(/Ilse|drill/);
});

it('approve and a concurrent resume run the job once', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Pavo walks the dog', body: 'Pavo walks the dog' });
  person('Pavo', a);
  const id = await card('forget Pavo', { person: 'Pavo' });
  const before = await forgetEpoch();
  const task = getWorkflowService()!.approve(id);
  await Promise.all([approveForget(task), resumeForgetJobs(), resumeForgetJobs()]);
  expect(await forgetEpoch()).toBe(before + 1);
});

it('a card approved just before a crash still runs at the next resume', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Rumi fixed the tap', body: 'Rumi fixed the tap' });
  person('Rumi', a);
  const id = await card('forget Rumi', { person: 'Rumi' });
  getWorkflowService()!.approve(id); // the crash came before approveForget
  expect(await resumeForgetJobs()).toBe(1);
  expect(getVaultRepository('general')!.getItemIncludeDeletedSync(a)!.body).toBe('');
});

it('a host that cannot do a step leaves the job unfinished, never reports it done', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Odo likes figs', body: 'Odo likes figs' });
  person('Odo', a);
  await chat.append({ id: 'm9', threadId: 'main', type: 'user', content: 'Odo says hi', metadata: {}, sources: [], timestamp: 9 });
  const id = await card('forget Odo', { person: 'Odo' });
  const noDelete = Object.assign(Object.create(Object.getPrototypeOf(chat)), chat, { deleteMessages: undefined });
  setChatMessageRepository(noDelete);
  await expect(approveForget(getWorkflowService()!.approve(id))).rejects.toThrow(/cannot delete chat messages/);
  setChatMessageRepository(chat);
});


it('without the workflow service, recovery leaves a waiting forget alone', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Sol owns a van', body: 'Sol owns a van' });
  person('Sol', a);
  const id = await card('forget Sol', { person: 'Sol' });
  const service = getWorkflowService()!;
  setWorkflowService(null as never);
  await resumeForgetJobs();
  setWorkflowService(service);
  // Still proposed: approving it now runs it.
  expect(await approveForget(service.approve(id))).toBe('done');
});

it('a crash while closing overlapping cards is finished at the next resume', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Tamsin sold the bike', body: 'Tamsin sold the bike' });
  person('Tamsin', a);
  const waiting = await card('forget Tamsin', { person: 'Tamsin' });
  const approved = await card('please forget Tamsin', { person: 'Tamsin' });
  const repo = getWorkflowService()!.store();
  const scrub = repo.scrubCardText!.bind(repo);
  // Scrubbing the OTHER card fails once: the crash comes mid-close.
  let failOnce = true;
  repo.scrubCardText = (id, ...rest) => {
    if (id === waiting && failOnce) {
      failOnce = false;
      throw new Error('crash');
    }
    return scrub(id, ...rest);
  };
  await expect(approveForget(getWorkflowService()!.approve(approved))).rejects.toThrow('crash');
  await resumeForgetJobs();
  expect(repo.getById(waiting)!.description).not.toMatch(/Tamsin|bike/);
  expect(JSON.stringify(await kvList('forget_jobs'))).not.toMatch(/Tamsin|bike/);
  repo.scrubCardText = scrub;
});

it('a persona unlocked while a job is still closing opens without the forgotten items', async () => {
  const h = storeItem('health', { type: 'note', summary: 'Wren takes insulin', body: 'Wren takes insulin' });
  const g = storeItem('general', { type: 'note', summary: 'Wren lives nearby', body: 'Wren lives nearby' });
  person('Wren', g);
  const waiting = await card('forget Wren', { person: 'Wren' });
  const approved = await card('please forget Wren', { person: 'Wren' });
  closePersona('health');
  // The crash comes while closing the other card.
  const repo = getWorkflowService()!.store();
  const scrub = repo.scrubCardText!.bind(repo);
  repo.scrubCardText = (id, ...rest) => {
    if (id === waiting) throw new Error('crash');
    return scrub(id, ...rest);
  };
  await expect(approveForget(getWorkflowService()!.approve(approved))).rejects.toThrow('crash');
  repo.scrubCardText = scrub;
  // Unlock before any resume: the item goes before the persona opens.
  expect(await finishPendingForgets('health')).toBe(true);
  expect(getVaultRepository('health')!.getItemIncludeDeletedSync(h)!.body).toBe('');
  openPersona('health', true);
  expect(await resumeForgetJobs()).toBe(1);
  expect(JSON.stringify(await kvList('forget_jobs'))).not.toMatch(/Wren/);
});

it('a job that finishes after its persona opened forgets the waiting items at once', async () => {
  const h = storeItem('health', { type: 'note', summary: 'Ezra sees Dr Bose', body: 'Ezra sees Dr Bose' });
  person('Ezra', h);
  const waiting = await card('forget Ezra', { person: 'Ezra' });
  const approved = await card('please forget Ezra', { person: 'Ezra' });
  closePersona('health');
  const repo = getWorkflowService()!.store();
  const scrub = repo.scrubCardText!.bind(repo);
  repo.scrubCardText = (id, ...rest) => {
    if (id === waiting) throw new Error('crash');
    return scrub(id, ...rest);
  };
  // Stopped in 'closing', with the health item waiting.
  await expect(approveForget(getWorkflowService()!.approve(approved))).rejects.toThrow('crash');
  repo.scrubCardText = scrub;
  // The persona opens without its unlock hook running, and its index loads.
  openPersona('health', true);
  const { buildIndex, indexSize, destroyIndex } = await import('../../src/embedding/persona_index');
  buildIndex('health', [{ id: h, embedding: new Float32Array(768).fill(0.1) }], 768);
  expect(indexSize('health')).toBe(1);
  expect(getVaultRepository('health')!.getItemIncludeDeletedSync(h)!.body).toBe('Ezra sees Dr Bose');
  await resumeForgetJobs();
  expect(getVaultRepository('health')!.getItemIncludeDeletedSync(h)!.body).toBe('');
  expect(indexSize('health')).toBe(0);
  destroyIndex('health');
});

it('the forget conversation itself goes too: messages naming the person written after the plan', async () => {
  const a = storeItem('general', { type: 'note', summary: 'Juno plays cello', body: 'Juno plays cello' });
  person('Juno', a);
  const id = await card('forget everything about Juno', { person: 'Juno' });
  // Written after the plan: the request and Dina's card reply.
  await chat.append({ id: 'late-1', threadId: 'main', type: 'user', content: 'forget everything about Juno', metadata: {}, sources: [], timestamp: Date.now() });
  await chat.append({ id: 'late-2', threadId: 'main', type: 'dina', content: 'A card is waiting to forget Juno.', metadata: {}, sources: [], timestamp: Date.now() });
  expect(await approveForget(getWorkflowService()!.approve(id))).toBe('done');
  expect((await chat.listByThread('main')).some((m) => /Juno/.test(m.content))).toBe(false);
});

