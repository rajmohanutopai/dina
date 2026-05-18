/**
 * Phase 1 smoke spec — proves the brain-server's `/web/` route serves
 * a SPA shell AND the bundled JS executes far enough to render the
 * onboarding screen via React Native Web.
 *
 * Pass criteria (mirrors __chrome__/welcome_screen_renders.scenario.md):
 *   - HTTP 200 on /web/.
 *   - The HTML response contains a `<div id="root">` placeholder.
 *   - After page load, the visible text contains one of the
 *     onboarding-screen phrases. Which one is rendered depends on
 *     `useOnboarding` state — accepting any of them means "the React
 *     bundle mounted and routed to an onboarding screen", which is
 *     exactly the Phase 1 entry criterion.
 *   - No JavaScript errors logged to the console during boot.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 1 "Done when".
 */

import { expect, test } from '@playwright/test';

const ONBOARDING_PHRASES = [
  'Welcome to Dina',
  'Choose your infrastructure',
  'What kind of node will this be?',
  "Let's set up Dina",
];

test('GET /web/ serves the SPA shell with cache-busting headers', async ({ request }) => {
  const resp = await request.get('/web/');
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toContain('text/html');
  expect(resp.headers()['cache-control']).toBe('no-cache, must-revalidate');
  const body = await resp.text();
  expect(body).toContain('id="root"');
});

test('Loading /web/ in Chromium mounts React and renders an onboarding screen', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });

  await page.goto('/web/');

  // React mounts asynchronously. Wait until the welcome-screen text
  // appears on the page — that's the signal the JS bundle executed,
  // RNW's render tree settled, and the Expo Router landed on an
  // onboarding screen.
  await expect(async () => {
    const text = await page.locator('body').innerText();
    const hit = ONBOARDING_PHRASES.find((p) => text.includes(p));
    expect(hit, `expected one of ${ONBOARDING_PHRASES.join(' / ')}`).toBeDefined();
  }).toPass({ timeout: 15_000, intervals: [250, 500, 1000] });

  // Sanity: the bundled JS didn't throw on boot. Some warnings
  // (`Image without an explicit width` etc.) are noise — but
  // hard errors usually mean a native module leaked into the web
  // bundle and we want CI to catch that.
  const hardErrors = consoleErrors.filter((e) =>
    /TypeError|ReferenceError|cannot read properties/i.test(e),
  );
  expect(hardErrors).toEqual([]);
});

test('Deep-link routes fall back to the SPA shell (client-side router takes over)', async ({
  request,
}) => {
  // The brain-server returns index.html for any /web/<unknown> URL so
  // the React Router on the client can resolve the route. This pins
  // the contract for refreshing a deep-link URL in the browser.
  const resp = await request.get('/web/onboarding/welcome');
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toContain('text/html');
  const body = await resp.text();
  expect(body).toContain('id="root"');
});
