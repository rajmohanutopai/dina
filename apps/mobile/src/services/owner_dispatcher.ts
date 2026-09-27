/**
 * The owner dispatcher, held at the MOBILE APP edge (WEB_OWNER_SURFACE_PLAN
 * §3.6). Every owner client (commerce, coordination, runs and watches) is
 * built over it, so the platform decides once how a request becomes the
 * owner's and the clients never know.
 *
 * On the phone it is the in-process dispatcher boot builds from the raw
 * `CoreRouter` and the boot-minted owner capability. SECURITY (R2-08): it
 * must NOT live in `@dina/core`, which Brain imports on this shared JS VM; a
 * core-level getter would hand Brain a dispatch Core admits as the owner.
 * Holding it here, in app-only code `@dina/brain` cannot import, keeps the
 * owner capability at the trusted UI edge. The browser build has its own
 * version (`owner_dispatcher.web.ts`).
 */

import type { OwnerDispatcher } from '@dina/core';

let dispatcher: OwnerDispatcher | null = null;

/** Boot installs it after building the router; teardown clears it. */
export function setOwnerDispatcher(next: OwnerDispatcher | null): void {
  dispatcher = next;
}

export function getOwnerDispatcher(): OwnerDispatcher | null {
  return dispatcher;
}
