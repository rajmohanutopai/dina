/**
 * Lane 1 provenance gaps (design A2A-I12, §4.2, §6.2 step 2, §9): the 24-hour
 * log of the owner's words, an item carried from one thread to another, and
 * releases logged for an audience other than Brain.
 */

import { makeVaultItem } from '@dina/test-harness';

import {
  RELEASE_LOG_TTL_MS,
  parseDelegationConsentCard,
  proposeDelegation,
  type ProposalInput,
} from '../../src/a2a';
import { createPersona, resetPersonaState } from '../../src/persona/service';
import { clearVaults, getItem, storeItem } from '../../src/vault/crud';

import { LaneWorld, SESSION, START } from './outbound_fixture';

const FIRST = 'Please book a table for two at seven.';
const LATER = 'Also check the opening hours for Sunday.';
const NOTE = 'The clinic opens at nine on weekdays.';

let world: LaneWorld;
let agentId: string;

beforeEach(async () => {
  clearVaults();
  resetPersonaState();
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  world = new LaneWorld();
  ({ agentId } = await world.activeAgent());
});

afterEach(() => {
  resetPersonaState();
  jest.restoreAllMocks();
  world.close();
});

const read = (persona: string, id: string, session = SESSION) => getItem(persona, id, { sessionId: session, audience: 'brain' });
const vault = (quote: string, persona: string, id: string) => ({ quote, from: 'vault', persona, item_id: id });
const owner = (quote: string) => ({ quote, from: 'owner' });

function propose(over: Partial<ProposalInput>, session = SESSION) {
  return proposeDelegation(world.runtime, { agentId, skill: 'summarize', releaseSession: session, ...over });
}

/** Store an item whose write stamp is `atMs` (Core stamps every write with the clock). */
function writtenAt(persona: string, body: string, atMs: number) {
  const item = makeVaultItem({ summary: 'Note', body });
  jest.spyOn(Date, 'now').mockReturnValueOnce(atMs);
  storeItem(persona, item);
  return item;
}

describe('the 24-hour log of the owner’s words (design §4.2 (a), §6.2 step 2)', () => {
  // Plan B95 (as the verifier read it: the conversation is what the 24-hour log holds)
  it('once the first turns pass the 24-hour window, an item written after the oldest turn Core still holds proves nothing', () => {
    const OLD_NOTE = 'The pharmacy closes at six on Saturdays.';
    // Control: an item saved before any turn, read and quoted in the same way.
    const old = writtenAt('general', OLD_NOTE, START - 60_000);
    world.turn(FIRST); // at START
    world.clock = START + 2 * 60 * 60_000;
    world.turn(LATER); // the oldest turn left once the first ones go
    const fresh = writtenAt('general', NOTE, START + 3 * 60 * 60_000);
    expect([getItem('general', old.id)?.updated_at, getItem('general', fresh.id)?.updated_at]).toEqual([START - 60_000, START + 3 * 60 * 60_000]);

    world.clock = START + RELEASE_LOG_TTL_MS + 60 * 60_000;
    world.turn('Send the clinic note to the agent, please.');
    read('general', old.id);
    read('general', fresh.id);

    // The log kept the first turns for 24 hours and no longer.
    expect(propose({ text: FIRST, sources: [owner(FIRST)] })).toEqual({ ok: false, reason: 'source_unproven' });
    expect(propose({ text: LATER, sources: [owner(LATER)] }).ok).toBe(true);
    // Read and logged the same way, the older item proves: so the refusal below comes from the write time alone.
    expect(propose({ text: OLD_NOTE, sources: [vault(OLD_NOTE, 'general', old.id)] }).ok).toBe(true);
    // The item was written during the part of the conversation Core still holds.
    expect(propose({ text: NOTE, sources: [vault(NOTE, 'general', fresh.id)] })).toEqual({ ok: false, reason: 'source_unproven' });
  });
});

describe('an item carried from one thread to another (A2A-I12, §10 laundering residual)', () => {
  // Plan B96 (as the verifier read it: the card says what the proof shows; taint stays per thread)
  it('proves only as an item of its own vault saved before this thread, and the card says so; this thread’s own reads decide its taint', () => {
    const THREAD_A = 'chat:a';
    const THREAD_B = 'chat:b';
    world.log.recordUtterance(THREAD_A, 'a-1', 'What did my last blood test say?');
    const lab = writtenAt('health', 'Cholesterol was 190 last month.', START - 60_000);
    read('health', lab.id, THREAD_A);
    // Thread A's model writes a general note from what it read there.
    const copied = writtenAt('general', NOTE, START + 1_000);

    world.clock = START + 60 * 60_000;
    world.log.recordUtterance(THREAD_B, 'b-1', 'Send my clinic note to the agent.');
    read('general', copied.id, THREAD_B);
    const proven = propose({ text: NOTE, sources: [vault(NOTE, 'general', copied.id)] }, THREAD_B);
    if (!proven.ok) throw new Error(proven.reason);
    expect(proven.labels).toEqual([]);
    const card = parseDelegationConsentCard(world.repo.getById(proven.approvalTaskId)?.payload ?? '');
    expect(card?.display.sources).toEqual([`“${NOTE}” is the full text of an item in your general vault, saved before this conversation.`]);

    // Thread A read the health vault; thread B has not yet, so its derived text carries no taint.
    const derivedText = `${NOTE} Please summarize it.`;
    const before = propose({ text: derivedText, sources: [vault(NOTE, 'general', copied.id)] }, THREAD_B);
    expect(before.ok && before.labels).toEqual(['may_contain_sensitive', 'unverified']);

    // Thread B reads the health vault too: its derived text now carries the taint.
    read('health', lab.id, THREAD_B);
    const derived = propose({ text: derivedText, sources: [vault(NOTE, 'general', copied.id)] }, THREAD_B);
    expect(derived.ok && derived.labels).toEqual(['may_contain_sensitive', 'restricted_source', 'unverified']);
  });
});

describe('releases belong to Brain alone (design §9 a2a_disclosures)', () => {
  // Plan B120
  it('the log refuses a release for any other audience, and a read that names one fails, so nothing leaves unlogged', () => {
    world.turn(FIRST);
    const item = writtenAt('general', NOTE, START - 60_000);
    expect(() =>
      world.log.recordDisclosures({ sessionId: SESSION, audience: 'agent' as never }, 'general', [item]),
    ).toThrow(/CHECK constraint failed/);
    expect(() => getItem('general', item.id, { sessionId: SESSION, audience: 'agent' as never })).toThrow(/CHECK constraint failed/);
    expect(world.db.query(`SELECT audience FROM a2a_disclosures`)).toEqual([]);

    // Control, in another conversation: the same item released to Brain writes one row.
    world.log.recordDisclosures({ sessionId: 'chat:control', audience: 'brain' }, 'general', [item]);
    expect(world.db.query(`SELECT session_id, audience FROM a2a_disclosures`)).toEqual([{ session_id: 'chat:control', audience: 'brain' }]);
    // This conversation logged no release, so the item proves nothing here.
    expect(propose({ text: NOTE, sources: [vault(NOTE, 'general', item.id)] })).toEqual({ ok: false, reason: 'source_unproven' });
  });
});
