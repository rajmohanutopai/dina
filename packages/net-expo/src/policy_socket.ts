/**
 * The phone's policy socket (UCP plan §3.4, U6): the `PolicySocket` contract of
 * `@dina/net-policy`, built over the native `DinaNet` module.
 *
 * React Native `fetch` cannot report or pin the connected address, so the
 * native module does two narrow things only:
 *   - `resolveHost(host)`: every A and AAAA answer from the system resolver;
 *   - `fetchPinned(request)`: one HTTP/1.1 exchange over TLS to exactly the
 *     given address, the certificate checked against the original name, no
 *     redirect followed, byte and time caps enforced while reading.
 * Every policy decision lives here, in the same classifier and rules the
 * server socket uses: refuse unsafe headers before anything else, refuse if
 * ANY answer is special-use (NAT64 answers judged by the IPv4 inside, the
 * network's prefixes found as RFC 7050 says), connect only to a vetted
 * address, check the address actually connected, refuse redirects and
 * compressed or unexpected bodies, and cap the headers.
 */

import { base64Decode, base64Encode } from '@dina/a2a';
import {
  acceptsContentType,
  bodyAllowed,
  isBlockedAddress,
  nat64PrefixesFrom,
  rawHeadersWithinLimits,
  RAW_HEADER_LIMITS,
  requestHeadersAcceptable,
  type PolicySocket,
  type PolicySocketRequest,
  type PolicySocketResult,
  type PolicyTransportError,
} from '@dina/net-policy';

/** The native request: one exchange with one vetted address. */
export interface NativePinnedRequest {
  method: PolicySocketRequest['method'];
  /** The original https URL; its host is the TLS name and the `Host` header. */
  url: string;
  /** The vetted address to connect to, and nothing else. */
  address: string;
  /** Lower-case names, in order, the socket's own headers already included. */
  headers: [string, string][];
  /** The exact body bytes, base64; null for none. */
  bodyBase64: string | null;
  minTls: PolicySocketRequest['minTls'];
  /** When false the body is not read (the answer is the status and headers). */
  readBody: boolean;
  /**
   * Whether a 401 or 403 body is read. Bodies of 3xx, 204 and 304 answers are
   * never read, nor 401/403 bodies unless this is set, so a large error page
   * can never turn a status into a transport failure.
   */
  readAuthErrorBodies: boolean;
  maxResponseBytes: number;
  maxHeaderFields: number;
  maxHeaderBytes: number;
  timeoutMs: number;
}

export type NativePinnedResult =
  | {
      ok: true;
      status: number;
      headers: [string, string][];
      bodyBase64: string;
      connectedAddress: string;
    }
  | {
      ok: false;
      error: 'connect_failed' | 'tls_failed' | 'timeout' | 'too_large' | 'io_error';
      /** False only when the failure came before the TLS handshake finished. */
      sent: boolean;
    };

export interface DinaNetNative {
  resolveHost(host: string): Promise<string[]>;
  fetchPinned(request: NativePinnedRequest): Promise<NativePinnedResult>;
}

/** Header names the socket owns; a caller cannot set them. */
const SOCKET_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept-encoding',
  'accept',
  'te',
  'upgrade',
  'if-none-match',
]);

const ACCEPT_VALUE: Record<PolicySocketRequest['accept'], string> = {
  json: 'application/json',
  'json-or-sse': 'application/json, text/event-stream',
  car: 'application/vnd.ipld.car',
  status: '*/*',
};

function failure(error: PolicyTransportError, sent: boolean): PolicySocketResult {
  return { ok: false, error, sent };
}

function headerValue(
  headers: readonly (readonly [string, string])[],
  name: string,
): string | undefined {
  const values = headers.filter(([n]) => n === name).map(([, v]) => v.trim());
  return values.length === 0 ? undefined : values.join(', ');
}

