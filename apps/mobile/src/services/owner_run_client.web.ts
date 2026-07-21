/**
 * The owner-only run/watch control client — WEB (round-C C-03, §12.5).
 *
 * SECURITY: a page SERVED BY BRAIN can never safely hold the owner capability —
 * Brain's JavaScript runs in that page, so any prompt/storage/request the page
 * makes exposes the reusable bearer to the untrusted Brain process (which could
 * then originate owner commands against Core directly). So the Brain-served web
 * SPA has NO owner client: `getOwnerRunClient()` returns null (unless a trusted
 * edge explicitly installs one), and the run/watch UI directs the operator to
 * the credential-safe surface — Core's own `/owner` console (served by
 * core-server, same-origin to Core, `DINA_CORE_OWNER_CONSOLE=1`), where the
 * capability never touches Brain.
 *
 * (Round-A shipped a Brain-origin HTTP client here; round-C removed it — even
 * with the Brain owner proxy disabled it still prompted for and stored the
 * capability under Brain's origin, defeating the "capability never transits
 * Brain" guarantee. See apps/home-node-lite/web/SECURITY.md.)
 */

import type { OwnerRunClient } from '@dina/core';

const LEGACY_STORAGE_KEY = 'dina.owner_capability';

// One-time migration: purge any owner capability a prior build stored under
// Brain's origin, so an upgraded operator isn't left with a bearer sitting in
// Brain-origin sessionStorage.
try {
  window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
} catch {
  /* no storage (SSR / test harness) — nothing to purge */
}

let ownerRunClient: OwnerRunClient | null = null;

/** A trusted UI edge MAY install a client; the web default is none. */
export function setOwnerRunClient(c: OwnerRunClient | null): void {
  ownerRunClient = c;
}

/** The owner UI hooks resolve it lazily. Null on the Brain-served web SPA —
 *  owner control lives on Core's `/owner` console, never on a Brain page. */
export function getOwnerRunClient(): OwnerRunClient | null {
  return ownerRunClient;
}
