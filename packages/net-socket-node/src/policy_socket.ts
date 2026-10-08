/**
 * The Node policy socket (UCP plan §3.3): `@dina/net-policy`'s PolicySocket on
 * `node:https`, the server half of the outbound policy whose rules live in
 * Core. UCP's `ucpFetch` and A2A's `a2aFetch` both run on it.
 *
 *  1. Resolve the name ONCE, within the deadline, and refuse if ANY answer is
 *     special-use (`classifyAddress`, every IANA special-purpose range). A
 *     name that resolves to a public and a private address is refused.
 *  2. Connect only to a vetted address: the socket's lookup is pinned to it,
 *     so a second DNS answer can never be used; TLS (at least `minTls`)
 *     validates the original name, sends it as SNI, and `Host` carries it.
 *     Only a connection that never opened moves on to the next address.
 *  3. No redirects (a 304 answering `If-None-Match` is a result), no
 *     compressed bodies, the media type `accept` allows, a byte cap on the
 *     body and a hard cap on the headers, one deadline over the whole exchange.
 *  4. `sent` is false only when the failure came before the TLS handshake
 *     finished, so a mutation that failed with `sent: false` did not run.
 *
 * A forbidden destination receives no connection at all: the refusal comes
 * before the socket exists.
 */

import { promises as dns } from 'node:dns';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import {
  acceptsContentType,
  bodyAllowed,
  isBlockedAddress,
  nat64PrefixesFrom,
  rawHeadersWithinLimits,
  requestHeadersAcceptable,
  type PolicySocket,
  type PolicySocketRequest,
  type PolicySocketResult,
  type PolicyTransportError,
} from '@dina/net-policy';

export interface NodePolicySocketOptions {
  /** Every address the name resolves to. Default: the system resolver, all families. */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Whether an address may be connected to. Default: not `isBlockedAddress`,
   * with the network's NAT64 prefixes (RFC 7050) taken into account.
   * Tests that run a server on loopback pass their own; production composition
   * never does.
   */
  isAllowedAddress?: (address: string) => boolean;
  /** Extra trusted CA certificates (PEM). Tests only; production uses the system store. */
  ca?: string;
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

async function systemResolve(hostname: string): Promise<string[]> {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

/** `::ffff:1.2.3.4` → `1.2.3.4`, so a mapped socket address compares equal. */
function plainAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address.toLowerCase();
}

function failure(error: PolicyTransportError, sent: boolean): PolicySocketResult {
  return { ok: false, error, sent };
}

function classifySocketError(err: NodeJS.ErrnoException): PolicyTransportError {
  const code = err.code ?? '';
  if (code === 'DINA_TIMEOUT') return 'timeout';
  // EPROTO: the peer refused the handshake (a protocol version below `minTls`, say).
  if (
    code === 'EPROTO' ||
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)
  ) {
    return 'tls_failed';
  }
  // Failures before any connection opened, including an address family the
  // host cannot use (no IPv6): the next vetted address may still serve.
  if (
    [
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
      'EADDRNOTAVAIL',
      'EAFNOSUPPORT',
    ].includes(code)
  ) {
    return 'connect_failed';
  }
  return 'io_error';
}

export function createNodePolicySocket(options: NodePolicySocketOptions = {}): PolicySocket {
  const resolve = options.resolve ?? systemResolve;

  return async (request: PolicySocketRequest): Promise<PolicySocketResult> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return failure('io_error', false);
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
      return failure('io_error', false);
    // Refused before any lookup, so a refused request has certainly not left.
    if (!requestHeadersAcceptable(request.headers) || !bodyAllowed(request))
      return failure('io_error', false);
    const deadline = Date.now() + request.timeoutMs;

    let addresses: string[];
    let ipv4only: string[];
    let resolveTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // RFC 7050: the network's NAT64 prefixes, found beside the name, so an
      // answer synthesised under a network-specific prefix is judged by the
      // IPv4 inside it. A failure here only means no prefix was found.
      [addresses, ipv4only] = await Promise.race([
        Promise.all([resolve(url.hostname), resolve('ipv4only.arpa').catch((): string[] => [])]),
        new Promise<never>((_, reject) => {
          resolveTimer = setTimeout(() => reject(new Error('resolve timeout')), request.timeoutMs);
          resolveTimer.unref();
        }),
      ]);
    } catch {
      return failure('dns_failed', false);
    } finally {
      clearTimeout(resolveTimer);
    }
    if (addresses.length === 0) return failure('dns_failed', false);
    const nat64Prefixes = nat64PrefixesFrom(ipv4only);
    const allowed =
      options.isAllowedAddress ?? ((a: string) => !isBlockedAddress(a, { nat64Prefixes }));
    if (addresses.some((a) => isIP(plainAddress(a)) === 0 || !allowed(plainAddress(a)))) {
      return failure('address_blocked', false);
    }

    const vetted = [...new Set(addresses.map(plainAddress))];
    let last: PolicySocketResult = failure('connect_failed', false);
    for (const address of vetted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failure('timeout', false);
      last = await requestVia(url, address, request, remaining, options.ca);
      if (last.ok || last.sent || last.error !== 'connect_failed') return last;
    }
    return last;
  };
}

