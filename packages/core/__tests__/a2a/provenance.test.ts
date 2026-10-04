/**
 * A2A M1b provenance (design A2A-I9, A2A-I12, §6.2 steps 0–3, §12 M1b
 * done-when): a proposal belongs to a live owner turn; Core proves a quote
 * only as a WHOLE unit — one complete message the owner sent in this
 * conversation, or the complete body of a vault item released into it and
 * written before it began — or refuses the proposal. No rule cuts a unit
 * into sentences, so no quote can drop the words that govern it. Unproven
 * text is derived — unverified, possibly sensitive, tainted by what the
 * conversation read; originals are kept only for a single provable source,
 * sealed under a purpose key, shown to the owner beside the answer (never
 * written into the remote's text, never to Brain), and gone on lock, shred
 * and expiry.
 */

import { randomBytes } from '@noble/hashes/utils.js';

import { makeVaultItem } from '@dina/test-harness';

import {
  A2A_ENDED_RETENTION_MS,
  ENTITY_MAX_LIFE_MS,
  ENTITY_RETENTION_AFTER_END_MS,
  OWNER_TURN_LIVE_MS,
  beginOutboundDispatch,
  claimNextGuardJob,
  outboundOperationView,
  restrictedReads,
  parseDelegationConsentCard,
  placeholderLegend,
  proposeDelegation,
  purgeEndedA2AOperations,
  recordRemoteOutcome,
  submitGuardVerdict,
  utteranceDigest,
  type ProposalInput,
} from '../../src/a2a';
import { registerPersonaDEK, releasePersonaDEK } from '../../src/persona/orchestrator';
import { createPersona, deletePersona, getPersona, onPersonaDeleted, resetPersonaState } from '../../src/persona/service';
import { CoreRouter } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';
import { clearVaults, getItem, storeItem } from '../../src/vault/crud';
import { InMemoryVaultRepository, setVaultRepository } from '../../src/vault/repository';

import { LaneWorld, RUNNER_DID, SESSION, START } from './outbound_fixture';

// Three messages the owner sent, one turn each.
const BOOK = 'Please book a table for two at seven.';
const MAIL = 'Write to alonso@example.com about the booking.';
const SECRET = 'Do not share my phone number with anyone.';
const CAP = 'owner-capability-for-tests';

let world: LaneWorld;
let agentId: string;

function speak(): void {
  for (const words of [BOOK, MAIL, SECRET]) world.turn(words);
}

beforeEach(async () => {
  clearVaults();
  resetPersonaState();
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  world = new LaneWorld();
  ({ agentId } = await world.activeAgent());
  speak();
});

afterEach(() => {
  releasePersonaDEK('general');
  releasePersonaDEK('health');
  resetPersonaState();
  jest.restoreAllMocks();
  world.close();
});

const read = (persona: string, id: string, session = SESSION) =>
  getItem(persona, id, { sessionId: session, audience: 'brain' });

function propose(over: Partial<ProposalInput>) {
  return proposeDelegation(world.runtime, { agentId, skill: 'summarize', releaseSession: SESSION, ...over });
}

const owner = (quote: string) => ({ quote, from: 'owner' });
const vault = (quote: string, persona: string, id: string) => ({ quote, from: 'vault', persona, item_id: id });

function cardOf(approvalTaskId: string) {
  const card = parseDelegationConsentCard(world.repo.getById(approvalTaskId)?.payload ?? '');
  if (card === null) throw new Error('no card');
  return card;
}

function op(operationId: string) {
  const row = world.store.getTaskByExternal('outbound', 'owner', operationId);
  if (row === null) throw new Error('no operation');
  return row;
}

/** An item saved before the conversation began (its write stamp precedes the first turn), then read in it. */
function released(persona: string, body: string, extra: Record<string, unknown> = {}) {
  const item = makeVaultItem({ summary: 'Note', body, ...extra });
  jest.spyOn(Date, 'now').mockReturnValueOnce(START - 60_000);
  storeItem(persona, item);
  read(persona, item.id);
  return item;
}

