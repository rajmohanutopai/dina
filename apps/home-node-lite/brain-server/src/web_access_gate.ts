/**
 * Web access gate (web thin-client design D4).
 *
 * The brain-server's `/api/v1/*` surface is the SPA's data plane: it reads
 * + writes the vault, lists approvals, etc. Binding to `127.0.0.1` is NOT
 * a security boundary on its own — any other local process, or any web
 * page the user visits (cross-origin → loopback), can reach it. The gate
 * closes both holes with a per-process **session cookie**:
 *
 *   - The brain mints a crypto-random secret once at boot and sets it as
 *     an `HttpOnly; SameSite=Strict` cookie when it serves the SPA bundle
 *     (`/web/*`). Browsers auto-attach a same-origin cookie to BOTH
 *     `fetch` and `EventSource`, so the SPA + the SSE reminder stream work
 *     with ZERO client changes.
 *   - Every `/api/v1/*` request must carry that cookie; otherwise 401.
 *
 * Why this is sufficient here:
 *   - **Other local processes** (non-browser) don't have the cookie → 401.
 *   - **CSRF / cross-origin pages**: `SameSite=Strict` means the cookie is
 *     never sent on a cross-site request, so a malicious page hitting
 *     `127.0.0.1:<brain>` can't authenticate → 401. (On loopback there are
 *     no sibling same-site origins, so the cookie alone is the CSRF
 *     defense — no separate CSRF token needed.)
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

      // Issue the cookie when the SPA bundle is served, so the SPA's
      // subsequent same-origin /api/v1 calls carry it.
      if (underPrefix(path, webPrefix)) {
        const have = parseCookie(req.headers.cookie, WEB_SESSION_COOKIE);
        if (have === null || !constantTimeEqual(have, secret)) {
          void reply.header('set-cookie', `${WEB_SESSION_COOKIE}=${secret}; ${cookieAttrs}`);
        }
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
