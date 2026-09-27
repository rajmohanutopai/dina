/**
 * Phase 3 onboarding render walk — proves the first onboarding surfaces
 * render correctly under React Native Web through Core's `/app/*` mount.
 *
 * Two screens, in the order the state machine produces them on a fresh
 * install:
 *
 *   1. **Welcome** (`OnboardingFlow` `INITIAL_STEP`). Brand splash +
 *      "Get started" CTA.
 *   2. **Mode choice** — create new, use an existing identity, restore from a
 *      recovery phrase, or join a business as staff.
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

test('Welcome → Mode choice renders end-to-end via /app/', async ({ page }) => {
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

  await page.goto('/app/');

  // We locate buttons by their visible text rather than by ARIA role
  // because RNW renders `Pressable` as a plain `<div>` without
  // `role="button"` by default. A future accessibility audit can add
  // `accessibilityRole="button"` to the Pressables and switch this
  // back to `getByRole` — for now, text selectors keep the test
  // honest about what the user actually sees.

  // ── Step 1: Welcome ───────────────────────────────────────────────
  // The first screen: the headline, the feature pills, and a "Get started"
  // CTA. Assert a stable bit of brand copy plus the CTA rather than pin the
  // whole tagline (marketing iterates on it).
  await expect(page.getByText('Your sovereign', { exact: false }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Sovereign Identity').first()).toBeVisible();
  await page.getByText(/get started/i).click();

  // ── Step 2: Mode choice ───────────────────────────────────────────
  await expect(page.getByText('Welcome to Dina')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Create a new Dina')).toBeVisible();
  await expect(page.getByText('Restore from recovery phrase')).toBeVisible();

  // No hard errors during the walk.
  const hardErrors = consoleErrors.filter((e) =>
    /TypeError|ReferenceError|cannot read properties/i.test(e),
  );
  expect(hardErrors).toEqual([]);
});
