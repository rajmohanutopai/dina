/**
 * MsgBox envelope handlers — D2D inbound, RPC inbound, RPC response.
 *
 * Processes envelopes dispatched by the WebSocket read pump:
 *   - D2D: parse ciphertext → delegate to receive pipeline (decrypt + verify + stage)
 *   - RPC: decrypt → verify identity binding → paired-device check → verify inner auth → route → respond
 *   - Cancel: abort in-flight RPC handler via AbortController
 *
 * Source: MsgBox Protocol — Home Node Implementation Guide
 */

import { sealEncrypt, sealDecryptWithScheme } from '../crypto/nacl';
import { sign, verify, getPublicKey } from '../crypto/ed25519';
import { extractPublicKey } from '../identity/did';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { appendAudit } from '../audit/service';
import { sendEnvelope, getIdentity, type MsgBoxEnvelope } from './msgbox_ws';
import { randomBytes } from '@noble/ciphers/utils.js';
import { isDevice } from '../auth/caller_type';
import { verifyPairingIdentityBinding } from '../pairing/ceremony';
import { receiveD2D, type ReceivePipelineResult } from '../d2d/receive_pipeline';
import type { D2DPayload } from '../d2d/envelope';

/** Inner RPC paths that opt into pair-identity binding instead of the
 *  signed-RPC path. Mirrors main-dina's `optionalAuthPaths` at the
 *  CLI→MsgBox→Core ingress: pair traffic is gated by the code itself
 *  plus a self-cert `env.from_did === did:key:<body.public_key>`
 *  check, not by prior-pairing state. */
const PAIR_PATHS = new Set<string>(['/v1/pair/complete']);

/** Reset handler state (for testing). */
export function resetHandlerState(): void {
  rpcRouter = null;
  inFlightRequests.clear();
}

/** Get the unified identity from the WS module. Throws if not configured. */
function identity(): { did: string; privateKey: Uint8Array } {
  const id = getIdentity();
  if (!id) throw new Error('msgbox: identity not configured — call setIdentity() first');
  return id;
}

// ---------------------------------------------------------------
// Injectable RPC router (routes inner HTTP requests)
// ---------------------------------------------------------------

export type RPCRouterFn = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

let rpcRouter: RPCRouterFn | null = null;

/** Set the RPC router (routes decrypted RPC requests through the handler chain). */
export function setRPCRouter(router: RPCRouterFn): void {
  rpcRouter = router;
}

// ---------------------------------------------------------------
// In-flight RPC tracking (for cancel support)
// ---------------------------------------------------------------

const inFlightRequests = new Map<string, AbortController>();

// ---------------------------------------------------------------
// D2D Inbound Handler
// ---------------------------------------------------------------

export interface D2DInboundResult {
  success: boolean;
  messageType?: string;
  senderDID?: string;
  pipelineAction?: string;
  stagingId?: string;
  error?: string;
  /**
   * Populated when the receive pipeline returned `action: 'bypassed'` — the
   * parsed, validated body of a service.query or service.response that the
   * contact-gate bypass authorised. Callers (the MsgBox boot wiring) hand
   * this off to Brain's D2D dispatcher so the provider-side handler can run.
   */
  bypassedBody?: unknown;
  /**
   * Populated when `pipelineAction === 'staged'` or `'ephemeral'` — the
   * raw verified body string. Callers use this to fan the message out
   * to a live UI surface (chat thread for coordination.*) without
   * reading the message back from the vault.
   */
  stagedBody?: string;
}

/**
 * Handle an inbound D2D envelope from another Home Node.
 *
 * Routes through the full receive pipeline:
 *   1. Parse D2DPayload { c, s } from envelope ciphertext
 *   2. Resolve sender verification keys + trust level
 *   3. Delegate to receiveD2D (unseal → verify → replay check → trust → stage/quarantine)
 *   4. Return result
 *
 * @param resolveSender — callback to resolve sender's verification keys and trust level from DID
 */
