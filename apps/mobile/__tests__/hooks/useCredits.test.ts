/**
 * computeCreditsView — the gate logic for the wall + low-balance cards
 * and the providers tile (pure; the React hook is a thin loader).
 */

import { computeCreditsView } from '../../src/hooks/useCredits';

const BASE = {
  hasGrantKey: true,
  hasByokOpenRouterKey: false,
  activeProvider: null as string | null,
  exhausted: false,
  lowBalanceDismissed: false,
  estConversationsLeft: 30 as number | null,
};

describe('computeCreditsView', () => {
  it('no grant → everything off', () => {
    const v = computeCreditsView({ ...BASE, hasGrantKey: false });
    expect(v).toEqual({
      grantActive: false,
      showWall: false,
      showLowBalance: false,
      estConversationsLeft: 30,
    });
  });

  it('BYOK OpenRouter key wins → grant not active, no cards (spec precedence)', () => {
    const v = computeCreditsView({ ...BASE, hasByokOpenRouterKey: true, exhausted: true });
    expect(v.grantActive).toBe(false);
    expect(v.showWall).toBe(false);
  });

  it('healthy balance → tile active, no cards', () => {
    const v = computeCreditsView(BASE);
    expect(v.grantActive).toBe(true);
    expect(v.showWall).toBe(false);
    expect(v.showLowBalance).toBe(false);
  });

  it('low balance at the threshold → low-balance card', () => {
    const v = computeCreditsView({ ...BASE, estConversationsLeft: 5 });
    expect(v.showLowBalance).toBe(true);
    expect(v.showWall).toBe(false);
  });

  it('dismissed-forever suppresses the low-balance card permanently', () => {
    const v = computeCreditsView({ ...BASE, estConversationsLeft: 2, lowBalanceDismissed: true });
    expect(v.showLowBalance).toBe(false);
  });

  it('exhausted → wall card, and it wins over low-balance', () => {
    const v = computeCreditsView({ ...BASE, exhausted: true, estConversationsLeft: 0 });
    expect(v.showWall).toBe(true);
    expect(v.showLowBalance).toBe(false);
  });

  it('switching the active provider to a non-OpenRouter BYOK hides the wall (escape path)', () => {
    const v = computeCreditsView({ ...BASE, exhausted: true, activeProvider: 'gemini' });
    expect(v.grantActive).toBe(false);
    expect(v.showWall).toBe(false);
  });

  it('active provider explicitly openrouter keeps the grant active', () => {
    const v = computeCreditsView({ ...BASE, activeProvider: 'openrouter' });
    expect(v.grantActive).toBe(true);
  });

  it('unknown balance (null) never shows the low-balance card', () => {
    const v = computeCreditsView({ ...BASE, estConversationsLeft: null });
    expect(v.showLowBalance).toBe(false);
  });
});
