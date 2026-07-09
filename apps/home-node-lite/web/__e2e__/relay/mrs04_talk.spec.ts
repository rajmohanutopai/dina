/**
 * MRS-04 — Talk (D2D) + enrichment · 2×UI · J  (§7 MRS-04)
 *
 * A peer's message lands in the receiver's chat as a verbatim `d2d-message`
 * bubble (NOT a Dina answer) and — for an actionable message — spins up an
 * enriched reminder that weaves in the receiver's own vault context.
 *
 * Party-under-test = SANCHO (the receiver), driven through his browser; his
 * render + enrichment is what's asserted/judged. Alonso's outbound is staged
 * backstage — a legitimate "seed a peer's outbound message" (§8), NOT the
 * human-visible behavior under test. (Design note: the web D2D *send* UI is
 * not yet parity-verified; MRS-04's judged behavior is the RECEIVE side, which
 * F4 made faithful. When the send UI is verified this becomes fully 2×UI.)
 *
 * Deterministic core (every run): the `d2d-message` bubble renders verbatim.
 * Judged (live tier, DINA_E2E_LIVE_JUDGE=1): the enriched reminder quality.
 *
 * @relay — needs the two dina-nodes running; SKIPS LOUD otherwise (§10.5).
 */

import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';

import { ChatThread } from '../fixtures/pages/chat_thread';
import { expectJudgePass, judgingEnabled } from '../fixtures/judge';
import { attachHygiene } from './relay_hygiene';
import { NODES, dispatch, nodeDid, relayReachable } from './relay_nodes';

// Unique per run: the relay nodes are long-lived and reused, and the SSE stream
// replays the WHOLE persisted `main` thread to every fresh subscriber — so a
// fixed string + `.last()` could match a STALE bubble from a prior run. A
// per-run token defeats that (keeps the "tomorrow morning" semantics the judge
// rubric relies on).
const RUN = randomUUID().slice(0, 8);
const PEER_TEXT = `coming over tomorrow morning [run-${RUN}]`;

test('MRS-04 — a peer message renders as a d2d-message; (live) an enriched reminder', async ({
  browser,
}) => {
  test.skip(!(await relayReachable()), 'relay: dina-nodes (alonso/sancho) not running');

  const sancho = NODES.sancho;
  const alonso = NODES.alonso;
  const sanchoDid = await nodeDid(sancho, alonso);

  // Sancho opens his chat (the human under test) — the main chat subscribes to
  // the SSE stream on mount (F4), so an inbound D2D surfaces live.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const hygiene = attachHygiene(page); // MRS-14 browser-half
  try {
    await page.goto(sancho.web, { waitUntil: 'domcontentloaded' });
    const thread = new ChatThread(page);
    await page.waitForTimeout(2500); // SSE subscribe
    const d2dBefore = await thread.d2dCount(); // baseline (prior-run bubbles)

    // Reminder RECORD baseline. NB: a peer message enriches through the
    // BACKGROUND staging drain (schedule_reminder → a reminder RECORD in a
    // persona), NOT a chat-thread card (that's the /remember path) — so this
    // is verified against the reminders collection, gated on an increment past
    // this pre-send baseline so a stale prior-run reminder can't satisfy it.
    const reminderRecords = async (): Promise<{ message: string }[]> => {
      const { body } = await dispatch(sancho, 'GET', '/v1/reminders', {
        query: { persona: 'general' },
      });
      return (body as { reminders?: { message: string }[] }).reminders ?? [];
    };
    const remBefore = (await reminderRecords()).length;

    // Alonso sends a Talk message (backstage — a peer's outbound, §8).
    const send = await dispatch(alonso, 'POST', '/v1/msg/send', {
      body: { recipient_did: sanchoDid, type: 'coordination.request', body: { text: PEER_TEXT } },
    });
    expect(send.status, 'alonso→sancho D2D accepted').toBeLessThan(300);

    // ── Deterministic: a NEW peer message renders as a `d2d-message` bubble
    //    (distinct from a Dina `answer`), verbatim, attributed to the peer.
    //    Wait for the count to INCREMENT so a stale prior-run bubble can't
    //    satisfy this; the per-run token in PEER_TEXT double-guards it.
    await expect(async () => {
      expect(await thread.d2dCount()).toBeGreaterThan(d2dBefore);
    }).toPass({ timeout: 45_000 });
    const peerRow = thread.d2dMessages().last();
    await expect(peerRow, 'peer D2D message surfaces in Sancho’s chat').toBeVisible({
      timeout: 45_000,
    });
    await expect(peerRow).toContainText(PEER_TEXT);
    // It must NOT be classified as a Dina `answer`. Scope the negative to THIS
    // peer's unique text: `main` is a shared, persisted, history-replayed
    // thread, so a global answer-row count would false-fail on any prior /ask.
    await expect(
      page.locator('[data-testid="chat-row"][data-kind="answer"]', { hasText: PEER_TEXT }),
      'a peer message is a d2d-message, never a Dina answer',
    ).toHaveCount(0);

    // ── The actionable peer message ENRICHES into a scheduled reminder.
    //    DETERMINISTIC: a NEW reminder record appears (increment past baseline)
    //    — the full chain (D2D receive → staging → drain → schedule_reminder)
    //    runs AFTER the bubble and lands ~tens of seconds later, so the window
    //    is generous. This proves the enrichment fired without any LLM judge.
    let newReminder = '';
    await expect(async () => {
      const recs = await reminderRecords();
      expect(
        recs.length,
        'the peer message scheduled a NEW reminder (background enrichment)',
      ).toBeGreaterThan(remBefore);
      newReminder = recs[recs.length - 1]?.message ?? '';
    }).toPass({ timeout: 90_000 });

    // ── Judged (live only): the scheduled reminder is ABOUT the visit.
    if (judgingEnabled()) {
      await expectJudgePass({
        rubric: `Sancho received a peer message from Alonso: "${PEER_TEXT}" (Alonso is coming over tomorrow morning). This is the reminder Dina scheduled from it. PASS if the reminder is about Alonso's visit / him coming over (a morning visit). FAIL if it is unrelated to the visit or a generic empty reminder.`,
        actual: newReminder,
      });
    }

    // MRS-14 browser-half: no vault content / secrets in the console, no
    // unexpected egress. (Server-log half runs in relay_teardown.ts.)
    hygiene.assertClean();
  } finally {
    await ctx.close();
  }
});
