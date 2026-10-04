/**
 * Core's calls to Brain carry Core's signature (docs/A2A_GATEWAY_ARCHITECTURE.md
 * §4.1, plan §3.18). Brain listens on loopback, and loopback is not an
 * identity, so Brain serves no unsigned caller: each request Core sends it
 * is signed with Core's service key (`m/9999'/3'/0'`) over Dina's canonical
 * payload (method, path, query, time, nonce, the body's hash). Brain learns
 * the key's DID from Core (`GET /v1/brain/callers`).
 */

import { signRequest } from '@dina/core';

export interface CoreServiceKey {
  did: string;
  privateKey: Uint8Array;
}

/** The bytes of a request body as sent. Core sends Brain JSON text only. */
function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new TypeError('signed Brain fetch: a request body must be a string');
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  return out;
}

/** A `fetch` that signs every request it sends with Core's service key. */
export function createSignedBrainFetch(
  key: CoreServiceKey,
  base: typeof fetch = fetch,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (input instanceof Request)
      throw new TypeError('signed Brain fetch: pass a URL, not a Request');
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const signed = signRequest(
      method,
      url.pathname,
      url.search.slice(1),
      bodyBytes(init.body),
      key.privateKey,
      key.did,
    );
    return base(url, { ...init, method, headers: { ...headerRecord(init.headers), ...signed } });
  }) as typeof fetch;
}
