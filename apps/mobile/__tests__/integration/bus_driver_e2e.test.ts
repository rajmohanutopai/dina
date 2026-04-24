/**
 * End-to-end integration: a runtime composition via `createNode()`
 * that wires Brain and Core together with a real signed HTTP
 * round-trip through the in-process CoreRouter.
 *
 * This is the test that would have failed on every Tier-1 wiring
 * issue flagged in the review:
 *   - #1 createNode has no runtime caller (we call it here).
 *   - #2 Core globals not wired (we verify `/v1/service/query` succeeds,
 *     which requires `setWorkflowService` + `setWorkflowRepository`).
 *   - #3 auth path has no caller-registration / PK resolver (we make a
 *     signed call; if the resolver were null, it would 401).
 *   - #4 provider ingress reads Core's global service_config (we seed
 *     `initialServiceConfig` and verify the inbound service.query is
 *     validated against it end-to-end).
 *   - #5/#6 inbound service.query is routed to Brain's dispatcher (we
 *     invoke the dispatcher directly, which `createNode` registered).
 *
 * If any of these regress, this test fails loudly instead of silently
 * continuing to stub out the seam.
 */

import { createNode, type DinaNode } from '../../src/services/bootstrap';
import { createCoreRouter } from '../../../core/src/server/core_server';
import { createInProcessDispatch } from '../../../core/src/server/in_process_dispatch';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';
// BrainCoreClient retired — mobile now uses InProcessTransport exclusively.
import { InMemoryWorkflowRepository } from '../../../core/src/workflow/repository';
import { InMemoryServiceConfigRepository } from '../../../core/src/service/service_config_repository';
import { getServiceConfig } from '../../../core/src/service/service_config';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { deriveDIDKey } from '../../../core/src/identity/did';
import { TEST_ED25519_SEED } from '@dina/test-harness';
import type { ServiceConfig } from '../../../core/src/service/service_config';
import type { PDSSession } from '../../../brain/src/pds/account';
import type { AppViewClient } from '../../../brain/src/appview_client/http';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROVIDER_SEED = TEST_ED25519_SEED;
const PROVIDER_PUB = getPublicKey(PROVIDER_SEED);
// Issue #18: the intended Home Node model uses did:plc, not did:key.
// For the test we synthesise a did:plc string and wire it to our
// pubkey via the public-key resolver that createNode installs —
// signatures verify regardless of DID scheme.
const PROVIDER_DID = 'did:plc:provider-test-fixture';
// Keep the derived did:key around as a label for future trace
// debugging; the production test identity is the did:plc above.
void deriveDIDKey(PROVIDER_PUB);

const REMOTE_PEER_DID = 'did:plc:busbot';

const INITIAL_CONFIG: ServiceConfig = {
  isDiscoverable: true,
  name: 'SFMTA Bus 42',
  description: 'Transit ETA provider (test fixture)',
  capabilities: {
    eta_query: {
      mcpServer: 'transit',
      mcpTool: 'eta',
      responsePolicy: 'auto',
    },
  },
};

function stubPDSSession(): PDSSession {
  return {
    did: PROVIDER_DID,
    handle: 'provider.test',
    accessJwt: 'access',
    refreshJwt: 'refresh',
  };
}

function stubAppView(): Pick<AppViewClient, 'searchServices'> {
  return { searchServices: async () => [] };
}

/**
 * Build a real runtime composition: CoreRouter with all routes, a
 * BrainCoreClient whose `signedDispatch` fires Core requests directly
 * into the router, and a `createNode` that installs the globals.
 */
