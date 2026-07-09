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
 * make the durability assertion flaky.
 *
 * Scope note (why this browser-reload test is the RIGHT surface here, not a
 * weaker stand-in for the §7 items):
 *   - The §7 "backstage /v1/export→/v1/import round-trip + archive EXCLUDES
 *     keys/PDS-password/seed" is a DEPRECATED-stack (Go) HTTP surface. In the
 *     TS product export/import is a DEVICE-LOCAL in-process operation (the
 *     mobile app calls importArchive directly; there is deliberately no
 *     /v1/export route — exposing the whole encrypted vault over HTTP would be
 *     a new attack surface). That round-trip + the secret-exclusion invariant
 *     are covered at the CORRECT layer by packages/core __tests__/export/
 *     archive_real.test.ts (clean-install restore, secret exclusion, path-
 *     traversal refusal, wrong-passphrase/corrupt/version failure).
 *   - Full Core-PROCESS-restart durability (kill + respawn core-server on the
 *     same DINA_VAULT_DIR) needs a process-control harness outside Playwright's
 *     webServer; the on-disk SQLCipher vault is inherently durable and its
 *     open-from-disk path runs on every stack boot. Tracked as an open item.
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