/** One HTTPS exchange whose socket can reach only `vetted`. */
function requestVia(
  url: URL,
  vetted: string,
  request: PolicySocketRequest,
  remaining: number,
  ca: string | undefined,
): Promise<PolicySocketResult> {
  const family = isIP(vetted);
  // The answer is given asynchronously, as a real lookup's is: answered
  // synchronously, a connect that fails at once destroys the socket before
  // TLS is set up on it, and https.request throws with no error listener.
  const pinned: LookupFunction = (hostname, lookupOptions, callback) => {
    process.nextTick(() => {
      if (hostname !== url.hostname) {
        callback(Object.assign(new Error('unexpected lookup'), { code: 'DINA_LOOKUP' }), '', 0);
        return;
      }
      if (lookupOptions.all === true) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
          { address: vetted, family },
        ]);
      } else {
        callback(null, vetted, family);
      }
    });
  };

  return new Promise<PolicySocketResult>((settle) => {
    let handshakeDone = false;
    let settled = false;
    let req: ReturnType<typeof https.request> | undefined;
    const timer = setTimeout(() => {
      req?.destroy(Object.assign(new Error('deadline'), { code: 'DINA_TIMEOUT' }));
    }, remaining);
    timer.unref();
    const finish = (result: PolicySocketResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(result);
    };

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const n = name.toLowerCase();
      if (!SOCKET_HEADERS.has(n)) headers[n] = value;
    }
    headers['accept'] = ACCEPT_VALUE[request.accept];
    headers['accept-encoding'] = 'identity';
    if (request.ifNoneMatch !== undefined) headers['if-none-match'] = request.ifNoneMatch;
    const body = request.body !== undefined ? Buffer.from(request.body) : undefined;
    if (body !== undefined || request.method === 'POST' || request.method === 'PUT') {
      headers['content-length'] = String(body?.length ?? 0);
    }

    try {
      req = https.request({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        servername: url.hostname,
        lookup: pinned,
        agent: false,
        rejectUnauthorized: true,
        minVersion: request.minTls,
        ...(ca !== undefined ? { ca } : {}),
      });
    } catch (err) {
      // https.request throws only on options it refuses (a header value with
      // CR or LF, say): nothing reached the network.
      finish(failure(classifySocketError(err as NodeJS.ErrnoException), false));
      return;
    }

    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        handshakeDone = true;
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      finish(failure(classifySocketError(err), handshakeDone));
    });

    req.on('response', (response) => {
      const connected = plainAddress(response.socket.remoteAddress ?? '');
      if (connected !== vetted) {
        req?.destroy();
        finish(failure('address_blocked', true));
        return;
      }
      const raw: [string, string][] = [];
      for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
        raw.push([
          (response.rawHeaders[i] as string).toLowerCase(),
          response.rawHeaders[i + 1] as string,
        ]);
      }
      if (!rawHeadersWithinLimits(raw)) {
        req?.destroy();
        finish(failure('too_large', true));
        return;
      }
      const status = response.statusCode ?? 0;
      const notModified = status === 304 && request.ifNoneMatch !== undefined;
      if (status >= 300 && status < 400 && !notModified) {
        req?.destroy();
        finish(failure('redirect_refused', true));
        return;
      }
      const empty = (): void => {
        req?.destroy();
        finish({
          ok: true,
          status,
          bodyBytes: new Uint8Array(0),
          rawHeaders: raw,
          connectedAddress: connected,
        });
      };
      // The status is the whole answer: nothing of the body is read.
      if (request.accept === 'status' || notModified || status === 204) return empty();
      // A refused credential, unless the caller reads challenges: the caller
      // learns the request was turned away, never what the remote wrote.
      if ((status === 401 || status === 403) && !request.readAuthErrorBodies) return empty();
      const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
      // A transfer coding other than chunked (which Node has already removed) is not the content.
      const transfer = String(response.headers['transfer-encoding'] ?? 'chunked').toLowerCase();
      if (
        encoding !== 'identity' ||
        transfer !== 'chunked' ||
        !acceptsContentType(request.accept, response.headers['content-type'])
      ) {
        req?.destroy();
        finish(failure('bad_content_type', true));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxResponseBytes) {
          req?.destroy();
          finish(failure('too_large', true));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => finish(failure('io_error', true)));
      response.on('end', () => {
        finish({
          ok: true,
          status,
          bodyBytes: new Uint8Array(Buffer.concat(chunks)),
          rawHeaders: raw,
          connectedAddress: connected,
        });
      });
    });

    req.end(body);
  });
}
