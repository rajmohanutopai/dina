/**
 * Web access gate (web thin-client design D4).
 *
 * The brain-server's `/api/v1/*` surface is the SPA's data plane: it reads
 * + writes the vault, lists approvals, etc. Binding to `127.0.0.1` is NOT
 * a security boundary on its own — any other local process, or any web
 * page the user visits (cross-origin → loopback), can reach it. The gate
 * closes both holes with a per-process **session cookie**:
 *
 *   - The brain mints a crypto-random secret once at boot and prints a
 *     tokenised URL (`…/web/?token=<secret>`) to the **server console**.
 *     That console is the OUT-OF-BAND channel: only the operator who started
 *     the node sees it. (Jupyter's notebook-token model.)
 *   - The operator opens that URL. The gate validates the token, sets an
 *     `HttpOnly; SameSite=Strict` session cookie, and 302-redirects to the
 *     clean `/web/` URL (stripping the token from history/referrer). The
 *     browser now carries the cookie on BOTH `fetch` and `EventSource`, so
 *     the SPA + SSE work with ZERO client changes.
 *   - Every `/api/v1/*` request must carry that cookie; otherwise 401.
 *
 * Why the cookie is NEVER handed to an arbitrary `/web` visitor (the bug this
 * fixes): if the gate `Set-Cookie`'d the secret to anyone who GETs `/web/*`,
 * a local process could `curl /web/index.html`, read the secret from the
 * `Set-Cookie` response header, and replay it — defeating the whole point. So
 * an unauthenticated `/web` request (no cookie, no valid token) gets **401, no
 * cookie** — it must come in through the tokenised URL.
 *
 * Why this is sufficient here:
 *   - **Other local processes** (non-browser) never saw the console token and
 *     are never handed the cookie → 401.
 *   - **CSRF / cross-origin pages**: `SameSite=Strict` means the cookie is
 *     never sent on a cross-site request, so a malicious page hitting
 *     `127.0.0.1:<brain>` can't authenticate → 401. (On loopback there are
 *     no sibling same-site origins, so the cookie alone is the CSRF defense
 *     for state-changing routes — no separate CSRF token needed.)
 *   - **XSS exfiltration**: `HttpOnly` keeps the secret out of JS.
 *
 * Dev/test escape: `DINA_BRAIN_DEV_OPEN=1` disables the gate entirely
 * (the design's explicit unauthenticated mode). The shipped default is
 * gated. This is orthogonal to the existing non-loopback bind guard,
 * which stays as defense-in-depth.
 *
 * No `Secure` attribute: the loopback default is http; a real https
 * deployment behind a proxy should add it (and would also front the gate
 * with the proxy's own auth via `DINA_BRAIN_ALLOW_NONLOOPBACK`).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

/** Cookie name carrying the per-process web-session secret. */
export const WEB_SESSION_COOKIE = 'dina_web_session';

export interface WebAccessGate {
  /** The per-process session secret (the cookie value). */
  readonly secret: string;
  /** Whether the gate is disabled (DINA_BRAIN_DEV_OPEN=1). */
  readonly devOpen: boolean;
  /**
   * Fastify `onRequest` hook. Sets the cookie on `/web/*` loads and
   * enforces it on `/api/v1/*`. Ungated paths (healthz/readyz/etc.) pass
   * through untouched.
   */
  onRequest(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export interface WebAccessGateOptions {
  /** Disable the gate (maps to DINA_BRAIN_DEV_OPEN=1). Default false. */
  devOpen?: boolean;
  /** Inject a fixed secret (tests). Default = crypto-random 32-byte hex. */
  secret?: string;
  /** API prefix to guard. Default `/api/v1`. */
  apiPrefix?: string;
  /** Web-bundle URL prefix that issues the cookie. Default `/web`. */
  webPrefix?: string;
}

/** Extract a single cookie value from a `Cookie` header, or null. */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === '') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Constant-time string compare (length-safe). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Read a query parameter from a raw URL, or null. */
function queryParam(url: string, name: string): string | null {
  const q = url.indexOf('?');
  if (q === -1) return null;
  return new URLSearchParams(url.slice(q + 1)).get(name);
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function createWebAccessGate(opts: WebAccessGateOptions = {}): WebAccessGate {
  const secret = opts.secret ?? randomBytes(32).toString('hex');
  const devOpen = opts.devOpen === true;
  const apiPrefix = opts.apiPrefix ?? '/api/v1';
  const webPrefix = opts.webPrefix ?? '/web';
  const cookieAttrs = 'Path=/; HttpOnly; SameSite=Strict';

  return {
    secret,
    devOpen,
    async onRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      if (devOpen) return;
      const path = pathOf(req.url);

      // Web bundle. The cookie is issued ONLY to a caller that proves
      // possession of the out-of-band token (printed to the server console at
      // boot) — never to an arbitrary visitor, or a local process could read
      // the secret straight off the `Set-Cookie` response header and replay it.
      if (underPrefix(path, webPrefix)) {
        const have = parseCookie(req.headers.cookie, WEB_SESSION_COOKIE);
        if (have !== null && constantTimeEqual(have, secret)) {
          return; // already authenticated → serve the bundle + its assets
        }
        const token = queryParam(req.url, 'token');
        if (token !== null && constantTimeEqual(token, secret)) {
          // Valid token → mint the session cookie, then 302 to the clean URL so
          // the token never lingers in the address bar / history / referrer.
          await reply
            .header('set-cookie', `${WEB_SESSION_COOKIE}=${secret}; ${cookieAttrs}`)
            .header('location', path)
            .code(302)
            .send();
          return;
        }
        // No cookie + no valid token → refuse. Crucially: do NOT set the cookie
        // and do NOT serve the bundle. The operator opens the tokenised URL.
        await reply
          .code(401)
          .type('text/plain; charset=utf-8')
          .send(
            'Dina web session required. Open the tokenised URL ' +
              '(http://127.0.0.1:<port>/web/?token=…) printed in your Home Node ' +
              'server console.',
          );
        return;
      }

      // Enforce the cookie on the data plane.
      if (underPrefix(path, apiPrefix)) {
        const have = parseCookie(req.headers.cookie, WEB_SESSION_COOKIE);
        if (have === null || !constantTimeEqual(have, secret)) {
          await reply.code(401).send({ error: 'web session required' });
        }
        return;
      }

      // healthz / readyz / dev / everything else — ungated.
    },
  };
}
