/**
 * The server host's A2A transport (design §6.6, plan §3.10): the socket
 * half of the outbound policy whose decisions live in Core. Core's Lane 1
 * calls go through it, and so do the A2A gateway's webhook pushes; both
 * processes install the same function, so a webhook cannot reach what a
 * Lane 1 call could not.
 *
 *  1. Core's URL check (HTTPS, no credentials, no literal IP).
 *  2. Resolve the name ONCE, and refuse if ANY answer is blocked
 *     (private, loopback, link-local, CGNAT, multicast, reserved; the same
 *     `isBlockedAddress` the commerce feed uses). A name that resolves to a
 *     public and a private address is refused, not half-trusted.
 *  3. Connect to the vetted address, with the socket's lookup pinned to it,
 *     so a second DNS answer can never be used; TLS validates the original
 *     hostname, sends it as SNI, and `Host` carries it.
 *  4. No redirects, a response byte cap, JSON responses only, no compressed
 *     encodings, UTF-8 only, one deadline over the whole exchange. A
 *     request that asks for the status only (`response: 'status'`, a
 *     webhook) has its body discarded unread.
 *
 * A forbidden destination therefore receives no connection at all: the
 * refusal comes before the socket exists.
 */

import { promises as dns } from 'node:dns';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { TextDecoder } from 'node:util';

import {
  checkOutboundUrl,
  isBlockedAddress,
  type A2AHostTransport,
  type A2AHttpRequest,
  type A2AHttpResult,
  type A2ATransportError,
} from '@dina/core';

export interface A2AHostTransportOptions {
  /** Every address the name resolves to. Default: the system resolver, all families. */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Whether an address may be connected to. Default: not `isBlockedAddress`.
   * Tests that run a reference agent on loopback pass their own; production
   * composition never does.
   */
  isAllowedAddress?: (address: string) => boolean;
  /** Extra trusted CA certificates (PEM). Tests only; production uses the system store. */
  ca?: string;
}

const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

async function systemResolve(hostname: string): Promise<string[]> {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

/** `::ffff:1.2.3.4` → `1.2.3.4`, so a mapped socket address compares equal. */
function plainAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address.toLowerCase();
}

function failure(error: A2ATransportError, sent: boolean): A2AHttpResult {
  return { ok: false, error, sent };
}

function classifySocketError(err: NodeJS.ErrnoException): A2ATransportError {
  const code = err.code ?? '';
  if (code === 'A2A_TIMEOUT') return 'timeout';
  if (
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

export function createA2AHostTransport(options: A2AHostTransportOptions = {}): A2AHostTransport {
  const resolve = options.resolve ?? systemResolve;
  const allowed = options.isAllowedAddress ?? ((a: string) => !isBlockedAddress(a));

  return async (request: A2AHttpRequest): Promise<A2AHttpResult> => {
    const check = checkOutboundUrl(request.url);
    if (!check.ok) return failure('url_refused', false);
    const url = check.url;
    const deadline = Date.now() + request.timeoutMs;

    let addresses: string[];
    let resolveTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        resolve(url.hostname),
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
    if (addresses.some((a) => isIP(plainAddress(a)) === 0 || !allowed(plainAddress(a)))) {
      return failure('address_blocked', false);
    }

    // Every answer was vetted; try them in order. Only a connection that
    // never opened moves on to the next address: nothing was sent on it.
    const vettedAddresses = [...new Set(addresses.map(plainAddress))];
    let last: A2AHttpResult = failure('connect_failed', false);
    for (const vetted of vettedAddresses) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failure('timeout', false);
      last = await requestVia(url, vetted, request, remaining, options.ca);
      if (last.ok || last.sent || last.error !== 'connect_failed') return last;
    }
    return last;
  };
}

/** One HTTPS exchange whose socket can reach only `vetted`. */
function requestVia(
  url: URL,
  vetted: string,
  request: A2AHttpRequest,
  remaining: number,
  ca: string | undefined,
): Promise<A2AHttpResult> {
  const family = isIP(vetted);
  // The socket may only ever reach the vetted address. The answer is given
  // asynchronously, as a real lookup's is: answered synchronously, a connect
  // that fails at once (an IPv6 address the host cannot route to) destroys
  // the socket before TLS is set up on it, and https.request throws while
  // the socket's error has no listener, taking the whole process down.
  const pinned: LookupFunction = (hostname, lookupOptions, callback) => {
    process.nextTick(() => {
      if (hostname !== url.hostname) {
        const err = Object.assign(new Error('unexpected lookup'), { code: 'A2A_LOOKUP' });
        callback(err, '', 0);
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

  return new Promise<A2AHttpResult>((settle) => {
    let handshakeDone = false;
    let settled = false;
    // The deadline runs from before the request exists, so finish can always clear it.
    let req: ReturnType<typeof https.request> | undefined;
    const timer = setTimeout(() => {
      req?.destroy(Object.assign(new Error('deadline'), { code: 'A2A_TIMEOUT' }));
    }, remaining);
    timer.unref();
    const finish = (result: A2AHttpResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(result);
    };

    const headers: Record<string, string> = {
      ...request.headers,
      accept: request.response === 'status' ? '*/*' : 'application/json',
      'accept-encoding': 'identity',
      'user-agent': 'dina-a2a/1',
    };
    if (request.body !== undefined) {
      headers['content-type'] = request.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(request.body, 'utf8'));
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
        ...(ca !== undefined ? { ca } : {}),
      });
    } catch (err) {
      // https.request throws only on options it refuses (a header value with
      // CR or LF, say, from a remote's token): nothing reached the network.
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
        req.destroy();
        finish(failure('address_blocked', true));
        return;
      }
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        req.destroy();
        finish(failure('redirect_refused', true));
        return;
      }
      // The status is the whole answer: nothing of the body is read.
      if (request.response === 'status') {
        req.destroy();
        finish({ ok: true, status, body: '', connectedAddress: connected });
        return;
      }
      // A refused credential, whatever its body: the caller learns the
      // request was turned away before it ran, never what the remote wrote.
      if (status === 401 || status === 403) {
        req.destroy();
        finish({ ok: true, status, body: '', connectedAddress: connected });
        return;
      }
      const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
      const contentType = String(response.headers['content-type'] ?? '');
      if (encoding !== 'identity' || !JSON_MEDIA.test(contentType)) {
        req.destroy();
        finish(failure('bad_content_type', true));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxResponseBytes) {
          req.destroy();
          finish(failure('too_large', true));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => finish(failure('io_error', true)));
      response.on('end', () => {
        let body: string;
        try {
          body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          finish(failure('bad_encoding', true));
          return;
        }
        finish({ ok: true, status, body, connectedAddress: connected });
      });
    });

    req.end(request.body);
  });
}
