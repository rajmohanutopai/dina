/**
 * WEB_OWNER_SURFACE_PLAN §3.4 — the Core-served page reaches Brain
 * cross-origin.
 *
 * The web app lives on CORE's origin (beside the owner device) and calls
 * Brain's `/api/*` directly, never through Core, so nothing Brain answers can
 * become a page on Core's origin. Browsers allow that only when Brain names
 * the page's origin in CORS. This module names exactly the origins the
 * operator lists in `DINA_BRAIN_WEB_ORIGIN` (comma-separated, e.g.
 * `http://127.0.0.1:8100,http://localhost:8100`), and nothing else:
 *
 *   - only `/api/*`, the data the app reads; `/healthz`, `/readyz` and every
 *     other path stay same-origin;
 *   - no credentials (Brain has no cookies or sessions to share);
 *   - no wildcard, no pattern: an origin is scheme, host and port, exactly.
 *
 * Unset means no CORS at all, as before. Brain stays loopback-bound and
 * behind the Host allowlist (host_guard.ts); CORS only lets the one page
 * read the answers.
 *
 * CORS alone does not stop a WRITE: a page on any site can send a "simple"
 * request (a form post, `fetch(..., {mode: 'no-cors'})`) that needs no
 * preflight, and the handler runs even though the page never reads the
 * answer. So `registerOriginGuard` refuses, before any handler, every request
 * whose `Origin` is neither a listed web origin nor Brain's own origin (the
 * same-origin `/dev` page). A request with no `Origin` (Core, the CLI, curl)
 * is not a browser page and passes, as before.
 */

import cors from '@fastify/cors';

import type { FastifyInstance, FastifyRequest } from 'fastify';

export const WEB_ORIGIN_ENV = 'DINA_BRAIN_WEB_ORIGIN';

/** The paths a listed origin may read. */
const CORS_PATH_PREFIX = '/api/';

/**
 * Parse `DINA_BRAIN_WEB_ORIGIN`. Each entry must be a bare http(s) origin;
 * anything else is an operator error and fails boot rather than widening or
 * silently dropping what the operator meant.
 */
export function parseWebOrigins(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (raw ?? '').split(',').map((s) => s.trim())) {
    if (entry === '') continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${WEB_ORIGIN_ENV}: "${entry}" is not a URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${WEB_ORIGIN_ENV}: "${entry}" must be http(s)`);
    }
    // An origin has no path, query or credentials. `new URL` gives `/` for
    // a bare origin, so anything more means the operator pasted a page URL.
    if (
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error(`${WEB_ORIGIN_ENV}: "${entry}" must be an origin only (scheme, host, port)`);
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * Refuse any browser request from an origin that is neither listed nor
 * Brain's own. Registered on every boot, listed origins or not: with none
 * listed, only Brain's own pages may drive it.
 */
export function registerOriginGuard(app: FastifyInstance, origins: readonly string[]): void {
  const allowed = new Set(origins);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    if (allowed.has(origin)) return;
    // Brain's own origin, as the browser names it: scheme plus the Host the
    // host guard already admitted. (Behind a TLS proxy the browser's scheme
    // is https while Brain sees http: list that origin in
    // DINA_BRAIN_WEB_ORIGIN.)
    const own = `${req.protocol}://${String(req.headers.host ?? '').toLowerCase()}`;
    if (origin.toLowerCase() === own) return;
    await reply.code(403).send({ error: 'origin_not_allowed' });
  });
}

/**
 * Allow the listed origins to read Brain's `/api/*`. A request from any other
 * origin, or for any other path, gets no CORS headers, so the browser keeps
 * the answer from the page.
 */
export async function registerWebOriginCors(
  app: FastifyInstance,
  origins: readonly string[],
): Promise<void> {
  if (origins.length === 0) return;
  const allowed = new Set(origins);
  await app.register(cors, {
    delegator: (req: FastifyRequest, callback) => {
      const origin = req.headers.origin;
      const listed =
        typeof origin === 'string' && allowed.has(origin) && req.url.startsWith(CORS_PATH_PREFIX);
      callback(
        null,
        listed
          ? {
              origin,
              methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              // The owner device signs each call (caller_auth.ts): its four
              // signature headers must survive the preflight.
              allowedHeaders: ['content-type', 'x-did', 'x-timestamp', 'x-nonce', 'x-signature'],
              credentials: false,
              maxAge: 600,
            }
          : { origin: false },
      );
    },
  });
}
