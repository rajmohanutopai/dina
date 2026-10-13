/**
 * Tell Core the owner's time zone (REAL_LIFE_FIXES_2 §0). Every date Dina
 * shows or reasons about uses it; a server's own zone is often UTC. The phone
 * sends it at boot, the browser when it connects as the owner's device. A
 * failure is harmless: Core falls back to the host's zone.
 */

import { getOwnerDispatcher } from './owner_dispatcher';

export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : null;
  } catch {
    return null;
  }
}

export async function syncOwnerTimeZone(): Promise<void> {
  const dispatcher = getOwnerDispatcher();
  const timezone = deviceTimeZone();
  if (dispatcher === null || timezone === null) return;
  try {
    await dispatcher.dispatch({ method: 'PUT', path: '/v1/settings/owner-timezone', body: { timezone } });
  } catch {
    /* Core keeps the host's zone */
  }
}
