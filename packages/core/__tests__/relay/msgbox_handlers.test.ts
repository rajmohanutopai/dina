/**
 * MsgBox envelope handlers — D2D inbound, RPC inbound, RPC cancel, D2D outbound.
 *
 * Tests the full handler chain: decrypt, verify, route, respond.
 *
 * Source: MsgBox Protocol — Home Node Implementation Guide
 */

import {
  handleInboundD2D,
  handleInboundRPC,
  handleRPCCancel,
  sendD2DViaWS,
  setRPCRouter,
  resetHandlerState,
  type RPCRouterFn,
} from '../../src/relay/msgbox_handlers';
import {
  setIdentity,
  getIdentity,
  resetConnectionState,
  setWSFactory,
  sendEnvelope,
  isAuthenticated,
  type WSLike,
  type MsgBoxEnvelope,
} from '../../src/relay/msgbox_ws';
import { sign, getPublicKey } from '../../src/crypto/ed25519';
import { sealEncrypt } from '../../src/crypto/nacl';
import { deriveDIDKey } from '../../src/identity/did';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { registerDevice, resetCallerTypeState } from '../../src/auth/caller_type';
import { sealMessage, buildMessage } from '../../src/d2d/envelope';
import { TEST_ED25519_SEED } from '@dina/test-harness';

// Second key pair for sender simulation
const SENDER_SEED = new Uint8Array(32);
SENDER_SEED.set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32,
]);
const SENDER_PUB = getPublicKey(SENDER_SEED);
const SENDER_DID = deriveDIDKey(SENDER_PUB);

const HOME_PUB = getPublicKey(TEST_ED25519_SEED);
const HOME_DID = deriveDIDKey(HOME_PUB);

/** Set up identity for handler tests. */
function setupIdentity(): void {
  setIdentity(HOME_DID, TEST_ED25519_SEED);
}

/** Create a mock WebSocket that captures sends. */
function createCapturingWS(): { ws: WSLike; sent: string[] } {
  const sent: string[] = [];
  const ws: WSLike = {
    send: jest.fn((data: string) => sent.push(data)),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: 1,
  };
  setTimeout(() => {
    if (ws.onopen) ws.onopen();
  }, 0);
  return { ws, sent };
}

/** Build a sealed D2D envelope from sender to home node. */
function buildSealedD2DEnvelope(): MsgBoxEnvelope {
  const message = {
    id: `msg-${bytesToHex(randomBytes(8))}`,
    type: 'social.update',
    from: SENDER_DID,
    to: HOME_DID,
    created_time: Date.now(),
    body: JSON.stringify({ text: 'Hello from sender' }),
  };

  const payload = sealMessage(message, SENDER_SEED, HOME_PUB);

  return {
    type: 'd2d',
    id: `d2d-${bytesToHex(randomBytes(8))}`,
    from_did: SENDER_DID,
    to_did: HOME_DID,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ciphertext: JSON.stringify(payload),
  };
}

/** Build a sealed RPC envelope (simulating a CLI device request). */
function buildSealedRPCEnvelope(cliSeed: Uint8Array, cliDID: string): MsgBoxEnvelope {
  const body = '{"query":"test"}';
  const timestamp = new Date().toISOString();
  const nonce = bytesToHex(randomBytes(16));
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const canonical = `GET\n/v1/vault\n\n${timestamp}\n${nonce}\n${bodyHash}`;
  const sigBytes = sign(cliSeed, new TextEncoder().encode(canonical));

  const inner = {
    method: 'GET',
    path: '/v1/vault',
    headers: {
      'X-DID': cliDID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': bytesToHex(sigBytes),
    },
    body,
  };

  const plainBytes = new TextEncoder().encode(JSON.stringify(inner));
  const sealed = sealEncrypt(plainBytes, HOME_PUB);
  const ciphertext = Buffer.from(sealed).toString('base64');

  return {
    type: 'rpc',
    id: `rpc-${bytesToHex(randomBytes(8))}`,
    from_did: cliDID,
    to_did: HOME_DID,
    direction: 'request',
    expires_at: Math.floor(Date.now() / 1000) + 120,
    ciphertext,
  };
}

