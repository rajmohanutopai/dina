/**
 * MsgBox WebSocket client — real transport for D2D + RPC relay.
 *
 * Protocol (from MsgBox Universal Transport spec):
 *   1. Connect outbound to wss://mailbox.dinakernel.com/ws
 *   2. Auth: sign "AUTH_RELAY\n{nonce}\n{ts}" with root Ed25519 key
 *   3. Read pump: dispatch JSON envelopes by type (d2d/rpc/cancel)
 *   4. Reconnect with exponential backoff (1s → 60s cap)
 *
 * The WebSocket implementation is injectable — production uses React
 * Native's WebSocket, tests use a mock.
 *
 * Source: MsgBox Protocol — Home Node Implementation Guide
 */

import { sign, getPublicKey } from '../crypto/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------
// Envelope types (unified format for all MsgBox frames)
// ---------------------------------------------------------------

export interface MsgBoxEnvelope {
  type: 'd2d' | 'rpc' | 'cancel';
  id: string;
  from_did: string;
  to_did: string;
  direction?: 'request' | 'response';
  expires_at?: number;
  subtype?: string;
  cancel_of?: string;
  ciphertext?: string;
}

export type EnvelopeHandler = (envelope: MsgBoxEnvelope) => void;

// ---------------------------------------------------------------
// Backoff constants
// ---------------------------------------------------------------

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000; // 60s cap (matching Go)

// ---------------------------------------------------------------
// Injectable WebSocket factory (for testing)
// ---------------------------------------------------------------

export interface WSLike {
  /**
   * Send a frame. The MsgBox relay only processes Binary frames after the
   * auth handshake (`msgbox/internal/handler.go:105`); Text frames are
   * silently dropped. After auth, all envelope sends MUST be binary, so
   * call sites pass `Uint8Array` / `ArrayBuffer`. String sends are still
   * permitted for the auth_response handshake itself, which the relay
   * accepts as text.
   */
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  readyState: number;
}

export type WSFactory = (url: string) => WSLike;

let wsFactory: WSFactory | null = null;

/** Set the WebSocket factory (production: React Native WebSocket, tests: mock). */
export function setWSFactory(factory: WSFactory | null): void {
  wsFactory = factory;
}

// ---------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------

let ws: WSLike | null = null;
let connected = false;
let authenticated = false;
/**
 * True once we've responded to an `auth_challenge`. Some MsgBox variants
 * skip the explicit `auth_success` frame and stream buffered envelopes
 * immediately after the signed `auth_response`. Tracking this lets us
 * implicitly promote to `authenticated` on the first envelope-shaped
 * frame (issue #15).
 */
let authChallengeSeen = false;
let currentURL: string | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shouldReconnect = true;

// Identity for auth handshake
let homeNodeDID: string = '';
let homeNodePrivateKey: Uint8Array | null = null;

// Message handlers
let d2dHandler: EnvelopeHandler | null = null;
let rpcHandler: EnvelopeHandler | null = null;
let cancelHandler: EnvelopeHandler | null = null;

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

/** Configure identity for auth handshake. Must be called before connect. */
export function setIdentity(did: string, privateKey: Uint8Array): void {
  homeNodeDID = did;
  homeNodePrivateKey = privateKey;
}

/** Get the current identity (used by handlers module for unified config). */
export function getIdentity(): { did: string; privateKey: Uint8Array } | null {
  if (!homeNodeDID || !homeNodePrivateKey) return null;
  return { did: homeNodeDID, privateKey: homeNodePrivateKey };
}

/** Register handler for inbound D2D envelopes. */
export function onD2DMessage(handler: EnvelopeHandler): void {
  d2dHandler = handler;
}

/** Register handler for inbound RPC request envelopes. */
export function onRPCRequest(handler: EnvelopeHandler): void {
  rpcHandler = handler;
}

