/**
 * Remote Core client over MsgBox — the STAFF PHONE's transport
 * (TRADE_FIRST_STRATEGY §6.3).
 *
 * A staff phone is not a Home Node: it holds one Ed25519 device key and
 * every call it makes is a signed, sealed HTTP-shaped request tunnelled
 * through the relay to the BUSINESS's Core — the same wire the Python
 * dina-agent CLI speaks (docs/designs/MSGBOX_TRANSPORT.md), ported so a
 * React Native app can be a §6 clerk device. Byte-for-byte protocol:
 *
 *   1. WS connect → `auth_challenge {nonce, ts}` → sign
 *      "AUTH_RELAY\n{nonce}\n{ts}" with the device key →
 *      `auth_response {did, sig, pub}` → `auth_success`.
 *   2. Inner request {method, path(+query), headers, body} — headers
 *      carry the canonical Ed25519 auth quartet, EXCEPT on `/v1/pair/*`
 *      where the pairing code is the credential and the envelope's
 *      `from_did` + body key give Core its binding.
 *   3. Sealed (libsodium sealed-box, BLAKE2b nonce) to the node's
 *      SIGNING key; outer envelope {type:'rpc', id, from_did, to_did,
 *      direction:'request', expires_at, ciphertext} as one frame.
 *   4. The response frame matches by id and `to_did`; its ciphertext
 *      unseals with the device key, and — beyond what the CLI checks —
 *      the response SIGNATURE is verified against the node's key
 *      (`core_rpc_response` canonical): a sealed box is anonymous-
 *      sender, so without this any holder of the device's public key
 *      could forge an answer.
 *
 * Pure: WebSocket construction, clocks and randomness are injected, so
 * the same class runs under Hermes (RN global WebSocket) and Node
 * tests ('ws').
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { signRequest } from '../auth/canonical';
import { getPublicKey, sign, verify } from '../crypto/ed25519';
import { sealDecryptWithScheme, sealEncrypt } from '../crypto/nacl';
import { buildResponseCanonical } from '../relay/rpc_response';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface RemoteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The WebSocket surface this client needs — RN's global and 'ws' both fit. */
export interface WebSocketLike {
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
}

export interface RemoteCoreClientOptions {
  /** Relay endpoint, e.g. `wss://test-mailbox.dinakernel.com/ws`. */
  msgboxUrl: string;
  /** The business node's DID — the envelope's `to_did`. */
  homenodeDid: string;
  /** The node's Ed25519 SIGNING key: seals requests, verifies responses. */
  homenodeSigningPub: Uint8Array;
  /** This device's identity. */
  deviceDid: string;
  devicePrivateKey: Uint8Array;
  makeWebSocket: (url: string) => WebSocketLike;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Injected for tests; defaults to crypto randomness via the id maker. */
  makeRequestId?: () => string;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Expiry seconds per path family — mirrors the CLI's `_EXPIRY_DEFAULTS`. */
function expirySecondsFor(path: string): number {
  if (path.includes('remember') || path.includes('task') || path.includes('pair')) return 300;
  if (path.includes('status') || path.includes('ask')) return 30;
  return 60;
}

function defaultRequestId(): string {
  const bytes = new Uint8Array(16);
  // Hermes (via crypto-expo polyfills) and Node both expose getRandomValues.
  (globalThis.crypto as { getRandomValues: (b: Uint8Array) => Uint8Array }).getRandomValues(bytes);
  return bytesToHex(bytes);
}

export class RemoteTransportError extends Error {
  constructor(
    message: string,
    readonly stage:
      | 'connect'
      | 'auth'
      | 'send'
      | 'timeout'
      | 'response'
      | 'decrypt'
      | 'signature',
  ) {
    super(message);
    this.name = 'RemoteTransportError';
  }
}

export class RemoteCoreClient {
  private readonly timeoutMs: number;

