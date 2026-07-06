/**
 * Composer page object — the real Dina chat composer.
 *
 * The composer is mode-first: it shows mode chips (Ask / Remember /
 * Services / Reviews / Talk), and the text input (`chat-input`) mounts
 * only AFTER a mode is picked (the "must pick a mode" design). So the
 * human flow for any message is: tap the mode chip → type → send.
 *
 * Real testIDs (verified in apps/mobile/app/index.tsx):
 *   index-mode-chip-<ask|remember|services|reviews>  (task hidden w/o agent)
 *   chat-input, send-button
 */

import { expect, type Page } from '@playwright/test';

export type ComposerMode = 'ask' | 'remember' | 'services' | 'reviews';

export class Composer {
  constructor(private readonly page: Page) {}

  private input() {
    return this.page.getByTestId('chat-input');
  }

  /** Pick a mode; the text input mounts afterwards. */
  async pickMode(mode: ComposerMode): Promise<void> {
    await this.page.getByTestId(`index-mode-chip-${mode}`).click();
    await this.input().waitFor({ state: 'visible', timeout: 15_000 });
  }

  /** Pick the mode, type the text (char-by-char so RN-Web's onChangeText
   *  fires and the send button enables), and send. */
  async submit(mode: ComposerMode, text: string): Promise<void> {
    await this.pickMode(mode);
    await this.input().click();
    await this.input().pressSequentially(text, { delay: 10 });
    const send = this.page.getByTestId('send-button');
    // The send button is disabled while Dina is still processing a prior
    // turn (`isTyping`). Wait for it to be enabled with a clear message — a
    // stuck-typing state (rather than an opaque click timeout) points at a
    // real backend stall. The window is generous (90s) so a transient Gemini
    // rate-limit backoff under combined load recovers rather than flaking
    // (see implementation-notes F3).
    await expect(
      send,
      'send button never enabled — Dina appears stuck processing a prior turn',
    ).toBeEnabled({ timeout: 90_000 });
    await send.click();
  }

  remember(fact: string): Promise<void> {
    return this.submit('remember', fact);
  }

  ask(question: string): Promise<void> {
    return this.submit('ask', question);
  }
}
