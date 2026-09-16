/**
 * The organizer's plan card (GROUP_COORDINATION §9) — reads the plan through
 * the owner-marked client, shows one row per household and the folded slots,
 * and carries the organizer's decisions back through the same client.
 *
 * Pinned here: a household that could not be reached is shown with no reason
 * (§5); a decision is offered only when the plan is folded; a refusal comes
 * back as one plain line.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { addLifecycleMessage, getThread, resetThreads, type ChatMessage } from '@dina/brain/chat';
import { OwnerCoordinationHttpError, type GroupPlanWire, type InProcessOwnerCoordinationClient } from '@dina/core';

import { InlineGroupPlanCard, parseCandidates } from '../../src/components/InlineGroupPlanCard';
import { setOwnerCoordinationClient } from '../../src/services/owner_coordination_client';

const THREAD = 't';
const GARCIA = 'did:plc:garcia';
const MILLER = 'did:plc:miller';

function post(planId = 'gp_1'): ChatMessage {
  addLifecycleMessage(THREAD, '', { kind: 'group_plan', status: 'open', planId, intent: "Emma's birthday" });
  const thread = getThread(THREAD);
  return thread[thread.length - 1] as ChatMessage;
}

function plan(over: Partial<GroupPlanWire> = {}): GroupPlanWire {
  return {
    plan_id: 'gp_1',
    intent: "Emma's birthday",
    state: 'proposing',
    window_seconds: 120,
    round: 1,
    round_opened_at: 1,
    window_closes_at: 120_001,
    created_at: 1,
    updated_at: 1,
    candidates: [{ start: 'Sat 19' }, { start: 'Sat 26' }],
    chosen: null,
    fold: { state: 'waiting', agreed: [], missing_required: [GARCIA, MILLER], emptied_by: [], optional_fit: {}, counters: {}, needs_more_info: [] },
    guests: [
      { contact_did: GARCIA, required: true, outcome: 'waiting', reply: null, disclosures: [], spokes: [] },
      { contact_did: MILLER, required: true, outcome: 'waiting', reply: null, disclosures: [], spokes: [] },
    ],
    requirements: [],
    ...over,
  };
}

type FakeClient = Pick<InProcessOwnerCoordinationClient, 'get' | 'choose' | 'widen' | 'makeOptional' | 'abandon'>;

function fakeClient(current: GroupPlanWire | null): FakeClient & { calls: string[] } {
  const calls: string[] = [];
  const client = {
    calls,
    get: jest.fn(async () => current),
    choose: jest.fn(async (_id: string, slot: { start: string }) => {
      calls.push(`choose:${slot.start}`);
      return plan({ state: 'confirming', round: 2, chosen: slot, candidates: [slot] });
    }),
    widen: jest.fn(async (_id: string, candidates: { start: string }[]) => {
      calls.push(`widen:${candidates.map((c) => c.start).join('|')}`);
      return plan({ state: 'proposing', round: 2, candidates });
    }),
    makeOptional: jest.fn(async (_id: string, did: string) => {
      calls.push(`optional:${did}`);
      return plan({ state: 'folded' });
    }),
    abandon: jest.fn(async () => {
      calls.push('abandon');
      return plan({ state: 'abandoned' });
    }),
  };
  return client;
}

function install(client: FakeClient): void {
  setOwnerCoordinationClient(client as unknown as InProcessOwnerCoordinationClient);
}

beforeEach(() => {
  resetThreads();
  setOwnerCoordinationClient(null);
});

describe('InlineGroupPlanCard', () => {
  it('reads the plan and shows one row per household with its outcome, and no reason for a household it could not reach', async () => {
    install(
      fakeClient(
        plan({
          guests: [
            { contact_did: GARCIA, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
            { contact_did: MILLER, required: false, outcome: 'unreachable', reply: null, disclosures: [], spokes: [] },
          ],
        }),
      ),
    );
    render(<InlineGroupPlanCard message={post()} />);
    await waitFor(() => expect(screen.getByTestId('group-plan-card-title-gp_1')).toBeTruthy());
    expect(screen.getByText("Emma's birthday")).toBeTruthy();
    expect(screen.getByText('1 slot works')).toBeTruthy();
    expect(screen.getByText("Couldn't reach")).toBeTruthy();
    expect(screen.queryByText(/refused|offline|declined|grant/i)).toBeNull();
    // Still asking: no decision is offered.
    expect(screen.queryByTestId('group-plan-choose-gp_1-Sat 26')).toBeNull();
    expect(screen.getByText('Waiting for replies…')).toBeTruthy();
  });

  it('while asking, a provisional slot is shown as "works so far" and cannot be chosen', async () => {
    const client = fakeClient(
      plan({
        fold: { state: 'waiting', agreed: [{ start: 'Sat 26' }], missing_required: [MILLER], emptied_by: [], optional_fit: {}, counters: {}, needs_more_info: [] },
        guests: [
          { contact_did: GARCIA, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
          { contact_did: MILLER, required: true, outcome: 'waiting', reply: null, disclosures: [], spokes: [] },
        ],
      }),
    );
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    const slot = await screen.findByTestId('group-plan-choose-gp_1-Sat 26');
    expect(screen.getByText('Works so far:')).toBeTruthy();
    expect(screen.queryByText('Choose Sat 26')).toBeNull();
    await act(async () => {
      fireEvent.press(slot);
    });
    expect(client.calls).toEqual([]);
    expect(screen.queryByTestId(`group-plan-optional-gp_1-${MILLER}`)).toBeNull();
  });

  it('a fold that closed on a household nobody could reach offers "go ahead without", never a choice (§4, §13)', async () => {
    const client = fakeClient(
      plan({
        state: 'folded',
        fold: { state: 'waiting', agreed: [{ start: 'Sat 26' }], missing_required: [MILLER], emptied_by: [], optional_fit: {}, counters: {}, needs_more_info: [] },
        guests: [
          { contact_did: GARCIA, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
          { contact_did: MILLER, required: true, outcome: 'unreachable', reply: null, disclosures: [], spokes: [] },
        ],
      }),
    );
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    const without = await screen.findByTestId(`group-plan-optional-gp_1-${MILLER}`);
    expect(screen.getByText('Works so far:')).toBeTruthy();
    expect(screen.queryByText('Choose Sat 26')).toBeNull();
    expect(screen.getByTestId('group-plan-outcome-gp_1').props.children).toMatch(/Couldn't reach did:plc:miller/);
    await act(async () => {
      fireEvent.press(screen.getByTestId('group-plan-choose-gp_1-Sat 26'));
    });
    expect(client.calls).toEqual([]);
    await act(async () => {
      fireEvent.press(without);
    });
    expect(client.calls).toEqual([`optional:${MILLER}`]);
  });

  it('a household that reneged at confirm leaves the organizer the §13 moves: go ahead without them, ask again, stop', async () => {
    const client = fakeClient(
      plan({
        state: 'confirming',
        round: 2,
        chosen: { start: 'Sat 26' },
        candidates: [{ start: 'Sat 26' }],
        fold: { state: 'empty', agreed: [], missing_required: [], emptied_by: [GARCIA], optional_fit: {}, counters: { [GARCIA]: [{ start: 'Sun 27' }] }, needs_more_info: [] },
        guests: [
          { contact_did: GARCIA, required: true, outcome: 'answered', reply: { status: 'counter', counter_slots: [{ start: 'Sun 27' }] }, disclosures: [], spokes: [] },
          { contact_did: MILLER, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
        ],
      }),
    );
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    const without = await screen.findByTestId(`group-plan-optional-gp_1-${GARCIA}`);
    expect(screen.getByTestId('group-plan-outcome-gp_1').props.children).toMatch(/did:plc:garcia can't make Sat 26 after all/);
    expect(screen.getByTestId('group-plan-widen-input-gp_1')).toBeTruthy();
    expect(screen.getByTestId('group-plan-stop-gp_1')).toBeTruthy();
    await act(async () => {
      fireEvent.press(without);
    });
    expect(client.calls).toEqual([`optional:${GARCIA}`]);
  });

  it('a read that fails says so instead of spinning forever', async () => {
    const client = fakeClient(null);
    client.get = jest.fn(async () => {
      throw new OwnerCoordinationHttpError('x', 503, 'not_wired');
    });
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    await waitFor(() => expect(screen.getByTestId('group-plan-unreadable-gp_1')).toBeTruthy());
  });

  it('offers the agreed slots as choices only once the plan folded, and sends the choice through the owner client', async () => {
    const client = fakeClient(
      plan({
        state: 'folded',
        fold: { state: 'converged', agreed: [{ start: 'Sat 26' }], missing_required: [], emptied_by: [], optional_fit: {}, counters: {}, needs_more_info: [] },
        guests: [
          { contact_did: GARCIA, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
          { contact_did: MILLER, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
        ],
      }),
    );
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    const choose = await screen.findByTestId('group-plan-choose-gp_1-Sat 26');
    expect(screen.getByText('Choose Sat 26')).toBeTruthy();
    await act(async () => {
      fireEvent.press(choose);
    });
    expect(client.calls).toEqual(['choose:Sat 26']);
    await waitFor(() => expect(screen.getByText('Confirming Sat 26 with everyone…')).toBeTruthy());
  });

  it('names the household that emptied the fold only when it answered, and offers "go ahead without" for one it could not reach', async () => {
    const client = fakeClient(
      plan({
        state: 'folded',
        fold: { state: 'waiting', agreed: [], missing_required: [MILLER], emptied_by: [], optional_fit: {}, counters: {}, needs_more_info: [] },
        guests: [
          { contact_did: GARCIA, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
          { contact_did: MILLER, required: true, outcome: 'unreachable', reply: null, disclosures: [], spokes: [] },
        ],
      }),
    );
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    const without = await screen.findByTestId(`group-plan-optional-gp_1-${MILLER}`);
    expect(screen.getByText(/Couldn't reach did:plc:m/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(without);
    });
    expect(client.calls).toEqual([`optional:${MILLER}`]);
  });

  it('widens with the dates the organizer typed, and stops the plan', async () => {
    const client = fakeClient(
      plan({
        state: 'folded',
        fold: { state: 'empty', agreed: [], missing_required: [], emptied_by: [GARCIA], optional_fit: {}, counters: {}, needs_more_info: [] },
        guests: [
          { contact_did: GARCIA, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [] }, disclosures: [], spokes: [] },
          { contact_did: MILLER, required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] },
        ],
      }),
    );
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    const input = await screen.findByTestId('group-plan-widen-input-gp_1');
    expect(screen.getByText(/No slot works for did:plc:g/)).toBeTruthy();
    fireEvent.changeText(input, 'Sun 27, Sun 4 Oct');
    await act(async () => {
      fireEvent.press(screen.getByTestId('group-plan-widen-gp_1'));
    });
    expect(client.calls).toEqual(['widen:Sun 27|Sun 4 Oct']);
    await act(async () => {
      fireEvent.press(screen.getByTestId('group-plan-stop-gp_1'));
    });
    expect(client.calls).toEqual(['widen:Sun 27|Sun 4 Oct', 'abandon']);
    await waitFor(() => expect(screen.getByText('You stopped this plan.')).toBeTruthy());
  });

  it("a refusal from Core is one plain line, keyed by the route's own name", async () => {
    const client = fakeClient(
      plan({
        state: 'folded',
        fold: { state: 'converged', agreed: [{ start: 'Sat 26' }], missing_required: [], emptied_by: [], optional_fit: {}, counters: {}, needs_more_info: [] },
      }),
    );
    client.choose = jest.fn(async () => {
      throw new OwnerCoordinationHttpError('x', 409, 'rounds_exhausted');
    });
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    const choose = await screen.findByTestId('group-plan-choose-gp_1-Sat 26');
    await act(async () => {
      fireEvent.press(choose);
    });
    await waitFor(() => expect(screen.getByTestId('group-plan-error-gp_1')).toBeTruthy());
    expect(screen.getByText(/last round Dina can ask/)).toBeTruthy();
  });

  it('a settled plan shows the slot and can still be reopened with other dates or cancelled (§13); a deleted plan says so', async () => {
    const client = fakeClient(plan({ state: 'settled', chosen: { start: 'Sat 26' } }));
    install(client);
    render(<InlineGroupPlanCard message={post()} />);
    await waitFor(() => expect(screen.getByTestId('group-plan-settled-gp_1')).toBeTruthy());
    expect(screen.getByText('Settled: Sat 26')).toBeTruthy();
    expect(screen.queryByTestId('group-plan-choose-gp_1-Sat 26')).toBeNull();
    expect(screen.getByText('Cancel this plan')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('group-plan-widen-input-gp_1'), 'Sun 27');
    await act(async () => {
      fireEvent.press(screen.getByTestId('group-plan-widen-gp_1'));
    });
    expect(client.calls).toEqual(['widen:Sun 27']);

    resetThreads();
    install(fakeClient(null));
    render(<InlineGroupPlanCard message={post('gp_gone')} />);
    await waitFor(() => expect(screen.getByText('This plan was deleted.')).toBeTruthy());
  });

  it('parses the organizer’s dates one per comma or line', () => {
    expect(parseCandidates(' Sun 27, Sun 4 Oct\n\n Sat 10 ;')).toEqual([{ start: 'Sun 27' }, { start: 'Sun 4 Oct' }, { start: 'Sat 10' }]);
    expect(parseCandidates('   ')).toEqual([]);
  });
});
