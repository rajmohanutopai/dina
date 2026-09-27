/**
 * Connect this browser as the owner's device (WEB_OWNER_SURFACE_PLAN §3.3),
 * the way a person does: Menu → Settings → Owner access, paste the node's
 * owner key, Connect. The owner routes the web app uses (the approval inbox,
 * the owner screens) answer only a connected browser.
 *
 * On a stack in security mode (`buildStack({ ownerPassphrase })`) the node
 * checks the passphrase before it pairs an owner device, so it is typed here;
 * a convenience-mode stack has none to check and connecting needs none.
 */

import type { Page } from '@playwright/test';

export async function connectAsOwner(page: Page, ownerKey: string): Promise<void> {
  await page.getByTestId('root-layout-menu').click();
  await page.getByTestId('root-layout-menu-row-settings').click();
  await page.getByTestId('settings-row-owner-access').click();
  const connected = page.getByTestId('owner-access-connected');
  if (await connected.isVisible().catch(() => false)) return;
  await page.getByTestId('owner-access-key').fill(ownerKey);
  const passphrase = process.env.DINA_E2E_OWNER_PASSPHRASE ?? '';
  if (passphrase !== '') await page.getByTestId('owner-access-passphrase').fill(passphrase);
  await page.getByTestId('owner-access-connect').click();
  await connected.waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('tab-chat').click();
}
