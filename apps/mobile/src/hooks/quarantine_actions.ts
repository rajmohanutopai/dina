/**
 * Quarantine card actions — NATIVE / default.
 *
 * In-process: accept/block run the compound flow (trust the sender + release
 * or drop their held messages) directly against Core via `useD2DMessages`. The
 * web peer (`quarantine_actions.web.ts`) POSTs to the brain-server's compound
 * accept/block endpoints instead, because the thin-client can't touch the
 * in-process quarantine store (F4 / MRS-05).
 */

import { acceptFromQuarantine, blockFromQuarantine } from './useD2DMessages';

export function acceptQuarantine(quarantineId: string, _senderDID: string): Promise<boolean> {
  return Promise.resolve(acceptFromQuarantine(quarantineId).action === 'accepted');
}

export function blockQuarantine(quarantineId: string, _senderDID: string): Promise<boolean> {
  return Promise.resolve(blockFromQuarantine(quarantineId).action === 'blocked');
}
