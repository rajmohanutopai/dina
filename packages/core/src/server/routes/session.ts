/**
 * Session lifecycle routes — minimal stubs for paired dina-agent.
 *
 * The Go Core implements full persona-scoped sessions: when an agent
 * starts a session it pins a persona for the lifetime of any work
 * claimed under that session, and `/v1/session/end` releases the pin.
 * The TS Core hasn't ported the persona-pinning yet, so these
 * endpoints accept the lifecycle calls but treat them as no-ops —
 * paired agents can claim/heartbeat/complete tasks without the route
 * surfacing 404 on every claim.
 *
 * Wire-compatible with `dina-agent` so the daemon's openclaw flow:
 *   POST /v1/session/start  → { session_id }
 *   POST /v1/session/end    → { ok: true }
 * doesn't fail-task on missing routes.
 *
 * Auth: open to `agent`, `brain`, `admin` (see `auth/authz.ts`).
 */

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

export function registerSessionRoutes(router: CoreRouter): void {
  router.post('/v1/session/start', async (_req: CoreRequest): Promise<CoreResponse> => {
    const sessionId = `sess-${bytesToHex(randomBytes(8))}`;
    return {
      status: 200,
      body: { session_id: sessionId, status: 'open' },
    };
  });

  router.post('/v1/session/end', async (_req: CoreRequest): Promise<CoreResponse> => {
    return {
      status: 200,
      body: { ok: true },
    };
  });
}
