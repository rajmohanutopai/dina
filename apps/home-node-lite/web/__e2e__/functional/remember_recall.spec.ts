/**
 * MRS-01 (Remember + persona routing) & MRS-02 (Ask / recall).
 * docs/E2E_TESTING.md §7; behavior spec dina_details.md §3.1-3.2.
 *
 * The owner (in-app) remembers three facts — a general one, a health one,
 * a finance one. Deterministic invariants (no LLM): NO approval card ever
 * appears (owner-in-app is never gated, even for sensitive content), and
 * each fact routes to the right vault (verified backstage). Judged (live
 * Gemini): Ask recalls the facts, and the health answer does not leak
 * finance (cross-domain). Live tier.
 */

import { expectJudgePass } from '../fixtures/judge';
import { expect, test } from '../fixtures/human_session';

const PERSONAS = ['general', 'health', 'finance', 'work'];

test.describe('MRS-01/02 — Remember + persona routing + Ask recall', () => {
  test('facts route to the right vault, Ask recalls them, owner is never gated', async ({
    human,
  }) => {
    const { composer, thread, backstage } = human;

    // ── MRS-01: Remember three facts (classifier routes by content) ─────
    await composer.remember('Emma loves dinosaurs');
    await thread.waitForNewAnswer(0);
    await composer.remember('my HbA1c blood test result is 6.1');
    await thread.waitForNewAnswer(1);
    await composer.remember('my Barclays bank account balance is 4200 pounds');
    await thread.waitForNewAnswer(2);

    // The load-bearing owner-vs-agent gate: owner-in-app is NEVER gated,
    // even remembering health/finance. Deterministic, no LLM. Checked BOTH
    // in the UI (no approval card renders) AND server-side (no approval task
    // was created — catches a card that failed to render over a real task).
    expect(
      await thread.approvalCount(),
      'owner-in-app Remember must never raise an approval card (even for sensitive content)',
    ).toBe(0);
    const pending = await backstage.pendingApprovals();
    if (pending !== null) {
      expect(
        pending.length,
        'owner-in-app Remember must not create a server-side approval task',
      ).toBe(0);
    }

    // ── MRS-01 routing (backstage, invisible) ───────────────────────────
    const dinoP = await backstage.waitForPersonaContaining(PERSONAS, 'dinosaur');
    const hbaP = await backstage.waitForPersonaContaining(PERSONAS, 'HbA1c');
    const bankP = await backstage.waitForPersonaContaining(PERSONAS, 'Barclays');
    // eslint-disable-next-line no-console
    console.log(`[MRS-01 routing] dinosaur→${dinoP} HbA1c→${hbaP} Barclays→${bankP}`);
    expect(dinoP, 'the general fact must be stored and listable').not.toBeNull();
    expect(hbaP, 'the health fact must be stored and listable').not.toBeNull();
    expect(bankP, 'the finance fact must be stored and listable').not.toBeNull();
    // Sensitive content routes to its sensitive vault.
    expect(hbaP, 'health content routes to the health vault').toBe('health');
    expect(bankP, 'finance content routes to the finance vault').toBe('finance');

    // ── MRS-02: Ask recall (judged) ─────────────────────────────────────
    let before = await thread.answerCount();
    await composer.ask('what does Emma like?');
    const dinoAnswer = await thread.waitForNewAnswer(before);
    await expectJudgePass({
      rubric:
        'The user asked what Emma likes, having earlier told Dina "Emma loves dinosaurs". ' +
        'PASS if the answer states or clearly implies dinosaurs. FAIL if it says it does not ' +
        'know, or names a different interest.',
      actual: dinoAnswer,
    });

    before = await thread.answerCount();
    await composer.ask('what is my HbA1c?');
    const healthAnswer = await thread.waitForNewAnswer(before);
    await expectJudgePass({
      rubric:
        'The user asked for their HbA1c, having earlier told Dina it is 6.1. PASS if the answer ' +
        'states 6.1. FAIL if it says it does not know or gives a different value.',
      actual: healthAnswer,
    });
    // Cross-domain: the health answer must not leak finance.
    await expectJudgePass({
      rubric:
        'This is an answer to a HEALTH question (HbA1c). PASS only if it is about health and ' +
        'contains NO bank/finance/account/balance details. FAIL if any finance detail appears.',
      actual: healthAnswer,
    });

    // Recall of the owner's own memory is never gated either.
    expect(await thread.approvalCount(), 'owner-in-app Ask must never gate').toBe(0);
  });
});
