/**
 * Vault items hook — UI-friendly listing + delete for the Vault detail
 * screen.
 *
 * Wraps Core's `browseRecent` (returns the most-recent N items in a
 * persona) + `deleteItem` (soft-delete: sets `deleted = 1` so audit
 * trail survives). The hook is sync — vault repos are sync under the
 * hood — so the screen can re-render immediately after a delete
 * without an awkward async dance.
 *
 * Production data flow:
 *   /remember → staging.ingest → drain tick → storeItem(persona, …)
 *     → SQLiteVaultRepository write → this hook surfaces it on next
 *       `useVaultItems(persona)` call.
 *
 * Note: this hook intentionally does NOT subscribe to vault changes.
 * The Vaults screen re-fetches on focus (via `useFocusEffect` in the
 * caller) and after every delete. That's enough for the current UX
 * (no real-time updates needed) and avoids wiring a vault-event bus.
 */

import {
  browseRecent,
  deleteItem,
  vaultItemCount,
} from '@dina/core';
import type { VaultItem } from '@dina/test-harness';

export interface VaultItemUI {
  id: string;
  /** Display headline — `content_l0 || summary` so renders never go blank. */
  headline: string;
  /** Body text — first ~200 chars of the actual body. */
  bodyPreview: string;
  /** Original item type (note, email, calendar_event, …). */
  type: string;
  /** Where it came from (staging source: user_remember, gmail, d2d, …). */
  source: string;
  /** Original event timestamp (ms). */
  timestamp: number;
  /** When the row landed in the vault (ms). */
  createdAt: number;
}

const DEFAULT_LIMIT = 100;
const FAR_FUTURE = 8_640_000_000_000_000; // browseRecent's `before` upper bound
const PREVIEW_CHARS = 200;

/**
 * List the most-recent items in a persona's vault. Newest first. Up
 * to `limit` items. Throws if the persona's repo isn't wired (strict
 * `requireRepo` — production calls `openPersonaDB` at unlock).
 */
export function listVaultItemsUI(persona: string, limit: number = DEFAULT_LIMIT): VaultItemUI[] {
  const items = browseRecent(persona, 0, FAR_FUTURE, limit);
  return items.map(toUI);
}

/**
 * Soft-delete a vault item by id. Returns `true` if the row existed
 * + was marked deleted, `false` if the id was unknown.
 */
export function deleteVaultItem(persona: string, itemId: string): boolean {
  return deleteItem(persona, itemId);
}

/**
 * Total item count for a persona's vault. Fast — wraps the repo's
 * `valuesSync().length`. Used on the index screen to show "12 items"
 * next to each vault.
 */
export function countVaultItems(persona: string): number {
  return vaultItemCount(persona);
}

function toUI(item: VaultItem): VaultItemUI {
  const headline = item.content_l0 || item.summary || '(no summary)';
  const bodyRaw = item.body ?? '';
  const bodyPreview =
    bodyRaw.length > PREVIEW_CHARS ? bodyRaw.slice(0, PREVIEW_CHARS).trimEnd() + '…' : bodyRaw;
  return {
    id: item.id,
    headline,
    bodyPreview,
    type: item.type,
    source: item.source,
    timestamp: item.timestamp,
    createdAt: item.created_at,
  };
}