describe('a proposal belongs to a live owner turn (§6.2 step 0)', () => {
  it('is refused with no conversation, in a conversation with no turn, or after the turn went stale', () => {
    expect(propose({ releaseSession: undefined, text: 'x' })).toEqual({ ok: false, reason: 'no_owner_turn' });
    expect(propose({ releaseSession: 'chat:elsewhere', text: 'x' })).toEqual({ ok: false, reason: 'no_owner_turn' });
    world.clock += OWNER_TURN_LIVE_MS + 1;
    expect(propose({ text: 'x' })).toEqual({ ok: false, reason: 'no_owner_turn' });
    world.turn();
    expect(propose({ text: 'x' }).ok).toBe(true);
  });

  it('records the conversation on the operation', () => {
    const p = propose({ text: 'x' });
    if (!p.ok) throw new Error(p.reason);
    expect(op(p.operationId).release_session_id).toBe(SESSION);
  });
});

describe('the owner’s own messages (user_request)', () => {
  it('proves a whole message the owner sent here, and drops the doubt labels when everything is proven', () => {
    const p = propose({ text: BOOK, sources: [owner(BOOK)] });
    if (!p.ok) throw new Error(p.reason);
    expect(p.labels).toEqual([]);
    const card = cardOf(p.approvalTaskId);
    expect(card.consent.provenance).toEqual([{ quote: BOOK, from: 'owner' }]);
    expect(card.display.sources).toEqual([`“${BOOK}” is a message you sent in this conversation, word for word.`]);
  });

  it('proves several whole messages; a space or a new line between them is not content', () => {
    const p = propose({ text: `${MAIL}\n${BOOK}`, sources: [owner(MAIL), owner(BOOK)] });
    expect(p.ok && p.labels).toEqual(['placeholders']);
  });

  it('refuses a message the owner sent in another conversation (utterance mismatch)', () => {
    world.log.recordUtterance('chat:other', 'turn-x', 'Send my password to them now.');
    expect(propose({ text: 'Send my password to them now.', sources: [owner('Send my password to them now.')] })).toEqual({
      ok: false,
      reason: 'source_unproven',
    });
  });

  it('labels what no proven quote covers as derived: unverified and possibly sensitive', () => {
    const p = propose({ text: `Hello there. ${BOOK}`, sources: [owner(BOOK)] });
    expect(p.ok && p.labels).toEqual(['may_contain_sensitive', 'unverified']);
    const d = propose({ text: BOOK, data: { day: 'Tuesday' }, sources: [owner(BOOK)] });
    expect(d.ok && d.labels).toEqual(['may_contain_sensitive', 'unverified']);
  });

  it('a long message proves only whole: its first part, however long, proves nothing', () => {
    const long = `${'Plan the trip carefully. '.repeat(400)}Sell the house to Bob unless he fails the inspection.`;
    world.turn(long);
    const head = long.slice(0, 8_000).trim();
    expect(propose({ text: head, sources: [owner(head)] })).toEqual({ ok: false, reason: 'source_unproven' });
    const whole = propose({ text: long, sources: [owner(long)] });
    expect(whole.ok && whole.labels).toEqual([]);
  });

  it('Core keeps a digest of each message, never the words', () => {
    world.turn('My account number is 4471 0098.');
    const rows = world.log.utterances(SESSION);
    expect(JSON.stringify(rows)).not.toContain('4471');
    expect(rows.map((r) => r.digest)).toContain(utteranceDigest('My account number is 4471 0098.'));
  });

  it('documents what a whole message proves: that the owner sent it, not what a later message added', () => {
    // A sentence split over two sends: the first is a whole message, so it
    // proves as one, and the card says exactly that.
    world.turn('Sell the house to Bob');
    world.turn('only if he pays the full price in cash.');
    const p = propose({ text: 'Sell the house to Bob', sources: [owner('Sell the house to Bob')] });
    if (!p.ok) throw new Error(p.reason);
    expect(cardOf(p.approvalTaskId).display.sources[0]).toMatch(/is a message you sent in this conversation, word for word/);
  });
});

