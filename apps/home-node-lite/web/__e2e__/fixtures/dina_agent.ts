/**
 * A faithful in-test `dina-agent`.
 *
 * Pairs a `role='agent'` device against Core's REAL pairing ceremony, then
 * makes canonically-SIGNED HTTP requests so Core resolves
 * `callerType='agent'`. This is what makes the agent-safety gates fire for
 * real — a paired agent making signed requests, NOT a backstage owner-bypass
 * (which is always the owner and is therefore never gated).
 *
 * The signing mirrors `packages/core/src/auth/canonical.ts`:
 *   canonical = `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}`
 *   headers   = X-DID, X-Timestamp, X-Nonce, X-Signature (hex Ed25519 sig)
 */

import { randomBytes } from 'node:crypto';

import * as ed25519 from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';

import * as backstage from './backstage';

// @noble/ed25519 v3+ needs an explicit SHA-512 (same shim as support/stack.ts).
const edHashes = ed25519.hashes as { sha512?: (...msgs: Uint8Array[]) => Uint8Array };
edHashes.sha512 = (...msgs: Uint8Array[]) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

const CORE_PORT = Number(process.env.DINA_CORE_E2E_PORT ?? 18298);
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;

export interface AgentResponse {
  status: number;
  body: unknown;
}

export interface DinaAgent {
  /** The agent's did:key (the X-DID it signs with). */
  did: string;
  /** Make a signed request to Core as this agent. */
  signedFetch(
    method: string,
    path: string,
    opts?: { query?: Record<string, string>; body?: unknown },
  ): Promise<AgentResponse>;
}

/**
 * Pair a fresh agent device and return a signed-request client. Uses
 * backstage (owner-bypass) only for the admin-gated `/v1/pair/initiate`
 * step (staging a precondition); `/v1/pair/complete` is the public route
 * the real agent hits, and every subsequent call is a genuine signed RPC.
 */
export async function pairAgent(deviceName = 'e2e-agent'): Promise<DinaAgent> {
  const secret = new Uint8Array(randomBytes(32));
  const publicKey = ed25519.getPublicKey(secret);
  const payload = new Uint8Array(2 + publicKey.length);
  payload[0] = 0xed; // Ed25519 multicodec varint
  payload[1] = 0x01;
  payload.set(publicKey, 2);
  const multibase = `z${base58.encode(payload)}`;
  const did = `did:key:${multibase}`;

  // 1) initiate (admin) via backstage — the role is fixed here to 'agent'
  //    (Core refuses privilege escalation at /complete).
  const init = (await backstage.dispatchOk('POST', '/v1/pair/initiate', {
    body: { device_name: deviceName, role: 'agent' },
  })) as { code?: string };
  const code = init.code ?? '';
  if (code === '') throw new Error('dina_agent: /v1/pair/initiate returned no code');

  // 2) complete (public route) — the code is the credential.
  const res = await fetch(`${CORE_URL}/v1/pair/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, public_key_multibase: multibase }),
  });
  if (res.status !== 201) {
    throw new Error(`dina_agent: /v1/pair/complete → ${res.status}: ${await res.text()}`);
  }

  async function signedFetch(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<AgentResponse> {
    // Match Core's canonical query serializer (router.ts serialiseQuery uses
    // encodeURIComponent: space → %20, not URLSearchParams' form-encoding
    // space → +). Signing the SAME bytes Core reconstructs is what keeps the
    // Ed25519 verification valid for queries containing spaces / special chars.
    const queryStr = opts.query
      ? Object.entries(opts.query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    const bodyBytes =
      opts.body !== undefined ? new TextEncoder().encode(JSON.stringify(opts.body)) : new Uint8Array();
    const timestamp = new Date().toISOString(); // RFC3339 (millis + Z) — within Core's window
    const nonce = bytesToHex(new Uint8Array(randomBytes(16)));
    const bodyHash = bytesToHex(sha256(bodyBytes));
    const canonical = `${method}\n${path}\n${queryStr}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = ed25519.sign(new TextEncoder().encode(canonical), secret);
    const url = `${CORE_URL}${path}${queryStr !== '' ? `?${queryStr}` : ''}`;
    const r = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'X-DID': did,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': bytesToHex(signature),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await r.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: r.status, body };
  }

  return { did, signedFetch };
}
