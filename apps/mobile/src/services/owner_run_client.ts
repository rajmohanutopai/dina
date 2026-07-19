/**
 * The owner-only run/watch control client, held at the MOBILE APP edge (§12.5).
 *
 * SECURITY (R2-08): this singleton must NOT live in `@dina/core`. Brain (the
 * untrusted tenant) imports `@dina/core` on the shared mobile JS VM, so a
 * core-level `getOwnerRunClient()` would hand Brain a dispatcher that stamps
 * `callerType: 'owner'` — defeating the owner boundary the `/v1/run/*` guards
 * enforce. Holding the instance here, in app-only code that `@dina/brain` cannot
 * import, keeps the owner capability at the trusted UI edge. (The
 * `InProcessOwnerRunClient` class stays in core, but constructing it needs the
 * raw `CoreRouter`, which Brain never receives — it only gets a `CoreClient`.)
 */

import type { OwnerRunClient } from '@dina/core';

let ownerRunClient: OwnerRunClient | null = null;

/** Boot installs the owner client after building the router. */
export function setOwnerRunClient(c: OwnerRunClient | null): void {
  ownerRunClient = c;
}

/** The owner UI hooks resolve it lazily. */
export function getOwnerRunClient(): OwnerRunClient | null {
  return ownerRunClient;
}