  constructor(private readonly opts: RemoteCoreClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One request, one connection. The CLI reuses sockets with drain
   * logic; a clerk's tap cadence does not need that complexity, and a
   * fresh challenge per request means a stolen socket is worth nothing.
   */
  async request(
    method: string,
    pathAndQuery: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<RemoteResponse> {
    const requestId = (this.opts.makeRequestId ?? defaultRequestId)();
    const [path, query = ''] = pathAndQuery.split('?');
    const bodyText = body ?? '';

    // Pairing is code-authenticated; everything else carries the quartet.
    const isPairing = (path ?? '').startsWith('/v1/pair/');
    const headers: Record<string, string> = isPairing
      ? { ...extraHeaders }
      : {
          ...extraHeaders,
          ...signRequest(
            method,
            path ?? '',
            query,
            new TextEncoder().encode(bodyText),
            this.opts.devicePrivateKey,
            this.opts.deviceDid,
          ),
        };

    const inner = JSON.stringify({
      method,
      path: query !== '' ? `${path ?? ''}?${query}` : (path ?? ''),
      headers,
      body: bodyText,
    });
    const sealed = sealEncrypt(new TextEncoder().encode(inner), this.opts.homenodeSigningPub);
    const nowMs = (this.opts.now ?? Date.now)();
    const envelope: Record<string, unknown> = {
      type: 'rpc',
      id: requestId,
      from_did: this.opts.deviceDid,
      to_did: this.opts.homenodeDid,
      direction: 'request',
      expires_at: Math.floor(nowMs / 1000) + expirySecondsFor(path ?? ''),
      ciphertext: bytesToBase64(sealed),
      ...(isPairing ? { subtype: 'pair' } : {}),
    };

    const raw = await this.roundTrip(JSON.stringify(envelope), requestId);
    return this.parseResponse(raw, requestId);
  }

  private roundTrip(frame: string, requestId: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = this.opts.makeWebSocket(this.opts.msgboxUrl);
      const timer = setTimeout(() => {
        finish(() =>
          reject(new RemoteTransportError(`no response within ${String(this.timeoutMs)}ms`, 'timeout')),
        );
      }, this.timeoutMs);

      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        settle();
      };

      let authed = false;
      ws.onerror = () => {
        finish(() => reject(new RemoteTransportError('relay socket error', 'connect')));
      };
      ws.onclose = () => {
        finish(() => reject(new RemoteTransportError('relay closed before answering', 'response')));
      };
      ws.onmessage = (event) => {
        let text: string;
        const data = event.data as unknown;
        if (typeof data === 'string') text = data;
        else if (data instanceof Uint8Array) text = new TextDecoder().decode(data);
        else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
        else return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return; // not for us
        }
        if (!authed) {
          if (parsed.type === 'auth_challenge') {
            const payload = `AUTH_RELAY\n${String(parsed.nonce)}\n${String(parsed.ts)}`;
            const sig = sign(this.opts.devicePrivateKey, new TextEncoder().encode(payload));
            ws.send(
              JSON.stringify({
                type: 'auth_response',
                did: this.opts.deviceDid,
                sig: bytesToHex(sig),
                pub: bytesToHex(getPublicKey(this.opts.devicePrivateKey)),
              }),
            );
            return;
          }
          if (parsed.type === 'auth_success') {
            authed = true;
            // BINARY, not text: the relay's envelope reader consumes
            // binary frames only (auth control frames are text) — a
            // text-framed envelope is a silent debug-level drop on the
            // relay, which read as a clean timeout here. Found live.
            ws.send(new TextEncoder().encode(frame));
            return;
          }
          if (parsed.type === 'auth_failure' || parsed.type === 'error') {
            finish(() =>
              reject(new RemoteTransportError(`relay auth refused: ${text.slice(0, 120)}`, 'auth')),
            );
          }
          return;
        }
        // Post-auth: only the envelope answering OUR request, addressed to US.
        if (parsed.id !== requestId) return;
        if (parsed.to_did !== this.opts.deviceDid) return;
        finish(() => resolve(parsed));
      };
    });
  }

  private parseResponse(env: Record<string, unknown>, requestId: string): RemoteResponse {
    const ciphertextRaw = typeof env.ciphertext === 'string' ? env.ciphertext : '';
    let inner: Record<string, unknown>;
    if (ciphertextRaw !== '' && !ciphertextRaw.startsWith('{')) {
      let plaintext: Uint8Array;
      try {
        const decoded = sealDecryptWithScheme(
          base64ToBytes(ciphertextRaw),
          getPublicKey(this.opts.devicePrivateKey),
          this.opts.devicePrivateKey,
        );
        plaintext = decoded.plaintext;
      } catch (err) {
        throw new RemoteTransportError(
          `response decryption failed: ${err instanceof Error ? err.message : String(err)}`,
          'decrypt',
        );
      }
      inner = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    } else {
      // Plaintext is legal for ERRORS only (no user data in errors); a
      // plaintext success is a forgery or a misconfiguration — refused
      // unconditionally here, with no dev-mode escape: a clerk device
      // has no dev mode.
      inner = JSON.parse(ciphertextRaw === '' ? '{}' : ciphertextRaw) as Record<string, unknown>;
      const status = Number(inner.status ?? 200);
      if (status >= 200 && status < 300) {
        throw new RemoteTransportError('plaintext success refused — responses must be sealed', 'response');
      }
    }

    const status = Number(inner.status ?? 0);
    const bodyText = typeof inner.body === 'string' ? inner.body : '';
    // A sealed box names no sender: the signature is what makes this
    // answer THE NODE's. Errors may arrive unsigned (they carry no user
    // data and refusing them would hide every genuine failure); a
    // SUCCESS must verify.
    const signature = typeof inner.signature === 'string' ? inner.signature : '';
    if (status >= 200 && status < 300) {
      const canonical = buildResponseCanonical(requestId, status, bodyText);
      const sigBytes = signature === '' ? null : hexToBytes(signature);
      if (
        sigBytes === null ||
        !verify(this.opts.homenodeSigningPub, new TextEncoder().encode(canonical), sigBytes)
      ) {
        throw new RemoteTransportError('response signature does not verify', 'signature');
      }
    }
    return {
      status,
      headers: (inner.headers as Record<string, string> | undefined) ?? {},
      body: bodyText,
    };
  }
}
