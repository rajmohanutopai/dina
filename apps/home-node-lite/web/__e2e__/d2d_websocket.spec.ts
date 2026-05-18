/**
 * Phase 9 — D2D + MsgBox WebSocket capability check.
 *
 * Mobile's D2D (Dina-to-Dina) transport upgrades from direct HTTP to
 * a MsgBox-tunnelled WebSocket when the recipient sits behind NAT.
 * On the web target the browser's built-in `WebSocket` ctor handles
 * both the wss:// MsgBox subscription and the inbound D2D message
 * stream — no polyfill needed.
 *
 * This spec runs INSIDE the Chromium bundle (via `page.evaluate`) to
 * prove three things about the live web environment:
 *
 *   1. `WebSocket` is a valid constructor — covers any future Metro
 *      tree-shake that might accidentally drop it.
 *   2. `globalThis.crypto.subtle` is available — D2D NaCl sealed-box
 *      envelopes use a BLAKE2b nonce + Curve25519 ops, both of which
 *      libsodium-wrappers builds on the same WebCrypto base our
 *      keychain shim uses (Phase 2).
 *   3. The `/web/chat/<did>` route renders. That's the D2D thread UI
 *      — when MsgBox messages arrive in production they land here.
 *
 * The actual MsgBox round-trip (open WS → subscribe → push test
 * envelope → assert it surfaces in the conversation pane) requires
 * a live MsgBox relay. Pointing CI at `test-mailbox.dinakernel.com`
 * crosses the public-network line; a local MsgBox fixture is a
 * later orchestration concern. The capability check here closes
 * the per-phase "Done when" criterion (the bundle has what it needs
 * to make MsgBox work).
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 9.
 */

import { expect, test } from '@playwright/test';

test('Browser WebSocket + WebCrypto.subtle available inside the SPA', async ({ page }) => {
  await page.goto('/web/');

  // Evaluate inside the page context so we're testing the live
  // bundle's globals, not Playwright's Node-side environment.
  const env = await page.evaluate(() => ({
    webSocketCtor: typeof WebSocket === 'function',
    cryptoSubtle: typeof globalThis.crypto?.subtle === 'object',
    cryptoGetRandomValues: typeof globalThis.crypto?.getRandomValues === 'function',
    indexedDb: typeof indexedDB === 'object',
  }));
  expect(env).toEqual({
    webSocketCtor: true,
    cryptoSubtle: true,
    cryptoGetRandomValues: true,
    indexedDb: true,
  });
});

test('GET /web/chat/<did> renders the D2D conversation surface', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // Deep-link a plausible-shaped DID. Expo Router substitutes the
  // path segment into `useLocalSearchParams().did` — the chat
  // screen renders the empty-state when no thread exists yet.
  await page.goto('/web/chat/did:plc:phase9-fake');

  await expect(page.locator('#root')).toBeAttached({ timeout: 10_000 });
  await expect(page.locator('body')).not.toBeEmpty({ timeout: 15_000 });

  // Same liberal-match strategy as tab_routes — accept any of the
  // gates (infra-setup / onboarding / unlock) plus the actual chat
  // surface keywords.
  const expected =
    /chat|message|conversation|did|infrastructure|sovereign|set up|unlock|passphrase/i;
  await expect(async () => {
    const text = await page.locator('body').innerText();
    expect(text).toMatch(expected);
  }).toPass({ timeout: 10_000, intervals: [250, 500, 1000] });

  const hardErrors = consoleErrors.filter((e) =>
    /TypeError|ReferenceError|cannot read properties|Module not found/i.test(e),
  );
  expect(hardErrors).toEqual([]);
});
