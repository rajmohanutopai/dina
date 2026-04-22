/**
 * In-process dispatch — the transport that doesn't cross a socket.
 *
 * Used by dina-mobile (RN app, no http.Server) where Brain and Core are
 * in the same JS runtime. `BrainCoreClient` takes a `signedDispatch`
 * function; when this factory's result is supplied, every HTTP call
 * becomes a direct function call into `CoreRouter.handle`. The signed
 * canonical is identical (same headers, same body) — only the wire
 * disappears.
 *
 * On the server side (MsgBox RPC handler), the same dispatch is used:
 * when an agent's signed RPC arrives over MsgBox, `handleCoreRequest`
 * is called with the unwrapped envelope. No fake Express req/res.
 */

import type { CoreRouter, CoreRequest, CoreResponse } from './router';

export type SignedDispatch = (
  method: CoreRequest['method'],
  path: string,
  headers: Record<string, string>,
  body: Uint8Array,
) => Promise<CoreResponse>;

export interface InProcessDispatchOptions {
  router: CoreRouter;
}

/**
 * Build a dispatch function that feeds requests into the router.
 *
 * The signature `(method, path, headers, body) → Promise<CoreResponse>`
 * matches what `BrainCoreClient` and MsgBox handlers already have:
 * after they produce the signed canonical + body bytes, they just call
 * dispatch() instead of fetch() or coreApp.handle().
 *
 * Query string parsing, body JSON parsing, and path/query splitting all
 * happen here so callers don't need to worry about it.
 */
export function createInProcessDispatch(options: InProcessDispatchOptions): SignedDispatch {
  const router = options.router;
  return async (method, path, headers, body) => {
    const [pathOnly, queryString] = splitPathQuery(path);
    const query = parseQuery(queryString);
    const parsedBody = tryParseBody(body, headers);
    const req: CoreRequest = {
      method,
      path: pathOnly,
      query,
      headers: lowerCaseHeaders(headers),
      body: parsedBody,
      rawBody: body,
      params: {},
    };
    return router.handle(req);
  };
}

function splitPathQuery(path: string): [string, string] {
  const i = path.indexOf('?');
  if (i < 0) return [path, ''];
  return [path.slice(0, i), path.slice(i + 1)];
}

function parseQuery(qs: string): Record<string, string> {
  if (qs === '') return {};
  const out: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      out[decodeURIComponent(pair)] = '';
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

function lowerCaseHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function tryParseBody(body: Uint8Array, headers: Record<string, string>): unknown {
  if (body.length === 0) return undefined;
  const contentType = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
  if (
    contentType.includes('application/json') ||
    contentType.includes('application/octet-stream') ||
    contentType === ''
  ) {
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      return body;
    }
  }
  return body;
}
