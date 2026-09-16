/**
 * `coordinate_group` (GROUP_COORDINATION §11; §16 rule 10) — the one tool
 * that touches N contacts: names resolve against the contact directory, one
 * call hands the whole guest list to Core, and the turn ends.
 */

import { createCoordinateGroupTool, createGroupPlanHandoffTool, matchGuest, nameKey } from '../../src/reasoning/group_tools';

import type { CoordinateGroupCoreClient, CoordinateGroupOutcome, GroupPlanChoice, GroupPlanHandoff } from '../../src/reasoning/group_tools';
import type { Contact, GroupPlanWire, OpenGroupPlanClientResult } from '@dina/core';

function contact(did: string, displayName: string, aliases: string[] = []): Contact {
  return {
    personId: `person_${did}`,
    did,
    displayName,
    trustLevel: 'verified',
    sharingTier: 'summary',
    relationship: 'friend',
    dataResponsibility: 'personal',
    aliases,
  } as unknown as Contact;
}

const GARCIAS = contact('did:plc:garcia', 'The Garcias', ['Garcia family']);
const MILLERS = contact('did:plc:miller', 'The Millers');
const JOHNSONS = contact('did:plc:johnson', 'The Johnsons');
const MILLER_TOM = contact('did:plc:tom', 'Tom Miller');

function planWire(over: Partial<GroupPlanWire> = {}): GroupPlanWire {
  return {
    plan_id: 'gp_1',
    intent: "Emma's 8th birthday",
    state: 'proposing',
    window_seconds: 300,
    round: 1,
    round_opened_at: 1,
    window_closes_at: 300_001,
    created_at: 1,
    updated_at: 1,
    candidates: [{ start: 'Sat 26' }],
    chosen: null,
    fold: null,
    guests: [
      { contact_did: 'did:plc:garcia', required: true, outcome: 'waiting', reply: null, disclosures: [], spokes: [] },
      { contact_did: 'did:plc:miller', required: false, outcome: 'waiting', reply: null, disclosures: [], spokes: [] },
    ],
    requirements: [],
    ...over,
  };
}

function fakeCore(result: OpenGroupPlanClientResult, contacts: Contact[] = [GARCIAS, MILLERS, JOHNSONS]) {
  const open = jest.fn(async () => result);
  const list = jest.fn(async () => contacts);
  const core: CoordinateGroupCoreClient = { openGroupPlan: open, listContacts: list };
  return { core, open, list };
}

const ARGS = {
  intent: "Emma's 8th birthday",
  guests: [{ name: 'the Garcias' }, { name: 'Millers', required: false }],
  candidate_slots: [{ start: 'Sat 26' }],
};

describe('names become contacts in routing, never by guessing', () => {
  it('folds case, spacing and the leading article', () => {
    expect(nameKey('  The   Garcias ')).toBe('garcias');
    expect(nameKey('the millers')).toBe('millers');
  });

  it('an exact display name or alias wins; a contained name matches one; two matches are a question', () => {
    const all = [GARCIAS, MILLERS, JOHNSONS, MILLER_TOM];
    expect(matchGuest('The Garcias', all)).toEqual({ kind: 'one', contact: GARCIAS });
    expect(matchGuest('garcia family', all)).toEqual({ kind: 'one', contact: GARCIAS });
    expect(matchGuest('Johnsons', all)).toEqual({ kind: 'one', contact: JOHNSONS });
    expect(matchGuest('Miller', all)).toEqual({ kind: 'many', names: ['The Millers', 'Tom Miller'] });
    expect(matchGuest('the Millers', all)).toEqual({ kind: 'one', contact: MILLERS });
    expect(matchGuest('did:plc:tom', all)).toEqual({ kind: 'one', contact: MILLER_TOM });
    expect(matchGuest('Smiths', all)).toEqual({ kind: 'none' });
    expect(matchGuest('', all)).toEqual({ kind: 'none' });
  });
});