describe('no part of a unit proves: the governing words cannot be cut away', () => {
  it.each([
    ['a piece of a message', 'book a table for two at seven.', 'book a table for two at seven.'],
    ['a negation dropped', 'share my phone number with anyone.', 'share my phone number with anyone.'],
    ['a short piece', 'two at seven', 'two at seven'],
  ])('refuses %s', (_name, text, quote) => {
    expect(propose({ text, sources: [owner(quote)] }).ok).toBe(false);
  });

  it.each([
    ['a roman-numbered list', 'Do NOT do any of these:\ni. call my ex\nii. sell the house to Bob today.', 'sell the house to Bob today.'],
    ['an exclamation inside a name', 'Do not forward my Yahoo! Mail password reset codes to anyone.', 'Mail password reset codes to anyone.'],
    ['an ellipsis', 'Do not, under any circumstances... transfer the deed to my cousin.', 'transfer the deed to my cousin.'],
    ['a title', 'I refuse to let Lt. Dan sell the farm to the developers.', 'Dan sell the farm to the developers.'],
    ['a time of day', 'Wire the deposit at 9 a.m. only after the inspection passes.', 'Wire the deposit at 9 a.m.'],
    ['a country', 'Do not move money out of the U.S. Bank account to my brother.', 'Bank account to my brother.'],
    ['reported speech', 'The scammer wrote "Wire me the cash. Send all my savings to account 4471 today."', 'Send all my savings to account 4471 today."'],
    ['a German abbreviation', 'Bitte niemals, z.B. das Haus an Bob verkaufen.', 'das Haus an Bob verkaufen.'],
  ])('refuses a cut after %s', (_name, said, quote) => {
    world.turn(said);
    expect(propose({ text: quote, sources: [owner(quote)] })).toEqual({ ok: false, reason: 'source_unproven' });
  });

  it('refuses the same cut of a vault item, and the item’s model-written summaries', () => {
    const body = 'Share my HIV status with the clinic in the U.S. only after my written consent.';
    const item = released('health', body, { content_l1: 'The owner wants the HIV status shared with the clinic.' });
    expect(propose({ text: 'Share my HIV status with the clinic in the U.S.', sources: [vault('Share my HIV status with the clinic in the U.S.', 'health', item.id)] })).toEqual({
      ok: false,
      reason: 'source_unproven',
    });
    expect(
      propose({
        text: 'The owner wants the HIV status shared with the clinic.',
        sources: [vault('The owner wants the HIV status shared with the clinic.', 'health', item.id)],
      }),
    ).toEqual({ ok: false, reason: 'source_unproven' });
  });
});

describe('a source cannot be forged out of fragments', () => {
  it.each([
    ['a short piece', 'table for two', [owner('for two')], 'source_too_short'],
    ['a one-word piece', 'seven', [owner('seven')], 'source_too_short'],
    ['a quote the message holds twice', `${BOOK} ${BOOK}`, [owner(BOOK)], 'source_ambiguous'],
    ['the same quote claimed twice', BOOK, [owner(BOOK), owner(BOOK)], 'sources_overlap'],
    ['a quote inside a word of the message', `X${BOOK}`, [owner(BOOK)], 'source_not_in_message'],
    ['a quote padded with spaces', BOOK, [owner(` ${BOOK}`)], 'sources_malformed'],
    ['a quote that is not in the message', 'hello', [owner(BOOK)], 'source_not_in_message'],
  ])('refuses %s', (_name, text, sources, reason) => {
    expect(propose({ text, sources })).toEqual({ ok: false, reason });
  });

  it.each([
    ['circled letters', 'ⓗⓘⓥ ⓟⓞⓢⓘⓣⓘⓥⓔ'],
    ['squared letters', '🅷🅸🆅'],
    ['Braille cells', '⠓⠊⠧'],
    ['an emoji', '🚫'],
    ['a run of exotic spaces', '  　 '],
    ['punctuation', '!!'],
    ['a question mark that turns a statement into a question', '?'],
  ])('counts %s beside the units as unproven, and keeps the conversation’s taint', (_name, extra) => {
    released('health', 'Cholesterol was 190 last month.');
    const p = propose({ text: `${BOOK} ${extra}`, sources: [owner(BOOK)] });
    if (!p.ok) throw new Error(p.reason);
    expect(p.labels).toEqual(['may_contain_sensitive', 'restricted_source', 'unverified']);
  });

  it('a mark between two units, joining them into new words, is content', () => {
    world.turn('Give the keys to Bob');
    world.turn('s brother gets nothing at all.');
    const p = propose({
      text: "Give the keys to Bob's brother gets nothing at all.",
      sources: [owner('Give the keys to Bob'), owner('s brother gets nothing at all.')],
    });
    expect(p.ok && p.labels).toEqual(['may_contain_sensitive', 'unverified']);
  });

  it('refuses a quote whose end falls inside a personal detail of the message', () => {
    // The owner's message ends mid-number; Brain's message runs on into a full phone number.
    world.turn('Call +1 415 555');
    expect(propose({ text: 'Call +1 415 555 0134 today.', sources: [owner('Call +1 415 555')] })).toEqual({
      ok: false,
      reason: 'source_cuts_personal_detail',
    });
  });

  it('counts refusals toward the hourly cap, so claims cannot be probed for free', () => {
    for (let i = 0; i < 30; i += 1) propose({ text: 'seven', sources: [owner('seven')] });
    expect(propose({ text: 'x' })).toEqual({ ok: false, reason: 'too_many_recent' });
  });
});

