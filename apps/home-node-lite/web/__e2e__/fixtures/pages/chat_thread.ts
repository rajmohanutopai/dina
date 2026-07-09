/**
 * ChatThread page object — reads the rendered chat rows via the
 * `chat-row` + `data-*` contract (docs/E2E_TESTING.md §5).
 *
 * Text extraction: plain answer bubbles expose `row-primary-text`; cards
 * expose their own `<kind>-card-body-*` testID (§5.3).
 */

import { expect, type Locator, type Page } from '@playwright/test';

export class ChatThread {
  constructor(private readonly page: Page) {}

  private rows(kind: string): Locator {
    return this.page.locator(`[data-testid="chat-row"][data-kind="${kind}"]`);
  }

  answers(): Locator {
    return this.rows('answer');
  }

  reminders(): Locator {
    return this.rows('reminder');
  }

  /** Peer D2D message bubbles (a contact's message, NOT a Dina answer). */
  d2dMessages(): Locator {
    return this.rows('d2d-message');
  }

  async d2dCount(): Promise<number> {
    return this.d2dMessages().count();
  }

  /** Count of approval-kind rows — the load-bearing NEGATIVE assertion:
   *  an owner-in-app flow must never show an approval card. */
  async approvalCount(): Promise<number> {
    return this.rows('approval').count();
  }

  /** Count of vault-read-approval ("lock prompt") rows — the READ-path
   *  negative: an owner-in-app read of a Sensitive/Locked vault must never
   *  raise a lock prompt (a distinct data-kind from 'approval'). */
  async vaultReadApprovalCount(): Promise<number> {
    return this.rows('vault-read-approval').count();
  }

  async answerCount(): Promise<number> {
    return this.answers().count();
  }

  async latestAnswerText(): Promise<string> {
    const row = this.answers().last();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    return (await row.getByTestId('row-primary-text').innerText()).trim();
  }

  /** Wait until a NEW answer bubble appears (count exceeds `previous`),
   *  then return its text. Generous timeout — real Gemini synthesis. */
  async waitForNewAnswer(previous: number, timeout = 60_000): Promise<string> {
    await expect(async () => {
      expect(await this.answers().count()).toBeGreaterThan(previous);
    }).toPass({ timeout });
    return this.latestAnswerText();
  }

  async reminderCount(): Promise<number> {
    return this.reminders().count();
  }

  /** The latest reminder card's body text, or null if there is no
   *  reminder card. Uses the card's own body testID (not row-primary-text). */
  async latestReminderText(timeout = 45_000): Promise<string | null> {
    try {
      await expect(async () => {
        expect(await this.reminders().count()).toBeGreaterThan(0);
      }).toPass({ timeout });
    } catch {
      return null;
    }
    const body = this.reminders().last().getByTestId(/^reminder-card-body-/);
    return (await body.innerText()).trim();
  }

  /** The latest reminder card's HEADER text ("REMINDER · NOV 7"), which
   *  carries the scheduled due date (formatDueShort) — distinct from the body.
   *  The deterministic "DATED" half of MRS-03. Null if there is no card. */
  async latestReminderHeader(timeout = 45_000): Promise<string | null> {
    try {
      await expect(async () => {
        expect(await this.reminders().count()).toBeGreaterThan(0);
      }).toPass({ timeout });
    } catch {
      return null;
    }
    const header = this.reminders().last().getByTestId(/^reminder-card-header-/);
    return (await header.innerText()).trim();
  }
}