/** Register handler for RPC cancel envelopes. */
export function onRPCCancel(handler: EnvelopeHandler): void {
  cancelHandler = handler;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Build the handshake payload: "AUTH_RELAY\n{nonce}\n{timestamp}".
 */
export function buildHandshakePayload(nonce: string, timestamp: string): string {
  return `AUTH_RELAY\n${nonce}\n${timestamp}`;
}

/**
 * Compute reconnect backoff delay in ms.
 * Exponential: 1s → 2s → 4s → ... → capped at 60s.
 */
export function computeReconnectDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

/**
 * Sign the handshake payload with the root identity Ed25519 key.
 */
export function signHandshake(nonce: string, timestamp: string, privateKey: Uint8Array): string {
  const payload = buildHandshakePayload(nonce, timestamp);
  const sig = sign(privateKey, new TextEncoder().encode(payload));
  return bytesToHex(sig);
}

/**
 * Connect to MsgBox WebSocket relay.
 *
 * 1. Opens WebSocket to the MsgBox URL
 * 2. Waits for auth_challenge
 * 3. Signs and sends auth_response
 * 4. Starts read pump for envelope dispatch
 * 5. Auto-reconnects on disconnect
 */
export async function connectToMsgBox(
  url: string,
  options?: { readyTimeoutMs?: number },
): Promise<void> {
  if (!wsFactory) {
    throw new Error('msgbox_ws: no WebSocket factory set — call setWSFactory() first');
  }
  if (!homeNodePrivateKey || !homeNodeDID) {
    throw new Error('msgbox_ws: identity not configured — call setIdentity() first');
  }

  const isSecure = url.startsWith('wss://');
  const isLocalDev = url.startsWith('ws://localhost') || url.startsWith('ws://127.0.0.1');
  if (!isSecure && !isLocalDev) {
    throw new Error('msgbox_ws: insecure URL — wss:// required (ws:// only for localhost)');
  }

  currentURL = url;
  shouldReconnect = true;
  doConnect(url);

  // Optionally await auth readiness so callers (bootstrap) can rely
  // on the WS being usable when this resolves. The default is `0`
  // (no wait) because `doConnect` is already kicked off asynchronously;
  // wiring that cares about the handshake (e.g. `createNode.start()`)
  // passes a real `readyTimeoutMs`. Previously this function returned
  // immediately and callers logged "connected" before the auth_challenge
  // had been answered — the first outbound envelope would silently fail
  // `sendEnvelope` until auth completed. Issue #7.
  const timeoutMs = options?.readyTimeoutMs ?? 0;
  if (timeoutMs > 0) {
    await waitForAuthenticated(timeoutMs);
  }
}

/**
 * Poll until `authenticated === true` or `timeoutMs` elapses. Resolves
 * on authentication, rejects on timeout so the caller can surface a
 * real error instead of logging a false "connected" message.
 */
function waitForAuthenticated(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (authenticated) {
      resolve();
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (authenticated) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`msgbox_ws: handshake did not complete within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Check if connected to MsgBox. */
export function isConnected(): boolean {
  return connected;
}

/** Check if fully authenticated (connected + auth complete). */
export function isAuthenticated(): boolean {
  return connected && authenticated;
}

/**
 * Send a raw envelope over the WebSocket as a **Binary** frame.
 *
 * The MsgBox relay only forwards binary frames after the auth handshake;
 * text frames are silently dropped (`msgbox/internal/handler.go:105`).
 * Building the JSON via `TextEncoder().encode()` produces a `Uint8Array`,
 * which RN/browser/Node `WebSocket.send` implementations all surface as a
 * binary frame. Sending the raw string would surface as a text frame and
 * the response would never reach the recipient.
 */
export function sendEnvelope(envelope: MsgBoxEnvelope): boolean {
  if (!ws || !connected || !authenticated) {
    // eslint-disable-next-line no-console
    console.error(
      `[WS] sendEnvelope DROP type=${envelope.type} id=${envelope.id?.slice(0, 8)} dir=${envelope.direction ?? '-'} state ws=${ws !== null} conn=${connected} auth=${authenticated}`,
    );
    return false;
  }
  try {
    const wire = new TextEncoder().encode(JSON.stringify(envelope));
    ws.send(wire);
    // eslint-disable-next-line no-console
    console.error(
      `[WS] sendEnvelope OK type=${envelope.type} id=${envelope.id?.slice(0, 8)} dir=${envelope.direction ?? '-'} to=${envelope.to_did?.slice(0, 30)} bytes=${wire.byteLength}`,
    );
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[WS] sendEnvelope THREW type=${envelope.type} id=${envelope.id?.slice(0, 8)} err=${(err as Error).message}`,
    );
    return false;
  }
}

/** Disconnect and stop reconnection. */
export async function disconnect(): Promise<void> {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ok */
    }
    ws = null;
  }
  connected = false;
  authenticated = false;
  authChallengeSeen = false;
  currentURL = null;
  reconnectAttempt = 0;
}

/** Complete the handshake (for backward compat with existing tests). */
export async function completeHandshake(
  nonce: string,
  timestamp: string,
  privateKey: Uint8Array,
): Promise<boolean> {
  if (privateKey.length !== 32) return false;
  signHandshake(nonce, timestamp, privateKey);
  return true;
}

