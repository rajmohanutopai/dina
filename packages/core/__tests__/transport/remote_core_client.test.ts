/**
 * The staff phone's transport, proven against the NODE-SIDE crypto: the
 * fake relay in this file authenticates the challenge, unseals the
 * request with the node's real sealed-box open, verifies the inner
 * Ed25519 quartet with the real canonical builder, and answers with the
 * real `buildSignedResponse` — so a drift on either side of the wire
 * fails here rather than on a phone.
 */

import { createHash, randomBytes } from 'node:crypto';

import { bytesToHex } from '@noble/hashes/utils.js';

import { buildCanonicalPayload } from '@dina/protocol';

import { getPublicKey, verify } from '../../src/crypto/ed25519';
import { sealDecryptWithScheme, sealEncrypt } from '../../src/crypto/nacl';
import { deriveDIDKey } from '../../src/identity/did';
import { buildSignedResponse } from '../../src/relay/rpc_response';
import {
  RemoteCoreClient,
  RemoteTransportError,
  type WebSocketLike,
} from '../../src/transport/remote_core_client';

const nodeSeed = new Uint8Array(randomBytes(32));
const nodePub = getPublicKey(nodeSeed);
const NODE_DID = 'did:plc:staffremotenode0000000000';
const deviceSeed = new Uint8Array(randomBytes(32));
const devicePub = getPublicKey(deviceSeed);
const DEVICE_DID = deriveDIDKey(devicePub);

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

interface FakeRelayBehavior {
  /** Answer the unsealed inner request. */
  respond: (inner: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }) => { status: number; body: string };
  /** Tamper knobs. */
  breakResponseSignature?: boolean;
  plaintextSuccess?: boolean;
}

/** A relay + node in one fake socket, speaking the real protocol. */
function fakeRelay(behavior: FakeRelayBehavior): {
  makeWebSocket: (url: string) => WebSocketLike;
  seen: {
    authPayload?: string;
    envelope?: Record<string, unknown>;
    inner?: Record<string, unknown>;
    envelopeWasBinary?: boolean;
  };
} {
  const seen: {
    authPayload?: string;
    envelope?: Record<string, unknown>;
    inner?: Record<string, unknown>;
    envelopeWasBinary?: boolean;
  } = {};
  const makeWebSocket = (): WebSocketLike => {
    const ws: WebSocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: () => undefined,
      send: (data) => {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.type === 'rpc') seen.envelopeWasBinary = typeof data !== 'string';
        if (frame.type === 'auth_response') {
          // Verify the challenge signature exactly as the relay does.
          const payload = seen.authPayload ?? '';
          const ok = verify(
            new Uint8Array(Buffer.from(String(frame.pub), 'hex')),
            new TextEncoder().encode(payload),
            new Uint8Array(Buffer.from(String(frame.sig), 'hex')),
          );
          queueMicrotask(() => {
            ws.onmessage?.({
              data: JSON.stringify(ok ? { type: 'auth_success' } : { type: 'auth_failure' }),
            });
          });
          return;
        }
        if (frame.type === 'rpc') {
          seen.envelope = frame;
          const opened = sealDecryptWithScheme(
            b64ToBytes(String(frame.ciphertext)),
            nodePub,
            nodeSeed,
          );
          const inner = JSON.parse(new TextDecoder().decode(opened.plaintext)) as {
            method: string;
            path: string;
            headers: Record<string, string>;
            body: string;
          };
          seen.inner = inner as unknown as Record<string, unknown>;
          const answer = behavior.respond(inner);
          const signed = buildSignedResponse(
            String(frame.id),
            answer.status,
            {},
            answer.body,
            NODE_DID,
            nodeSeed,
          );
          if (behavior.breakResponseSignature === true) signed.signature = '00'.repeat(64);
          const responseCiphertext = behavior.plaintextSuccess === true
            ? JSON.stringify(signed)
            : Buffer.from(
                sealEncrypt(new TextEncoder().encode(JSON.stringify(signed)), devicePub),
              ).toString('base64');
          queueMicrotask(() => {
            ws.onmessage?.({
              data: JSON.stringify({
                id: frame.id,
                to_did: DEVICE_DID,
                from_did: NODE_DID,
                ciphertext: responseCiphertext,
              }),
            });
          });
        }
      },
    };
    // The relay speaks first: the challenge.
    const nonce = bytesToHex(randomBytes(8));
    const ts = '2026-08-18T12:00:00Z';
    seen.authPayload = `AUTH_RELAY\n${nonce}\n${ts}`;
    queueMicrotask(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'auth_challenge', nonce, ts }) });
    });
    return ws;
  };
  return { makeWebSocket, seen };
}

