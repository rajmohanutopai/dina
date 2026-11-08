/**
 * What belongs to one identity, and when it stops applying.
 *
 * Two things here, both for the phone that changes identity with no restart:
 *
 *   - `resetIdentityScopedState`: memory that outlives the database teardown
 *     because a plain seal of the same identity should keep it. Sign out,
 *     erase, and persistence opening for another seed all clear it.
 *
 *   - The keychain rows that describe an owner but hold no secret (preferences,
 *     role, the linked account). Sign out keeps them, since nothing else holds
 *     them and the same owner coming back expects them. It records whose they
 *     were, as a hash; when a different identity onboards they go.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { resetPersonaState } from '@dina/core';
import { resetReminderCaches } from '@dina/core/reminders';

import { resetActiveProviderCache } from '../ai/active_provider';
import { resetApprovalCards } from '../hooks/useChatApprovals';
import { resetNudges } from '../hooks/useChatNudges';
import { resetD2DChatSnapshotsForTest } from '../hooks/useD2DChat';
import { seedDefaultPersonas } from '../onboarding/default_personas';

import * as Keychain from './keychain';
import { resetOfferedCatalogCacheForTest } from './offered_catalog';
import { resetPendingPreflights } from './pending_preflight';
import { resetSupplierNameCache } from './supplier_names';
import { clearUserPreferencesCache } from './user_preferences';

export const SIGNED_OUT_SERVICE = 'dina.identity.signed_out';
const USERNAME = 'dina';

/** Rows that describe the signed-out owner, kept for their return. */
export const OWNER_ROWS: readonly string[] = [
  'dina.user_preferences',
  'dina.node_role',
  'dina.linked_atproto_identity',
  'dina.verification_status',
  'dina.verification_banner_dismissed',
  'dina.backup_prompt.snooze_until',
];

/**
 * Clear in-memory state of the identity that just ended. Persistence must be
 * closed: nothing here touches a database. Built-in personas come straight
 * back, since the next unlock expects them; custom ones return from the next
 * identity's own table.
 */
export function resetIdentityScopedState(): void {
  resetReminderCaches();
  resetApprovalCards();
  resetPersonaState();
  seedDefaultPersonas();
  clearUserPreferencesCache();
  resetActiveProviderCache();
  resetD2DChatSnapshotsForTest();
  resetNudges();
  resetSupplierNameCache();
  resetOfferedCatalogCacheForTest();
  resetPendingPreflights();
}

function tag(did: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`dina:signed_out:${did}`)));
}

/** Sign out: remember whose rows these are. */
export async function rememberSignedOutIdentity(did: string): Promise<void> {
  await Keychain.setGenericPassword(USERNAME, tag(did), { service: SIGNED_OUT_SERVICE });
}

/**
 * Onboarding, once the DID is known and before anything for it is written:
 * rows left by a different identity go, and the owner's own stay.
 */
export async function settleSignedOutIdentity(did: string): Promise<void> {
  const row = await Keychain.getGenericPassword({ service: SIGNED_OUT_SERVICE });
  if (row === false) return;
  if (row.password !== tag(did)) {
    for (const service of OWNER_ROWS) {
      await Keychain.resetGenericPassword({ service });
    }
    clearUserPreferencesCache();
  }
  await Keychain.resetGenericPassword({ service: SIGNED_OUT_SERVICE });
}
