import * as https from 'node:https';
import * as zlib from 'node:zlib';

import {
  CATALOG_FEED_LIMITS,
  checkCatalogFeedDecompression,
  type AuthedTransport,
  type FeedResponse,
} from '@dina/core';

/**
 * The server's outbound transport for catalog connectors (§10.3, WS-9.1).
 *
 * DUMB ON PURPOSE. It is handed a URL the fetch policy has already cleared and
 * headers it must send verbatim, and it reports back what it actually
 * connected to. Every decision — is this address allowed, may we follow this
 * redirect, is this content type one we parse — belongs to `fetchUnderPolicy`
 * in Core, which is where it can be tested without a network.
 *
 * WHY `node:https` AND NOT `fetch`. Two reasons, both load-bearing:
 *
 *   1. `connectedAddress`. §10.3 re-checks the address actually connected to,
 *      which is the defence against a hostname that resolves to a private
 *      address after it passed the URL check. `fetch` does not expose the
 *      socket, so a transport built on it would have to report a DNS lookup it
 *      did separately — a different answer to a different question, and one
 *      that reads as if the check happened.
 *
 *   2. Redirects. The policy owns the redirect loop so it can re-validate each
 *      hop; `https.request` does not follow them, which is exactly right here.
 *
 * HTTPS ONLY. There is no `http` import in this file. The URL check already
 * refuses anything else, and a transport that could speak plaintext is one
 * refactor away from being asked to.
 */

/** Nothing here logs. A header this function carries is a credential. */
export const nodeAuthedTransport: AuthedTransport = async (url, headers) =>
  new Promise<FeedResponse>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: {
          ...headers,
          // Asked for explicitly so the decompression accounting below has
          // something to account for, and so a server cannot pick an encoding
          // this file does not know how to bound.
          'accept-encoding': 'gzip, deflate',
        },
        timeout: CATALOG_FEED_LIMITS.maxMillis,
      },
      (response) => {
        const connectedAddress = response.socket.remoteAddress ?? '';
        const contentType = response.headers['content-type'] ?? null;
        const location = response.headers.location;
        const encoding = (response.headers['content-encoding'] ?? '').toLowerCase();

        let compressedBytes = 0;
        let decompressedBytes = 0;
        const chunks: Buffer[] = [];
        let settled = false;

        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          request.destroy();
          reject(error);
        };

        // The decompressor, or a pass-through. Both are counted the same way,
        // so a plain response and a gzip bomb are bounded by one code path.
        const sink =
          encoding === 'gzip'
            ? zlib.createGunzip()
            : encoding === 'deflate'
              ? zlib.createInflate()
              : null;

        response.on('data', (chunk: Buffer) => {
          compressedBytes += chunk.length;
          if (compressedBytes > CATALOG_FEED_LIMITS.maxBytes) {
            // ABORTED MID-STREAM, not measured afterwards. A cap checked only
            // once the body has arrived bounds nothing: the memory is already
            // spent by the time the check runs.
            fail(new Error('catalog connector: response exceeds the byte cap'));
            return;
          }
          if (sink === null) {
            decompressedBytes = compressedBytes;
            chunks.push(chunk);
          }
        });

        if (sink !== null) {
          response.pipe(sink);
          sink.on('data', (chunk: Buffer) => {
            decompressedBytes += chunk.length;
            const refusal = checkCatalogFeedDecompression(compressedBytes, decompressedBytes);
            if (refusal !== null) {
              fail(new Error(`catalog connector: ${refusal}`));
              return;
            }
            chunks.push(chunk);
          });
          sink.on('error', (error: Error) => {
            fail(error);
          });
          sink.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
              status: response.statusCode ?? 0,
              contentType,
              connectedAddress,
              ...(typeof location === 'string' ? { location } : {}),
              body: Buffer.concat(chunks).toString('utf8'),
              compressedBytes,
              decompressedBytes,
            });
          });
          return;
        }

        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            contentType,
            connectedAddress,
            ...(typeof location === 'string' ? { location } : {}),
            body: Buffer.concat(chunks).toString('utf8'),
            compressedBytes,
            decompressedBytes,
          });
        });
        response.on('error', fail);
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('catalog connector: the endpoint did not answer in time'));
    });
    request.on('error', reject);
    request.end();
  });