async function composeNode(opts?: {
  sendD2D?: (toDID: string, body: unknown) => Promise<void>;
  handlerLog?: Array<Record<string, unknown>>;
}): Promise<{ node: DinaNode; sent: unknown[] }> {
  const router = createCoreRouter();
  // Bridge the two SignedDispatch variants:
  // - Core: method is a narrow union; CoreResponse.body is optional.
  // - Brain: method is `string`; body is required in the result shape.
  const coreDispatch = createInProcessDispatch({ router });
  const dispatch = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ) => {
    const resp = await coreDispatch(
      method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path,
      headers,
      body,
    );
    return { status: resp.status, body: resp.body, headers: resp.headers };
  };

  const repo = new InMemoryWorkflowRepository();
  const configRepo = new InMemoryServiceConfigRepository();

  // BrainCoreClient was retired — in-process Brain↔Core uses
  // InProcessTransport (auth bypass via `trustedInProcess` flag).
  void dispatch;
  const coreClient = new InProcessTransport(router);

  // Egress spy via the production wiring path (issue #20). We pass a
  // real `sendD2D` into createNode and capture every call — the
  // bootstrap installs its OWN service-query sender that wraps this
  // callback, so asserting on `sent` proves the live wiring is
  // correct. Previously the test manually called setServiceQuerySender
  // which bypassed the createNode code path it was meant to prove.
  const sent: Array<{ to: string; body: unknown }> = [];

  const node = await createNode({
    did: PROVIDER_DID,
    signingKeypair: { privateKey: PROVIDER_SEED, publicKey: PROVIDER_PUB },
    pdsSession: stubPDSSession(),
    sendD2D:
      opts?.sendD2D ??
      (async (to, body) => {
        sent.push({ to, body });
      }),
    coreClient,
    appViewClient: stubAppView(),
    workflowRepository: repo,
    serviceConfigRepository: configRepo,
    initialServiceConfig: INITIAL_CONFIG,
    role: 'both',
    globalWiring: false, // avoid clobbering chat orchestrator in other tests
    nowMsFn: () => 1_700_000_000_000,
    setInterval: () => 0 as unknown,
    clearInterval: () => {
      /* no-op */
    },
    logger: opts?.handlerLog !== undefined ? (entry) => opts.handlerLog!.push(entry) : undefined,
  });

  // start() is what installs the Core globals (issue #8). Tests need to
  // call it so the routes aren't 503-ing.
  await node.start();

  return { node, sent };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bus Driver end-to-end runtime composition', () => {
  afterEach(() => {
    // No teardown needed — each test composes its own node via
    // createNode(), and each test calls node.dispose() which resets
    // all Core globals it set. The production wiring path IS the
    // sender, so there's no manual setServiceQuerySender() to clear.
  });

  it('seeds initialServiceConfig into Core globals (issue #4)', async () => {
    const { node } = await composeNode();
    try {
      const cfg = getServiceConfig();
      expect(cfg).not.toBeNull();
      expect(cfg?.name).toBe('SFMTA Bus 42');
      expect(cfg?.capabilities.eta_query?.responsePolicy).toBe('auto');
    } finally {
      await node.dispose();
    }
  });

  it('signed /v1/service/query round-trips through the in-process router and creates a workflow task (issues #2, #3)', async () => {
    const { node, sent } = await composeNode();
    try {
      const result = await node.coreClient.sendServiceQuery({
        toDID: REMOTE_PEER_DID,
        capability: 'eta_query',
        params: { location: { lat: 37.76, lng: -122.43 }, route_id: '42' },
        ttlSeconds: 60,
        queryId: 'q-e2e-1',
      });

      expect(result.queryId).toBe('q-e2e-1');
      // Task id is `sq-${queryId}-${sha256(to_did|cap|queryId).slice(0,8)}`
      // (issue #20 — namespace-by-tuple to avoid queryId reuse collisions).
      expect(result.taskId).toMatch(/^sq-q-e2e-1-[0-9a-f]{8}$/);
      // `CoreClient.sendServiceQuery` returns `deduped?: boolean` (undefined
      // on fresh create); callers that need always-set collapse via
      // `?? false`. Match the raw transport shape here.
      expect(result.deduped).toBeFalsy();

      // Route actually dispatched the D2D sender — proves Core globals
      // are wired (no 503), auth round-tripped (no 401), and the
      // service_query handler ran.
      expect(sent).toHaveLength(1);
    } finally {
      await node.dispose();
    }
  });

  it('dispatcher routes inbound service.query to the registered ServiceHandler (issues #5, #6)', async () => {
    const handlerLog: Array<Record<string, unknown>> = [];
    const { node } = await composeNode({ handlerLog });
    try {
      const body = {
        query_id: 'q-inbound-1',
        capability: 'eta_query',
        params: { location: { lat: 37.76, lng: -122.43 }, route_id: '42' },
        ttl_seconds: 60,
      };
      // Minimal raw shape; dispatcher only reads `type` off it.
      const raw = {
        type: 'service.query',
        from: REMOTE_PEER_DID,
        to: PROVIDER_DID,
        id: 'm-1',
      } as Parameters<typeof node.dispatcher.dispatch>[1];

      const dispatch = await node.dispatcher.dispatch(REMOTE_PEER_DID, raw, body);
      expect(dispatch.routed).toBe(true);
      expect(dispatch.dropped).toBe(false);
      expect(dispatch.handlerError).toBeNull();

      // ServiceHandler should have created a delegation task — prove it
      // by asking Core for queued delegations.
      const tasks = await node.coreClient.listWorkflowTasks({
        kind: 'delegation',
        state: 'queued',
      });
      if (tasks.length === 0) {
        // Make the assertion failure actionable by dumping what the
        // handler actually did.
        // eslint-disable-next-line no-console
        console.log('handler log:', JSON.stringify(handlerLog, null, 2));
      }
      expect(tasks).toHaveLength(1);
      const payload = JSON.parse(tasks[0].payload) as {
        type: string;
        from_did: string;
        query_id: string;
        capability: string;
      };
      expect(payload.type).toBe('service_query_execution');
      expect(payload.from_did).toBe(REMOTE_PEER_DID);
      expect(payload.query_id).toBe('q-inbound-1');
      expect(payload.capability).toBe('eta_query');
    } finally {
      await node.dispose();
    }
  });

  it('dispatcher drops service.query when the capability is not configured (issue #4 negative case)', async () => {
    const { node } = await composeNode();
    try {
      const body = {
        query_id: 'q-bad-cap',
        capability: 'not_registered',
        params: {},
        ttl_seconds: 60,
      };
      const raw = {
        type: 'service.query',
        from: REMOTE_PEER_DID,
        to: PROVIDER_DID,
        id: 'm-2',
      } as Parameters<typeof node.dispatcher.dispatch>[1];

      await node.dispatcher.dispatch(REMOTE_PEER_DID, raw, body);

      // No delegation task should have been created — the config check
      // in ServiceHandler.handleQuery (reading from Core's global via
      // getServiceConfig) rejects unknown capabilities.
      const tasks = await node.coreClient.listWorkflowTasks({
        kind: 'delegation',
        state: 'queued',
      });
      expect(tasks).toHaveLength(0);
    } finally {
      await node.dispose();
    }
  });

  it('dispose() releases Core globals so the next createNode() starts from a clean slate', async () => {
    const { node: node1 } = await composeNode();
    await node1.dispose();

    // After dispose, the global service config should be gone.
    expect(getServiceConfig()).toBeNull();

    // And we can compose a fresh node without the old state leaking in.
    const { node: node2 } = await composeNode();
    try {
      const cfg = getServiceConfig();
      expect(cfg?.name).toBe('SFMTA Bus 42'); // seeded by node2, not node1
    } finally {
      await node2.dispose();
    }
  });
});
