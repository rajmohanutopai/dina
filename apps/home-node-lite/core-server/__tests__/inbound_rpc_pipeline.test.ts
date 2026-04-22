/**
 * Task 4.41 — inbound RPC pipeline tests.
 *
 * End-to-end coverage: sender seals a CoreRPCRequest → handleInboundRpc
 * runs unseal → idempotency → dispatch (through the real Fastify
 * chain) → re-seal → returns sealed bytes the sender can open. The
 * test uses actual Ed25519 keypairs + the @dina/core seal helpers as
 * the counter-party, so we exercise the full crypto path.
 */

import { pino } from 'pino';
import {
  RPC_REQUEST_TYPE,
  RPC_RESPONSE_TYPE,
  type CoreRPCRequest,
} from '@dina/protocol';
import {
  generateMnemonic,
  mnemonicToSeed,
  sealDecrypt,
  sealRPCRequest,
  verifyResponseSignature,
  type CoreRPCResponse,
} from '@dina/core';

import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { deriveIdentity } from '../src/identity/derivations';
import { CancelRegistry } from '../src/msgbox/cancel_registry';
import { IdempotencyCache } from '../src/msgbox/idempotency_cache';
import {
  handleInboundRpc,
  type InboundRpcContext,
  type InboundRpcEvent,
} from '../src/msgbox/inbound_rpc_pipeline';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

function fresh() {
  return deriveIdentity({ masterSeed: mnemonicToSeed(generateMnemonic()) });
}

const CORE_DID = 'did:plc:core';
const SENDER_DID = 'did:plc:sender';

function buildRequest(overrides: Partial<CoreRPCRequest> = {}): CoreRPCRequest {
  return {
    type: RPC_REQUEST_TYPE,
    request_id: 'req-1',
    from: SENDER_DID,
    method: 'GET',
    path: '/healthz',
    query: '',
    headers: {},
    body: '',
    ...overrides,
  };
}

interface Scenario {
  ctx: InboundRpcContext;
  coreKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
  senderKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
  events: InboundRpcEvent[];
  closeApp: () => Promise<void>;
}

async function buildScenario(
  overrides: {
    knownSenders?: Map<string, Uint8Array>;
    idempotency?: IdempotencyCache;
  } = {},
): Promise<Scenario> {
  const coreKeys = fresh().root;
  const senderKeys = fresh().root;
  const knownSenders =
    overrides.knownSenders ?? new Map([[SENDER_DID, senderKeys.publicKey]]);
  const idempotency =
    overrides.idempotency ?? new IdempotencyCache({ ttlMs: 5 * 60 * 1000 });
  const cancels = new CancelRegistry();
  const events: InboundRpcEvent[] = [];
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });

  const ctx: InboundRpcContext = {
    coreDid: CORE_DID,
    corePrivateKey: coreKeys.privateKey,
    corePublicKey: coreKeys.publicKey,
    resolveSenderPubkey: (did) => knownSenders.get(did) ?? null,
    app,
    idempotency,
    cancels,
    onEvent: (e) => events.push(e),
  };

  return {
    ctx,
    coreKeys,
    senderKeys,
    events,
    closeApp: () => app.close(),
  };
}

/**
 * Open a sealed response envelope + verify its signature against the
 * supplied Core public key. Returns the parsed `CoreRPCResponse`.
 */
function openSealed(
  sealed: Uint8Array,
  senderPriv: Uint8Array,
  senderPub: Uint8Array,
  corePub: Uint8Array,
): CoreRPCResponse {
  // sealDecrypt signature: (ciphertext, recipientPub, recipientPriv).
  const plaintext = sealDecrypt(sealed, senderPub, senderPriv);
  const text = new TextDecoder().decode(plaintext);
  const parsed = JSON.parse(text) as CoreRPCResponse;
  // Verify the signature — uses the helper re-exported from @dina/core.
  const sigOk = verifyResponseSignature(parsed, corePub);
  if (!sigOk) throw new Error('signature verification failed');
  return parsed;
}

