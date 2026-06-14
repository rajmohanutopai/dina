/**
 * Backup-prompt scheduling — decides WHEN to ask the user to back up
 * their recovery phrase.
 *
 * Design (deferred, value-proportionate): the recovery phrase is NEVER a
 * first-run wall and there is no passive banner. The mnemonic is generated
 * silently at provisioning and the identity starts in `verification_status`
 * === 'pending'. Once the vault holds enough that losing it would actually
 * hurt (>= ITEM_THRESHOLD stored memories), a backup page pops up at the
 * next quiet moment. The user can complete it (-> 'verified', never asked
 * again) or snooze it (quiet for SNOOZE_MS, then it re-pops). A brand-new
 * user kicking the tyres on day one is never interrupted.
 *
 * This module owns the count + snooze gating; `verification_status` owns the
 * pending/verified flag.
 */

import { isPersonaOpen, listPersonas } from '@dina/core';

import { countVaultItems } from '../hooks/useVaultItems';

import * as Keychain from './keychain';
import { loadVerificationStatus } from './verification_status';

/**
 * Stored memories required before we ask. Tunable. Deliberately above the
 * "first day of testing" range (3-5) so a curious new user storing a few
 * throwaway notes — or poking at health/finance — is never interrupted; we
 * only ask once they've clearly invested ("used it a bit").
 */
export const BACKUP_PROMPT_ITEM_THRESHOLD = 12;

/** How long "Remind me later" keeps the prompt quiet before it re-pops. */
export const BACKUP_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const SNOOZE_SERVICE = 'dina.backup_prompt.snooze_until';
const USERNAME = 'dina';

/**
 * Total stored items across all OPEN personas. Synchronous — `countVaultItems`
 * is an in-memory repo read. A persona mid-bring-up can throw; we skip it
 * (best-effort count — undercounting just delays the prompt, never crashes).
 */
export function countAllVaultItems(): number {
  let total = 0;
  for (const p of listPersonas()) {
    if (!isPersonaOpen(p.name)) continue;
    try {
      total += countVaultItems(p.name);
    } catch {
      /* persona not ready — skip */
    }
  }
  return total;
}

/** ms-epoch the snooze expires (0 when never snoozed / on read error). */
export async function loadSnoozeUntil(): Promise<number> {
  try {
    const row = await Keychain.getGenericPassword({ service: SNOOZE_SERVICE });
    if (row === false) return 0;
    const n = Number.parseInt(row.password, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Snooze the prompt for BACKUP_SNOOZE_MS from now. `now` injectable for tests. */
export async function snoozeBackupPrompt(now: () => number = Date.now): Promise<void> {
  try {
    await Keychain.setGenericPassword(USERNAME, String(now() + BACKUP_SNOOZE_MS), {
      service: SNOOZE_SERVICE,
    });
  } catch {
    /* best-effort — worst case the prompt re-pops next foreground */
  }
}

/**
 * Should the backup page pop now? True iff ALL hold:
 *   - backup is still pending (a fresh identity that hasn't been confirmed),
 *   - the vault holds >= ITEM_THRESHOLD stored items, AND
 *   - we're past any active snooze window.
 * Count / threshold / clock are injectable for tests.
 */
export async function shouldPromptBackup(
  opts: { now?: () => number; itemCount?: () => number; threshold?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const count = opts.itemCount ?? countAllVaultItems;
  const threshold = opts.threshold ?? BACKUP_PROMPT_ITEM_THRESHOLD;

  if ((await loadVerificationStatus()) !== 'pending') return false;
  if (count() < threshold) return false;
  if (now() < (await loadSnoozeUntil())) return false;
  return true;
}