export function createNativePolicySocket(native: DinaNetNative): PolicySocket {
  return async (request: PolicySocketRequest): Promise<PolicySocketResult> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return failure('io_error', false);
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
      return failure('io_error', false);
    const host = url.hostname;
    // Refused before any lookup, so a refused request has certainly not left.
    if (!requestHeadersAcceptable(request.headers) || !bodyAllowed(request))
      return failure('io_error', false);

    const deadline = Date.now() + request.timeoutMs;
    let answers: string[];
    let ipv4only: string[];
    let resolveTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // RFC 7050: the network's NAT64 prefixes, found beside the name, so an
      // answer synthesised under a network-specific prefix is judged by the
      // IPv4 inside it. A failure here only means no prefix was found.
      [answers, ipv4only] = await Promise.race([
        Promise.all([
          native.resolveHost(host),
          native.resolveHost('ipv4only.arpa').catch(() => []),
        ]),
        new Promise<never>((_, reject) => {
          resolveTimer = setTimeout(() => reject(new Error('resolve timeout')), request.timeoutMs);
        }),
      ]);
    } catch {
      return failure('dns_failed', false);
    } finally {
      clearTimeout(resolveTimer);
    }
    if (answers.length === 0) return failure('dns_failed', false);
    const nat64Prefixes = nat64PrefixesFrom(ipv4only);
    const blocked = (a: string): boolean => isBlockedAddress(a, { nat64Prefixes });
    // One special-use answer refuses the name: a resolver that mixes a public
    // and a private answer is exactly the rebinding attack.
    if (answers.some(blocked)) return failure('address_blocked', false);
    const vetted = [...new Set(answers)];

    const headers: [string, string][] = [];
    for (const [name, value] of Object.entries(request.headers)) {
      const n = name.toLowerCase();
      if (!SOCKET_HEADERS.has(n)) headers.push([n, value]);
    }
    headers.push(['accept', ACCEPT_VALUE[request.accept]], ['accept-encoding', 'identity']);
    if (request.ifNoneMatch !== undefined) headers.push(['if-none-match', request.ifNoneMatch]);

    // Every answer was vetted; try them in order. Only a connection that never
    // opened (nothing sent) moves on to the next address, as the server socket does.
    let result: NativePinnedResult = { ok: false, error: 'connect_failed', sent: false };
    let address = vetted[0] as string;
    for (const candidate of vetted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failure('timeout', false);
      address = candidate;
      try {
        result = await native.fetchPinned({
          method: request.method,
          url: request.url,
          address,
          headers,
          bodyBase64: request.body !== undefined ? base64Encode(request.body) : null,
          minTls: request.minTls,
          readBody: request.accept !== 'status',
          readAuthErrorBodies: request.readAuthErrorBodies,
          maxResponseBytes: request.maxResponseBytes,
          maxHeaderFields: RAW_HEADER_LIMITS.maxFields,
          maxHeaderBytes: RAW_HEADER_LIMITS.maxBytes,
          timeoutMs: remaining,
        });
      } catch {
        // A native call that throws vouches for nothing: assume bytes left.
        return failure('io_error', true);
      }
      if (result.ok || result.sent || result.error !== 'connect_failed') break;
    }
    if (!result.ok) return failure(result.error, result.sent);

    // From here the request may have run remotely.
    if (result.connectedAddress !== address || blocked(result.connectedAddress)) {
      return failure('address_blocked', true);
    }
    const rawHeaders = result.headers.map(([n, v]) => [n.toLowerCase(), v] as const);
    if (!rawHeadersWithinLimits(rawHeaders)) return failure('too_large', true);

    const status = result.status;
    const notModified = status === 304 && request.ifNoneMatch !== undefined;
    if (status >= 300 && status < 400 && !notModified) return failure('redirect_refused', true);

    let bodyBytes: Uint8Array = new Uint8Array(0);
    const discardAuthBody = (status === 401 || status === 403) && !request.readAuthErrorBodies;
    // The body is used only here; encoding and media type matter only for a body that is used.
    if (request.accept !== 'status' && !notModified && status !== 204 && !discardAuthBody) {
      const encoding = headerValue(rawHeaders, 'content-encoding');
      const transfer = headerValue(rawHeaders, 'transfer-encoding');
      // A compressed body, or a transfer coding other than chunked (which the
      // native side has already removed), is not the content: refuse it.
      if (
        (encoding !== undefined && encoding.toLowerCase() !== 'identity') ||
        (transfer !== undefined && transfer.toLowerCase() !== 'chunked')
      ) {
        return failure('bad_content_type', true);
      }
      // As the server socket: the media type is checked whenever a body is read, empty or not.
      if (!acceptsContentType(request.accept, headerValue(rawHeaders, 'content-type'))) {
        return failure('bad_content_type', true);
      }
      const decoded = base64Decode(result.bodyBase64);
      if (decoded === null) return failure('io_error', true);
      if (decoded.length > request.maxResponseBytes) return failure('too_large', true);
      bodyBytes = decoded;
    }
    return { ok: true, status, bodyBytes, rawHeaders, connectedAddress: result.connectedAddress };
  };
}