describe('handleInboundRpc (task 4.41)', () => {
  describe('happy path', () => {
    it('unseals → dispatches → seals a signed response', async () => {
      const s = await buildScenario();
      const sealed = sealRPCRequest(buildRequest(), s.coreKeys.publicKey);

      const result = await handleInboundRpc(sealed, s.ctx);
      expect(result).not.toBeNull();
      const response = openSealed(
        result!.sealed,
        s.senderKeys.privateKey,
        s.senderKeys.publicKey,
        s.coreKeys.publicKey,
      );
      expect(response.type).toBe(RPC_RESPONSE_TYPE);
      expect(response.request_id).toBe('req-1');
      expect(response.from).toBe(CORE_DID);
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as { status: string };
      expect(body.status).toBe('ok');

      expect(s.events.map((e) => e.kind)).toEqual(['dispatched', 'completed']);
      await s.closeApp();
    });

    it('404 path seals a 404 response', async () => {
      const s = await buildScenario();
      const sealed = sealRPCRequest(
        buildRequest({ path: '/does-not-exist' }),
        s.coreKeys.publicKey,
      );
      const result = await handleInboundRpc(sealed, s.ctx);
      const response = openSealed(
        result!.sealed,
        s.senderKeys.privateKey,
        s.senderKeys.publicKey,
        s.coreKeys.publicKey,
      );
      expect(response.status).toBe(404);
      await s.closeApp();
    });
  });

  describe('idempotency cache', () => {
    it('second call with same (sender, request_id) returns cached structured response', async () => {
      const s = await buildScenario();
      const sealed = sealRPCRequest(buildRequest(), s.coreKeys.publicKey);

      const first = await handleInboundRpc(sealed, s.ctx);
      expect(first).not.toBeNull();
      const second = await handleInboundRpc(sealed, s.ctx);
      expect(second).not.toBeNull();

      // Ciphertext is distinct (fresh ephemeral per seal) but plaintext is identical.
      expect(first!.sealed).not.toEqual(second!.sealed);
      const firstBody = openSealed(
        first!.sealed,
        s.senderKeys.privateKey,
        s.senderKeys.publicKey,
        s.coreKeys.publicKey,
      );
      const secondBody = openSealed(
        second!.sealed,
        s.senderKeys.privateKey,
        s.senderKeys.publicKey,
        s.coreKeys.publicKey,
      );
      expect(secondBody.body).toBe(firstBody.body);
      expect(secondBody.status).toBe(firstBody.status);

      // Second call should have emitted idempotency_hit, no dispatched/completed.
      const secondEvents = s.events.slice(s.events.findIndex((e) => e.kind === 'completed') + 1);
      expect(secondEvents.map((e) => e.kind)).toEqual(['idempotency_hit']);
      await s.closeApp();
    });
  });

  describe('unseal failures', () => {
    it('wrong recipient key → null + unseal_failed event', async () => {
      const s = await buildScenario();
      const wrongCore = fresh().root;
      const sealed = sealRPCRequest(buildRequest(), wrongCore.publicKey);

      const result = await handleInboundRpc(sealed, s.ctx);
      expect(result).toBeNull();
      expect(s.events[0]?.kind).toBe('unseal_failed');
      await s.closeApp();
    });

    it('garbled bytes → null + unseal_failed', async () => {
      const s = await buildScenario();
      const garbled = new Uint8Array(48); // too short + random
      const result = await handleInboundRpc(garbled, s.ctx);
      expect(result).toBeNull();
      expect(s.events.some((e) => e.kind === 'unseal_failed')).toBe(true);
      await s.closeApp();
    });
  });

  describe('unknown sender', () => {
    it('emits sender_unknown + returns null (no sealed response)', async () => {
      const s = await buildScenario({
        knownSenders: new Map(), // no known senders
      });
      const sealed = sealRPCRequest(buildRequest(), s.coreKeys.publicKey);
      const result = await handleInboundRpc(sealed, s.ctx);
      expect(result).toBeNull();
      expect(s.events.map((e) => e.kind)).toEqual(['sender_unknown']);
      await s.closeApp();
    });
  });

  describe('cancel integration', () => {
    it('registers the request in CancelRegistry during dispatch + unregisters after', async () => {
      const s = await buildScenario();
      const sealed = sealRPCRequest(
        buildRequest({ request_id: 'cancel-test' }),
        s.coreKeys.publicKey,
      );
      await handleInboundRpc(sealed, s.ctx);
      // After dispatch + sealing, the registry should have no entry.
      expect(s.ctx.cancels.size()).toBe(0);
      await s.closeApp();
    });
  });

  describe('full chain engagement (task 4.46 wiring)', () => {
    it('tunnelled 404 flows through Fastify error handler + envelope', async () => {
      const s = await buildScenario();
      const sealed = sealRPCRequest(
        buildRequest({ path: '/ghost' }),
        s.coreKeys.publicKey,
      );
      const result = await handleInboundRpc(sealed, s.ctx);
      const response = openSealed(
        result!.sealed,
        s.senderKeys.privateKey,
        s.senderKeys.publicKey,
        s.coreKeys.publicKey,
      );
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: 'not found' });
      await s.closeApp();
    });
  });

  describe('response signature binds to request_id', () => {
    it('signature over canonical {requestId, status, body} verifies', async () => {
      const s = await buildScenario();
      const sealed = sealRPCRequest(
        buildRequest({ request_id: 'sig-check-42' }),
        s.coreKeys.publicKey,
      );
      const result = await handleInboundRpc(sealed, s.ctx);
      // openSealed throws if the signature doesn't verify — its
      // successful return IS the signature-verification pin.
      const response = openSealed(
        result!.sealed,
        s.senderKeys.privateKey,
        s.senderKeys.publicKey,
        s.coreKeys.publicKey,
      );
      expect(response.request_id).toBe('sig-check-42');
      await s.closeApp();
    });
  });
});
