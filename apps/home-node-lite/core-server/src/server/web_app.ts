/**
 * WEB_OWNER_SURFACE_PLAN §3.2 — Core serves the web app.
 *
 * The same bundle the phone app compiles to (`npx expo export --platform
 * web`) is served from CORE's origin at `/app/`, so the owner's device key and
 * the owner routes share an origin and nothing owner-related is ever on a page
 * Brain serves. Opt-in (`DINA_CORE_WEB_UI=1`), off by default like every
 * other served UI: Core is the vault keeper and serves HTML only when an
 * operator asks.
 *
 * Headers are as strict as the old owner console's where it counts: the page
 * runs only its own scripts (`script-src 'self'`, no inline, no JS eval), cannot
 * be framed, and loads no plugins. The page reaches Brain cross-origin and
 * never through Core (§3.4), so nothing Brain returns can become a page on
 * this origin.
 *
 * `/app/runtime-config.json` tells the page two things: that Core served it
 * (so it may offer "connect this browser as the owner"), and where Brain is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import fastifyStatic from '@fastify/static';

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawServerDefault,
} from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const WEB_APP_PREFIX = '/app/';
export const RUNTIME_CONFIG_PATH = `${WEB_APP_PREFIX}runtime-config.json`;

/**
 * Where the web build writes the bundle: the sibling
 * `apps/home-node-lite/web/dist/` (`npm run -w @dina/home-node-lite-web-e2e
 * build:bundle`, the command the installer runs; it reads no `.env`, so no
 * developer key reaches the page).
 */
export const DEFAULT_WEB_BUNDLE_DIR = path.resolve(__dirname, '..', '..', '..', 'web', 'dist');

export interface RegisterWebAppOptions {
  /** Directory holding `index.html` and `_expo/` (the web export). */
  bundleDir: string;
  /** Brain's origin as the browser reaches it, e.g. `http://127.0.0.1:8200`. */
  brainOrigin: string;
}

/**
 * The content security policy for every response under `/app/`.
 *
 * `style-src 'unsafe-inline'`: React Native Web writes its generated styles
 * into `<style>` elements at run time and Expo's shell carries an inline reset
 * block. Scripts get no such allowance; styles cannot run code.
 *
 * `script-src 'wasm-unsafe-eval'`: the passphrase key derivation (Argon2id)
 * runs as WebAssembly, which the browser compiles only with this keyword. It
 * permits compiling WebAssembly modules the page itself loads; it does NOT
 * permit `eval` or `new Function` on JavaScript (that would be
 * `'unsafe-eval'`, which stays off).
 *
 * `connect-src` names Core and Brain and also allows any `https:`/`wss:`
 * origin. The web build runs its own limited node in the tab, which talks to
 * the PDS, the AppView, the relay and AI providers directly, at endpoints the
 * owner can change in Settings; a fixed list would break it. The defence
 * against injected code is `script-src 'self'`; `connect-src` only narrows
 * where already-running code may send data. Plain `http:` stays limited to
 * Core and Brain.
 */
export function webAppContentSecurityPolicy(brainOrigin: string): string {
  const connect = `'self'${brainOrigin === '' ? '' : ` ${brainOrigin}`} https: wss:`;
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Validate an operator-supplied origin: scheme + host + optional port, nothing else. */
export function parseBrainOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`web app: Brain origin must be http(s), got ${url.protocol}`);
  }
  return url.origin;
}

export async function registerWebAppRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>,
  opts: RegisterWebAppOptions,
): Promise<void> {
  const bundleDir = path.resolve(opts.bundleDir);
  const indexHtmlPath = path.join(bundleDir, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(
      `web app: index.html not found at ${indexHtmlPath}. ` +
        `Build it first: npm run -w @dina/home-node-lite-web-e2e build:bundle`,
    );
  }
  const policy = webAppContentSecurityPolicy(opts.brainOrigin);
  const secure = (reply: FastifyReply): FastifyReply =>
    reply
      .header('content-security-policy', policy)
      .header('x-frame-options', 'DENY')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');

  // `serve: false`: nothing is exposed automatically; the one route below
  // decides what is a file and what gets the SPA shell.
  await app.register(fastifyStatic, {
    root: bundleDir,
    prefix: WEB_APP_PREFIX,
    serve: false,
    decorateReply: true,
  });

  app.get(RUNTIME_CONFIG_PATH, async (_req, reply) =>
    secure(reply)
      .header('cache-control', 'no-store')
      .header('content-type', 'application/json; charset=utf-8')
      .send({ served_by: 'core', brain_url: opts.brainOrigin }),
  );

  app.get(`${WEB_APP_PREFIX}*`, async (req: FastifyRequest, reply: FastifyReply) => {
    const relPath = readWildcard(req).replace(/^\/+/, '');
    secure(reply);
    if (relPath === '' || relPath === 'index.html') return sendIndex(reply, indexHtmlPath);
    const candidate = path.resolve(bundleDir, relPath);
    // `path.resolve` collapses `..`; anything outside the bundle, or not a
    // file, gets the shell and the client router shows its own not-found.
    if (
      !candidate.startsWith(`${bundleDir}${path.sep}`) ||
      !fs.existsSync(candidate) ||
      !fs.statSync(candidate).isFile()
    ) {
      return sendIndex(reply, indexHtmlPath);
    }
    return reply.sendFile(relPath);
  });
}

function readWildcard(req: FastifyRequest): string {
  const params = req.params as { '*'?: unknown } | undefined;
  return typeof params?.['*'] === 'string' ? params['*'] : '';
}

function sendIndex(reply: FastifyReply, indexHtmlPath: string): FastifyReply {
  // The shell revalidates on every navigation so a deploy lands without a
  // hard reload; assets carry content hashes and cache on their own.
  return reply
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-cache, must-revalidate')
    .send(fs.createReadStream(indexHtmlPath));
}
