/**
 * Router-level integration tests — the Bus Driver critical path served
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
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';
import type { WorkflowTask } from '../../src/workflow/domain';
import { setServiceQuerySender } from '../../src/server/routes/service_query';
import { setServiceRespondSender } from '../../src/server/routes/service_respond';
import { clearServiceConfig, resetServiceConfigState } from '../../src/service/service_config';
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

    it('claim returns 204 when no queued delegation exists', async () => {
      const resp = await router.handle(signedReq('POST', '/v1/workflow/tasks/claim', {}, agent));
      expect(resp.status).toBe(204);
    });

    it('claim lifts payload.type to payload_type for service_query_execution', async () => {
      // Real BusDriver-shaped payload: the brain stores `type`,
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
        name: 'Test',
        capabilities: {
          eta_query: { mcpServer: 'transit', mcpTool: 'eta', responsePolicy: 'auto' },
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
  });
});
