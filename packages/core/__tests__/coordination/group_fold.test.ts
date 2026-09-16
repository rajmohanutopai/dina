/**
 * The fold (GROUP_COORDINATION §4, §16 rules 1–3) — pure, and pinned by the
 * three rules that give it its shape.
 *
 * Most of these are about what the fold does NOT do: read a silence as a no,
 * let arrival order change the answer, or treat a guest's own wording of a
 * date as the organizer's candidate.
 */

import { foldGroupPlan, slotKey, type FoldGuest, type MeetingSlot } from '../../src/coordination/group_fold';

const SAT_12: MeetingSlot = { start: 'Sat 12' };
const SAT_19: MeetingSlot = { start: 'Sat 19' };
const SAT_26: MeetingSlot = { start: 'Sat 26' };
const CANDIDATES = [SAT_12, SAT_19, SAT_26];

const GARCIA = 'did:plc:garcia';
const MILLER = 'did:plc:miller';
const JOHNSON = 'did:plc:johnson';

function accepted(contactDid: string, slots: MeetingSlot[], required = true): FoldGuest {
  return { contactDid, required, reply: { status: 'accepted', accepted_slots: slots } };
}
function silent(contactDid: string, required = true): FoldGuest {
  return { contactDid, required, reply: null };
}
function counter(contactDid: string, slots: MeetingSlot[], required = true): FoldGuest {
  return { contactDid, required, reply: { status: 'counter', counter_slots: slots } };
}

describe('the intersection', () => {
  it('converges on the candidates every required guest accepted, in the organizer’s order', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [
        accepted(GARCIA, [SAT_26, SAT_19]),
        accepted(MILLER, [SAT_19, SAT_26, SAT_12]),
        accepted(JOHNSON, [SAT_26, SAT_19]),
      ],
    });
    expect(fold.state).toBe('converged');
    expect(fold.agreed).toEqual([SAT_19, SAT_26]);
    expect(fold.missingRequired).toEqual([]);
    expect(fold.emptiedBy).toEqual([]);
  });

  it('is order-independent — the same replies in any order give the same fold (rule 1)', () => {
    const guests = [
      accepted(GARCIA, [SAT_26]),
      accepted(MILLER, [SAT_26, SAT_12]),
      accepted(JOHNSON, [SAT_12, SAT_26], false),
    ];
    const forward = foldGroupPlan({ candidates: CANDIDATES, guests });
    const reversed = foldGroupPlan({ candidates: CANDIDATES, guests: [...guests].reverse() });
    const shuffled = foldGroupPlan({ candidates: CANDIDATES, guests: [guests[1], guests[2], guests[0]] });
    // The guest lists differ in order, so per-guest maps are compared by content.
    expect(reversed.agreed).toEqual(forward.agreed);
    expect(shuffled.agreed).toEqual(forward.agreed);
    expect(reversed.optionalFit).toEqual(forward.optionalFit);
    expect(reversed.state).toBe(forward.state);
    // And the candidate order in the answer is the organizer's, not anyone's reply order.
    const scrambledCandidates = foldGroupPlan({ candidates: [SAT_26, SAT_12, SAT_19], guests });
    expect(scrambledCandidates.agreed).toEqual([SAT_26]);
  });

  it('a required guest’s non-answer blocks; an optional guest’s does not (rule 2)', () => {
    const blocked = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_26]), silent(MILLER), accepted(JOHNSON, [SAT_26])],
    });
    expect(blocked.state).toBe('waiting');
    expect(blocked.missingRequired).toEqual([MILLER]);
    // Provisional: what the answered required guests agree on so far.
    expect(blocked.agreed).toEqual([SAT_26]);

    const unblocked = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_26]), silent(MILLER, false), accepted(JOHNSON, [SAT_26])],
    });
    expect(unblocked.state).toBe('converged');
    expect(unblocked.missingRequired).toEqual([]);
  });

  it('a non-answer is never read as a refusal — `emptiedBy` names only guests who answered (rule 3)', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_12]), accepted(MILLER, [SAT_26]), silent(JOHNSON)],
    });
    expect(fold.state).toBe('waiting');
    expect(fold.emptiedBy).toEqual([]);
    expect(fold.missingRequired).toEqual([JOHNSON]);
  });

  it('with nobody required answered yet, nothing is agreed — an empty intersection is not "everything"', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [silent(GARCIA), silent(MILLER), accepted(JOHNSON, [SAT_12, SAT_19, SAT_26], false)],
    });
    expect(fold.state).toBe('waiting');
    expect(fold.agreed).toEqual([]);
  });
});

