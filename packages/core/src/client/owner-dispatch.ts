/**
 * WEB_OWNER_SURFACE_PLAN §3.6 — how an owner client reaches Core.
 *
 * Every owner client (commerce, coordination, runs and watches, devices,
 * plugins) needs exactly one thing: send a request AS THE OWNER. How depends
 * on where the interface runs, and the clients know neither way:
 *
 *   - On the phone the owner is the in-app user. The request goes straight
 *     into the router, stamped with the two-part owner marker
 *     (`trustedInProcess` skips the network pipeline; the unforgeable
 *     `ownerCapability` is what the route guard verifies). Brain shares the VM
 *     but never holds this dispatcher or the capability it closes over.
 *   - In a browser the request is signed by the owner device (a key the page
 *     cannot read) and sent to Core's own origin, where the host verifies the
 *     signature and stamps the same marker. No reusable secret is sent.
 *
 * So a client is written once against `OwnerDispatcher`, and the platform
 * picks the dispatcher.
 */

import { signRequestWith, type RequestSigner } from '../auth/canonical';

import type { CoreResponse, CoreRouter } from '../server/router';

export type OwnerMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** What an owner client asks for: a route, and nothing about who is asking. */
export interface OwnerRequest {
  method: OwnerMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface OwnerDispatcher {
  dispatch(req: OwnerRequest): Promise<CoreResponse>;
}

/** The phone's dispatcher: into the router, as the owner. */
export function inProcessOwnerDispatcher(
  router: CoreRouter,
  ownerCapability: string,
): OwnerDispatcher {
  return {
    dispatch: (req) =>
      router.handle({
        method: req.method,
        path: req.path,
        query: req.query ?? {},
        headers: {},
        body: req.body,
        rawBody: new Uint8Array(),
        params: {},
        trustedInProcess: true,
        callerType: 'owner',
        ownerCapability,
      }),
  };
}

export interface HttpOwnerDispatcherOptions {
  /** Core's origin as the page reaches it, e.g. `''` (same origin) or `http://127.0.0.1:8100`. */
  baseUrl: string;
  /** The owner device. */
  signer: RequestSigner;
  /** Injected for tests and non-browser hosts; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * The browser's dispatcher: a signed request to Core's own origin.
 *
 * The query string is serialised the way Core re-serialises a parsed query
 * before verifying (`encodeURIComponent(key)=encodeURIComponent(value)`,
 * joined by `&`, in insertion order), and the body is sent as exactly the
 * bytes that were signed, so what Core hashes is what the device signed.
 */
export class HttpOwnerDispatcher implements OwnerDispatcher {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpOwnerDispatcherOptions) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async dispatch(req: OwnerRequest): Promise<CoreResponse> {
    const query = serializeQuery(req.query ?? {});
    const bodyText = req.body === undefined ? '' : JSON.stringify(req.body);
    const signed = await signRequestWith(
      req.method,
      req.path,
      query,
      new TextEncoder().encode(bodyText),
      this.options.signer,
    );
    const res = await this.fetchFn(
      `${this.options.baseUrl}${req.path}${query === '' ? '' : `?${query}`}`,
      {
        method: req.method,
        headers: {
          ...signed,
          ...(bodyText === '' ? {} : { 'content-type': 'application/json' }),
        },
        ...(bodyText === '' ? {} : { body: bodyText }),
        // No cookies, and no HTTP cache: a signed GET must never be answered
        // from a stale cached copy. (`cache` is a browser `RequestInit` field
        // the Node type library omits, hence the widened type.)
        credentials: 'omit',
        cache: 'no-store',
      } as RequestInit & { cache: 'no-store' },
    );
    const text = await res.text();
    return { status: res.status, body: parseBody(text) };
  }
}

function serializeQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
