/**
 * `GET /web/*` — serves the React Native Web SPA bundle produced by
 * `npx expo export --platform web` in `apps/mobile/`. The bundle lives
 * at `apps/home-node-lite/web/dist/` (a sibling of brain-server).
 *
 * Opt-in via `DINA_BRAIN_WEB_UI=1` — same gate philosophy as `/dev`,
 * so production deployments don't accidentally expose the SPA to the
 * public listener.
 *
 * Two route surfaces in one plugin:
 *   1. `/web/<file>`         → static file under `dist/<file>` if it exists
 *   2. anything else         → `dist/index.html` (SPA deep-link fallback)
 *
 * SPA fallback is required because Expo Router emits client-side routes
 * (`/onboarding/welcome`, `/(tabs)/chat`, …) that don't correspond to
 * files on disk. Without a fallback, deep-linking a tab URL would 404.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 1 "Build pipeline".
 */

import fs from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterWebRoutesOptions {
  /** Absolute path to the directory containing `index.html` + `_expo/`. */
  bundleDir: string;
  /** URL prefix the SPA is mounted under. Defaults to `/web`. */
  urlPrefix?: string;
}

export interface RegisterWebRoutesResult {
  /** Resolved bundle directory used by the plugin. */
  bundleDir: string;
  /** URL prefix actually registered (always ends in `/`). */
  urlPrefix: string;
}

/** The HTML shell loads bundle assets whose names contain content
 *  hashes — those bust caches on their own. The shell itself must
 *  re-validate on every navigation so a deploy lands without users
 *  having to hard-reload. */
const SPA_HTML_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache, must-revalidate',
};

export async function registerWebRoutes(
  app: FastifyInstance,
  opts: RegisterWebRoutesOptions,
): Promise<RegisterWebRoutesResult> {
  const bundleDir = path.resolve(opts.bundleDir);
  const indexHtmlPath = path.join(bundleDir, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(
      `registerWebRoutes: index.html not found at ${indexHtmlPath}. ` +
        `Run 'npx expo export --platform web --output-dir ${bundleDir}' first.`,
    );
  }

  const rawPrefix = opts.urlPrefix ?? '/web';
  const urlPrefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;

  // fastify-static gives us:
  //   - `reply.sendFile(<relative path>)` for properly typed responses
  //     (content-type, last-modified, etag, conditional GET).
  //   - Path-traversal protection inside `reply.sendFile`.
  // We register with `serve: false` so fastify-static does NOT auto-
  // expose every file in `bundleDir`. Instead we delegate from our
  // single SPA wildcard route below, which lets us interleave the
  // deep-link fallback with the file-serving path inside one handler.
  await app.register(fastifyStatic, {
    root: bundleDir,
    prefix: urlPrefix,
    serve: false,
    decorateReply: true,
  });

  app.get(`${urlPrefix}*`, async (req: FastifyRequest, reply: FastifyReply) => {
    const wildcard = readWildcard(req);
    const relPath = wildcard.replace(/^\/+/, '');

    // Root request → SPA shell. We never let `reply.sendFile('')`
    // wander into directory-index behaviour.
    if (relPath === '' || relPath === 'index.html') {
      return sendIndex(reply, indexHtmlPath);
    }

    const candidatePath = path.resolve(bundleDir, relPath);
    // `path.resolve` collapses `..`, so any escape attempt resolves
    // outside `bundleDir`. We treat that as "not a real asset" and
    // hand back the SPA shell — the client-side router will then
    // surface a 404 view if the path is genuinely unknown.
    if (
      !candidatePath.startsWith(`${bundleDir}${path.sep}`) ||
      !fs.existsSync(candidatePath) ||
      !fs.statSync(candidatePath).isFile()
    ) {
      return sendIndex(reply, indexHtmlPath);
    }

    return reply.sendFile(relPath);
  });

  return { bundleDir, urlPrefix };
}

function readWildcard(req: FastifyRequest): string {
  const params = req.params as { '*'?: unknown } | undefined;
  return typeof params?.['*'] === 'string' ? params['*'] : '';
}

function sendIndex(reply: FastifyReply, indexHtmlPath: string): FastifyReply {
  for (const [k, v] of Object.entries(SPA_HTML_HEADERS)) {
    reply.header(k, v);
  }
  return reply.send(fs.createReadStream(indexHtmlPath));
}
