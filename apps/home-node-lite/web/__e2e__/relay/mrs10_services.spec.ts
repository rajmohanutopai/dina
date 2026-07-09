/**
 * MRS-10 — Services, public (bus ETA) · UI + backstage provider · J  (§7 MRS-10)
 *
 * The consumer (a browser on Sancho) asks a live-service question in ASK mode;
 * the intent routes to `provider_services`; PUBLIC discovery finds an
 * `eta_query` provider through `test-appview`; the query goes D2D over MsgBox;
 * the provider's paired `stub_eta` daemon claims + answers; the in-thread
 * service-query card flips `pending → resolved` and presents a bus-42 ETA
 * (judged).
 *
 * Backstage provider (§8 — a precondition a human can't stage in one browser):
 * a second Dina (Alonso) publishes a public `eta_query` listing
 * (`put_service_config.ts`) and runs the `stub_eta` daemon
 * (`run_daemon.py` + `stub_eta_runner.py`) paired to it. See
 * `docs/E2E_TESTING.md` §7 and `dina-nodes/README.md`. Boot both with:
 *
 *   # provider listing (Alonso :8301) at a UNIQUE location (Reykjavik) so
 *   # PUBLIC discovery over the SHARED cloud test-appview is DETERMINISTIC —
 *   # the requester's geo-search returns only the provider serving that area,
 *   # not the many SF test listings. The consumer asks a bus in Reykjavik.
 *   cd demo/dina-services-demo && \
 *     DINA_CORE_URL=http://127.0.0.1:8301 \
 *     DINA_SERVICE_KEY_DIR=$PWD/../../dina-nodes/nodes/alonso/service_keys \
 *     DINA_DISCOVERABILITY=public \
 *     DINA_SERVICE_LAT=64.1466 DINA_SERVICE_LNG=-21.9426 DINA_SERVICE_RADIUS_KM=30 \
 *     npx tsx put_service_config.ts
 *   # runner (paired dina-agent "busagent" on Alonso):
 *   cd dina-nodes && ./agent.sh add busagent alonso
 *   cd demo/dina-services-demo && \
 *     DINA_CONFIG_DIR=$PWD/../../dina-nodes/agents/busagent/config/.dina/cli \
 *     STUB_ETA_DELAY_SECONDS=1 STUB_ETA_REVERSE_GEOCODE=0 \
 *     ../../dina-nodes/agents/busagent/.venv/bin/python run_daemon.py
 *   # then run with DINA_E2E_SERVICES_PROVIDER=1 (+ DINA_E2E_LIVE_JUDGE=1).
 *
 * VERIFIED PASSING end-to-end: the daemon claims the eta_query task with
 * route_id=42 + the Reykjavik coordinates, answers over MsgBox, and the card
 * flips pending→resolved (judge: bus-42 ETA). Geo-isolation is legitimate test
 * isolation — a real bus-ETA query resolves by the asker's location too — not a
 * workaround for the shared AppView. The judged rubric runs only under
 * `DINA_E2E_LIVE_JUDGE=1`; the deterministic pending→resolved transition (the
 * provider genuinely answered) always runs.
 *
 * @relay — needs the dina-nodes + the eta provider running; SKIPS LOUD otherwise.
 */

import { test, expect } from '@playwright/test';

import { Composer } from '../fixtures/pages/composer';
import { expectJudgePass, judgingEnabled } from '../fixtures/judge';

import { attachHygiene } from './relay_hygiene';
import { NODES, relayReachable } from './relay_nodes';

const SERVICE_CARD = '[data-testid="chat-row"][data-kind="service-query"]';

test.describe('MRS-10 — Services, public (bus ETA)', () => {
  test('a public bus-ETA question resolves a service-query card via discovery + D2D', async ({
    browser,
  }) => {
    test.skip(!(await relayReachable()), 'relay: dina-nodes (alonso/sancho) not running');
    // MRS-10 needs a live PROVIDER: Alonso publishing a public `eta_query`
    // listing at Reykjavik + the paired `stub_eta` daemon answering (see the
    // file header for the boot commands). That provider isn't part of the
    // default dina-nodes bring-up, so gate on the harness having set it up and
    // skip LOUD otherwise — this keeps the relay suite green while the spec runs
    // for real the moment the provider is up (DINA_E2E_SERVICES_PROVIDER=1).
    test.skip(
      process.env.DINA_E2E_SERVICES_PROVIDER !== '1',
      'MRS-10 needs the eta_query provider running (DINA_E2E_SERVICES_PROVIDER=1) — publish + ' +
        'daemon per the file header; see also implementation-notes.html',
    );

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const hygiene = attachHygiene(page); // MRS-14 browser-half
    try {
      await page.goto(NODES.sancho.web, { waitUntil: 'domcontentloaded' });

      // Human asks a live-service question. ASK mode → the intent classifier
      // routes it to provider_services (the vault cannot hold a live ETA). The
      // location (Reykjavik) is what makes PUBLIC discovery deterministic over
      // the SHARED cloud test-appview: the geo-search returns only the provider
      // serving that area (this run's Alonso), not the many SF test listings.
      const composer = new Composer(page);
      await composer.ask("when's the next 42 bus in Reykjavik?");

      // The service-query card surfaces (pending) — discovery + the D2D
      // dispatch have started.
      const card = page.locator(SERVICE_CARD);
      await expect(card.first(), 'a service-query card surfaces after the ask').toBeVisible({
        timeout: 60_000,
      });

      // …then RESOLVES once the provider's stub_eta daemon answers over MsgBox.
      // This is the load-bearing DETERMINISTIC assertion: a card that never
      // resolves means discovery/D2D/daemon broke — no LLM judgement needed.
      const resolved = page.locator(`${SERVICE_CARD}[data-status="resolved"]`);
      await expect(
        resolved.first(),
        'the service-query resolves — provider discovered + answered over D2D',
      ).toBeVisible({ timeout: 120_000 });

      // Judged: the resolved card presents a bus-42 ETA (live tier only).
      if (judgingEnabled()) {
        // Read the WHOLE resolved row's text, not `service-query-card-body-*` —
        // that testID exists only on InlineServiceQueryCard's FALLBACK text
        // branch. A well-formed eta_minutes result renders via the PRIMARY
        // CardSpec path (SafeCardRenderer, no body testID), so scraping the
        // body testID would match zero elements on the happy path. The row's
        // innerText captures both render paths.
        const body = await resolved.first().innerText();
        await expectJudgePass({
          rubric:
            'This is a RESOLVED service-query card answering the user\'s question "when\'s the ' +
            'next 42 bus?". PASS if it presents an arrival ETA for bus/route 42 (a clock time or ' +
            'a minutes-until-arrival). FAIL if it is an error, says it does not know, or is ' +
            'unrelated to a bus arrival time.',
          actual: body.trim(),
        });
      }

      hygiene.assertClean(); // MRS-14 browser-half
    } finally {
      await ctx.close();
    }
  });
});