export async function handleInboundD2D(
  env: MsgBoxEnvelope,
  resolveSender: (did: string) => Promise<{ keys: Uint8Array[]; trust: string }>,
): Promise<D2DInboundResult> {
  // TEMP DIAGNOSTIC LOG — confirms MsgBox is delivering D2D envelopes
  // to the receive pipeline. Pairs with the stageMessage log to
  // distinguish "transport broken" from "transport OK, my code bypassed".
  console.log(
    '[d2d:handleInboundD2D]',
    JSON.stringify({
      from: env.from_did,
      to: env.to_did,
      id: env.id,
      hasCiphertext: typeof env.ciphertext === 'string' && env.ciphertext.length > 0,
    }),
  );

  const { did: myDID, privateKey } = (() => {
    try {
      return identity();
    } catch {
      return { did: '', privateKey: null as Uint8Array | null };
    }
  })();
  if (!privateKey) {
    return { success: false, error: 'Identity not configured' };
  }

  try {
    if (!env.ciphertext) {
      return { success: false, error: 'No ciphertext in D2D envelope' };
    }

    // 1. Parse D2DPayload from envelope ciphertext
    const d2dPayload: D2DPayload = JSON.parse(env.ciphertext);
    if (!d2dPayload.c || !d2dPayload.s) {
      return { success: false, error: 'Invalid D2D payload — missing c or s field' };
    }

    // 2. Resolve sender
    const sender = await resolveSender(env.from_did);
    const myPub = getPublicKey(privateKey);

    // 3. Route through receive pipeline
    const result: ReceivePipelineResult = receiveD2D(
      d2dPayload,
      myPub,
      privateKey,
      sender.keys,
      sender.trust,
    );

    appendAudit(
      env.from_did,
      'd2d_recv',
      myDID,
      `type=${result.messageType ?? 'unknown'} id=${env.id} action=${result.action}`,
    );

    return {
      success:
        result.action === 'staged' || result.action === 'ephemeral' || result.action === 'bypassed',
      messageType: result.messageType,
      senderDID: env.from_did,
      pipelineAction: result.action,
      stagingId: result.stagingId,
      error: result.action === 'dropped' ? result.reason : undefined,
      bypassedBody: result.action === 'bypassed' ? result.bypassedBody : undefined,
      stagedBody:
        result.action === 'staged' || result.action === 'ephemeral' ? result.stagedBody : undefined,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'D2D processing failed' };
  }
}

// ---------------------------------------------------------------
// RPC Inbound Handler
// ---------------------------------------------------------------

/**
 * Handle an inbound RPC request over MsgBox.
 *
 * Two code paths share the decrypt + dispatch + response plumbing:
 *
 *   1. **Signed RPC (paired)** — the default. Caller must be a
 *      registered paired device; inner headers carry Ed25519
 *      `{X-DID, X-Timestamp, X-Nonce, X-Signature}` and the
 *      identity binding `env.from_did === inner.X-DID` holds. This
 *      is how every post-pairing call (workflow claim, etc.) flows.
 *
 *   2. **Pair RPC (self-cert)** — used during the initial
 *      `/v1/pair/complete` handshake. An un-paired agent has a
 *      fresh did:key keypair. We bypass `isDevice` + signature
 *      verification and instead check that the envelope's DID is
 *      literally `did:key:<body.public_key_multibase>` — the agent
 *      IS the key it's pairing. Main-dina calls this
 *      `VerifyPairingIdentityBinding`. The pair CODE itself
 *      (brute-force-limited, single-use, 5-min TTL) is the
 *      remaining credential enforced by the route handler.
 */
