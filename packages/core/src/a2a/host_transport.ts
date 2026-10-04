/**
 * The outbound connection port for A2A Lane 1 (design §6.6). Core decides
 * what may be fetched and how much may come back; the host owns the socket.
 * Core never opens a connection itself: the server host installs a transport
 * that resolves the name first, refuses any private, loopback or link-local
 * answer, connects to the vetted address with TLS validated against the
 * original name, follows no redirects, and enforces the caps passed here. A
 * host that cannot resolve before connecting installs nothing, and Lane 1
 * does not run there (design §1.3, plan D6).
 */

import { checkOutboundUrl, type OutboundUrlCheck } from '@dina/a2a';


export type A2ATransportError =
  /** The URL fails Core's policy; nothing was resolved or sent. */
  | 'url_refused'
  /** The name did not resolve. */
  | 'dns_failed'
  /** A resolved (or connected) address is private, loopback, link-local or otherwise blocked. */
  | 'address_blocked'
  | 'connect_failed'
  | 'tls_failed'
  | 'timeout'
  /** The response passed its byte cap. */
  | 'too_large'
  /** A 3xx: redirects are never followed. */
  | 'redirect_refused'
  /** Not JSON, or compressed. */
  | 'bad_content_type'
  /** The body is not valid UTF-8. */
  | 'bad_encoding'
  | 'io_error'
  /** No transport installed on this host. */
  | 'unavailable';

export interface A2AHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  /** Extra headers (`A2A-Version`, a credential's header). Host, length and media types are the transport's. */
  headers: Readonly<Record<string, string>>;
  /** The body of a POST: JSON text, or a form for an OAuth token request. */
  body?: string;
  /** The body's media type; JSON when absent. A webhook push is `application/a2a+json` (A2A §4.3.3). */
  contentType?: 'application/json' | 'application/a2a+json' | 'application/x-www-form-urlencoded';
  /**
   * What the caller reads of the answer. `json` (the default): the body,
   * which must be JSON within `maxResponseBytes`. `status`: the status
   * code only; the body is never read (a webhook's answer is discarded,
   * design §6.6), and `body` comes back empty.
   */
  response?: 'json' | 'status';
  maxResponseBytes: number;
  timeoutMs: number;
}

export type A2AHttpResult =
  | { ok: true; status: number; body: string; connectedAddress: string }
  | {
      ok: false;
      error: A2ATransportError;
      /**
       * Whether any request byte may have reached the remote. False only when
       * the failure came before the TLS handshake finished (resolution, the
       * address check, connect, the handshake), so a POST that failed with
       * `sent: false` certainly did not run remotely.
       */
      sent: boolean;
    };

export type A2AHostTransport = (request: A2AHttpRequest) => Promise<A2AHttpResult>;

/** Caps and timeouts per call kind (design §6.6). */
export const A2A_FETCH_LIMITS = Object.freeze({
  card: { maxResponseBytes: 128 * 1024, timeoutMs: 10_000 },
  keySet: { maxResponseBytes: 64 * 1024, timeoutMs: 10_000 },
  rpc: { maxResponseBytes: 256 * 1024, timeoutMs: 30_000 },
  /** An OAuth token endpoint's answer (design §5.3). */
  token: { maxResponseBytes: 32 * 1024, timeoutMs: 10_000 },
  /** A webhook push (A2A §4.3.3, 10–30 s recommended): the answer's status only. */
  webhook: { maxResponseBytes: 0, timeoutMs: 10_000 },
});

// The URL rule is @dina/a2a's, shared with Brain's directory candidates.
export { checkOutboundUrl, type OutboundUrlCheck };

let installed: A2AHostTransport | null = null;

export function setA2AHostTransport(transport: A2AHostTransport | null): void {
  installed = transport;
}

export function getA2AHostTransport(): A2AHostTransport | null {
  return installed;
}

/**
 * Fetch under the policy: Core's URL check first, then the installed host
 * transport. With no transport installed the answer is `unavailable`.
 *
 * Core holds the deadline itself: callers size claim leases on `timeoutMs`
 * (the dispatch runner), so a transport that overruns it answers `timeout`
 * here, as possibly sent, whatever it does later.
 */
export async function a2aFetch(request: A2AHttpRequest): Promise<A2AHttpResult> {
  const check = checkOutboundUrl(request.url);
  if (!check.ok) return { ok: false, error: 'url_refused', sent: false };
  const transport = installed;
  if (transport === null) return { ok: false, error: 'unavailable', sent: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<A2AHttpResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timeout', sent: true }), request.timeoutMs);
  });
  try {
    return await Promise.race([
      transport(request).catch(
        // A transport that throws reports nothing it can vouch for; assume bytes left.
        (): A2AHttpResult => ({ ok: false, error: 'io_error', sent: true }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