/** Reset all connection state (for testing). */
export function resetConnectionState(): void {
  disconnect();
  d2dHandler = null;
  rpcHandler = null;
  cancelHandler = null;
  homeNodeDID = '';
  homeNodePrivateKey = null;
  wsFactory = null;
}

// ---------------------------------------------------------------
// Internal: connection lifecycle
// ---------------------------------------------------------------

function doConnect(url: string): void {
  if (!wsFactory) return;

  try {
    ws = wsFactory(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    reconnectAttempt = 0; // reset backoff on successful connect
    // eslint-disable-next-line no-console
    console.error(`[WS] onopen url=${url}`);
    // Wait for auth_challenge from server — handled in onmessage
  };

  ws.onmessage = (event) => {
    // MsgBox speaks JSON over WS. Most frames are strings, but RN
    // WebSocket polyfills surface binary frames as ArrayBuffer, a
    // typed-array view, OR Blob depending on platform. Decode
    // opportunistically; silently dropping binary frames (the old
    // behaviour) meant replayed buffered envelopes after reconnect
    // were lost (issues #15, #8).
    const decoded = coerceToString(event.data);
    if (decoded === null) return;
    if (typeof decoded === 'string') {
      handleFrameText(decoded);
    } else {
      // Blob path — async decode.
      decoded.then(
        (text) => {
          if (text !== null) handleFrameText(text);
        },
        () => {
          /* blob read failed — drop */
        },
      );
    }
  };

  ws.onclose = (ev) => {
    // eslint-disable-next-line no-console
    console.error(
      `[WS] onclose code=${ev?.code ?? '-'} reason=${ev?.reason ?? '-'} wasAuth=${authenticated}`,
    );
    connected = false;
    authenticated = false;
    authChallengeSeen = false;
    ws = null;
    if (shouldReconnect) scheduleReconnect();
  };

  ws.onerror = (ev) => {
    // ev is `unknown` per WSLike — RN polyfill surfaces { message }, browser
    // surfaces an Event with { type }. Best-effort string-coerce both.
    const msg =
      ev !== null && typeof ev === 'object' && 'message' in ev
        ? String((ev as { message?: unknown }).message ?? '')
        : '';
    // eslint-disable-next-line no-console
    console.error(`[WS] onerror msg=${msg !== '' ? msg : '(no message)'}`);
    // Error triggers close, which triggers reconnect
  };
}

/** Parse + route a decoded JSON frame. Shared between string + Blob paths. */
function handleFrameText(text: string): void {
  let msg: { type?: string } & Record<string, unknown>;
  try {
    msg = JSON.parse(text) as { type?: string } & Record<string, unknown>;
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[WS] frame_unparseable preview=${text.slice(0, 120)}`);
    return;
  }
  if (msg.type === 'auth_challenge' && !authenticated) {
    // eslint-disable-next-line no-console
    console.error('[WS] frame=auth_challenge — replying');
    handleAuthChallenge(msg as unknown as { nonce: string; ts: number });
    return;
  }
  if (msg.type === 'auth_success') {
    // eslint-disable-next-line no-console
    console.error('[WS] frame=auth_success — authenticated');
    authenticated = true;
    return;
  }
  if (!authenticated && isEnvelopeLike(msg) && authChallengeSeen) {
    // eslint-disable-next-line no-console
    console.error('[WS] envelope arrived pre-auth_success — flipping to authenticated');
    authenticated = true;
  }
  if (authenticated) {
    // eslint-disable-next-line no-console
    console.error(
      `[WS] dispatch type=${msg.type} id=${typeof msg.id === 'string' ? msg.id.slice(0, 8) : '-'} dir=${typeof msg.direction === 'string' ? msg.direction : '-'} from=${typeof msg.from_did === 'string' ? msg.from_did.slice(0, 30) : '-'}`,
    );
    dispatchEnvelope(msg as unknown as MsgBoxEnvelope);
  } else {
    // eslint-disable-next-line no-console
    console.error(
      `[WS] frame dropped pre-auth type=${msg.type} authChalSeen=${authChallengeSeen}`,
    );
  }
}

function handleAuthChallenge(challenge: { nonce: string; ts: number }): void {
  if (!ws || !homeNodePrivateKey || !homeNodeDID) return;

  const sig = signHandshake(challenge.nonce, String(challenge.ts), homeNodePrivateKey);
  const pubHex = bytesToHex(getPublicKey(homeNodePrivateKey));

  ws.send(
    JSON.stringify({
      type: 'auth_response',
      did: homeNodeDID,
      sig,
      pub: pubHex,
    }),
  );

  // Mark that we've replied to the challenge so the onmessage handler
  // can accept either an explicit `auth_success` or a buffered-envelope
  // burst as implicit auth completion (issue #15).
  authChallengeSeen = true;

  // The production relay doesn't send `auth_success` — it just holds
  // the socket open on a successful sig, and closes on failure. The Go
  // client treats a still-open socket 500 ms after `auth_response` as
  // authenticated (matches `msgbox_client.connected` in busdriver-core
  // logs). We mirror that: optimistically flip the flag here, then let
  // `onclose` undo it if the server rejects. Without this the TS client
  // waits forever for an `auth_success` that never arrives on the real
  // relay, even though sig verification succeeded.
  setTimeout(() => {
    if (ws !== null && connected && authChallengeSeen) {
      authenticated = true;
    }
  }, 500);
}

/**
 * Coerce an incoming WS frame's payload to string. RN's WebSocket
 * polyfill surfaces binary frames as ArrayBuffer, typed-array view, OR
 * Blob depending on platform and `binaryType`. We decode UTF-8 when
 * possible. Returns a promise-like result because Blob decoding is
 * async; the caller awaits before parsing.
 */
function coerceToString(data: unknown): string | Promise<string | null> | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    try {
      return new TextDecoder('utf-8').decode(new Uint8Array(data));
    } catch {
      return null;
    }
  }
  if (ArrayBuffer.isView(data)) {
    try {
      const view = data as ArrayBufferView;
      return new TextDecoder('utf-8').decode(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      );
    } catch {
      return null;
    }
  }
  // RN WebSocket (and some browser impls with binaryType='blob') emits
  // Blob frames. Blob.text() returns a Promise<string>; we propagate
  // the promise so the caller's onmessage handler can await it.
  // Guarded for platforms that don't define Blob.
  const BlobCtor = (globalThis as unknown as { Blob?: unknown }).Blob;
  if (typeof BlobCtor === 'function' && data instanceof (BlobCtor as new () => unknown)) {
    const blob = data as unknown as { text?: () => Promise<string> };
    if (typeof blob.text === 'function') {
      return blob.text().catch(() => null);
    }
    return null;
  }
  return null;
}

/**
 * Cheap shape check: does `msg` look like a routable envelope?
 * Used to promote implicit authentication after a replied challenge.
 */
function isEnvelopeLike(msg: unknown): msg is MsgBoxEnvelope {
  if (msg === null || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return (m.type === 'd2d' || m.type === 'rpc' || m.type === 'cancel') && typeof m.id === 'string';
}

function dispatchEnvelope(env: MsgBoxEnvelope): void {
  // Finding #9: Validate to_did matches our DID — reject misdirected envelopes
  if (env.to_did && homeNodeDID && env.to_did !== homeNodeDID) {
    // eslint-disable-next-line no-console
    console.error(
      `[WS] dispatch DROP misdirected to=${env.to_did.slice(0, 30)} self=${homeNodeDID.slice(0, 30)} id=${env.id?.slice(0, 8)}`,
    );
    return;
  }

  // Finding #9: Reject expired envelopes (expires_at is unix seconds)
  if (env.expires_at && env.expires_at < Math.floor(Date.now() / 1000)) {
    // eslint-disable-next-line no-console
    console.error(
      `[WS] dispatch DROP expired exp=${env.expires_at} now=${Math.floor(Date.now() / 1000)} id=${env.id?.slice(0, 8)}`,
    );
    return;
  }

  switch (env.type) {
    case 'd2d':
      if (d2dHandler) d2dHandler(env);
      else
        // eslint-disable-next-line no-console
        console.error(`[WS] dispatch DROP no d2dHandler id=${env.id?.slice(0, 8)}`);
      break;
    case 'rpc':
      if (env.direction === 'request' && rpcHandler) rpcHandler(env);
      else if (env.direction === 'request')
        // eslint-disable-next-line no-console
        console.error(`[WS] dispatch DROP no rpcHandler id=${env.id?.slice(0, 8)}`);
      else
        // eslint-disable-next-line no-console
        console.error(
          `[WS] dispatch IGNORE rpc dir=${env.direction ?? '-'} (home node only routes requests) id=${env.id?.slice(0, 8)}`,
        );
      break;
    case 'cancel':
      if (cancelHandler) cancelHandler(env);
      break;
  }
}

function scheduleReconnect(): void {
  if (!shouldReconnect || !currentURL) return;
  const delay = computeReconnectDelay(reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    if (currentURL && shouldReconnect) doConnect(currentURL);
  }, delay);
}
