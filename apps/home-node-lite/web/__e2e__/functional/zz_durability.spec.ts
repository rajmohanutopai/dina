/**
 * MRS-13 — Foundational durability (persistence across a browser reload).
 * docs/E2E_TESTING.md §7.
 *
 * The durability INVARIANT — "a remembered fact survives" — is tested
 * deterministically: the fact is in the Core vault before the reload and
 * STILL in it after, and the app UNLOCKS the existing vault rather than
 * re-onboarding (the wrapped seed persists in the browser). We assert the
 * persisted DATA directly (backstage) rather than via an LLM recall,
 * because after a reload the brain's in-memory retrieval index needs a
 * moment to re-hydrate — an immediate recall is timing-sensitive and would
 * make the durability assertion flaky. (See the open item: recall-after-
 * reload re-hydration; and full Core-process-restart durability, which
 * needs a process-control harness outside Playwright's webServer.)
 */

import { expect, test } from '../fixtures/human_session';

const PERSONAS = ['general', 'health', 'finance', 'work'];

test.describe('MRS-13 — Durability (reload persistence)', () => {
  test('a remembered fact survives a browser reload; the app does not re-onboard', async ({
    human,
  }) => {
    const { composer, thread, page, backstage } = human;

    // Remember a distinctive fact; confirm it landed in the Core vault.
    await composer.remember('My spaceship is named Neptune');
    await thread.waitForNewAnswer(0);
    expect(
      await backstage.waitForPersonaContaining(PERSONAS, 'Neptune'),
      'the fact should be stored before the reload',
    ).not.toBeNull();

    // ── Reload ──────────────────────────────────────────────────────────
    await page.reload();
    // Chat-ready again — the app unlocks the existing seed (fast, no PDS
    // re-provision). It must NOT re-onboard.
    await page
      .getByTestId('index-mode-chip-remember')
      .waitFor({ state: 'visible', timeout: 60_000 });
    expect(
      await page.getByText(/get started/i).count(),
      'a reload must unlock the existing vault, never re-onboard',
    ).toBe(0);

    // ── Durability: the fact persisted across the reload ────────────────
    expect(
      await backstage.waitForPersonaContaining(PERSONAS, 'Neptune'),
      'the fact must still be in the Core vault after the reload',
    ).not.toBeNull();
  });
});