describe('coordinate_group', () => {
  it('is terminal, hands Core the whole guest list in ONE call, and answers with the plan (rule 10)', async () => {
    const { core, open, list } = fakeCore({ ok: true, plan: planWire() });
    const events: Record<string, unknown>[] = [];
    const tool = createCoordinateGroupTool({ core, logger: (e) => events.push(e) });
    expect(tool.terminal).toBe(true);
    const out = await tool.execute(ARGS);
    expect(list).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({
      intent: "Emma's 8th birthday",
      guests: [
        { contactDid: 'did:plc:garcia', required: true },
        { contactDid: 'did:plc:miller', required: false },
      ],
      candidates: [{ start: 'Sat 26' }],
    });
    expect(out).toEqual(
      expect.objectContaining({
        status: 'pending',
        plan_id: 'gp_1',
        guests: [
          { contact_did: 'did:plc:garcia', display_name: 'The Garcias', required: true },
          { contact_did: 'did:plc:miller', display_name: 'The Millers', required: false },
        ],
        window_closes_at: 300_001,
      }),
    );
    // The log carries counts and the outcome, never a name, an intent or a slot.
    expect(events).toEqual([{ event: 'group_plan_requested', guests: 2, candidates: 1, outcome: 'opened' }]);
    expect(JSON.stringify(events)).not.toContain('Garcia');
    expect(JSON.stringify(events)).not.toContain('Emma');
  });

  it('a second call in the same request is refused — one plan per question', async () => {
    const { core, open } = fakeCore({ ok: true, plan: planWire() });
    const tool = createCoordinateGroupTool({ core });
    await tool.execute(ARGS);
    await expect(tool.execute(ARGS)).rejects.toThrow(/already opened/);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('an unknown or ambiguous name is a question back to the user, and nothing is sent', async () => {
    const { core, open } = fakeCore({ ok: true, plan: planWire() }, [GARCIAS, MILLERS, MILLER_TOM]);
    const tool = createCoordinateGroupTool({ core });
    await expect(tool.execute({ ...ARGS, guests: [{ name: 'the Garcias' }, { name: 'Smiths' }] })).rejects.toThrow(
      /not in the user's contacts: Smiths/,
    );
    await expect(tool.execute({ ...ARGS, guests: [{ name: 'Miller' }] })).rejects.toThrow(
      /more than one contact matches: Miller \(The Millers, Tom Miller\)/,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("Core's refusal is relayed by name, and the same guest named twice is asked once", async () => {
    const { core, open } = fakeCore({ ok: false, refusal: 'too_many_candidates', detail: '13 candidates; the ceiling is 12' });
    const tool = createCoordinateGroupTool({ core });
    await expect(
      tool.execute({ ...ARGS, guests: [{ name: 'the Garcias' }, { name: 'Garcia family' }, { name: 'did:plc:miller' }] }),
    ).rejects.toThrow(/coordinate_group refused \(too_many_candidates\): 13 candidates/);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        guests: [
          { contactDid: 'did:plc:garcia', required: true },
          { contactDid: 'did:plc:miller', required: true },
        ],
      }),
    );
  });

  it('malformed arguments are refused before Core is asked', async () => {
    const { core, open } = fakeCore({ ok: true, plan: planWire() });
    const tool = createCoordinateGroupTool({ core });
    await expect(tool.execute({ ...ARGS, intent: '' })).rejects.toThrow(/intent is required/);
    await expect(tool.execute({ ...ARGS, guests: [] })).rejects.toThrow(/guests must be a non-empty array/);
    await expect(tool.execute({ ...ARGS, candidate_slots: [{ note: 'x' }] })).rejects.toThrow(/start is required/);
    await expect(tool.execute({ ...ARGS, guests: [{ required: true }] })).rejects.toThrow(/every guest needs a name/);
    expect(open).not.toHaveBeenCalled();
  });

  it('an unreadable success reply ends the turn without asking again', async () => {
    const { core } = fakeCore({ ok: false, refusal: 'response_malformed', detail: 'x' });
    const tool = createCoordinateGroupTool({ core });
    const out = (await tool.execute(ARGS)) as CoordinateGroupOutcome;
    expect(out.status).toBe('pending');
    expect(out.plan_id).toBe('');
    await expect(tool.execute(ARGS)).rejects.toThrow(/already opened/);
  });
});

describe('group_plan_handoff (§10; rule 7)', () => {
  const settled = planWire({
    state: 'settled',
    chosen: { start: 'Sat 26' },
    requirements: [{ kind: 'dietary', count: 1, needs: ['gluten-free'] }],
    guests: [
      {
        contact_did: 'did:plc:garcia',
        required: true,
        outcome: 'answered',
        reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] },
        disclosures: [{ kind: 'dietary', text: 'gluten-free', about: 'household' }],
        spokes: [{ round: 1, stage: 'queried', task_id: 't1' }],
      },
    ],
  });

  const handleOf = (p: GroupPlanWire) => ({ plan_id: p.plan_id, intent: p.intent, state: p.state, round: p.round, chosen: p.chosen, updated_at: p.updated_at });

  it('hands the model the slot and the de-identified requirements — and not one household, reply or disclosure', async () => {
    const tool = createGroupPlanHandoffTool({ core: { getGroupPlan: jest.fn(async () => settled), listGroupPlanHandles: jest.fn(async () => []) } });
    expect(tool.terminal).toBeUndefined();
    const out = (await tool.execute({ plan_id: 'gp_1' })) as GroupPlanHandoff;
    expect(out).toEqual(
      expect.objectContaining({
        plan_id: 'gp_1',
        state: 'settled',
        chosen: { start: 'Sat 26' },
        requirements: [{ kind: 'dietary', count: 1, needs: ['gluten-free'] }],
        ready: true,
      }),
    );
    const wire = JSON.stringify(out);
    // The NEED travels (§10: "one gluten-free portion"); the household, the
    // name, the reply and the disclosure record do not (rule 7).
    expect(wire).toContain('gluten-free');
    expect(wire).not.toContain('did:');
    expect(wire).not.toContain('Garcia');
    expect(wire).not.toContain('household');
    expect(wire).not.toContain('about');
    expect(wire).not.toContain('accepted_slots');
    expect(wire).not.toContain('disclosures');
  });

  it('is not ready before a slot is chosen, says so for a stopped plan, and refuses an unknown one', async () => {
    const open = createGroupPlanHandoffTool({ core: { getGroupPlan: jest.fn(async () => planWire()), listGroupPlanHandles: jest.fn(async () => []) } });
    const notReady = (await open.execute({ plan_id: 'gp_1' })) as GroupPlanHandoff;
    expect(notReady.ready).toBe(false);
    expect(notReady.chosen).toBeNull();
    expect(notReady.note).toMatch(/No slot is chosen yet/);

    const stopped = createGroupPlanHandoffTool({ core: { getGroupPlan: jest.fn(async () => planWire({ state: 'abandoned' })), listGroupPlanHandles: jest.fn(async () => []) } });
    expect(((await stopped.execute({ plan_id: 'gp_1' })) as GroupPlanHandoff).note).toMatch(/stopped this plan/);

    const missing = createGroupPlanHandoffTool({ core: { getGroupPlan: jest.fn(async () => null), listGroupPlanHandles: jest.fn(async () => []) } });
    await expect(missing.execute({ plan_id: 'nope' })).rejects.toThrow(/no plan nope/);
  });

  it('with no plan id it finds the plan from the handles: one plan, or the one that is bookable; several → a choice; none → a refusal that offers to plan (found on the first live run)', async () => {
    const proposing = planWire({ plan_id: 'gp_open', intent: 'cake tasting' });
    const byId = new Map<string, GroupPlanWire>([[settled.plan_id, settled], [proposing.plan_id, proposing]]);
    const core = (handles: GroupPlanWire[]) => ({
      getGroupPlan: jest.fn(async (id: string) => byId.get(id) ?? null),
      listGroupPlanHandles: jest.fn(async () => handles.map(handleOf)),
    });
    // One plan: it is the plan.
    const one = createGroupPlanHandoffTool({ core: core([proposing]) });
    expect(((await one.execute({})) as GroupPlanHandoff).plan_id).toBe('gp_open');
    // Two plans, one settled: the settled one is what a booking follows.
    const two = createGroupPlanHandoffTool({ core: core([proposing, settled]) });
    const picked = (await two.execute({})) as GroupPlanHandoff;
    expect(picked.plan_id).toBe('gp_1');
    expect(picked.ready).toBe(true);
    // Two plans, both still open: hand the handles back — id, intent, state, chosen; no guests.
    const other = planWire({ plan_id: 'gp_other', intent: 'dinner with the Millers' });
    const ambiguous = createGroupPlanHandoffTool({ core: core([proposing, other]) });
    const choice = (await ambiguous.execute({})) as GroupPlanChoice;
    expect(choice.status).toBe('choose_plan');
    expect(choice.plans.map((p) => p.plan_id)).toEqual(['gp_open', 'gp_other']);
    expect(JSON.stringify(choice)).not.toContain('did:');
    // No plans at all: a refusal the model relays, pointing at coordinate_group.
    const none = createGroupPlanHandoffTool({ core: core([]) });
    await expect(none.execute({})).rejects.toThrow(/coordinated no plan yet/);
  });
});
