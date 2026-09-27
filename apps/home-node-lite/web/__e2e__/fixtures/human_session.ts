/**
 * humanSession fixture — the single-human harness (docs/E2E_TESTING.md §9).
 *
 * Provides a `human` fixture already at a clean Chat: navigates to Core's
 * /app/, lets the onboarding autopilot provision + unlock, and waits for
 * Chat-ready (the Remember mode chip). Bundles the composer, the chat thread
 * reader, and backstage (debug-dispatch) for invisible assertions. A spec that
 * decides as the owner connects the browser first (`pages/owner_access.ts`).
 *
 * Requires the AUTOPILOT bundle (dist-e2e) + the functional config (which
 * boots Core with debug-dispatch and Brain with live Gemini).
 */

import { test as base, expect, type Page } from '@playwright/test';

import { egressHost, isAllowedEgress, scanForLeaks } from '../support/log_hygiene';

import * as backstage from './backstage';
import { ChatThread } from './pages/chat_thread';
import { Composer } from './pages/composer';

export interface HumanSession {
  page: Page;
  composer: Composer;
  thread: ChatThread;
  backstage: typeof backstage;
}

export const test = base.extend<{ human: HumanSession }>({
  human: async ({ page }, use) => {
    const consoleErrors: string[] = [];
    const consoleAll: string[] = [];
    const requestUrls: string[] = [];
    page.on('console', (m) => {
      consoleAll.push(m.text());
      if (m.type() === 'error') consoleErrors.push(m.text());
      // m.text() renders object arguments as "JSHandle@object", hiding
      // content passed as an object (e.g. console.log('x', {vault})). Also
      // resolve each arg's value (best-effort, async — flushed before the
      // teardown scan) so an object-arg leak is still caught.
      for (const arg of m.args()) {
        arg.jsonValue().then(
          (v) => {
            if (v !== undefined && v !== null) {
              consoleAll.push(typeof v === 'string' ? v : JSON.stringify(v));
            }
          },
          () => {
            /* handle disposed after navigation — ignore */
          },
        );
      }
    });
    page.on('pageerror', (e) => {
      consoleAll.push(e.message);
      consoleErrors.push(e.message);
    });
    page.on('request', (r) => requestUrls.push(r.url()));

    // The functional stack shares ONE Core vault + workflow store across the
    // run — reset both so each test starts clean (no accumulated facts, no
    // leftover approval proposals from an agent test polluting negatives).
    await backstage.resetVault();
    await backstage.resetApprovals();

    await page.goto('/app/');
    // Chat-ready = the Remember mode chip is present. Autopilot: welcome →
    // provision did:plc (test-pds) → argon2 unlock → Chat (the guided-demo
    // gate is disabled under autopilot). Generous wait for provision + KDF.
    await page
      .getByTestId('index-mode-chip-remember')
      .waitFor({ state: 'visible', timeout: 90_000 });

    await use({
      page,
      composer: new Composer(page),
      thread: new ChatThread(page),
      backstage,
    });

    // Fail the test on hard runtime errors surfaced during the flow — a
    // native-only module leaking into the web bundle shows up here.
    const hard = consoleErrors.filter((e) => /TypeError|ReferenceError/i.test(e));
    expect(hard, `hard console errors during flow: ${hard.join('; ')}`).toEqual([]);

    // Let any pending async console-arg resolutions flush before scanning.
    await page.waitForTimeout(300);

    // MRS-14 (browser half): the console must never carry vault content /
    // secrets / recovery phrases. (Same-origin API RESPONSE bodies are not
    // console output, so this does not false-fail on the owner's own
    // answer text — §4.3.)
    const consoleLeaks = scanForLeaks(consoleAll.join('\n'), 'browser-console');
    expect(
      consoleLeaks,
      `MRS-14: browser console leaked content: ${JSON.stringify(consoleLeaks)}`,
    ).toEqual([]);

    // MRS-14 (egress): the browser must reach ONLY the loopback stack + the
    // test fleet. A request to any other host is a hard failure — an
    // unexpected new host is either a real exfil path or a legit host to add
    // to ALLOWED_EGRESS_HOSTS after review, not something to log-and-pass.
    const unexpected = [
      ...new Set(requestUrls.filter((u) => !isAllowedEgress(u)).map(egressHost)),
    ].filter((h): h is string => h !== null);
    // Name the requests too (path only: a query string can carry a key).
    const examples = [
      ...new Set(
        requestUrls
          .filter((u) => !isAllowedEgress(u))
          .map((u) => {
            try {
              const url = new URL(u);
              return `${url.host}${url.pathname}`;
            } catch {
              return u.split('?')[0];
            }
          }),
      ),
    ].slice(0, 3);
    expect(
      unexpected,
      `MRS-14: browser reached non-allowlisted host(s): ${unexpected.join(', ')} ` +
        `(e.g. ${examples.join(', ')}) — review and add to ALLOWED_EGRESS_HOSTS if legitimate.`,
    ).toEqual([]);
  },
});

export { expect };