export async function handleInboundRPC(env: MsgBoxEnvelope): Promise<void> {
  const { did: myDID, privateKey } = (() => {
    try {
      return identity();
    } catch {
      return { did: '', privateKey: null as Uint8Array | null };
    }
  })();
  if (!privateKey || !rpcRouter) return;

  const controller = new AbortController();
  inFlightRequests.set(env.id, controller);

  try {
    if (!env.ciphertext) {
      await sendRPCError(env, myDID, privateKey, 400, 'No ciphertext');
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[RPC] recv from=${env.from_did.slice(0, 30)}... id=${env.id.slice(0, 8)}`);
    // 1. Decrypt before any routing decision — the inner path tells
    //    us whether this is a pair-ceremony request or a normal
    //    signed call. Remember the sender's nonce scheme so the
    //    response is encrypted in the same format (SHA-512 for Go /
    //    mobile-sent envelopes, BLAKE2b for dina-cli libsodium
    //    sealed-box).
    const ctBytes = base64ToBytes(env.ciphertext);
    const myPub = getPublicKey(privateKey);
    let plaintext: Uint8Array;
    let nonceScheme: 'sha512' | 'blake2b' = 'sha512';
    try {
      const decoded = sealDecryptWithScheme(ctBytes, myPub, privateKey);
      plaintext = decoded.plaintext;
      nonceScheme = decoded.scheme;
    } catch (decErr) {
      // eslint-disable-next-line no-console
      console.error(`[RPC] decrypt FAILED: ${(decErr as Error).message}`);
      throw decErr;
    }
    // eslint-disable-next-line no-console
    console.log(`[RPC] decrypted ${plaintext.length} bytes (nonce=${nonceScheme})`);
    const inner = JSON.parse(new TextDecoder().decode(plaintext));

    if (
      !inner ||
      typeof inner.method !== 'string' ||
      typeof inner.path !== 'string' ||
      !inner.headers
    ) {
      await sendRPCError(env, myDID, privateKey, 400, 'Malformed RPC inner payload');
      return;
    }

    const isPairPath = inner.method.toUpperCase() === 'POST' && PAIR_PATHS.has(inner.path);

    // eslint-disable-next-line no-console
    console.log(
      `[RPC] in from=${env.from_did.slice(0, 30)} path=${inner.path} pair=${isPairPath}`,
    );

    if (isPairPath) {
      // Pair path: skip isDevice (agent isn't registered yet) but
      // still verify the inner Ed25519 signature + self-cert binding.
      // Matches main-dina's `VerifyPairingIdentityBinding` — the
      // envelope's did:key must derive from the body's public key.
      const publicKeyMultibase = extractPairPublicKey(inner.body);
      // eslint-disable-next-line no-console
      console.log(`[RPC] pair body pub=${publicKeyMultibase?.slice(0, 20)}`);
      if (publicKeyMultibase === null) {
        // eslint-disable-next-line no-console
        console.error(`[RPC] pair reject: no public_key in body`);
        appendAudit(env.from_did, 'pair_identity_mismatch', myDID, `id=${env.id}`);
        await sendRPCError(env, myDID, privateKey, 403, 'Pair identity binding failed');
        return;
      }
      if (!verifyPairingIdentityBinding(publicKeyMultibase, env.from_did)) {
        // eslint-disable-next-line no-console
        console.error(
          `[RPC] pair reject: binding mismatch env.from_did=${env.from_did} body.public_key=${publicKeyMultibase}`,
        );
        appendAudit(env.from_did, 'pair_identity_mismatch', myDID, `id=${env.id}`);
        await sendRPCError(env, myDID, privateKey, 403, 'Pair identity binding failed');
        return;
      }
      // Inner signature verification — the CLI signs every inner
      // request, including pair calls, using the did:key's private
      // key. Since the binding above guarantees env.from_did
      // derives from the body's public key, we verify the signature
      // with that key.
      if (
        typeof inner.headers?.['X-Signature'] === 'string' &&
        typeof inner.headers?.['X-Timestamp'] === 'string' &&
        typeof inner.headers?.['X-Nonce'] === 'string'
      ) {
        try {
          const cliPub = extractPublicKey(env.from_did);
          const bodyStr =
            typeof inner.body === 'string' ? inner.body : JSON.stringify(inner.body ?? '');
          const bodyHash = bytesToHex(sha256(new TextEncoder().encode(bodyStr)));
          const canonical = `${inner.method}\n${inner.path}\n\n${inner.headers['X-Timestamp']}\n${inner.headers['X-Nonce']}\n${bodyHash}`;
          const sigBytes = hexToBytes(inner.headers['X-Signature']);
          if (!verify(cliPub, new TextEncoder().encode(canonical), sigBytes)) {
            appendAudit(env.from_did, 'pair_sig_invalid', myDID, `id=${env.id}`);
            await sendRPCError(env, myDID, privateKey, 401, 'Invalid pair signature');
            return;
          }
        } catch {
          // extractPublicKey throws only for non-did:key formats —
          // we've already confirmed the binding so this is very
          // unlikely, but treat as a rejection just in case.
          await sendRPCError(env, myDID, privateKey, 401, 'Pair signature check failed');
          return;
        }
      }
      // Unsigned pair calls (test harness) are accepted because the
      // self-cert binding alone proves envelope ownership; the
      // route handler enforces the code's brute-force cap.
    } else {
      // Signed-RPC path: requires prior pairing + full auth.
      if (!isDevice(env.from_did)) {
        appendAudit(env.from_did, 'rpc_unregistered_device', myDID, `id=${env.id}`);
        await sendRPCError(env, myDID, privateKey, 403, 'Device not registered');
        return;
      }

      // Identity binding: envelope from_did must match inner X-DID.
      if (env.from_did !== inner.headers?.['X-DID']) {
        appendAudit(env.from_did, 'rpc_identity_mismatch', myDID, `id=${env.id}`);
        await sendRPCError(env, myDID, privateKey, 403, 'Identity binding failed');
        return;
      }

      // Inner Ed25519 signature.
      const cliPub = extractPublicKey(env.from_did);
      const bodyHash = bytesToHex(sha256(new TextEncoder().encode(inner.body ?? '')));
      const canonical = `${inner.method}\n${inner.path}\n\n${inner.headers['X-Timestamp']}\n${inner.headers['X-Nonce']}\n${bodyHash}`;
      const sigBytes = hexToBytes(inner.headers['X-Signature']);

      if (!verify(cliPub, new TextEncoder().encode(canonical), sigBytes)) {
        appendAudit(env.from_did, 'rpc_sig_invalid', myDID, `id=${env.id}`);
        await sendRPCError(env, myDID, privateKey, 401, 'Invalid signature');
        return;
      }
    }

    // Shared dispatch + response.
    if (controller.signal.aborted) return;

    const response = await rpcRouter(
      inner.method,
      inner.path,
      inner.headers,
      inner.body ?? '',
      controller.signal,
    );

    if (!controller.signal.aborted) {
      // eslint-disable-next-line no-console
      console.log(
        `[RPC] out status=${response.status} nonce=${nonceScheme} body=${response.body?.slice(0, 200)}`,
      );
      await sendRPCResponse(env, myDID, privateKey, response, nonceScheme);
      appendAudit(
        env.from_did,
        isPairPath ? 'pair_handled' : 'rpc_handled',
        myDID,
        `id=${env.id} path=${inner.path} status=${response.status}`,
      );
    }
  } catch (err) {
    await sendRPCError(
      env,
      myDID,
      privateKey,
      500,
      err instanceof Error ? err.message : 'Internal error',
    );
  } finally {
    inFlightRequests.delete(env.id);
  }
}

/**
 * Pull the `public_key` multibase string out of an RPC inner body.
 * Returns null on any parse / shape failure — callers treat that as
 * "reject the pair attempt." The pair-identity check itself lives in
 * `pairing/ceremony.ts::verifyPairingIdentityBinding`.
 */
function extractPairPublicKey(body: unknown): string | null {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    if (body === '') return null;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  // dina-cli uses `public_key_multibase` on the wire; accept
  // `public_key` as a test-harness alias.
  const pk =
    (typeof obj.public_key_multibase === 'string' ? obj.public_key_multibase : '') ||
    (typeof obj.public_key === 'string' ? obj.public_key : '');
  const trimmed = pk.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Handle an RPC cancel envelope — abort the in-flight handler.
 */
export function handleRPCCancel(env: MsgBoxEnvelope): void {
  const cancelId = env.cancel_of ?? env.id;
  const controller = inFlightRequests.get(cancelId);
  if (controller) {
    controller.abort();
    inFlightRequests.delete(cancelId);
    const myDID = getIdentity()?.did ?? '';
    appendAudit(env.from_did, 'rpc_cancelled', myDID, `id=${cancelId}`);
  }
}

// ---------------------------------------------------------------
// D2D Outbound via WebSocket
// ---------------------------------------------------------------

/**
 * Send a D2D message to another Home Node via WebSocket envelope.
 *
 * Alternative to HTTP POST /forward — uses the persistent WS connection.
 */
export function sendD2DViaWS(
  recipientDID: string,
  recipientEd25519Pub: Uint8Array,
  plaintextMessage: Record<string, unknown>,
): boolean {
  const id = getIdentity();
  if (!id) return false;

  const plainBytes = new TextEncoder().encode(JSON.stringify(plaintextMessage));

  // Encrypt with recipient's Ed25519 key (sealEncrypt handles Ed25519→X25519)
  const sealed = sealEncrypt(plainBytes, recipientEd25519Pub);

  // Sign the plaintext
  const sig = sign(id.privateKey, plainBytes);

  // Build d2dPayload
  const d2dPayload = JSON.stringify({
    c: bytesToBase64(sealed),
    s: bytesToHex(sig),
  });

  // Send as envelope
  return sendEnvelope({
    type: 'd2d',
    id: `d2d-${bytesToHex(randomBytes(8))}`,
    from_did: id.did,
    to_did: recipientDID,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ciphertext: d2dPayload,
  });
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

async function sendRPCResponse(
  requestEnv: MsgBoxEnvelope,
  myDID: string,
  privateKey: Uint8Array,
  response: { status: number; headers: Record<string, string>; body: string },
  nonceScheme: 'sha512' | 'blake2b' = 'sha512',
): Promise<void> {
  const responseJSON = JSON.stringify(response);
  const responseBytes = new TextEncoder().encode(responseJSON);

  // Encrypt response with CLI's public key; mirror the nonce scheme
  // the sender used so libsodium-based clients (dina-cli) can
  // decrypt while Go Core + mobile SHA-512 senders keep working.
  const cliPub = extractPublicKey(requestEnv.from_did);
  const sealed = sealEncrypt(responseBytes, cliPub, nonceScheme);

  // `sendEnvelope` returns `false` when the WS is mid-reconnect /
  // unauthenticated; the response is silently dropped in that case
  // and the CLI eventually trips its 30 s recv timeout. If the send
  // would silently drop, queue the envelope and retry until the
  // socket is back, capped at the relay-side TTL (120 s) so we
  // don't pile up dead envelopes when the client has long
  // disconnected.
  const env: MsgBoxEnvelope = {
    type: 'rpc',
    id: requestEnv.id,
    from_did: myDID,
    to_did: requestEnv.from_did,
    direction: 'response',
    expires_at: Math.floor(Date.now() / 1000) + 120,
    ciphertext: bytesToBase64(sealed),
  };
  const ok = await sendOrRetryUntilExpired(env);
  // eslint-disable-next-line no-console
  console.log(
    `[RPC] sent rid=${requestEnv.id.slice(0, 8)} status=${response.status} delivered=${ok}`,
  );
}

/**
 * Send `env` over the relay WS, with a brief retry window so a
 * mid-reconnect race doesn't silently drop the response. Tries
 * once, then polls the connection state every 200 ms for up to
 * `MAX_SEND_RETRY_MS` total. Returns `true` on a successful WS
 * write, `false` after the budget is exhausted.
 *
 * The cap is intentionally short — the CLI's recv timeout is 30 s
 * by default, and a real reconnect either completes in <1 s (the
 * WS layer's `reconnect_attempt` schedule) or won't complete in
 * time anyway. Long retries also block tests that drive a never-
 * connected fake WS.
 */
const MAX_SEND_RETRY_MS = 2_000;
const SEND_RETRY_INTERVAL_MS = 200;

async function sendOrRetryUntilExpired(env: MsgBoxEnvelope): Promise<boolean> {
  if (sendEnvelope(env)) return true;
  const deadlineMs = Date.now() + MAX_SEND_RETRY_MS;
  while (Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_INTERVAL_MS));
    if (sendEnvelope(env)) return true;
  }
  return false;
}

async function sendRPCError(
  requestEnv: MsgBoxEnvelope,
  myDID: string,
  privateKey: Uint8Array,
  status: number,
  message: string,
  nonceScheme: 'sha512' | 'blake2b' = 'sha512',
): Promise<void> {
  await sendRPCResponse(
    requestEnv,
    myDID,
    privateKey,
    {
      status,
      headers: {},
      body: JSON.stringify({ error: message }),
    },
    nonceScheme,
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