describe('who emptied it', () => {
  it('names the required guest whose acceptance shares nothing with what the others agree on', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_26, SAT_19]), accepted(MILLER, [SAT_19, SAT_26]), accepted(JOHNSON, [SAT_12])],
    });
    expect(fold.state).toBe('empty');
    expect(fold.agreed).toEqual([]);
    expect(fold.emptiedBy).toEqual([JOHNSON]);
  });

  it('names nobody when the others agree on nothing either', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_12]), accepted(MILLER, [SAT_19]), accepted(JOHNSON, [SAT_26])],
    });
    expect(fold.state).toBe('empty');
    expect(fold.emptiedBy).toEqual([]);
  });

  it('a lone required guest who accepted nothing emptied it alone', () => {
    const fold = foldGroupPlan({ candidates: CANDIDATES, guests: [accepted(GARCIA, [])] });
    expect(fold.state).toBe('empty');
    expect(fold.emptiedBy).toEqual([GARCIA]);
  });
});

describe('acceptance is echoing a candidate', () => {
  it('compares by a canonical key — spacing and case do not matter, the words do', () => {
    expect(slotKey({ start: '  sat  26 ' })).toBe(slotKey({ start: 'Sat 26' }));
    expect(slotKey({ start: 'Saturday the 26th' })).not.toBe(slotKey({ start: 'Sat 26' }));
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [{ start: 'SAT 26', note: 'parking is easy' }]), accepted(MILLER, [SAT_26])],
    });
    expect(fold.agreed).toEqual([SAT_26]);
  });

  it('a slot the organizer never proposed is a counter, whatever the guest called it', () => {
    const sun27 = { start: 'Sun 27' };
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_26, sun27]), accepted(MILLER, [SAT_26])],
    });
    expect(fold.agreed).toEqual([SAT_26]);
    expect(fold.counters).toEqual({ [GARCIA]: [sun27] });
  });

  it('a `counter` reply accepts nothing, even where it echoes a candidate', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_26]), counter(MILLER, [SAT_26, { start: 'Sun 27' }])],
    });
    expect(fold.state).toBe('empty');
    expect(fold.emptiedBy).toEqual([MILLER]);
    expect(fold.counters[MILLER]).toEqual([SAT_26, { start: 'Sun 27' }]);
  });

  it('`needs_more_info` accepts nothing and is listed as such', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [
        accepted(GARCIA, [SAT_26]),
        { contactDid: MILLER, required: true, reply: { status: 'needs_more_info', message: 'which weekend?' } },
      ],
    });
    expect(fold.state).toBe('empty');
    expect(fold.needsMoreInfo).toEqual([MILLER]);
    // A question is not a no: the guest who asked did not empty the fold.
    expect(fold.emptiedBy).toEqual([]);
  });

  it('an `accepted` with no slots is an honest reply that accepts nothing', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_26]), { contactDid: MILLER, required: true, reply: { status: 'accepted' } }],
    });
    expect(fold.state).toBe('empty');
    expect(fold.emptiedBy).toEqual([MILLER]);
  });

  it('duplicate candidates and duplicate acceptances collapse by key, first wording kept', () => {
    const fold = foldGroupPlan({
      candidates: [SAT_26, { start: 'sat 26' }, SAT_19],
      guests: [accepted(GARCIA, [SAT_26, { start: 'SAT 26' }])],
    });
    expect(fold.agreed).toEqual([SAT_26]);
  });
});

describe('optional guests', () => {
  it('report which of the agreed slots suit them, and never narrow the agreed set', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [
        accepted(GARCIA, [SAT_19, SAT_26]),
        accepted(MILLER, [SAT_19, SAT_26]),
        accepted(JOHNSON, [SAT_26], false),
      ],
    });
    expect(fold.agreed).toEqual([SAT_19, SAT_26]);
    expect(fold.optionalFit).toEqual({ [JOHNSON]: [SAT_26] });
  });

  it('an optional guest who accepted nothing agreed on is reported as fitting nothing', () => {
    const fold = foldGroupPlan({
      candidates: CANDIDATES,
      guests: [accepted(GARCIA, [SAT_26]), accepted(JOHNSON, [SAT_12], false)],
    });
    expect(fold.optionalFit).toEqual({ [JOHNSON]: [] });
    expect(fold.state).toBe('converged');
  });
});