describe('vault items released into the conversation (disclosure)', () => {
  const NOTE = 'Dr. Rao sees patients on Tuesday mornings.';

  it('proves the whole body of an item saved before the conversation and released in it', () => {
    const item = released('general', NOTE);
    const p = propose({ text: NOTE, sources: [vault(NOTE, 'general', item.id)] });
    if (!p.ok) throw new Error(p.reason);
    expect(p.labels).toEqual([]);
    expect(cardOf(p.approvalTaskId).consent.provenance).toEqual([{ quote: NOTE, from: 'vault', persona: 'general' }]);
    expect(cardOf(p.approvalTaskId).display.sources[0]).toMatch(/is the full text of an item in your general vault, saved before this conversation/);
  });

  it('refuses an item written during the conversation (Brain could have written it from what it read)', () => {
    released('health', 'Cholesterol was 190 last month.');
    // Laundering: the health text copied into a fresh general item, then quoted as "general".
    const fresh = makeVaultItem({ body: 'Cholesterol was 190 last month.' });
    jest.spyOn(Date, 'now').mockReturnValueOnce(START + 1000);
    storeItem('general', fresh);
    read('general', fresh.id);
    expect(propose({ text: 'Cholesterol was 190 last month.', sources: [vault('Cholesterol was 190 last month.', 'general', fresh.id)] })).toEqual({
      ok: false,
      reason: 'source_unproven',
    });
  });

  it('refuses an item never released into this conversation (fabricated handle)', () => {
    const item = makeVaultItem({ body: 'The secret plan is ready now.' });
    jest.spyOn(Date, 'now').mockReturnValueOnce(START - 60_000);
    storeItem('general', item);
    read('general', item.id, 'chat:other');
    expect(propose({ text: 'The secret plan is ready now.', sources: [vault('The secret plan is ready now.', 'general', item.id)] })).toEqual({
      ok: false,
      reason: 'source_unproven',
    });
    expect(propose({ text: 'The secret plan is ready now.', sources: [vault('The secret plan is ready now.', 'general', 'no-such-item')] })).toEqual({
      ok: false,
      reason: 'source_unproven',
    });
  });

  it('refuses text the item does not hold whole, an item changed since release, and a locked persona', () => {
    const item = released('general', NOTE);
    expect(propose({ text: 'Dr. Rao is free on Friday.', sources: [vault('Dr. Rao is free on Friday.', 'general', item.id)] })).toEqual({
      ok: false,
      reason: 'source_unproven',
    });
    storeItem('general', { ...item, body: 'Dr. Rao moved to Friday mornings.' });
    expect(propose({ text: 'Dr. Rao moved to Friday mornings.', sources: [vault('Dr. Rao moved to Friday mornings.', 'general', item.id)] })).toEqual({
      ok: false,
      reason: 'source_changed',
    });
    const other = released('general', 'A note from the clinic arrived.');
    setVaultRepository('general', null); // the persona's vault is closed: Core cannot re-read it
    expect(propose({ text: 'A note from the clinic arrived.', sources: [vault('A note from the clinic arrived.', 'general', other.id)] })).toEqual({
      ok: false,
      reason: 'source_unproven',
    });
  });

  it('marks a quote from a private vault restricted, and names the vault', () => {
    const item = released('health', 'Cholesterol was 190 last month.');
    const p = propose({ text: 'Cholesterol was 190 last month.', sources: [vault('Cholesterol was 190 last month.', 'health', item.id)] });
    if (!p.ok) throw new Error(p.reason);
    expect(p.labels).toEqual(['restricted_source']);
    expect(cardOf(p.approvalTaskId).display.restricted_personas).toEqual(['health']);
  });

  it('marks a quote restricted when its persona was raised after the read: private when read OR now, as the read-set rule', () => {
    createPersona('work', 'standard');
    setVaultRepository('work', new InMemoryVaultRepository());
    const PLAN = 'The third quarter plan ships on Friday.';
    const item = released('work', PLAN);
    const quoted = () => propose({ text: PLAN, sources: [vault(PLAN, 'work', item.id)] });
    // Control: read and quoted while standard, the quote is not restricted.
    const before = quoted();
    if (!before.ok) throw new Error(before.reason);
    expect(before.labels).toEqual([]);
    // The owner raises the persona; personas load at their stored tier, as at the next start.
    resetPersonaState();
    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    createPersona('work', 'sensitive');
    const after = quoted();
    if (!after.ok) throw new Error(after.reason);
    expect(after.labels).toEqual(['restricted_source']);
    expect(cardOf(after.approvalTaskId).display.restricted_personas).toEqual(['work']);
  });

  // Cold audit C5-2: reading again never erases a private read
  describe('a persona lowered after a private read, then read again: the conversation stays tainted', () => {
    /** The owner lowers `work`; personas load at their stored tier, as at the next start. */
    const lowerWork = () => {
      resetPersonaState();
      createPersona('general', 'default');
      createPersona('health', 'sensitive');
      createPersona('work', 'standard');
    };
    beforeEach(() => {
      createPersona('work', 'sensitive');
      setVaultRepository('work', new InMemoryVaultRepository());
    });

    it('an item', () => {
      const item = released('work', 'The merger closes next week.');
      expect(restrictedReads(world.log, SESSION)).toEqual(['work']);
      lowerWork();
      read('work', item.id);
      expect(restrictedReads(world.log, SESSION)).toEqual(['work']);
      const p = propose({ text: 'Tell them the timing.' });
      expect(p.ok && p.labels).toContain('restricted_source');
    });

    it('a topic list', () => {
      world.log.recordTopics({ sessionId: SESSION, audience: 'brain' }, 'work', ['merger']);
      expect(restrictedReads(world.log, SESSION)).toEqual(['work']);
      lowerWork();
      world.log.recordTopics({ sessionId: SESSION, audience: 'brain' }, 'work', ['merger']);
      expect(restrictedReads(world.log, SESSION)).toEqual(['work']);
    });

    it('control: a read made only once lowered is not private', () => {
      lowerWork();
      setVaultRepository('work', new InMemoryVaultRepository());
      released('work', 'The merger closes next week.');
      expect(restrictedReads(world.log, SESSION)).toEqual([]);
    });
  });

  it('derived text inherits the conversation’s read-set taint, item reads and topic lists alike', () => {
    released('health', 'Cholesterol was 190 last month.');
    const p = propose({ text: 'Is my number normal?' });
    if (!p.ok) throw new Error(p.reason);
    expect(p.labels).toEqual(['may_contain_sensitive', 'restricted_source', 'unverified']);
    world.log.recordTopics({ sessionId: 'chat:topics', audience: 'brain' }, 'health', ['diabetes']);
    world.log.recordUtterance('chat:topics', 't1', 'hi');
    const q = proposeDelegation(world.runtime, { agentId, skill: 'summarize', releaseSession: 'chat:topics', text: 'Anything new?' });
    expect(q.ok && q.labels).toContain('restricted_source');
  });

  it('a topic list can taint, but never prove a quote', () => {
    world.log.recordTopics({ sessionId: SESSION, audience: 'brain' }, 'general', ['Dinner plans for Friday night.']);
    expect(
      propose({ text: 'Dinner plans for Friday night.', sources: [vault('Dinner plans for Friday night.', 'general', '#topics')] }),
    ).toEqual({ ok: false, reason: 'source_unproven' });
  });

  it('the consent hash covers the proven sources', () => {
    const item = released('general', BOOK);
    const a = propose({ text: BOOK, sources: [owner(BOOK)] });
    const b = propose({ text: BOOK, sources: [vault(BOOK, 'general', item.id)] });
    expect(a.ok && b.ok && a.consentHash !== b.consentHash).toBe(true);
  });
});

