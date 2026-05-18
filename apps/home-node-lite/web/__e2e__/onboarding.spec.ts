/**
 * Phase 3 onboarding render walk — proves the first three onboarding
 * surfaces render correctly under React Native Web through the
 * brain-server's `/web/*` mount.
 *
 * Three screens covered here, in the order the unlock gate + state
 * machine produce them on a fresh install:
 *
 *   1. **Infra setup** (`unlock_gate.tsx` mounts this BEFORE the main
 *      onboarding flow). Operator picks PDS / AppView URLs.
 *   2. **Welcome** (`OnboardingFlow` `INITIAL_STEP`). Brand splash +
 *      "Get started" CTA.
 *   3. **Mode choice** — create-new vs restore-from-recovery.
 *
 * Steps 4-11 (passphrase set → mnemonic reveal → verify → recovery
 * handle → handle picker → owner name → provisioning) drive into Core
 * to mint a `did:plc` and write the wrapped seed. That requires a
 * running `core-server` next to brain-server, which is a Phase 4+
 * orchestration concern. We keep Phase 3 to the render-parity slice
 * any operator can run locally without spinning Core up.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 3 "Onboarding flow".
 */

import { expect, test } from '@playwright/test';

test('Infra setup → Welcome → Mode choice renders end-to-end via /web/', async ({ page }) => {
  // Capture hard JS errors throughout — same pattern as smoke.spec.ts.
  // Any TypeError / ReferenceError during this walk is a regression
  // (usually a native-only module leaking into the web bundle).
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });

  await page.goto('/web/');

  // We locate buttons by their visible text rather than by ARIA role
  // because RNW renders `Pressable` as a plain `<div>` without
  // `role="button"` by default. A future accessibility audit can add
  // `accessibilityRole="button"` to the Pressables and switch this
  // back to `getByRole` — for now, text selectors keep the test
  // honest about what the user actually sees.

  // ── Step 1: Infra setup ───────────────────────────────────────────
  await expect(page.getByText('Choose your infrastructure')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('PDS URL')).toBeVisible();
  await expect(page.getByText('PeerLens and Services URL')).toBeVisible();
  await page.getByText('Continue', { exact: true }).click();

  // ── Step 2: Welcome ───────────────────────────────────────────────
  // The welcome screen shows the brand wordmark, the "Your sovereign
  // personal AI" tagline, the six-feature pill row, and a "Get
  // started" CTA. We assert on a stable bit of brand copy plus the
  // CTA presence rather than try to pin the tagline exactly (which
  // is more likely to change as marketing iterates).
  await expect(page.getByText('Your sovereign')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Sovereign Identity')).toBeVisible();
  await page.getByText(/get started/i).click();

  // ── Step 3: Mode choice ───────────────────────────────────────────
  // Two CTAs: create new Dina, restore from recovery phrase.
  await expect(page.getByText("Let's get your Dina set up")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('Create a new Dina')).toBeVisible();
  await expect(page.getByText('Restore from recovery phrase')).toBeVisible();

  // No hard errors during the walk.
  const hardErrors = consoleErrors.filter((e) =>
    /TypeError|ReferenceError|cannot read properties/i.test(e),
  );
  expect(hardErrors).toEqual([]);
});
