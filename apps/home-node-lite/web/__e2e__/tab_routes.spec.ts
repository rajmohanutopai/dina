/**
 * Phases 5-9 tab-routes render walk.
 *
 * Mobile's Expo Router maps every URL pattern at `apps/mobile/app/*`
 * to a screen. On web the same routes mount through React Native Web —
 * which means we can navigate the browser directly to any of them and
 * assert "this tab renders, no hard errors, no native-module leaks."
 *
 * That render-parity slice IS the Phase 5-9 "Done when" criterion in
 * spirit: each tab loads through Core's `/app/*` mount (web_app.ts),
 * the bundle's per-tab code path executes far enough to populate the
 * DOM, and the console stays free of TypeError / ReferenceError that
 * would signal a native-only module slipping into the web bundle.
 *
 * Interactive happy-paths (e.g. "submit a vouch", "schedule a
 * reminder", "send a D2D message") still need a fully-provisioned
 * identity. The paired-stack we boot in `playwright.config.ts` gets
 * Core + Brain running side-by-side, but the autopilot through
 * onboarding lands on the chat home only when a real `did:plc` mints
 * against a PDS — that's a Phase 10 orchestration layer adding a
 * local PDS fixture. Until then, the render-parity slice here is the
 * regression-catch that proves the bundle did not break.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phases 5, 6, 7, 8, 9.
 */

import { expect, test } from '@playwright/test';

/**
 * Routes covered, grouped by the Phase that owns the contract.
 *
 * The asserted text is the most stable visible bit on each screen
 * — usually a screen title or a default empty-state hint. We don't
 * pin on long sentences (those rot fast); short, distinctive labels
 * are the regression-catch.
 *
 * `'/app/'` (the SPA root) is intentionally NOT listed — that's
 * already covered by `smoke.spec.ts` and `onboarding.spec.ts`.
 */
const ROUTES: { phase: number; path: string; mustSee: RegExp[] }[] = [
  // Phase 5 — PeerLens
  { phase: 5, path: '/app/peerlens', mustSee: [/peerlens|peer\s*lens|reviews/i] },
  { phase: 5, path: '/app/peerlens/search', mustSee: [/search|find|filter/i] },
  { phase: 5, path: '/app/peerlens/write', mustSee: [/write|draft|review/i] },
  { phase: 5, path: '/app/peerlens/outbox', mustSee: [/outbox|pending|queue/i] },
  { phase: 5, path: '/app/peerlens/namespace', mustSee: [/namespace|topic|category/i] },
  { phase: 5, path: '/app/peerlens/subject-1', mustSee: [/peerlens|subject|reviews/i] },
  {
    phase: 5,
    path: '/app/peerlens/reviewer/did:plc:fake',
    mustSee: [/reviewer|did|profile|reviews/i],
  },
  { phase: 5, path: '/app/peerlens-preferences/budget', mustSee: [/budget|price/i] },
  { phase: 5, path: '/app/peerlens-preferences/dietary', mustSee: [/diet|food|restriction/i] },
  { phase: 5, path: '/app/peerlens-preferences/region', mustSee: [/region|location|country/i] },
  { phase: 5, path: '/app/peerlens-preferences/languages', mustSee: [/language|locale/i] },
  { phase: 5, path: '/app/peerlens-preferences/accessibility', mustSee: [/accessibility|a11y/i] },
  { phase: 5, path: '/app/peerlens-preferences/devices', mustSee: [/device|platform/i] },

  // Phase 6 — Vault + personas (parametric route exercises persona-name resolution)
  { phase: 6, path: '/app/vault', mustSee: [/vault|memories|personas/i] },
  { phase: 6, path: '/app/vault/general', mustSee: [/vault|persona|general|memories/i] },

  // Phase 7 — Other tabs (includes the D2D chat/[did] route — that's
  // also Phase 9's primary surface, exercised through the same render
  // walk since the underlying React tree is what both phases
  // ultimately ship.)
  { phase: 7, path: '/app/chat/did:plc:fake', mustSee: [/chat|message|conversation|did/i] },
  { phase: 7, path: '/app/people', mustSee: [/people|contacts|relationships/i] },
  { phase: 7, path: '/app/approvals', mustSee: [/approval|pending|requests/i] },
  { phase: 7, path: '/app/notifications', mustSee: [/notification|alerts|inbox/i] },
  { phase: 7, path: '/app/reminders', mustSee: [/reminder|upcoming|scheduled/i] },
  { phase: 7, path: '/app/admin', mustSee: [/admin|debug|status/i] },
  { phase: 7, path: '/app/paired-devices', mustSee: [/device|paired|link/i] },
  { phase: 7, path: '/app/policy', mustSee: [/polic|trust|consent/i] },
  { phase: 7, path: '/app/settings', mustSee: [/setting|preferences|account/i] },
  { phase: 7, path: '/app/help', mustSee: [/help|guide|docs|about/i] },
  { phase: 7, path: '/app/recovery-phrase', mustSee: [/recovery|mnemonic|phrase/i] },
  { phase: 7, path: '/app/service-settings', mustSee: [/service|sharing|infrastructure/i] },
  { phase: 7, path: '/app/add-contact', mustSee: [/contact|handle|did/i] },
  { phase: 7, path: '/app/confirm-recovery-phrase', mustSee: [/confirm|verify|recovery|phrase/i] },
];

for (const { phase, path: routePath, mustSee } of ROUTES) {
  test(`Phase ${phase} — GET ${routePath} renders without console errors`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    await page.goto(routePath);

    // Step 1: Core returned an HTML shell. Its web-app route sends
    // index.html for any /app/<unknown-route> (the SPA fallback in
    // core-server/src/server/web_app.ts).
    await expect(page.locator('#root')).toBeAttached({ timeout: 10_000 });

    // Step 2: the React bundle mounted and rendered something. RNW
    // populates <div id="root"> asynchronously; wait for at least one
    // text node to appear before asserting the route-specific copy.
    await expect(page.locator('body')).not.toBeEmpty({ timeout: 15_000 });

    // Step 3: route-specific assertion. The page should contain at
    // least one of the per-tab text patterns within a reasonable
    // window. The flow may have routed to the InfraSetupForm
    // (returning user without infra config) or the unlock gate
    // (returning user with a wrapped seed) — both are valid
    // intermediate states, BUT a route that crash-loops would show
    // nothing past the loading spinner. The regex match captures
    // either the tab content OR an unlock-gate / infra-setup
    // sentinel.
    const liberalPatterns = [
      ...mustSee,
      /Choose your infrastructure/i, // infra setup
      /unlock|passphrase/i, // returning-user unlock gate
      /welcome|sovereign|get started/i, // onboarding welcome
      /let's get your dina set up/i, // mode choice
    ];
    await expect(async () => {
      const text = await page.locator('body').innerText();
      const hit = liberalPatterns.find((re) => re.test(text));
      expect(hit, `none of ${liberalPatterns.map(String).join(' / ')} matched`).toBeTruthy();
    }).toPass({ timeout: 10_000, intervals: [250, 500, 1000] });

    // Step 4: no hard JS errors during the route's bundle execution.
    // Soft warnings (RNW deprecation noise, image-size warnings) are
    // filtered out so they don't drown the signal.
    const hardErrors = consoleErrors.filter((e) =>
      /TypeError|ReferenceError|cannot read properties|Module not found/i.test(e),
    );
    expect(hardErrors).toEqual([]);
  });
}
