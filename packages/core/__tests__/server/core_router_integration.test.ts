/**
 * Router-level integration tests — the service-discovery critical path served
 * by the pure CoreRouter (no Express, no HTTP).
 *
 * Replaces the family of supertest-based endpoint tests (vault / pii /
 * devices / staging / service_* / workflow_*) that were deleted when
 * Express was removed from the mobile path. Where a specific scenario
 * still deserves coverage, it appears here as a direct
 * `router.handle(req)` call.
 *
 * Coverage intent:
 *   - healthz is public (no auth)
 *   - unsigned requests 401 regardless of path existence
 *   - signed but unauthorized caller types get 403
 *   - workflow task create + lookup round-trips
 *   - agent-role devices can hit the /v1/workflow/tasks/claim subtree
 *   - service_query dedup + service_respond completion contract
 *   - pii scrub + service_config round-trip
 */

import { createCoreRouter } from '../../src/server/core_server';
import type { CoreRequest, CoreResponse } from '../../src/server/router';
import { signRequest } from '../../src/auth/canonical';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../src/auth/middleware';
import {
  registerDevice as registerDeviceDID,
  registerService,
  resetCallerTypeState,
  setDeviceRoleResolver,
} from '../../src/auth/caller_type';
import { InMemoryWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService, getWorkflowService } from '../../src/workflow/service';
import type { WorkflowTask } from '../../src/workflow/domain';
import { WorkflowTaskState } from '../../src/workflow/domain';
import { setServiceQuerySender } from '../../src/server/routes/service_query';
import { setServiceRespondSender } from '../../src/server/routes/service_respond';
import {
  clearServiceConfig,
  resetServiceConfigState,
  setServiceConfig,
} from '../../src/service/service_config';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import { setNodeDID } from '../../src/pairing/ceremony';
import {
  setServiceGrantRepository,
  type ServiceGrant,
} from '../../src/service/service_grant_repository';
import { TEST_ED25519_SEED } from '@dina/test-harness';
import { randomBytes } from '@noble/ciphers/utils.js';

interface Actor {
  did: string;
  seed: Uint8Array;
  pub: Uint8Array;
}

function makeActor(seed: Uint8Array): Actor {
  const pub = getPublicKey(seed);
  return { did: deriveDIDKey(pub), seed, pub };
}

function splitPQ(url: string): [string, string] {
  const i = url.indexOf('?');
  return i >= 0 ? [url.slice(0, i), url.slice(i + 1)] : [url, ''];
}

function parseQuery(qs: string): Record<string, string> {
  if (qs === '') return {};
  const q: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) q[decodeURIComponent(pair)] = '';
    else q[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  return q;
}

function signedReq(
  method: CoreRequest['method'],
  url: string,
  body: unknown,
  actor: Actor,
): CoreRequest {
  const [path, queryString] = splitPQ(url);
  const query = parseQuery(queryString);
  const bodyBytes =
    body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
  const headers = signRequest(method, path, queryString, bodyBytes, actor.seed, actor.did);
  return {
    method,
    path,
    query,
    headers: {
      'x-did': headers['X-DID'],
      'x-timestamp': headers['X-Timestamp'],
      'x-nonce': headers['X-Nonce'],
      'x-signature': headers['X-Signature'],
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : body,
    rawBody: bodyBytes,
    params: {},
  };
}

function unsignedReq(method: CoreRequest['method'], path: string): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(0),
    params: {},
  };
}