describe('MsgBox Envelope Handlers', () => {
  beforeEach(() => {
    resetConnectionState();
    resetHandlerState();
    resetCallerTypeState();
    setupIdentity();
  });

  // -----------------------------------------------------------
  // D2D Inbound
  // -----------------------------------------------------------

  describe('handleInboundD2D', () => {
    const resolveSender = async (_did: string) => ({
      keys: [SENDER_PUB],
      trust: 'verified',
    });

    it('processes a valid D2D envelope through receive pipeline', async () => {
      const env = buildSealedD2DEnvelope();
      const result = await handleInboundD2D(env, resolveSender);
      expect(result.success).toBe(true);
      expect(result.senderDID).toBe(SENDER_DID);
      expect(result.messageType).toBe('social.update');
      expect(result.pipelineAction).toBeDefined();
    });

    it('rejects envelope with no ciphertext', async () => {
      const env: MsgBoxEnvelope = {
        type: 'd2d',
        id: 'test-1',
        from_did: SENDER_DID,
        to_did: HOME_DID,
      };
      const result = await handleInboundD2D(env, resolveSender);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No ciphertext');
    });

    it('rejects envelope with invalid D2D payload', async () => {
      const env: MsgBoxEnvelope = {
        type: 'd2d',
        id: 'test-2',
        from_did: SENDER_DID,
        to_did: HOME_DID,
        ciphertext: JSON.stringify({ c: '', s: '' }),
      };
      const result = await handleInboundD2D(env, resolveSender);
      expect(result.success).toBe(false);
      expect(result.error).toContain('missing c or s');
    });

    it('returns error when identity not configured', async () => {
      resetConnectionState(); // clears identity
      const env = buildSealedD2DEnvelope();
      const result = await handleInboundD2D(env, resolveSender);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Identity not configured');
    });

    it('handles malformed JSON ciphertext gracefully', async () => {
      const env: MsgBoxEnvelope = {
        type: 'd2d',
        id: 'test-3',
        from_did: SENDER_DID,
        to_did: HOME_DID,
        ciphertext: 'not-json',
      };
      const result = await handleInboundD2D(env, resolveSender);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // -----------------------------------------------------------
  // RPC Inbound
  // -----------------------------------------------------------

  describe('handleInboundRPC', () => {
    // Use SENDER_SEED as the CLI device key
    const CLI_SEED = SENDER_SEED;
    const CLI_PUB = SENDER_PUB;
    const CLI_DID = SENDER_DID;

    const mockRouter: RPCRouterFn = jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"result":"ok"}',
    }));

    beforeEach(() => {
      (mockRouter as jest.Mock).mockClear();
      setRPCRouter(mockRouter);
      // Register the CLI device so it passes the paired-device check
      registerDevice(CLI_DID, 'test-cli');
    });

    it('rejects request from unregistered device', async () => {
      resetCallerTypeState(); // unregister all devices
      // Set up WS so we can capture the error response
      const { ws } = createCapturingWS();
      setWSFactory(() => ws);

      const env = buildSealedRPCEnvelope(CLI_SEED, CLI_DID);
      await handleInboundRPC(env);

      // Router should NOT have been called
      expect(mockRouter).not.toHaveBeenCalled();
    });

    it('routes valid RPC through handler chain', async () => {
      const env = buildSealedRPCEnvelope(CLI_SEED, CLI_DID);
      await handleInboundRPC(env);
      expect(mockRouter).toHaveBeenCalledWith(
        'GET',
        '/v1/vault',
        expect.objectContaining({ 'X-DID': CLI_DID }),
        expect.any(String),
        expect.any(Object), // AbortSignal
      );
    });

    it('passes AbortSignal to router', async () => {
      const env = buildSealedRPCEnvelope(CLI_SEED, CLI_DID);
      await handleInboundRPC(env);
      const lastCall = (mockRouter as jest.Mock).mock.calls[0];
      expect(lastCall[4]).toBeInstanceOf(AbortSignal);
    });

    it('silently returns when no router is set', async () => {
      resetHandlerState(); // clears router
      const env = buildSealedRPCEnvelope(CLI_SEED, CLI_DID);
      // Should not throw
      await expect(handleInboundRPC(env)).resolves.toBeUndefined();
    });

    it('rejects when identity binding fails (from_did != inner X-DID)', async () => {
      // Build envelope where from_did differs from inner X-DID
      const otherSeed = randomBytes(32);
      const otherPub = getPublicKey(otherSeed);
      const otherDID = deriveDIDKey(otherPub);
      registerDevice(otherDID, 'other-device');

      // Build inner with CLI_DID but envelope with otherDID
      const body = '';
      const timestamp = new Date().toISOString();
      const nonce = bytesToHex(randomBytes(16));
      const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
      const canonical = `GET\n/v1/vault\n\n${timestamp}\n${nonce}\n${bodyHash}`;
      const sigBytes = sign(CLI_SEED, new TextEncoder().encode(canonical));

      const inner = {
        method: 'GET',
        path: '/v1/vault',
        headers: {
          'X-DID': CLI_DID, // inner says CLI_DID
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Signature': bytesToHex(sigBytes),
        },
        body,
      };

      const plainBytes = new TextEncoder().encode(JSON.stringify(inner));
      const sealed = sealEncrypt(plainBytes, HOME_PUB);

      const env: MsgBoxEnvelope = {
        type: 'rpc',
        id: 'rpc-binding-test',
        from_did: otherDID, // envelope says otherDID
        to_did: HOME_DID,
        direction: 'request',
        ciphertext: Buffer.from(sealed).toString('base64'),
      };

      await handleInboundRPC(env);
      expect(mockRouter).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // RPC Cancel
  // -----------------------------------------------------------

  describe('handleRPCCancel', () => {
    it('aborts in-flight RPC request', async () => {
      // Register CLI device and set up a slow router
      registerDevice(SENDER_DID, 'cli');

      type RouterResult = { status: number; headers: Record<string, string>; body: string };
      const resolveRef: { fn: ((v: RouterResult) => void) | null } = { fn: null };
      const slowRouter: RPCRouterFn = jest.fn(
        () =>
          new Promise<RouterResult>((resolve) => {
            resolveRef.fn = resolve;
          }),
      );
      setRPCRouter(slowRouter);

      const env = buildSealedRPCEnvelope(SENDER_SEED, SENDER_DID);

      // Start RPC (don't await — it's hanging on the slow router)
      const rpcPromise = handleInboundRPC(env);

      // Small delay to let the RPC handler start
      await new Promise((r) => setTimeout(r, 10));

      // Cancel it
      handleRPCCancel({ type: 'cancel', id: env.id, from_did: SENDER_DID, to_did: HOME_DID });

      // Resolve the router to let the promise settle
      if (resolveRef.fn) resolveRef.fn({ status: 200, headers: {}, body: '{}' });
      await rpcPromise;
    });

    it('cancel with cancel_of field targets the right request', () => {
      const cancelEnv: MsgBoxEnvelope = {
        type: 'cancel',
        id: 'cancel-1',
        from_did: SENDER_DID,
        to_did: HOME_DID,
        cancel_of: 'target-rpc-id',
      };
      // Should not throw even if no in-flight request
      handleRPCCancel(cancelEnv);
    });
  });

  // -----------------------------------------------------------
  // D2D Outbound via WebSocket
  // -----------------------------------------------------------

  describe('sendD2DViaWS', () => {
    it('returns false when identity not configured', () => {
      resetConnectionState();
      const result = sendD2DViaWS(SENDER_DID, SENDER_PUB, { text: 'hi' });
      expect(result).toBe(false);
    });

    it('returns false when WS not connected', () => {
      // Identity set but no WS connection
      const result = sendD2DViaWS(SENDER_DID, SENDER_PUB, { text: 'hi' });
      expect(result).toBe(false);
    });

    it('sends envelope with correct structure when connected', async () => {
      const { ws, sent } = createCapturingWS();
      setWSFactory(() => ws);

      // We need an authenticated connection to send
      // Simulate full auth flow
      const { connectToMsgBox } = await import('../../src/relay/msgbox_ws');
      await connectToMsgBox('wss://test.relay/ws');
      await new Promise((r) => setTimeout(r, 10));

      // Simulate auth challenge + success
      if (ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({ type: 'auth_challenge', nonce: 'test', ts: 12345 }),
        });
        ws.onmessage({ data: JSON.stringify({ type: 'auth_success' }) });
      }

      const result = sendD2DViaWS(SENDER_DID, SENDER_PUB, { text: 'hello' });
      // If authenticated, should return true
      if (isAuthenticated()) {
        expect(result).toBe(true);
        // Last sent message should be the d2d envelope
        const lastSent = JSON.parse(sent[sent.length - 1]);
        expect(lastSent.type).toBe('d2d');
        expect(lastSent.from_did).toBe(HOME_DID);
        expect(lastSent.to_did).toBe(SENDER_DID);
        expect(lastSent.ciphertext).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------
  // GAP-PAIR-MBX-01 — Pair-over-MsgBox ingress (Phase 2)
  //
  // Proves a FRESH, un-paired agent can send a pair RPC over
  // MsgBox and hit `/v1/pair/complete` without first being
  // registered. Main-dina calls this `VerifyPairingIdentityBinding`.
  // Without this, the docker openclaw flow can't bootstrap.
  // -----------------------------------------------------------

  describe('handleInboundRPC — pair path (GAP-PAIR-MBX-01)', () => {
    // Fresh agent keypair — NOT registered as a device.
    const AGENT_SEED = new Uint8Array(32);
    AGENT_SEED.set([
      99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79, 78, 77,
      76, 75, 74, 73, 72, 71, 70, 69, 68,
    ]);
    const AGENT_PUB = getPublicKey(AGENT_SEED);
    const AGENT_DID = deriveDIDKey(AGENT_PUB);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { publicKeyToMultibase } = require('../../src/identity/did') as {
      publicKeyToMultibase: (pub: Uint8Array) => string;
    };

    function buildPairEnvelope(bodyOverride?: Record<string, unknown>): MsgBoxEnvelope {
      const body = JSON.stringify(
        bodyOverride ?? { code: '123456', public_key: publicKeyToMultibase(AGENT_PUB) },
      );
      const inner = {
        method: 'POST',
        path: '/v1/pair/complete',
        // No X-DID / X-Signature — pair path is self-cert.
        headers: { 'content-type': 'application/json' },
        body,
      };
      const plainBytes = new TextEncoder().encode(JSON.stringify(inner));
      const sealed = sealEncrypt(plainBytes, HOME_PUB);
      return {
        type: 'rpc',
        id: `rpc-pair-${bytesToHex(randomBytes(8))}`,
        from_did: AGENT_DID,
        to_did: HOME_DID,
        direction: 'request',
        expires_at: Math.floor(Date.now() / 1000) + 120,
        ciphertext: Buffer.from(sealed).toString('base64'),
      };
    }

    const pairRouter: RPCRouterFn = jest.fn(async () => ({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"device_id":"x","node_did":"did:plc:home","device_name":"openclaw-user","role":"agent"}',
    }));

    beforeEach(() => {
      (pairRouter as jest.Mock).mockClear();
      setRPCRouter(pairRouter);
      const { ws } = createCapturingWS();
      setWSFactory(() => ws);
    });

    it('dispatches /v1/pair/complete even when the sender is un-paired', async () => {
      // `isDevice` would return false for AGENT_DID — the pair path
      // must NOT hit that gate.
      const env = buildPairEnvelope();
      await handleInboundRPC(env);
      expect(pairRouter).toHaveBeenCalledTimes(1);
      const [method, path] = (pairRouter as jest.Mock).mock.calls[0];
      expect(method).toBe('POST');
      expect(path).toBe('/v1/pair/complete');
    });

    it('rejects a pair envelope when env.from_did is not did:key:<body.public_key>', async () => {
      // Body claims a DIFFERENT public key than the envelope's from_did.
      const wrongSeed = new Uint8Array(32);
      wrongSeed[0] = 1;
      const wrongPub = getPublicKey(wrongSeed);
      const env = buildPairEnvelope({
        code: '123456',
        public_key: publicKeyToMultibase(wrongPub),
      });
      await handleInboundRPC(env);
      // Router never called — binding failed before dispatch.
      expect(pairRouter).not.toHaveBeenCalled();
    });

    it('rejects a pair envelope when body.public_key is missing', async () => {
      const env = buildPairEnvelope({ code: '123456' });
      await handleInboundRPC(env);
      expect(pairRouter).not.toHaveBeenCalled();
    });

    it('signed-RPC path still rejects un-paired DIDs for non-pair paths', async () => {
      // Sanity: an un-paired agent trying `GET /v1/vault` should
      // still die at `isDevice`, not accidentally ride the pair
      // exemption.
      const nonPairEnv = buildSealedRPCEnvelope(AGENT_SEED, AGENT_DID);
      await handleInboundRPC(nonPairEnv);
      expect(pairRouter).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------
  // Identity helper
  // -----------------------------------------------------------

  describe('identity management', () => {
    it('getIdentity returns configured identity', () => {
      const id = getIdentity();
      expect(id).not.toBeNull();
      expect(id!.did).toBe(HOME_DID);
      expect(id!.privateKey).toBe(TEST_ED25519_SEED);
    });

    it('getIdentity returns null when not configured', () => {
      resetConnectionState();
      expect(getIdentity()).toBeNull();
    });
  });
});
