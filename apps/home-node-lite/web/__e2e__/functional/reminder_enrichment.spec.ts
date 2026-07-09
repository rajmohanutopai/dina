/**
 * MRS-03 — Reminder + context enrichment.
 * docs/E2E_TESTING.md §7; behavior spec dina_details.md §3.3.
 *
 * A dated/actionable fact auto-creates an ENRICHED reminder card (judged:
 * it references the specific event, not a generic reminder). The
 * load-bearing NEGATIVE is deterministic: a plain preference produces NO
 * reminder card. Live tier.
 */

import { expectJudgePass } from '../fixtures/judge';
import { expect, test } from '../fixtures/human_session';

test.describe('MRS-03 — Reminder enrichment (with vs without)', () => {
  test('a dated fact creates an enriched reminder card; a plain preference does not', async ({
    human,
  }) => {
    const { composer, thread, page } = human;

    // ── With: a dated/actionable fact → an enriched reminder card ────────
    await composer.remember("Emma's birthday is on November 7th");
    const reminderText = await thread.latestReminderText(45_000);
    expect(reminderText, 'a dated fact should auto-create a reminder card').not.toBeNull();
    await expectJudgePass({
      rubric:
        'This is an auto-created reminder MESSAGE produced after the user said "Emma\'s birthday ' +
        'is on November 7th". PASS if it is an ENRICHED reminder clearly about EMMA\'s BIRTHDAY ' +
        '(it names Emma and the birthday, not a bare "you have a reminder"). FAIL if it is generic, ' +
        'unrelated, or not about a birthday. NOTE: the exact calendar date is verified separately ' +
        'against the card HEADER, so relative phrasing ("today"/"tomorrow") in this message body is ' +
        'acceptable — judge ENRICHMENT here, not the date.',
      actual: reminderText as string,
    });
    // The DATED half — DETERMINISTIC (no judge): the card header carries the
    // scheduled due date. A Nov 7 birthday schedules in early November (the
    // product may fire the day before), so accept NOV 6 or 7 — never a default
    // "tomorrow". This pins what the rubric alone can't verify (the date lives
    // in the header, not the judged body).
    const reminderHeader = await thread.latestReminderHeader(45_000);
    expect(reminderHeader, 'the reminder card header carries a scheduled due date').not.toBeNull();
    expect(
      reminderHeader as string,
      'MRS-03 DATED: the birthday reminder schedules on/near Nov 7 (header), not a generic "tomorrow"',
    ).toMatch(/NOV\s*0?[67]\b/);
    const remindersBaseline = await thread.reminderCount();

    // ── Without: a plain preference → NO new reminder card ──────────────
    // Anchor the wait on Dina's ACK (a new assistant answer), NOT on any new
    // row — the user's own message bubble renders instantly and would
    // satisfy a row-count wait before the server has processed anything,
    // making the negative vacuous. Waiting for the answer means the server
    // finished and HAD its chance to emit a reminder.
    const answersBefore = await thread.answerCount();
    await composer.remember("Emma's favorite color is blue");
    await thread.waitForNewAnswer(answersBefore, 45_000);
    // …then give any reminder a beat to render, and assert none did.
    await page.waitForTimeout(4000);
    expect(
      await thread.reminderCount(),
      'a plain preference must NOT create a reminder card',
    ).toBe(remindersBaseline);
  });
});