describe('CoreRouter integration', () => {
  let brain: Actor;
  let agent: Actor;
  let router: ReturnType<typeof createCoreRouter>;

  beforeEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
    resetServiceConfigState();
    clearServiceConfig();

    brain = makeActor(TEST_ED25519_SEED);
    agent = makeActor(randomBytes(32));

    registerPublicKeyResolver((d) => {
      if (d === brain.did) return brain.pub;
      if (d === agent.did) return agent.pub;
      return null;
    });
    registerService(brain.did, 'brain');
    registerDeviceDID(agent.did, 'agent-1');
    const repo = new InMemoryWorkflowRepository();
    setWorkflowRepository(repo);
    setWorkflowService(new WorkflowService({ repository: repo }));

    router = createCoreRouter();
    // `createCoreRouter` wires its own device-role resolver (reads from
    // `devices/registry`). Override it AFTER router construction so the
    // test's lightweight test-only resolver wins — without this the
    // production resolver returns null for the test agent (it uses the
    // caller_type registry, not devices/registry) and every claim 403s.
    setDeviceRoleResolver((d) => (d === agent.did ? 'agent' : null));
  });

  afterAll(() => {
    setWorkflowRepository(null);
    setWorkflowService(null);
    setServiceQuerySender(null);
    setServiceRespondSender(null);
    resetMiddlewareState();
    resetCallerTypeState();
  });

  // -------------------------------------------------------------------------
  // Public + auth-gate basics
  // -------------------------------------------------------------------------

  describe('healthz', () => {
    it('is public — unsigned GET returns 200', async () => {
      const resp = await router.handle(unsignedReq('GET', '/healthz'));
      expect(resp.status).toBe(200);
      expect((resp.body as { status: string }).status).toBe('ok');
    });
  });

  describe('auth gating', () => {
    it('returns 401 for any unsigned non-public request', async () => {
      const resp = await router.handle(unsignedReq('GET', '/v1/workflow/tasks'));
      expect(resp.status).toBe(401);
    });

    it('returns 401 for unsigned request to a path that does not exist', async () => {
      const resp = await router.handle(unsignedReq('GET', '/v1/absolutely-nothing'));
      expect(resp.status).toBe(401);
    });

    it('returns 404 for signed request to a path that does not exist', async () => {
      const req = signedReq('GET', '/v1/absolutely-nothing', undefined, brain);
      const resp = await router.handle(req);
      // Path doesn't match → 404 (auth passed; no route).
      // NOTE: authz may deny first; the important invariant is "not 200".
      expect(resp.status).toBeGreaterThanOrEqual(400);
    });
  });

  // -------------------------------------------------------------------------
  // Workflow tasks — CRUD round-trips
  // -------------------------------------------------------------------------

  describe('workflow tasks CRUD', () => {
    it('POST + GET round-trip', async () => {
      const createReq = signedReq(
        'POST',
        '/v1/workflow/tasks',
        {
          id: 'test-task-1',
          kind: 'generic',
          description: 'test',
          payload: '{}',
        },
        brain,
      );
      const createResp = await router.handle(createReq);
      expect(createResp.status).toBe(201);

      const getReq = signedReq('GET', '/v1/workflow/tasks/test-task-1', undefined, brain);
      const getResp = await router.handle(getReq);
      expect(getResp.status).toBe(200);
      expect((getResp.body as { task: WorkflowTask }).task.id).toBe('test-task-1');
    });

    it('GET missing task returns 404', async () => {
      const resp = await router.handle(
        signedReq('GET', '/v1/workflow/tasks/nope', undefined, brain),
      );
      expect(resp.status).toBe(404);
    });

    it('LIST by kind + state returns the tasks', async () => {
      await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks',
          {
            id: 't1',
            kind: 'delegation',
            description: '',
            payload: '{}',
            initial_state: 'queued',
          },
          brain,
        ),
      );
      const resp = await router.handle(
        signedReq('GET', '/v1/workflow/tasks?kind=delegation&state=queued', undefined, brain),
      );
      expect(resp.status).toBe(200);
      expect((resp.body as { tasks: WorkflowTask[] }).tasks.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Agent-pull — /v1/workflow/tasks/claim allows role=agent
  // -------------------------------------------------------------------------

  describe('agent-pull', () => {
    async function seedAndClaim(id: string, leaseMs = 30_000): Promise<WorkflowTask> {
      await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks',
          {
            id,
            kind: 'delegation',
            description: '',
            payload: '{}',
            initial_state: 'queued',
          },
          brain,
        ),
      );
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/claim', { lease_ms: leaseMs }, agent),
      );
      expect(resp.status).toBe(200);
      // Claim returns the flat task body (no `task` envelope) so the
      // Python dina-agent daemon can read `body.id` directly when forming
      // its follow-up `POST /v1/workflow/tasks/{id}/running` URL. See
      // workflow.ts `claimTask`.
      return resp.body as WorkflowTask;
    }

    it('agent-role device can claim queued delegation', async () => {
      // Seed a queued delegation task (by brain) then claim (by agent).
      await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks',
          {
            id: 'del-1',
            kind: 'delegation',
            description: '',
            payload: '{}',
            initial_state: 'queued',
          },
          brain,
        ),
      );
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/claim', { lease_ms: 30_000 }, agent),
      );
      expect(resp.status).toBe(200);
      const claimed = resp.body as WorkflowTask & { payload_type: string };
      expect(claimed.id).toBe('del-1');
      expect(claimed.agent_did).toBe(agent.did);
      // Go-Core parity: `payload_type` is lifted out of the JSON-encoded
      // payload and exposed at the top level on the wire. The Python
      // dina-agent's `build_task_prompt` reads this to decide whether to
      // augment the LLM prompt with structured capability/params; without
      // it, OpenClaw never gets the `mcp_tool` binding and the LLM
      // wanders. Empty string is the correct value when payload has no
      // `type` field — but the field MUST always be present.
      expect(claimed.payload_type).toBe('');
    });

    it('honors lease_seconds from the dina-agent CLI (not the 30s default)', async () => {
      // Regression: the CLI sends `lease_seconds` (client.py claim_task);
      // Core used to read only `lease_ms` → silently fell back to 30s, so the
      // lease-expiry sweeper requeued still-running long tasks (duplicate exec).
      await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks',
          { id: 'del-lease', kind: 'delegation', description: '', payload: '{}', initial_state: 'queued' },
          brain,
        ),
      );
      const before = Date.now();
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/claim', { lease_seconds: 120 }, agent),
      );
      expect(resp.status).toBe(200);
      const claimed = resp.body as WorkflowTask & { payload_type: string };
      // 120s lease ⇒ expiry well beyond the old 30s default.
      expect(claimed.lease_expires_at ?? 0).toBeGreaterThan(before + 100_000);
    });

    it('claim returns 204 when no queued delegation exists', async () => {
      const resp = await router.handle(signedReq('POST', '/v1/workflow/tasks/claim', {}, agent));
      expect(resp.status).toBe(204);
    });

    it('claim lifts payload.type to payload_type for service_query_execution', async () => {
      // Real service provider-shaped payload: the brain stores `type`,
      // `capability`, `params`, `mcp_tool` etc. as a JSON string in the
      // task's `payload` column. Core MUST surface `type` as a sibling
      // top-level `payload_type` field on every wire response or the
      // Python daemon's `build_task_prompt` falls back to the abstract
      // description and OpenClaw never gets `transit__get_eta` bound.
      const payload = JSON.stringify({
        type: 'service_query_execution',
        capability: 'eta_query',
        params: { route_id: '42', location: { lat: 37.762, lng: -122.435 } },
        mcp_tool: 'transit__get_eta',
      });
      await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks',
          {
            id: 'svc-exec-1',
            kind: 'delegation',
            description: 'Execute service query: eta_query',
            payload,
            initial_state: 'queued',
          },
          brain,
        ),
      );
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/claim', { lease_ms: 30_000 }, agent),
      );
      expect(resp.status).toBe(200);
      const claimed = resp.body as WorkflowTask & { payload_type: string };
      expect(claimed.id).toBe('svc-exec-1');
      expect(claimed.payload_type).toBe('service_query_execution');
      expect(claimed.payload).toBe(payload); // unchanged

      // The same field must also appear on GET (used by /running echo +
      // admin/diagnostic reads).
      const getResp = await router.handle(
        signedReq('GET', '/v1/workflow/tasks/svc-exec-1', undefined, brain),
      );
      const getTask = (getResp.body as { task: WorkflowTask & { payload_type: string } }).task;
      expect(getTask.payload_type).toBe('service_query_execution');
    });

    it('holder agent can heartbeat to extend the lease', async () => {
      const claimed = await seedAndClaim('del-hb-1');
      const initialLease = claimed.lease_expires_at;
      expect(initialLease).toBeDefined();

      // Small wait so the updated lease is visibly later than the initial one.
      await new Promise((r) => setTimeout(r, 5));

      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/del-hb-1/heartbeat', { lease_ms: 60_000 }, agent),
      );
      expect(resp.status).toBe(200);
      expect((resp.body as { ok: boolean }).ok).toBe(true);

      const getResp = await router.handle(
        signedReq('GET', '/v1/workflow/tasks/del-hb-1', undefined, brain),
      );
      const task = (getResp.body as { task: WorkflowTask }).task;
      expect(task.status).toBe('running');
      expect(task.lease_expires_at).toBeGreaterThan(initialLease ?? 0);
    });

    it('heartbeat on non-existent task returns 404', async () => {
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/does-not-exist/heartbeat', {}, agent),
      );
      expect(resp.status).toBe(404);
    });

    it('heartbeat by a different agent returns 409', async () => {
      // Second agent — also role='agent' but a distinct DID.
      const agent2 = makeActor(randomBytes(32));
      registerDeviceDID(agent2.did, 'agent-2');
      registerPublicKeyResolver((d) => {
        if (d === brain.did) return brain.pub;
        if (d === agent.did) return agent.pub;
        if (d === agent2.did) return agent2.pub;
        return null;
      });
      setDeviceRoleResolver((d) => (d === agent.did || d === agent2.did ? 'agent' : null));

      await seedAndClaim('del-hb-guard');
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/del-hb-guard/heartbeat', {}, agent2),
      );
      expect(resp.status).toBe(409);
      expect((resp.body as { error: string }).error).toMatch(/different agent/);
    });

    it('holder agent can post progress updates', async () => {
      await seedAndClaim('del-prog-1');
      const resp = await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks/del-prog-1/progress',
          { message: 'step 2 of 5' },
          agent,
        ),
      );
      expect(resp.status).toBe(200);

      const getResp = await router.handle(
        signedReq('GET', '/v1/workflow/tasks/del-prog-1', undefined, brain),
      );
      const task = (getResp.body as { task: WorkflowTask }).task;
      expect(task.progress_note).toBe('step 2 of 5');
    });

    it('progress rejects empty message with 400', async () => {
      await seedAndClaim('del-prog-empty');
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/del-prog-empty/progress', {}, agent),
      );
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/message/);
    });

    it('progress update by a different agent returns 409', async () => {
      const agent2 = makeActor(randomBytes(32));
      registerDeviceDID(agent2.did, 'agent-2');
      registerPublicKeyResolver((d) => {
        if (d === brain.did) return brain.pub;
        if (d === agent.did) return agent.pub;
        if (d === agent2.did) return agent2.pub;
        return null;
      });
      setDeviceRoleResolver((d) => (d === agent.did || d === agent2.did ? 'agent' : null));

      await seedAndClaim('del-prog-guard');
      const resp = await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks/del-prog-guard/progress',
          { message: 'hijack' },
          agent2,
        ),
      );
      expect(resp.status).toBe(409);
    });

    it('complete accepts result-only body (Python dina-agent parity)', async () => {
      // The Python `dina-agent` MCP `dina_task_complete(task_id, result)`
      // posts only `{ result }` — no `result_summary`. Go-Core derives
      // the summary from `result`; the TS port must too. Without this
      // every paired-OpenClaw completion 400s and the response bridge
      // never fires.
      await seedAndClaim('del-result-only');
      const resp = await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks/del-result-only/complete',
          {
            result:
              '{"eta_minutes":12,"stop_name":"Castro Station","map_url":"https://maps.example/x"}',
            agent_did: agent.did,
          },
          agent,
        ),
      );
      expect(resp.status).toBe(200);
      const fetched = await router.handle(
        signedReq('GET', '/v1/workflow/tasks/del-result-only', undefined, brain),
      );
      const task = (fetched.body as { task: WorkflowTask }).task;
      expect(task.status).toBe('completed');
      expect(task.result).toContain('Castro Station');
      // Summary derived from the first 200 chars of `result` so the
      // admin UI / `dina /taskstatus` view still has display text.
      expect(task.result_summary).toContain('Castro Station');
    });

    it('claim → heartbeat → progress → complete end-to-end', async () => {
      await seedAndClaim('del-e2e');

      expect(
        (await router.handle(signedReq('POST', '/v1/workflow/tasks/del-e2e/heartbeat', {}, agent)))
          .status,
      ).toBe(200);
      expect(
        (
          await router.handle(
            signedReq('POST', '/v1/workflow/tasks/del-e2e/progress', { message: 'halfway' }, agent),
          )
        ).status,
      ).toBe(200);
      const done = await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks/del-e2e/complete',
          { result: '{"ok":true}', result_summary: 'ok', agent_did: agent.did },
          agent,
        ),
      );
      expect(done.status).toBe(200);

      const fetched = await router.handle(
        signedReq('GET', '/v1/workflow/tasks/del-e2e', undefined, brain),
      );
      const task = (fetched.body as { task: WorkflowTask }).task;
      expect(task.status).toBe('completed');
      expect(task.progress_note).toBe('halfway');
      expect(task.result).toBe('{"ok":true}');
    });

    it('heartbeat after completion returns 409 (task no longer running)', async () => {
      await seedAndClaim('del-hb-after-done');
      await router.handle(
        signedReq(
          'POST',
          '/v1/workflow/tasks/del-hb-after-done/complete',
          { result: '{}', result_summary: 'done', agent_did: agent.did },
          agent,
        ),
      );
      const resp = await router.handle(
        signedReq('POST', '/v1/workflow/tasks/del-hb-after-done/heartbeat', {}, agent),
      );
      expect(resp.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // Service config
  // -------------------------------------------------------------------------

  describe('service config', () => {
    it('GET returns 404 before any PUT', async () => {
      const resp = await router.handle(signedReq('GET', '/v1/service/config', undefined, brain));
      expect(resp.status).toBe(404);
    });

    it('PUT then GET round-trips', async () => {
      const cfg = {
        isDiscoverable: true,
        // Catalog-valid listing: explicit discoverability + a per-capability
        // category are now REQUIRED at the Core boundary (strict #4).
        discoverability: 'public',
        name: 'Test',
        capabilities: {
          eta_query: {
            mcpServer: 'transit',
            mcpTool: 'eta',
            responsePolicy: 'auto',
            category: 'transit',
          },
        },
      };
      const putResp = await router.handle(signedReq('PUT', '/v1/service/config', cfg, brain));
      expect(putResp.status).toBe(200);
      const getResp = await router.handle(signedReq('GET', '/v1/service/config', undefined, brain));
      expect(getResp.status).toBe(200);
      expect((getResp.body as { name: string }).name).toBe('Test');
    });

    it('PUT with malformed config returns 400', async () => {
      const resp = await router.handle(
        signedReq(
          'PUT',
          '/v1/service/config',
          {
            // missing required fields
            isDiscoverable: 'not-a-boolean',
          },
          brain,
        ),
      );
      expect(resp.status).toBe(400);
    });

    it('PUT rejects a catalog-INVALID listing — strict listing validation (#4)', async () => {
      // Structurally valid, but no explicit discoverability + no per-capability
      // category → validateServiceListing rejects it at the Core boundary (no
      // compatibility bypass).
      const resp = await router.handle(
        signedReq(
          'PUT',
          '/v1/service/config',
          {
            isDiscoverable: true,
            name: 'NoCat',
            capabilities: {
              eta_query: { mcpServer: 'transit', mcpTool: 'eta', responsePolicy: 'auto' },
            },
          },
          brain,
        ),
      );
      expect(resp.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // PII scrub
  // -------------------------------------------------------------------------

  describe('pii scrub', () => {
    it('POST /v1/pii/scrub scrubs email addresses', async () => {
      const resp = await router.handle(
        signedReq(
          'POST',
          '/v1/pii/scrub',
          {
            text: 'Contact john@example.com about the meeting',
          },
          brain,
        ),
      );
      expect(resp.status).toBe(200);
      const body = resp.body as { scrubbed: string; entityCount: number };
      expect(body.scrubbed).not.toContain('john@example.com');
      expect(body.entityCount).toBeGreaterThan(0);
    });

    it('POST with missing text returns 400', async () => {
      const resp = await router.handle(signedReq('POST', '/v1/pii/scrub', {}, brain));
      expect(resp.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Service query (sender injected; no real D2D)
  // -------------------------------------------------------------------------

  describe('service query', () => {
    it('POST /v1/service/query dedups on idempotency key', async () => {
      const sent: unknown[] = [];
      setServiceQuerySender(async (to, type, body) => {
        sent.push({ to, type, body });
      });
      const req = () =>
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:bus',
            capability: 'eta_query',
            params: { route: '42' },
            ttl_seconds: 60,
            query_id: 'q-dup-test',
          },
          brain,
        );

      const first = await router.handle(req());
      expect(first.status).toBe(200);
      const second = await router.handle(req());
      expect(second.status).toBe(200);
      expect((second.body as { deduped?: boolean }).deduped).toBe(true);
      // Sender called once — second request was a dedup.
      expect(sent).toHaveLength(1);
    });

    it('does NOT dedupe two requests to the same DID/cap/params but different listings (#1, P1)', async () => {
      const sent: unknown[] = [];
      setServiceQuerySender(async (to, type, body) => {
        sent.push({ to, type, body });
      });
      const reqFor = (serviceUri: string, queryId: string) =>
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:market',
            capability: 'price_check',
            params: { sku: 'X' },
            ttl_seconds: 60,
            query_id: queryId,
            service_uri: serviceUri,
          },
          brain,
        );

      const a = await router.handle(
        reqFor('at://did:plc:market/com.dinakernel.service.profile/store-2', 'q-listing-a'),
      );
      expect(a.status).toBe(200);
      expect((a.body as { deduped?: boolean }).deduped ?? false).toBe(false);
      const b = await router.handle(
        reqFor('at://did:plc:market/com.dinakernel.service.profile/store-3', 'q-listing-b'),
      );
      expect(b.status).toBe(200);
      // Different listing → NOT a dedup → both reach the provider.
      expect((b.body as { deduped?: boolean }).deduped ?? false).toBe(false);
      expect(sent).toHaveLength(2);
    });

    it('DOES dedupe two requests with the same listing service_uri (#1, P1)', async () => {
      const sent: unknown[] = [];
      setServiceQuerySender(async (to, type, body) => {
        sent.push({ to, type, body });
      });
      const req = () =>
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:market',
            capability: 'price_check',
            params: { sku: 'X' },
            ttl_seconds: 60,
            query_id: 'q-same-listing',
            service_uri: 'at://did:plc:market/com.dinakernel.service.profile/store-2',
          },
          brain,
        );

      const first = await router.handle(req());
      expect(first.status).toBe(200);
      const second = await router.handle(req());
      expect(second.status).toBe(200);
      expect((second.body as { deduped?: boolean }).deduped).toBe(true);
      expect(sent).toHaveLength(1);
    });

    it('POST /v1/service/query forwards service_uri onto the D2D body (#1, chosen listing)', async () => {
      const sent: Array<{ body: Record<string, unknown> }> = [];
      setServiceQuerySender(async (_to, _type, body) => {
        sent.push({ body: body as unknown as Record<string, unknown> });
      });
      const res = await router.handle(
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:bus',
            capability: 'price_check',
            params: { sku: 'X' },
            ttl_seconds: 60,
            query_id: 'q-uri-1',
            service_uri: 'at://did:plc:bus/com.dinakernel.service.profile/store-2',
          },
          brain,
        ),
      );
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].body.service_uri).toBe('at://did:plc:bus/com.dinakernel.service.profile/store-2');
    });

    it('POST /v1/service/query omits service_uri from the D2D body when absent (#1)', async () => {
      const sent: Array<{ body: Record<string, unknown> }> = [];
      setServiceQuerySender(async (_to, _type, body) => {
        sent.push({ body: body as unknown as Record<string, unknown> });
      });
      const res = await router.handle(
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:bus',
            capability: 'eta_query',
            params: { route: '42' },
            ttl_seconds: 60,
            query_id: 'q-nouri-1',
          },
          brain,
        ),
      );
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect('service_uri' in sent[0].body).toBe(false);
    });

    it('rejects a present-but-non-string service_uri (P2: not silently dropped)', async () => {
      const sent: unknown[] = [];
      setServiceQuerySender(async (_to, _type, body) => {
        sent.push(body);
      });
      const res = await router.handle(
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:bus',
            capability: 'eta_query',
            params: { route: '42' },
            ttl_seconds: 60,
            query_id: 'q-nonstring-uri',
            service_uri: 42, // number where a listing URI is expected
          },
          brain,
        ),
      );
      expect(res.status).toBe(400);
      expect(sent).toHaveLength(0);
    });

    it('rejects a structurally-malformed service_uri (P2: bound listing URI)', async () => {
      const sent: unknown[] = [];
      setServiceQuerySender(async (_to, _type, body) => {
        sent.push(body);
      });
      const res = await router.handle(
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:bus',
            capability: 'eta_query',
            params: { route: '42' },
            ttl_seconds: 60,
            query_id: 'q-bad-uri',
            service_uri: 'not-an-at-uri',
          },
          brain,
        ),
      );
      expect(res.status).toBe(400);
      expect(sent).toHaveLength(0);
    });

    it('rejects a cross-DID service_uri whose authority != to_did (P2)', async () => {
      const sent: unknown[] = [];
      setServiceQuerySender(async (_to, _type, body) => {
        sent.push(body);
      });
      const res = await router.handle(
        signedReq(
          'POST',
          '/v1/service/query',
          {
            to_did: 'did:plc:bus',
            capability: 'eta_query',
            params: { route: '42' },
            ttl_seconds: 60,
            query_id: 'q-cross-did',
            // Well-formed listing URI, but for a DIFFERENT provider DID.
            service_uri: 'at://did:plc:attacker/com.dinakernel.service.profile/store-9',
          },
          brain,
        ),
      );
      expect(res.status).toBe(400);
      expect(sent).toHaveLength(0);
    });

    it('POST /v1/service/respond forwards a provider-authored card onto the D2D body', async () => {
      // Regression for the main architectural gap: a provider's
      // `response_body.card` must survive `/v1/service/respond` onto the D2D
      // `service.response` body (the requester re-validates it untrusted).
      // The route builds the D2D body INLINE — a separate path from the
      // bridge's deriveResponseBody — so it needs its own coverage.
      const sent: Array<{ to: string; body: Record<string, unknown> }> = [];
      setServiceRespondSender(async (to, _type, body) => {
        sent.push({ to, body: body as unknown as Record<string, unknown> });
      });
      // A claimable approval task carrying the service-query payload the route
      // extracts from_did/query_id/capability/ttl out of.
      getWorkflowService()!.create({
        id: 'svc-resp-card',
        kind: 'approval',
        description: '',
        payload: JSON.stringify({
          type: 'service_query_execution',
          from_did: 'did:plc:requester',
          query_id: 'q-card-1',
          capability: 'price_check',
          ttl_seconds: 60,
          service_name: 'Corner Market',
        }),
        initialState: WorkflowTaskState.Queued,
      });
      const card = { version: 1, blocks: [{ kind: 'title', text: 'Organic Bananas' }] };
      const resp = await router.handle(
        signedReq(
          'POST',
          '/v1/service/respond',
          {
            task_id: 'svc-resp-card',
            response_body: { status: 'success', result: { price: 0.79 }, card },
          },
          brain,
        ),
      );
      expect(resp.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('did:plc:requester');
      expect(sent[0].body.status).toBe('success');
      expect(sent[0].body.result).toEqual({ price: 0.79 });
      // The card survived onto the D2D body — verbatim, opaque.
      expect(sent[0].body.card).toEqual(card);
    });

    it('POST /v1/service/respond drops a non-object card (never garbage on the wire)', async () => {
      const sent: Array<{ body: Record<string, unknown> }> = [];
      setServiceRespondSender(async (_to, _type, body) => {
        sent.push({ body: body as unknown as Record<string, unknown> });
      });
      getWorkflowService()!.create({
        id: 'svc-resp-badcard',
        kind: 'approval',
        description: '',
        payload: JSON.stringify({
          type: 'service_query_execution',
          from_did: 'did:plc:requester',
          query_id: 'q-card-2',
          capability: 'price_check',
          ttl_seconds: 60,
          service_name: 'Corner Market',
        }),
        initialState: WorkflowTaskState.Queued,
      });
      const resp = await router.handle(
        signedReq(
          'POST',
          '/v1/service/respond',
          {
            task_id: 'svc-resp-badcard',
            response_body: { status: 'success', result: { price: 1 }, card: 'not-a-card' },
          },
          brain,
        ),
      );
      expect(resp.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].body.card).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/service/offer — provider mints a grant + delivers it as an offer
  // -------------------------------------------------------------------------
  describe('POST /v1/service/offer (grant + offer)', () => {
    const created: ServiceGrant[] = [];
    const revoked: string[] = [];
    const sent: { to: string; type: string; body: Record<string, unknown> }[] = [];
    let senderThrows = false;
    // A router whose offer route treats only did:plc:emma as a contact (the
    // P2 contact gate). Other deps are the module-global stubs set below.
    let offerRouter: ReturnType<typeof createCoreRouter>;

    beforeEach(() => {
      created.length = 0;
      revoked.length = 0;
      sent.length = 0;
      senderThrows = false;
      setNodeDID('did:plc:me');
      setServiceGrantRepository({
        create: (g) => {
          created.push(g);
        },
        getById: () => null,
        isAuthorized: () => false,
        listByGrantee: () => [],
        revoke: (id) => {
          revoked.push(id);
          return true;
        },
      });
      setD2DSender(async (to, type, body) => {
        if (senderThrows) throw new Error('msgbox down');
        sent.push({ to, type, body });
      });
      // A known_only listing offering eta_query, with a schema.
      setServiceConfig(
        {
          name: 'My Private Bus',
          isDiscoverable: false,
          discoverability: 'known_only',
          status: 'active',
          capabilities: { eta_query: { mcpServer: 'stub_eta', mcpTool: 'eta', responsePolicy: 'auto' } },
          capabilitySchemas: {
            eta_query: {
              params: { type: 'object' },
              result: { type: 'object' },
              schemaHash: 'sha256:eta',
              defaultTtlSeconds: 60,
            },
          },
        } as never,
        'private-1',
      );
      offerRouter = createCoreRouter({
        serviceQuery: { isContact: (d) => d === 'did:plc:emma' },
      });
    });

    afterEach(() => {
      setServiceGrantRepository(null);
      setD2DSender(null);
      clearServiceConfig('private-1');
    });

    it('mints a grant for the contact + sends a service.offer carrying grant_id + service_uri', async () => {
      const resp = await offerRouter.handle(
        signedReq(
          'POST',
          '/v1/service/offer',
          { to_did: 'did:plc:emma', rkey: 'private-1', capability: 'eta_query' },
          brain,
        ),
      );
      expect(resp.status).toBe(200);
      const body = resp.body as { grant_id: string; service_uri: string };
      expect(body.service_uri).toBe('at://did:plc:me/com.dinakernel.service.profile/private-1');

      // The grant is the authority — created for THIS grantee/listing/capability.
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        grantId: body.grant_id,
        granteeDid: 'did:plc:emma',
        serviceRkey: 'private-1',
        capability: 'eta_query',
        grantType: 'standing',
      });

      // The offer DELIVERS the grant_id + self-contained listing metadata.
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('did:plc:emma');
      expect(sent[0].type).toBe('service.offer');
      expect(sent[0].body).toMatchObject({
        grant_id: body.grant_id,
        capability: 'eta_query',
        service_uri: 'at://did:plc:me/com.dinakernel.service.profile/private-1',
        schema_hash: 'sha256:eta',
      });
    });

    it('REFUSES to issue a grant to a NON-contact (403, contact-gated)', async () => {
      const resp = await offerRouter.handle(
        signedReq(
          'POST',
          '/v1/service/offer',
          { to_did: 'did:plc:stranger', rkey: 'private-1', capability: 'eta_query' },
          brain,
        ),
      );
      expect(resp.status).toBe(403);
      expect(created).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it('rejects an offer for a capability the listing does not offer', async () => {
      const resp = await offerRouter.handle(
        signedReq(
          'POST',
          '/v1/service/offer',
          { to_did: 'did:plc:emma', rkey: 'private-1', capability: 'price_check' },
          brain,
        ),
      );
      expect(resp.status).toBe(400);
      expect(created).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it('404s for an unknown listing rkey', async () => {
      const resp = await offerRouter.handle(
        signedReq(
          'POST',
          '/v1/service/offer',
          { to_did: 'did:plc:emma', rkey: 'nope', capability: 'eta_query' },
          brain,
        ),
      );
      expect(resp.status).toBe(404);
      expect(created).toHaveLength(0);
    });

    it('REVOKES the grant when the offer send fails (no dangling authority)', async () => {
      senderThrows = true;
      const resp = await offerRouter.handle(
        signedReq(
          'POST',
          '/v1/service/offer',
          { to_did: 'did:plc:emma', rkey: 'private-1', capability: 'eta_query' },
          brain,
        ),
      );
      expect(resp.status).toBe(502);
      // The grant was created, then rolled back (revoked) since it was never delivered.
      expect(created).toHaveLength(1);
      expect(revoked).toEqual([created[0].grantId]);
      expect(sent).toHaveLength(0);
    });
  });
});