function client(makeWebSocket: (url: string) => WebSocketLike): RemoteCoreClient {
  return new RemoteCoreClient({
    msgboxUrl: 'wss://relay.example.dev/ws',
    homenodeDid: NODE_DID,
    homenodeSigningPub: nodePub,
    deviceDid: DEVICE_DID,
    devicePrivateKey: deviceSeed,
    makeWebSocket,
    timeoutMs: 2_000,
  });
}

describe('the sealed round trip', () => {
  it('signs, seals, and verifies — and the node-side check accepts the quartet', async () => {
    const { makeWebSocket, seen } = fakeRelay({
      respond: (inner) => {
        // The NODE's own verification of the inner request: canonical
        // payload from the exact fields, signature by the device key.
        const [p, q = ''] = inner.path.split('?');
        const bodyHash = createHash('sha256').update(Buffer.from(inner.body)).digest('hex');
        const canonical = buildCanonicalPayload(
          inner.method,
          p ?? '',
          q,
          inner.headers['X-Timestamp'] ?? '',
          inner.headers['X-Nonce'] ?? '',
          bodyHash,
        );
        const ok = verify(
          devicePub,
          new TextEncoder().encode(canonical),
          new Uint8Array(Buffer.from(inner.headers['X-Signature'] ?? '', 'hex')),
        );
        return ok
          ? { status: 200, body: JSON.stringify({ ok: true, echo: inner.path }) }
          : { status: 401, body: JSON.stringify({ error: 'bad signature' }) };
      },
    });
    const res = await client(makeWebSocket).request(
      'GET',
      '/v1/commerce/trade/inbox?limit=5',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, echo: '/v1/commerce/trade/inbox?limit=5' });
    expect(seen.envelope).toMatchObject({
      type: 'rpc',
      from_did: DEVICE_DID,
      to_did: NODE_DID,
      direction: 'request',
    });
    // The relay consumes envelopes from BINARY frames only — a
    // text-framed envelope is silently dropped server-side.
    expect(seen.envelopeWasBinary).toBe(true);
  });

  it('a pairing request travels UNSIGNED with subtype pair — the code is the credential', async () => {
    const { makeWebSocket, seen } = fakeRelay({
      respond: () => ({ status: 201, body: JSON.stringify({ role: 'staff' }) }),
    });
    const res = await client(makeWebSocket).request(
      'POST',
      '/v1/pair/complete',
      JSON.stringify({ code: '123456', public_key_multibase: 'zStub' }),
    );
    expect(res.status).toBe(201);
    expect(seen.envelope?.subtype).toBe('pair');
    expect((seen.inner as { headers: Record<string, string> }).headers['X-Signature']).toBeUndefined();
  });

  it('a plaintext SUCCESS is refused unconditionally — a clerk phone has no dev mode', async () => {
    const { makeWebSocket } = fakeRelay({
      respond: () => ({ status: 200, body: '{"ok":true}' }),
      plaintextSuccess: true,
    });
    await expect(client(makeWebSocket).request('GET', '/v1/commerce/trade/inbox')).rejects.toThrow(
      RemoteTransportError,
    );
  });

  it('a forged response signature is refused — a sealed box names no sender', async () => {
    const { makeWebSocket } = fakeRelay({
      respond: () => ({ status: 200, body: '{"ok":true}' }),
      breakResponseSignature: true,
    });
    await expect(client(makeWebSocket).request('GET', '/v1/commerce/trade/inbox')).rejects.toThrow(
      'signature does not verify',
    );
  });

  it('an unsigned ERROR still surfaces — refusing it would hide every genuine failure', async () => {
    const { makeWebSocket } = fakeRelay({
      respond: () => ({ status: 403, body: JSON.stringify({ error: 'access_denied' }) }),
      breakResponseSignature: true,
    });
    const res = await client(makeWebSocket).request('GET', '/v1/commerce/trade/inbox');
    expect(res.status).toBe(403);
  });
});