describe('originals: kept for a single provable source, shown to the owner beside the answer (A2A-I9)', () => {
  const EMAIL = 'alonso@example.com';

  async function releasedResult(input: Partial<ProposalInput>, echo: string): Promise<string> {
    const p = propose(input);
    if (!p.ok) throw new Error(p.reason);
    world.workflow.approve(p.approvalTaskId);
    const task = world.claim(agentId);
    if (task === null) throw new Error('no claim');
    const claim = { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
    beginOutboundDispatch(world.runtime, claim);
    recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: echo }] });
    const work = claimNextGuardJob(world.runtime);
    if (work === null) throw new Error('no work');
    submitGuardVerdict(world.runtime, { jobId: work.job_id, claimId: work.claim_id, digest: work.digest, verdict: 'passed', code: 'model_pass' });
    return p.operationId;
  }

  const legendOf = (operationId: string) => placeholderLegend(world.runtime, op(operationId).id, operationId);

  async function ownerView(operationId: string) {
    const router = new CoreRouter();
    registerA2ARoutes(router, CAP);
    return router.handle({
      method: 'GET',
      path: `/v1/owner/a2a/operations/${operationId}`,
      query: {},
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: CAP,
    });
  }

  it('the owner’s own words: kept in the identity file, shown to the owner as a legend, never in the agent’s text', async () => {
    const id = await releasedResult({ text: MAIL, sources: [owner(MAIL)] }, 'See https://evil.example/c?e=[EMAIL_1] now.');
    expect(world.store.entitiesOf(op(id).id).map((e) => [e.placeholder, e.seal])).toEqual([['[EMAIL_1]', 'identity_db']]);
    const view = await ownerView(id);
    expect(view.body).toMatchObject({ placeholder_legend: [{ placeholder: '[EMAIL_1]', original: EMAIL }] });
    // The remote's text keeps its placeholder: no original lands inside its link.
    expect(JSON.stringify((view.body as { result: unknown }).result)).toContain('e=[EMAIL_1]');
    // Brain's view carries no originals at all.
    expect(JSON.stringify(outboundOperationView(world.runtime, id))).not.toContain(EMAIL);
    expect(JSON.stringify(op(id).consent_json)).not.toContain(EMAIL);
  });

  it('a vault original is sealed under a purpose key and opens only while the persona is open', async () => {
    registerPersonaDEK('general', randomBytes(32));
    const sentence = `Clinic email is ${EMAIL} for bookings.`;
    const item = released('general', sentence);
    const id = await releasedResult({ text: sentence, sources: [vault(sentence, 'general', item.id)] }, 'I wrote to [EMAIL_1].');
    const [entity] = world.store.entitiesOf(op(id).id);
    expect(entity).toMatchObject({ placeholder: '[EMAIL_1]', seal: 'persona_dek', persona: 'general' });
    expect(new TextDecoder().decode(entity?.sealed)).not.toContain(EMAIL);
    expect(legendOf(id)).toEqual([{ placeholder: '[EMAIL_1]', original: EMAIL }]);
    releasePersonaDEK('general'); // the persona locks
    expect(legendOf(id)).toEqual([]);
  });

  it('a sealed original moved to another place does not open', async () => {
    registerPersonaDEK('general', randomBytes(32));
    const sentence = `Clinic email is ${EMAIL} for bookings.`;
    const item = released('general', sentence);
    const a = await releasedResult({ text: sentence, sources: [vault(sentence, 'general', item.id)] }, '[EMAIL_1]');
    speak();
    const b = await releasedResult({ text: MAIL, sources: [owner(MAIL)] }, '[EMAIL_1]');
    const sealed = world.store.entitiesOf(op(a).id)[0];
    world.db.run(`UPDATE a2a_entities SET seal = 'persona_dek', persona = 'general', sealed = ? WHERE operation_ref = ?`, [sealed?.sealed, op(b).id]);
    expect(legendOf(b)).toEqual([]);
  });

  it('keeps no original for a value in derived text, in the data part, or held by two sources', async () => {
    const derived = await releasedResult({ text: `ping ${EMAIL}` }, '[EMAIL_1]');
    expect(world.store.entitiesOf(op(derived).id)).toEqual([]);
    speak();
    const inData = await releasedResult({ text: MAIL, data: { cc: EMAIL }, sources: [owner(MAIL)] }, '[EMAIL_1]');
    expect(world.store.entitiesOf(op(inData).id)).toEqual([]);
    speak();
    // The same address in two proven sentences from two sources: neither is its single source.
    const weekly = `Bookings go to ${EMAIL} every week.`;
    const item = released('general', weekly);
    const twoSources = await releasedResult(
      { text: `${MAIL} ${weekly}`, sources: [owner(MAIL), vault(weekly, 'general', item.id)] },
      '[EMAIL_1]',
    );
    expect(world.store.entitiesOf(op(twoSources).id)).toEqual([]);
  });

  it('a deleted persona takes its originals with it; a new persona of the same name finds nothing', async () => {
    registerPersonaDEK('health', randomBytes(32));
    const sentence = `Doctor is reached at ${EMAIL} on weekdays.`;
    const item = released('health', sentence);
    const id = await releasedResult({ text: sentence, sources: [vault(sentence, 'health', item.id)] }, '[EMAIL_1]');
    expect(world.store.entitiesOf(op(id).id)).toHaveLength(1);
    deletePersona('health');
    expect(world.store.entitiesOf(op(id).id)).toEqual([]);
    createPersona('health', 'sensitive');
    expect(legendOf(id)).toEqual([]);
  });

  it('a listener that fails stops the delete, so a persona is never gone while what it sealed remains', () => {
    const off = onPersonaDeleted(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => deletePersona('health')).toThrow('disk full');
    } finally {
      off();
    }
    expect(getPersona('health')).not.toBeNull();
  });

  it('forgets originals 7 days after the operation ends, at 30 days whatever happens, and the operation later', async () => {
    const id = await releasedResult({ text: MAIL, sources: [owner(MAIL)] }, '[EMAIL_1]');
    world.clock += ENTITY_RETENTION_AFTER_END_MS - 1;
    purgeEndedA2AOperations(world.runtime);
    expect(world.store.entitiesOf(op(id).id)).toHaveLength(1);
    world.clock += 2;
    purgeEndedA2AOperations(world.runtime);
    expect(world.store.entitiesOf(op(id).id)).toEqual([]);
    world.clock += A2A_ENDED_RETENTION_MS;
    purgeEndedA2AOperations(world.runtime);
    expect(outboundOperationView(world.runtime, id)).toBeNull();
  });

  it('an original whose result is held forever still goes at its hard end', () => {
    const p = propose({ text: MAIL, sources: [owner(MAIL)] });
    if (!p.ok) throw new Error(p.reason);
    expect(world.store.entitiesOf(op(p.operationId).id)).toHaveLength(1);
    world.clock += ENTITY_MAX_LIFE_MS;
    purgeEndedA2AOperations(world.runtime);
    expect(world.store.entitiesOf(op(p.operationId).id)).toEqual([]);
  });
});
