/**
 * Guided-demo content — the spec-critical birthday-date logic + the
 * deterministic demo data fixtures.
 */

import {
  DEMO_STEPS,
  DEMO_PEERLENS_CHAIRS,
  DEMO_SERVICE_RESPONSE,
  DEMO_AGENT,
  DEMO_TASK,
  DEMO_PUBLISH_DRAFT,
  buildChairRecommendation,
  nextNovember7,
} from '../../src/guided_demo/content';

describe('nextNovember7 (year derived, never hardcoded)', () => {
  it('returns this year when Nov 7 is still ahead', () => {
    const d = nextNovember7(new Date(2026, 0, 1)); // Jan 1 2026
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(7);
  });

  it('includes today (Nov 7 itself counts as upcoming)', () => {
    const d = nextNovember7(new Date(2026, 10, 7)); // Nov 7 2026
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(7);
  });

  it('rolls to next year once Nov 7 has passed', () => {
    expect(nextNovember7(new Date(2026, 10, 8)).getFullYear()).toBe(2027); // Nov 8 2026
    expect(nextNovember7(new Date(2026, 11, 1)).getFullYear()).toBe(2027); // Dec 1 2026
  });
});

describe('demo content fixtures', () => {
  it('opens with people (Emma + Alonso), one nav peek, then ordered synthesis', () => {
    expect(DEMO_STEPS.map((s) => s.id)).toEqual([
      'remember_people',
      'show_relations',
      'remember_private',
      'remember_emma_birthday',
      'chair_ask',
      'chair_availability',
    ]);
    const byId = Object.fromEntries(DEMO_STEPS.map((s) => [s.id, s]));
    // The opening step remembers a family member AND a friend (two remembers),
    // each seeded into People › Relations with the right relationship.
    expect(byId['remember_people'].remembers).toHaveLength(2);
    expect(byId['remember_people'].remembers?.[0]?.message).toContain('daughter');
    expect(byId['remember_people'].remembers?.[0]?.message).toContain('dinosaurs');
    expect(byId['remember_people'].remembers?.[0]?.person).toEqual({
      name: 'Emma',
      relation: 'daughter',
    });
    expect(byId['remember_people'].remembers?.[1]?.message).toMatch(/Alonso/);
    expect(byId['remember_people'].remembers?.[1]?.message).toMatch(/cold brew/i);
    expect(byId['remember_people'].remembers?.[1]?.person).toEqual({
      name: 'Alonso',
      relation: 'friend',
    });
    // Health + a GENERIC monthly budget (not tied to a chair) share one step,
    // each routing (scripted reply) to its own locked vault.
    expect(byId['remember_private'].remembers).toHaveLength(2);
    expect(byId['remember_private'].remembers?.[0]?.message).toMatch(/lower back/i);
    expect(byId['remember_private'].remembers?.[0]?.vault).toBe('Health');
    expect(byId['remember_private'].remembers?.[1]?.message).toContain('$500');
    expect(byId['remember_private'].remembers?.[1]?.vault).toBe('Finance');
    expect(byId['remember_private'].remembers?.[1]?.message).not.toMatch(/chair/i); // budget isn't obviously a chair
    // The birthday step carries scripted enrichment reminders (incl. dinosaurs).
    expect(byId['remember_emma_birthday'].remembers?.[0]?.message).toContain('Nov 7');
    expect(byId['remember_emma_birthday'].reminders?.some((r) => /dinosaur/i.test(r.text))).toBe(
      true,
    );
    // A single nav step peeks at People › Relations (the next step returns).
    expect(byId['show_relations'].kind).toBe('navigate');
    expect(byId['show_relations'].navigateTo).toBe('people-relations');
    // Only the availability check is a service step (real resolved card).
    expect(DEMO_STEPS.filter((s) => s.kind === 'service').map((s) => s.id)).toEqual([
      'chair_availability',
    ]);
    expect(byId['chair_availability'].message).toMatch(/ErgoFlex Study Chair/);
    expect(DEMO_STEPS[0].kind).toBeUndefined(); // chat is the default
  });

  it('PeerLens data supports recommend-ErgoFlex / reject-others', () => {
    const byName = Object.fromEntries(DEMO_PEERLENS_CHAIRS.map((c) => [c.product, c]));
    // ErgoFlex: in budget + good back support → the recommendation.
    expect(byName['ErgoFlex Study Chair'].price).toBeLessThanOrEqual(500);
    expect(byName['ErgoFlex Study Chair'].review).toMatch(/back/i);
    // BudgetLite: in budget but poor back support.
    expect(byName['BudgetLite Chair'].price).toBeLessThanOrEqual(500);
    expect(byName['BudgetLite Chair'].review).toMatch(/poor/i);
    // SpinePro: good support but over budget.
    expect(byName['SpinePro Chair'].price).toBeGreaterThan(500);
  });

  it('chair_ask is a grounded recommend step (not a free /ask)', () => {
    const chairAsk = DEMO_STEPS.find((s) => s.id === 'chair_ask');
    expect(chairAsk?.kind).toBe('recommend');
  });

  it('buildChairRecommendation is a grounded PeerLens result, no fake peers', () => {
    const { question, answer } = buildChairRecommendation();
    expect(question).toMatch(/office chair/i);
    expect(answer).toContain('ErgoFlex');
    expect(answer).toContain('$500'); // the user's budget
    expect(answer).toContain('over your budget'); // SpinePro excluded on price
    expect(answer).toContain('PeerLens'); // explicitly the PeerLens flow
    // Verified-Truth: only the seeded reviews — never invents peers/products.
    expect(answer).not.toMatch(/Rajmohan|Sancho|Aeron/);
  });

  it('service response is a rich card; agent has a decidable what/why; task framing', () => {
    expect(DEMO_SERVICE_RESPONSE.product).toBe('ErgoFlex Study Chair');
    expect(DEMO_SERVICE_RESPONSE.available).toBe(true);
    // Richer fields so the resolved card reads like a real result + money-formats.
    expect(DEMO_SERVICE_RESPONSE.price).toBe(420);
    expect(DEMO_SERVICE_RESPONSE.currency).toBe('USD');
    expect(DEMO_SERVICE_RESPONSE.seller).toMatch(/ChairMaker/);
    // Agent-safety request carries a plain-language what/why.
    expect(DEMO_AGENT.persona).toBe('health');
    expect(DEMO_AGENT.what.toLowerCase()).toContain('health');
    expect(DEMO_AGENT.why.length).toBeGreaterThan(0);
    // The approval is framed as a delegated task — an email draft (NOT a
    // purchase: Dina never touches money).
    expect(DEMO_TASK.message).toMatch(/Email my manager/i);
    expect(DEMO_TASK.message).not.toMatch(/buy/i);
    // The published service is the canon bus-driver ETA service (eta_query).
    expect(DEMO_PUBLISH_DRAFT.name).toMatch(/Bus.*ETA/i);
    expect(DEMO_PUBLISH_DRAFT.capability).toBe('eta_query');
  });
});
