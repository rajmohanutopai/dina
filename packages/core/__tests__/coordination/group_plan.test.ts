/**
 * The plan aggregate (GROUP_COORDINATION §7, §16 rules 6–8) — a state machine
 * of pure transitions, bounds refused by name, and requirements that leave
 * de-identified.
 */

import {
  MAX_GROUP_GUESTS,
  MAX_PLAN_CANDIDATES,
  MAX_PLAN_ROUNDS,
  MAX_WINDOW_SECONDS,
  abandon,
  choose,
  createGroupPlan,
  currentSpoke,
  deriveRequirements,
  foldPlan,
  makeOptional,
  markUnreachable,
  normaliseDisclosure,
  openRound,
  recordReply,
  recordSpoke,
  widen,
  windowClosesAt,
  type GroupPlan,
  type PlanResult,
} from '../../src/coordination/group_plan';

const T0 = 1_800_000_000_000;
const GARCIA = 'did:plc:garcia';
const MILLER = 'did:plc:miller';
const JOHNSON = 'did:plc:johnson';
const SAT_19 = { start: 'Sat 19' };
const SAT_26 = { start: 'Sat 26' };

function ok(result: PlanResult): GroupPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal} ${result.detail ?? ''}`);
  return result.plan;
}
function refusal(result: PlanResult): string {
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

const FRESH_ARGS: Parameters<typeof createGroupPlan>[0] = {
  planId: 'plan_1',
  intent: "Emma's 8th birthday, a Saturday this month",
  guests: [
    { contactDid: GARCIA, required: true },
    { contactDid: MILLER, required: true },
    { contactDid: JOHNSON, required: false },
  ],
  candidates: [{ start: 'Sat 12' }, SAT_19, SAT_26],
  nowMs: T0,
};

function fresh(over: Partial<Parameters<typeof createGroupPlan>[0]> = {}): GroupPlan {
  return ok(
    createGroupPlan({
      ...FRESH_ARGS,
      ...over,
    }),
  );
}

/** Send round 1 and have everyone answer. */
function answeredRound(plan: GroupPlan, replies: Record<string, Parameters<typeof recordReply>[1]['reply']>): GroupPlan {
  let p = ok(openRound(plan, T0 + 1));
  for (const guest of p.guests) {
    p = ok(
      recordSpoke(
        p,
        guest.contactDid,
        { stage: 'queried', taskId: `task_${guest.contactDid}`, queryId: `q_${guest.contactDid}` },
        T0 + 2,
      ),
    );
  }
  for (const [contactDid, reply] of Object.entries(replies)) {
    p = ok(recordReply(p, { contactDid, reply }, T0 + 3));
  }
  return p;
}

describe('opening a plan — the bounds are refused, never truncated (rule 8)', () => {
  it('opens with the intent one-lined and every guest waiting', () => {
    const plan = fresh({ intent: "  Emma's\n8th   birthday  " });
    expect(plan.intent).toBe("Emma's 8th birthday");
    expect(plan.state).toBe('proposing');
    expect(plan.round).toBe(0);
    expect(plan.guests.map((g) => g.outcome)).toEqual(['waiting', 'waiting', 'waiting']);
  });

  it('stamps createdAt once and updatedAt on every transition', () => {
    const plan = fresh();
    const later = ok(openRound(plan, T0 + 50));
    expect(later.createdAt).toBe(T0);
    expect(later.updatedAt).toBe(T0 + 50);
  });

  it('refuses a ninth guest by name', () => {
    const guests = Array.from({ length: MAX_GROUP_GUESTS + 1 }, (_, i) => ({ contactDid: `did:plc:g${i}`, required: true }));
    expect(refusal(createGroupPlan({ planId: 'p', intent: 'x', guests, candidates: [SAT_26], nowMs: T0 }))).toBe('too_many_guests');
  });

  it('refuses a thirteenth candidate by name', () => {
    const candidates = Array.from({ length: MAX_PLAN_CANDIDATES + 1 }, (_, i) => ({ start: `Sat ${i}` }));
    expect(refusal(createGroupPlan({ planId: 'p', intent: 'x', guests: [{ contactDid: GARCIA, required: true }], candidates, nowMs: T0 }))).toBe('too_many_candidates');
  });

  it('refuses a plan with no required guest — a date with nobody’s yes behind it', () => {
    expect(
      refusal(
        createGroupPlan({
          planId: 'p',
          intent: 'x',
          guests: [{ contactDid: GARCIA, required: false }, { contactDid: MILLER, required: false }],
          candidates: [SAT_26],
          nowMs: T0,
        }),
      ),
    ).toBe('no_required_guest');
  });

  it('refuses the rest by name: no guests, a duplicate, a malformed guest, no candidates, a malformed or duplicate slot, an empty intent', () => {
    const base = { planId: 'p', intent: 'x', guests: [{ contactDid: GARCIA, required: true }], candidates: [SAT_26], nowMs: T0 };
    expect(refusal(createGroupPlan({ ...base, guests: [] }))).toBe('no_guests');
    expect(refusal(createGroupPlan({ ...base, guests: [base.guests[0], base.guests[0]] }))).toBe('duplicate_guest');
    expect(refusal(createGroupPlan({ ...base, guests: [{ contactDid: '', required: true }] }))).toBe('malformed_guest');
    expect(refusal(createGroupPlan({ ...base, candidates: [] }))).toBe('no_candidates');
    expect(refusal(createGroupPlan({ ...base, candidates: [{ start: 7 }] }))).toBe('malformed_slot');
    expect(refusal(createGroupPlan({ ...base, candidates: [{ start: '   ' }] }))).toBe('malformed_slot');
    expect(refusal(createGroupPlan({ ...base, candidates: [SAT_26, { start: 'sat 26' }] }))).toBe('duplicate_candidate');
    // Over-long is refused, never clipped: a date cut in the middle is a different date.
    expect(refusal(createGroupPlan({ ...base, candidates: [{ start: 'S'.repeat(81) }] }))).toBe('malformed_slot');
    expect(refusal(createGroupPlan({ ...base, candidates: [{ start: 'Sat 26', note: 'n'.repeat(121) }] }))).toBe('malformed_slot');
    expect(refusal(createGroupPlan({ ...base, intent: '  \n ' }))).toBe('empty_intent');
    expect(refusal(createGroupPlan({ ...base, intent: 'x'.repeat(401) }))).toBe('intent_too_long');
  });
});

describe('the rounds', () => {
  it('a round resets every reply and advances the counter; three is the ceiling', () => {
    let plan = fresh();
    for (let i = 1; i <= MAX_PLAN_ROUNDS; i += 1) {
      plan = ok(openRound(plan, T0 + i));
      expect(plan.round).toBe(i);
    }
    expect(refusal(openRound(plan, T0 + 9))).toBe('rounds_exhausted');
  });

  it('records the spoke that carried each guest’s question, and refuses a guest the plan never named', () => {
    const plan = ok(openRound(fresh(), T0 + 1));
    const withSpoke = ok(recordSpoke(plan, GARCIA, { stage: 'queried', taskId: 't1', queryId: 'q1' }, T0 + 2));
    expect(withSpoke.guests[0].spokes).toEqual([{ round: 1, stage: 'queried', taskId: 't1', queryId: 'q1' }]);
    expect(refusal(recordSpoke(plan, 'did:plc:stranger', { stage: 'queried', taskId: 't', queryId: 'q' }, T0))).toBe(
      'unknown_guest',
    );
  });

  it('a preflight and the query it unlocked are one spoke — the query replaces the grant request of its round', () => {
    let plan = ok(openRound(fresh(), T0 + 1));
    plan = ok(recordSpoke(plan, GARCIA, { stage: 'grant_requested', requestId: 'req1' }, T0 + 2));
    expect(currentSpoke(plan.guests[0], 1)).toEqual({ round: 1, stage: 'grant_requested', requestId: 'req1' });
    plan = ok(recordSpoke(plan, GARCIA, { stage: 'queried', taskId: 't1', queryId: 'q1' }, T0 + 3));
    expect(plan.guests[0].spokes).toEqual([{ round: 1, stage: 'queried', taskId: 't1', queryId: 'q1' }]);
    // A later round's spoke is appended, never merged into the earlier one.
    plan = ok(foldPlan(ok(markUnreachable(ok(markUnreachable(plan, GARCIA, T0 + 4)), MILLER, T0 + 4)), T0 + 5));
    plan = ok(widen(plan, [{ start: 'Sun 4 Oct' }], T0 + 6));
    plan = ok(recordSpoke(plan, GARCIA, { stage: 'grant_requested', requestId: 'req2' }, T0 + 7));
    expect(plan.guests[0].spokes).toHaveLength(2);
    expect(currentSpoke(plan.guests[0], 2)).toEqual({ round: 2, stage: 'grant_requested', requestId: 'req2' });
    expect(currentSpoke(plan.guests[1], 2)).toBeNull();
  });

  it('the window is the plan’s: every round closes windowSeconds after it opened, and the bound is refused by name', () => {
    expect(windowClosesAt(fresh())).toBeNull();
    const plan = ok(openRound(fresh({ windowSeconds: 120 }), T0 + 1));
    expect(windowClosesAt(plan)).toBe(T0 + 1 + 120_000);
    expect(refusal(createGroupPlan({ ...FRESH_ARGS, windowSeconds: 0, nowMs: T0 }))).toBe('bad_window');
    expect(refusal(createGroupPlan({ ...FRESH_ARGS, windowSeconds: MAX_WINDOW_SECONDS + 1, nowMs: T0 }))).toBe('bad_window');
    expect(refusal(createGroupPlan({ ...FRESH_ARGS, windowSeconds: 1.5, nowMs: T0 }))).toBe('bad_window');
  });

  it('a reply marks the guest answered; the window closing marks a silent guest unreachable and leaves an answered one alone', () => {
    let plan = answeredRound(fresh(), { [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26] } });
    expect(plan.guests[0].outcome).toBe('answered');
    plan = ok(markUnreachable(plan, MILLER, T0 + 4));
    expect(plan.guests[1].outcome).toBe('unreachable');
    plan = ok(markUnreachable(plan, GARCIA, T0 + 4));
    expect(plan.guests[0].outcome).toBe('answered');
  });
});

describe('the fold moves the plan only when every required guest is accounted for', () => {
  it('stays proposing while a required guest may still answer', () => {
    const plan = ok(foldPlan(answeredRound(fresh(), { [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26] } }), T0 + 5));
    expect(plan.state).toBe('proposing');
    expect(plan.fold?.state).toBe('waiting');
  });

  it('moves to folded once the last required guest answered or the window closed on them', () => {
    let plan = answeredRound(fresh(), {
      [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26, SAT_19] },
      [MILLER]: { status: 'accepted', accepted_slots: [SAT_26] },
    });
    plan = ok(foldPlan(plan, T0 + 5));
    expect(plan.state).toBe('folded');
    expect(plan.fold?.agreed).toEqual([SAT_26]);

    // Unreachable also accounts for a guest — the fold reports them missing and folds anyway.
    let silent = answeredRound(fresh(), { [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26] } });
    silent = ok(markUnreachable(silent, MILLER, T0 + 4));
    silent = ok(foldPlan(silent, T0 + 5));
    expect(silent.state).toBe('folded');
    expect(silent.fold?.missingRequired).toEqual([MILLER]);
  });

  it('refuses to fold a settled or abandoned plan', () => {
    const plan = ok(abandon(fresh(), T0));
    expect(refusal(foldPlan(plan, T0))).toBe('wrong_state');
  });

  it('choose refuses a fold that closed on a required guest who never answered (§4: every REQUIRED guest); drop them first', () => {
    let plan = answeredRound(fresh(), { [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26] } });
    plan = ok(markUnreachable(plan, MILLER, T0 + 4));
    plan = ok(foldPlan(plan, T0 + 5));
    expect(plan.state).toBe('folded');
    expect(plan.fold?.state).toBe('waiting');
    expect(plan.fold?.agreed).toEqual([SAT_26]);
    const refused = choose(plan, SAT_26, T0 + 6);
    expect(refused).toEqual({ ok: false, refusal: 'required_unanswered', detail: MILLER });
    const relaxed = ok(makeOptional(plan, MILLER, T0 + 7));
    expect(relaxed.fold?.state).toBe('converged');
    const chosen = ok(choose(relaxed, SAT_26, T0 + 8));
    expect(chosen.state).toBe('confirming');
    expect(chosen.round).toBe(2);
  });

  it('a folded plan folds again — an optional guest’s late answer updates the fit without reopening the decision', () => {
    let plan = answeredRound(fresh(), {
      [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26, SAT_19] },
      [MILLER]: { status: 'accepted', accepted_slots: [SAT_19, SAT_26] },
    });
    plan = ok(foldPlan(plan, T0 + 5));
    expect(plan.state).toBe('folded');
    expect(plan.fold?.optionalFit).toEqual({});
    plan = ok(recordReply(plan, { contactDid: JOHNSON, reply: { status: 'accepted', accepted_slots: [SAT_19] } }, T0 + 6));
    plan = ok(foldPlan(plan, T0 + 7));
    expect(plan.state).toBe('folded');
    expect(plan.fold?.agreed).toEqual([SAT_19, SAT_26]);
    expect(plan.fold?.optionalFit).toEqual({ [JOHNSON]: [SAT_19] });
  });
});

describe('choosing, confirming, settling', () => {
  function folded(): GroupPlan {
    return ok(
      foldPlan(
        answeredRound(fresh(), {
          [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26, SAT_19] },
          [MILLER]: { status: 'accepted', accepted_slots: [SAT_26] },
          [JOHNSON]: { status: 'accepted', accepted_slots: [SAT_26] },
        }),
        T0 + 5,
      ),
    );
  }

  it('choose opens the confirm round with the one chosen candidate; a slot nobody agreed on is refused', () => {
    const plan = folded();
    expect(refusal(choose(plan, SAT_19, T0 + 6))).toBe('slot_not_agreed');
    const confirming = ok(choose(plan, { start: 'sat 26' }, T0 + 6));
    expect(confirming.state).toBe('confirming');
    expect(confirming.chosen).toEqual(SAT_26);
    expect(confirming.candidates).toEqual([SAT_26]);
    expect(confirming.round).toBe(2);
    expect(confirming.guests.every((g) => g.reply === null && g.outcome === 'waiting')).toBe(true);
  });

  it('settles when every required guest confirms the chosen slot', () => {
    let plan = ok(choose(folded(), SAT_26, T0 + 6));
    for (const g of plan.guests) {
      plan = ok(recordReply(plan, { contactDid: g.contactDid, reply: { status: 'accepted', accepted_slots: [SAT_26] } }, T0 + 7));
    }
    plan = ok(foldPlan(plan, T0 + 8));
    expect(plan.state).toBe('settled');
  });

  it('a guest who reneges at confirm leaves the plan confirming, for the organizer to widen or abandon', () => {
    let plan = ok(choose(folded(), SAT_26, T0 + 6));
    plan = ok(recordReply(plan, { contactDid: GARCIA, reply: { status: 'accepted', accepted_slots: [SAT_26] } }, T0 + 7));
    plan = ok(recordReply(plan, { contactDid: MILLER, reply: { status: 'counter', counter_slots: [{ start: 'Sun 27' }] } }, T0 + 7));
    plan = ok(foldPlan(plan, T0 + 8));
    expect(plan.state).toBe('confirming');
    expect(plan.fold?.state).toBe('empty');
    expect(plan.fold?.emptiedBy).toEqual([MILLER]);
  });

  it('choose is refused outside folded; settle and abandon are terminal', () => {
    expect(refusal(choose(fresh(), SAT_26, T0))).toBe('wrong_state');
    const gone = ok(abandon(fresh(), T0));
    expect(refusal(abandon(gone, T0))).toBe('wrong_state');
    expect(refusal(openRound(gone, T0))).toBe('wrong_state');
    // A settled plan is not a dead end (§13): it can be reopened with other
    // dates within the round ceiling, or stopped.
    const settled = { ...fresh(), state: 'settled' as const, chosen: SAT_26, round: 2, fold: null };
    const reopened = ok(widen(settled, [{ start: 'Sun 27' }], T0));
    expect(reopened.state).toBe('proposing');
    expect(reopened.round).toBe(3);
    expect(reopened.chosen).toBeNull();
    expect(ok(abandon(settled, T0)).state).toBe('abandoned');
  });
});

describe('widening and dropping a required guest', () => {
  it('widen opens a new proposing round over new candidates and keeps disclosures', () => {
    let plan = answeredRound(fresh(), {
      [GARCIA]: { status: 'accepted', accepted_slots: [] },
      [MILLER]: { status: 'accepted', accepted_slots: [SAT_26] },
    });
    plan = ok(recordReply(plan, { contactDid: JOHNSON, reply: { status: 'accepted', accepted_slots: [] }, disclosures: [{ kind: 'transport', text: 'we can drive', about: 'household' }] }, T0 + 3));
    plan = ok(foldPlan(plan, T0 + 5));
    expect(plan.state).toBe('folded');
    // Candidates are judged before anything moves: a malformed slot leaves the plan folded.
    expect(refusal(widen(plan, [{ start: 7 }], T0))).toBe('malformed_slot');
    const widened = ok(widen(plan, [{ start: 'Sun 27' }, { start: 'Sat 3 Oct' }], T0 + 6));
    expect(widened.state).toBe('proposing');
    expect(widened.round).toBe(2);
    expect(widened.candidates).toEqual([{ start: 'Sun 27' }, { start: 'Sat 3 Oct' }]);
    expect(widened.fold).toBeNull();
    expect(widened.chosen).toBeNull();
    expect(widened.guests[2].disclosures).toEqual([{ kind: 'transport', text: 'we can drive', about: 'household' }]);
    expect(widened.guests.every((g) => g.reply === null)).toBe(true);
    // And a round already proposing cannot be widened again until it folds.
    expect(refusal(widen(widened, [{ start: 'Sun 4 Oct' }], T0))).toBe('wrong_state');
  });

  it('makeOptional re-folds without asking anyone again, and refuses to drop the last required guest', () => {
    let plan = answeredRound(fresh(), {
      [GARCIA]: { status: 'accepted', accepted_slots: [SAT_26] },
      [MILLER]: { status: 'accepted', accepted_slots: [SAT_19] },
    });
    plan = ok(foldPlan(plan, T0 + 5));
    expect(plan.fold?.state).toBe('empty');
    const relaxed = ok(makeOptional(plan, MILLER, T0 + 6));
    expect(relaxed.state).toBe('folded');
    expect(relaxed.fold?.agreed).toEqual([SAT_26]);
    expect(relaxed.guests[1].required).toBe(false);
    // Nobody was asked again: the spokes are exactly round 1's.
    expect(relaxed.round).toBe(1);
    expect(refusal(makeOptional(relaxed, GARCIA, T0 + 7))).toBe('no_required_guest');
  });
});

describe('disclosures and requirements (rules 6–7)', () => {
  it('a disclosure is one bounded line about the household, or it is refused with the whole reply', () => {
    expect(normaliseDisclosure({ kind: 'dietary', text: '  gluten-free\n please ', about: 'household' })).toEqual({
      kind: 'dietary',
      text: 'gluten-free please',
      about: 'household',
    });
    expect(normaliseDisclosure({ kind: 'dietary', text: 'x', about: 'Lily' })).toBeNull();
    expect(normaliseDisclosure({ kind: 'medical', text: 'x', about: 'household' })).toBeNull();
    expect(normaliseDisclosure({ kind: 'dietary', text: '   ', about: 'household' })).toBeNull();
    expect(normaliseDisclosure({ kind: 'dietary', text: 'x'.repeat(500), about: 'household' })?.text.length).toBe(120);
    const plan = ok(openRound(fresh(), T0));
    expect(refusal(recordReply(plan, { contactDid: GARCIA, reply: { status: 'accepted' }, disclosures: [{ kind: 'dietary', text: 'x', about: 'Lily' }] }, T0))).toBe('malformed_disclosure');
    expect(plan.guests[0].disclosures).toEqual([]);
  });

  it('a disclosure repeated across rounds is one disclosure — a vendor never orders two portions for one child', () => {
    let plan = ok(openRound(fresh(), T0));
    const glutenFree = [{ kind: 'dietary', text: 'gluten-free', about: 'household' }];
    plan = ok(recordReply(plan, { contactDid: MILLER, reply: { status: 'accepted', accepted_slots: [SAT_26] }, disclosures: glutenFree }, T0));
    plan = ok(recordReply(plan, { contactDid: GARCIA, reply: { status: 'accepted', accepted_slots: [SAT_26] } }, T0));
    plan = ok(foldPlan(plan, T0));
    plan = ok(choose(plan, SAT_26, T0));
    plan = ok(recordReply(plan, { contactDid: MILLER, reply: { status: 'accepted', accepted_slots: [SAT_26] }, disclosures: glutenFree }, T0));
    expect(plan.guests[1].disclosures).toHaveLength(1);
    expect(deriveRequirements(plan)).toEqual([{ kind: 'dietary', count: 1, needs: ['gluten-free'] }]);
  });

  it('requirements are counts and needs by kind, fixed order, and carry no DID and no household (§6 point 4, §10)', () => {
    let plan = ok(openRound(fresh(), T0));
    plan = ok(recordReply(plan, { contactDid: MILLER, reply: { status: 'accepted', accepted_slots: [SAT_26] }, disclosures: [{ kind: 'dietary', text: 'gluten-free', about: 'household' }] }, T0));
    plan = ok(recordReply(plan, { contactDid: GARCIA, reply: { status: 'accepted', accepted_slots: [SAT_26] }, disclosures: [{ kind: 'accessibility', text: 'step-free please', about: 'household' }, { kind: 'dietary', text: 'no nuts', about: 'household' }] }, T0));
    plan = ok(recordReply(plan, { contactDid: JOHNSON, reply: { status: 'accepted', accepted_slots: [SAT_26] }, disclosures: [{ kind: 'transport', text: 'we can drive', about: 'household' }, { kind: 'note', text: 'Lily is shy', about: 'household' }] }, T0));
    const requirements = deriveRequirements(plan);
    expect(requirements).toEqual([
      { kind: 'dietary', count: 2, needs: ['gluten-free', 'no nuts'] },
      { kind: 'accessibility', count: 1, needs: ['step-free please'] },
    ]);
    const asJson = JSON.stringify(requirements);
    // No household, no name, no attribution, and nothing a vendor does not fill
    // (a transport offer, a note about a child) — only the needs.
    for (const forbidden of [GARCIA, MILLER, JOHNSON, 'about', 'household', 'drive', 'Lily']) {
      expect(asJson).not.toContain(forbidden);
    }
  });
});
