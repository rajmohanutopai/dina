/**
 * PLG-31 #1 — a connector may not originate an OWNER-DIRECT remember.
 *
 * `source: 'user_remember'` is the owner's typed remember; the brain drain
 * treats it as owner-direct and BYPASSES the locked-persona approval gate.
 * `/v1/staging/ingest` is allowlisted to `{brain, connector}`, so without a
 * finer check a connector (an external push source) could smuggle
 * `user_remember` — in the `source` field OR a `data.source` the drain reads
 * first — and land content in a locked persona with no owner approval.
 *
 * These tests drive the REAL signed-auth path (not an injected callerType) so
 * they prove the whole chain: the router threads the fine-grained authz role
 * (`connector` vs `brain`, which both resolve to `callerType:service`) onto the
 * request, and the staging route rejects the connector while letting the brain
 * through.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { registerService, resetCallerTypeState } from '../../src/auth/caller_type';
import { signRequest } from '../../src/auth/canonical';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../src/auth/middleware';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { createCoreRouter } from '../../src/server/core_server';
import { type CoreRequest } from '../../src/server/router';
import { resetStagingState } from '../../src/staging/service';
import { InMemoryWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const BRAIN_SEED = TEST_ED25519_SEED;
const BRAIN_PUB = getPublicKey(BRAIN_SEED);
const BRAIN_DID = deriveDIDKey(BRAIN_PUB);

// A distinct keypair for the connector — any other 32-byte seed.
const CONN_SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const CONN_PUB = getPublicKey(CONN_SEED);
const CONN_DID = deriveDIDKey(CONN_PUB);

function signedIngest(
  seed: Uint8Array,
  did: string,
  bodyObj: Record<string, unknown>,
): CoreRequest {
  const raw = new TextEncoder().encode(JSON.stringify(bodyObj));
  const headers = signRequest('POST', '/v1/staging/ingest', '', raw, seed, did);
  return {
    method: 'POST',
    path: '/v1/staging/ingest',
    query: {},
    headers: {
      'x-did': headers['X-DID'],
      'x-timestamp': headers['X-Timestamp'],
      'x-nonce': headers['X-Nonce'],
      'x-signature': headers['X-Signature'],
    },
    body: bodyObj,
    rawBody: raw,
    params: {},
  };
}

describe('staging ingest — owner-direct provenance authz (PLG-31 #1)', () => {
  beforeEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
    resetStagingState();
    const workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowRepository(workflowRepo);
    setWorkflowService(new WorkflowService({ repository: workflowRepo }));
    registerPublicKeyResolver((d) =>
      d === BRAIN_DID ? BRAIN_PUB : d === CONN_DID ? CONN_PUB : null,
    );
    registerService(BRAIN_DID, 'brain');
    registerService(CONN_DID, 'connector');
  });

  afterEach(() => {
    resetStagingState();
    setWorkflowService(null);
    setWorkflowRepository(null);
  });

  it('BLOCKS a connector claiming source=user_remember (403)', async () => {
    const router = createCoreRouter();
    const resp = await router.handle(
      signedIngest(CONN_SEED, CONN_DID, {
        source: 'user_remember',
        source_id: 'conn-owner-direct-1',
        data: { body: 'remember my ssn is 123' },
      }),
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toMatch(/owner-direct/i);
  });

  it('BLOCKS a connector smuggling source=user_remember inside data.source (403)', async () => {
    // The brain drain reads `data.source ?? item.source` — so a benign outer
    // `source` with an owner-direct `data.source` is the same bypass.
    const router = createCoreRouter();
    const resp = await router.handle(
      signedIngest(CONN_SEED, CONN_DID, {
        source: 'gmail',
        source_id: 'conn-owner-direct-2',
        data: { source: 'user_remember', body: 'remember my ssn is 123' },
      }),
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toMatch(/owner-direct/i);
  });

  it('ALLOWS the brain to originate source=user_remember (201)', async () => {
    // The brain is the legitimate producer of the owner's typed remember —
    // blocking it would break /remember. It resolves to authzRole=brain.
    const router = createCoreRouter();
    const resp = await router.handle(
      signedIngest(BRAIN_SEED, BRAIN_DID, {
        source: 'user_remember',
        source_id: 'brain-owner-direct-1',
        data: { body: 'remember Emma likes dinosaurs' },
      }),
    );
    expect(resp.status).toBe(201);
    expect((resp.body as { status: string }).status).toBe('received');
  });

  it('ALLOWS a connector to ingest a NON-owner-direct source (201)', async () => {
    // The connector lane itself is legitimate — only owner-direct provenance
    // is off-limits. A normal push source stages fine.
    const router = createCoreRouter();
    const resp = await router.handle(
      signedIngest(CONN_SEED, CONN_DID, {
        source: 'gmail',
        source_id: 'conn-normal-1',
        data: { body: 'flight confirmation AA123' },
      }),
    );
    expect(resp.status).toBe(201);
    expect((resp.body as { status: string }).status).toBe('received');
  });

  it('stamps producer_id from the authenticated caller DID, not the body', async () => {
    // PLG-31 #1: provenance is the AUTHENTICATED DID — a body `producer_id`
    // cannot forge it.
    const router = createCoreRouter();
    const resp = await router.handle(
      signedIngest(CONN_SEED, CONN_DID, {
        source: 'gmail',
        source_id: 'conn-producer-1',
        producer_id: 'did:key:zForgedBrain',
        data: { body: 'receipt' },
      }),
    );
    expect(resp.status).toBe(201);
    // The staged row's producer_id is the connector's real DID.
    const { getItem } = await import('../../src/staging/service');
    const id = (resp.body as { id: string }).id;
    expect(getItem(id)?.producer_id).toBe(CONN_DID);
  });
});
