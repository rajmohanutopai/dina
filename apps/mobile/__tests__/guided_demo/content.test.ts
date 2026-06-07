/**
 * Guided-demo content — the spec-critical birthday-date logic + the
 * deterministic demo data fixtures.
 */

import {
  DEMO_STEPS,
  DEMO_PEERLENS_CHAIRS,
  DEMO_SERVICE_RESPONSE,
  DEMO_AGENT,
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
  it('facts are split into separate inputs, ordered to reveal cross-input synthesis', () => {
    expect(DEMO_STEPS.map((s) => s.id)).toEqual([
      'remember_emma_relation',
      'remember_emma_likes',
      'remember_back',
      'remember_budget',
      'remember_emma_birthday',
      'chair_ask',
      'chair_availability',
    ]);
    // Each Emma fact is its own message (not one blob).
    expect(DEMO_STEPS[0].message).toContain('daughter');
    expect(DEMO_STEPS[1].message).toContain('dinosaurs');
    // Health + a GENERIC monthly budget (not tied to a chair) come BEFORE the
    // birthday line, so the user sees functionality arrive separately.
    expect(DEMO_STEPS[2].message).toMatch(/lower back/i);
    expect(DEMO_STEPS[3].message).toContain('$500');
    expect(DEMO_STEPS[3].message).not.toMatch(/chair/i); // budget isn't obviously about a chair
    expect(DEMO_STEPS[4].message).toContain('Nov 7'); // birthday last → connects to dinosaurs
    // Only the availability check is a service step (real resolved card).
    expect(DEMO_STEPS.filter((s) => s.kind === 'service').map((s) => s.id)).toEqual([
      'chair_availability',
    ]);
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

  it('service response is about the recommended chair; agent targets health read', () => {
    expect(DEMO_SERVICE_RESPONSE.product).toBe('ErgoFlex Study Chair');
    expect(DEMO_SERVICE_RESPONSE.available).toBe(true);
    expect(DEMO_AGENT.persona).toBe('health');
    expect(DEMO_PUBLISH_DRAFT.visibility).toBe('unlisted'); // never auto-public
  });
});
