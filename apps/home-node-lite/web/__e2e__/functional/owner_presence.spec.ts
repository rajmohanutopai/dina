/**
 * WEB_OWNER_SURFACE_PLAN §3.8 — a powerful owner action in the browser needs
 * a person present, on a node in security mode (this tier's stack wraps its
 * seed under `DINA_E2E_OWNER_PASSPHRASE`).
 *
 * Driven the way a person does it, in a real browser against real Core:
 *   1. Connect this browser as the owner: the owner key and the passphrase.
 *      That proof belongs to the owner key's surface, not to this browser.
 *   2. Agents → name a coding agent → Generate. Core refuses the mint with
 *      `no_user_presence`, because THIS browser has proven nothing yet, and
 *      the "confirm it's you" sheet opens.
 *   3. A wrong passphrase is said inside the sheet and mints nothing.
 *   4. The right one closes the sheet, the same mint runs again, and the
 *      one-paste setup code appears.
 *
 * A Jest render test cannot catch what this does: React Native Web's own
 * behaviour (Alert is a no-op there), the signed request from the browser's
 * non-extractable key, and Core's per-surface presence rule.
 */

import { expect, test } from '../fixtures/human_session';
import { connectAsOwner } from '../fixtures/pages/owner_access';

test.describe('owner presence in the browser', () => {
  test('a coding-agent code needs this browser to prove presence; a wrong passphrase is said in the sheet', async ({
    human,
  }) => {
    const { backstage, page } = human;
    const passphrase = process.env.DINA_E2E_OWNER_PASSPHRASE ?? '';
    expect(passphrase, 'this tier runs Core in security mode').not.toBe('');

    await connectAsOwner(page, backstage.readOwnerCapability());

    await page.getByTestId('root-layout-menu').click();
    await page.getByTestId('root-layout-menu-row-settings').click();
    await page.getByTestId('settings-row-agents').click();
    await page.getByTestId('paired-devices-agent-name').fill('e2e-presence-agent');
    await page.getByTestId('paired-devices-generate').click();

    const sheet = page.getByTestId('presence-sheet');
    await expect(sheet, 'Core asked for a person present').toBeVisible();
    await expect(page.getByTestId('paired-devices-setup-code')).toHaveCount(0);

    await page.getByTestId('presence-passphrase').fill('not the passphrase');
    await page.getByTestId('presence-submit').click();
    await expect(page.getByTestId('presence-error')).toHaveText('That passphrase did not verify.');
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('paired-devices-setup-code')).toHaveCount(0);

    await page.getByTestId('presence-passphrase').fill(passphrase);
    await page.getByTestId('presence-submit').click();
    await expect(sheet).toHaveCount(0);
    const code = page.getByTestId('paired-devices-setup-code');
    await expect(code, 'the same mint ran again and its code is shown').toBeVisible();
    await expect(code).toHaveText(/^dina1:/);
  });
});
