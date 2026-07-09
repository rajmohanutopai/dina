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
    const { composer, thread, backstage, page } = human;

    // ── MRS-01: Remember three facts (classifier routes by content) ─────
    await composer.remember('Emma loves dinosaurs');
    await thread.waitForNewAnswer(0);
    await composer.remember('my HbA1c blood test result is 6.1');
    await thread.waitForNewAnswer(1);
    await composer.remember('my Barclays bank account balance is 4200 pounds');
    await thread.waitForNewAnswer(2);

    // ── MRS-01 routing (backstage, invisible) ───────────────────────────
    // Resolve routing FIRST — waitForPersonaContaining polls until each fact
    // has drained through staging → vault write. This is the settle point:
    // only after it has the async remember pipeline demonstrably completed, so
    // the owner-never-gated negatives below are asserted against a settled
    // state (not the instant "Stored" ack, which renders before the drain — a
    // staging-triggered approval would otherwise appear AFTER a pre-settle read
    // and be missed).
    const dinoP = await backstage.waitForPersonaContaining(PERSONAS, 'dinosaur');
    const hbaP = await backstage.waitForPersonaContaining(PERSONAS, 'HbA1c');
    const bankP = await backstage.waitForPersonaContaining(PERSONAS, 'Barclays');
    // eslint-disable-next-line no-console
    console.log(`[MRS-01 routing] dinosaur→${dinoP} HbA1c→${hbaP} Barclays→${bankP}`);
    // Pin the exact bucket for ALL three (matching health/finance) — the
    // general fact routes to `general` (no sensitive signal), not merely
    // "stored somewhere".
    expect(dinoP, 'general content routes to the general vault').toBe('general');
    expect(hbaP, 'the health fact must be stored and listable').not.toBeNull();
    expect(bankP, 'the finance fact must be stored and listable').not.toBeNull();
    // Sensitive content routes to its sensitive vault.
    expect(hbaP, 'health content routes to the health vault').toBe('health');
    expect(bankP, 'finance content routes to the finance vault').toBe('finance');

    // The load-bearing owner-vs-agent gate: owner-in-app is NEVER gated, even
    // remembering health/finance. Asserted NOW — AFTER the pipeline settled
    // (above) — so a staging/drain-time approval had its full chance to appear.
    // Checked BOTH in the UI (no approval card renders) AND server-side (no
    // approval task exists — catches a card that failed to render over a real
    // task).
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

    // Recall of the owner's own memory is never gated either — MRS-02's full
    // negative is "no lock prompt AND no approval card". Both halves:
    expect(await thread.approvalCount(), 'owner-in-app Ask must never raise an approval card').toBe(
      0,
    );
    // No lock prompt on the owner's sensitive-vault read — both the in-thread
    // vault-read-approval card AND the passphrase modal.
    expect(
      await thread.vaultReadApprovalCount(),
      'owner-in-app Ask must never raise a vault-read-approval (lock) card',
    ).toBe(0);
    expect(
      await page.getByTestId('passphrase-field-input').count(),
      'owner-in-app Ask (even health) must never trigger a passphrase prompt',
    ).toBe(0);
  });
});
