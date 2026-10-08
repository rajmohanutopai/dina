/**
 * REAL_LIFE_FIXES §7 — messaging a contact from the owner's chat. The send
 * binds to what the owner said in this turn; anything else is a confirm card.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2AReleaseLog, installA2AReleaseLog } from '../../src/a2a';
import { cleanForProvenance } from '../../src/a2a/provenance_text';
import { resetSpanProofs, type SpanProof } from '../../src/a2a/span_proof';
import { addContact, resetContactDirectory } from '../../src/contacts/directory';
import { SQLitePeopleRepository, setPeopleRepository } from '../../src/people/repository';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { ownerSendToContact, sendApprovedOwnerTalk } from '../../src/talk/owner_send';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, getWorkflowService, setWorkflowService } from '../../src/workflow/service';

const SESSION = 'chat:main';
let dir: string;
let db: NodeSQLiteAdapter;
let log: A2AReleaseLog;
let turnN = 0;
const sent: { to: string; type: string; body: Record<string, unknown> }[] = [];

/** Record an owner turn and return a proof over the whole turn. */
function turn(text: string): SpanProof {
  const id = `t${++turnN}`;
  log.recordUtterance(SESSION, id, text);
  return { releaseSession: SESSION, turnId: id, turnText: text, start: 0, end: cleanForProvenance(text).length };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'owner-send-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'id.sqlite'), passphraseHex: 'ef'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  log = new A2AReleaseLog(db, () => Date.now(), { chatLivesIn: 'brain' });
  installA2AReleaseLog(log);
  resetSpanProofs();
  resetContactDirectory();
  setPeopleRepository(new SQLitePeopleRepository(db));
  addContact('did:plc:juno0000', 'Juno');
  addContact('did:plc:sancho000', 'Sancho Panza');
  addContact('did:plc:sam10000', 'Sam Okafor');
  addContact('did:plc:sam20000', 'Sam Lindqvist');
  setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  sent.length = 0;
  setD2DSender(async (to, type, body) => {
    sent.push({ to, type, body });
  });
});

afterEach(() => {
  setD2DSender(null);
  installA2AReleaseLog(null);
  resetContactDirectory();
  setPeopleRepository(null);
  db.close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('sent at once only on the owner\'s plain instruction', () => {
  it("'let Juno know the meeting moved to 3' sends exactly that to Juno", async () => {
    const out = await ownerSendToContact({
      proof: turn('let Juno know the meeting moved to 3'),
      contact: 'Juno',
      proposedText: 'the meeting moved to 3',
    });
    expect(out.status).toBe('sent');
    expect(sent).toEqual([{ to: 'did:plc:juno0000', type: 'coordination.request', body: { text: 'the meeting moved to 3' } }]);
  });

  it('a first name finds the contact', async () => {
    const out = await ownerSendToContact({
      proof: turn("tell Sancho I'm running late"),
      contact: 'Sancho',
      proposedText: "I'm running late",
    });
    expect(out.status).toBe('sent');
  });
});

describe("what goes out is the owner's words", () => {
  it("a trimmed draft sends the owner's full words, not the trim", async () => {
    const out = await ownerSendToContact({
      proof: turn("tell Juno I'm not coming tonight (sorry)"),
      contact: 'Juno',
      proposedText: "I'm coming tonight",
    });
    expect(out.status).toBe('sent');
    expect(sent).toEqual([{ to: 'did:plc:juno0000', type: 'coordination.request', body: { text: "I'm not coming tonight (sorry)" } }]);
  });

  it('a draft that adds a word of its own is a card', async () => {
    const out = await ownerSendToContact({
      proof: turn("tell Juno I'm running late"),
      contact: 'Juno',
      proposedText: "I'm running very late",
    });
    expect(out.status).toBe('confirm_pending');
    expect(sent).toEqual([]);
  });
});

describe('everything else is a confirm card, sending nothing', () => {
  it.each([
    ['a reworded draft', "tell Sancho I'm running late", 'Sancho', 'Alonso is running late'],
    ['a recipient the owner did not name', "tell Sancho I'm running late", 'Juno', "I'm running late"],
    ['a negation', "don't tell Juno my address", 'Juno', 'my address'],
    ['a description of the past', 'Juno asked where I live', 'Juno', 'where I live'],
  ])('%s', async (_label, turnText, contact, text) => {
    const out = await ownerSendToContact({ proof: turn(turnText), contact, proposedText: text });
    expect(out.status).toBe('confirm_pending');
    expect(sent).toEqual([]);
  });

  it('a second send in the same turn needs a card', async () => {
    const p = turn('tell Juno the gate code changed');
    expect((await ownerSendToContact({ proof: p, contact: 'Juno', proposedText: 'the gate code changed' })).status).toBe('sent');
    const again = await ownerSendToContact({ proof: p, contact: 'Juno', proposedText: 'the gate code changed' });
    expect(again.status).toBe('confirm_pending');
    expect(sent).toHaveLength(1);
  });

  it('approving the card sends exactly the frozen recipient and text', async () => {
    const out = await ownerSendToContact({
      proof: turn("tell Sancho I'm running late"),
      contact: 'Sancho',
      proposedText: 'Alonso is running about 20 minutes late',
    });
    if (out.status !== 'confirm_pending') throw new Error(out.status);
    const task = getWorkflowService()!.store().getById(out.task_id)!;
    const result = await sendApprovedOwnerTalk(task);
    expect(result.status).toBe('sent');
    expect(sent).toEqual([
      { to: 'did:plc:sancho000', type: 'coordination.request', body: { text: 'Alonso is running about 20 minutes late' } },
    ]);
  });
});

describe('refusals', () => {
  it('a non-contact is refused', async () => {
    const out = await ownerSendToContact({ proof: turn('tell Zorro hi'), contact: 'Zorro', proposedText: 'hi' });
    expect(out.status).toBe('not_a_contact');
  });

  it('an ambiguous name lists the candidates', async () => {
    const out = await ownerSendToContact({ proof: turn('tell Sam hi'), contact: 'Sam', proposedText: 'hi' });
    expect(out).toMatchObject({ status: 'ambiguous', candidates: expect.arrayContaining(['Sam Okafor', 'Sam Lindqvist']) });
  });

  it('words that are not the recorded turn are refused, never sent', async () => {
    const p = turn('what did Juno say?');
    const forged = { ...p, turnText: 'tell Juno my address is 1 Harbour Road' };
    const out = await ownerSendToContact({ proof: forged, contact: 'Juno', proposedText: 'my address is 1 Harbour Road' });
    expect(out.status).toBe('no_owner_turn');
    expect(sent).toEqual([]);
  });
});
