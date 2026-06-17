/**
 * `/api/v1/personas` routes — the SPA's persona registry + status layer.
 *
 * The browser SPA reads the persona list to render the persona switcher;
 * each entry already carries `tier` + `isOpen`, so the list alone backs
 * the switcher. The brain-server proxies to core-server through its
 * `CoreClient`. core-server owns the registry + the gatekeeper. Mobile
 * reads `listPersonas()` in-process and never hits this.
 *
 *   GET /api/v1/personas → CoreClient.personasList
 *
 * Intentionally NOT proxied here:
 *  - `personaStatus` (single-persona status) — the TS core registers no
 *    `/v1/persona/status` route, and `personasList` already returns
 *    `{ name, tier, isOpen }` per persona, so the web switcher needs
 *    nothing more. (Confirmed live: the route 404s + no web caller exists.)
 *  - `personaUnlock` (passphrase → DEK) — sending a passphrase from the
 *    browser is gated behind the web access model (design D3/D4, phase P3).
 */

import type { CoreClient } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterPersonaApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerPersonaApiRoutes(
  app: FastifyInstance,
  opts: RegisterPersonaApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/personas — the persona registry (name, tier, isOpen).
  app.get(`${prefix}/personas`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const personas = await core.personasList();
      return reply.status(200).send({ personas });
    } catch (err) {
      return reply.status(502).send({ error: asError(err) });
    }
  });
}
