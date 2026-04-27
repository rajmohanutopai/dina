/**
 * Agent intent validation HTTP routes — `POST /v1/agent/validate` +
 * `GET /v1/intent/proposals/:proposalId/status`.
 *
 * Pins the four CAPABILITIES.md scenarios at the wire level (signed
 * Ed25519 requests, full router pipeline) — and crucially, pins the
 * exact wire envelope produced by the Go Core + Python Brain stack
 * so the existing `dina validate` CLI works against Lite without
 * modification.
 *
 *   search        → 200 {action:'auto_approve',    risk:'SAFE',     approved:true,  requires_approval:false}
 *   send_email    → 200 {action:'flag_for_review', risk:'MODERATE', approved:false, requires_approval:true,  proposal_id}
 *   transfer_money → 200 {action:'flag_for_review', risk:'HIGH',     approved:false, requires_approval:true,  proposal_id}
 *   read_vault    → 200 {action:'deny',            risk:'BLOCKED',  approved:false, requires_approval:false}
 *
 * Then the operator approve / cancel lifecycle through the existing
 * workflow repository, projected onto the status endpoint's wire
 * shape (Python `_pending_proposals` projection):
 *
 *   pending_approval → approve → status='approved'
 *   pending_approval → cancel  → status='denied'
 */

import { createCoreRouter } from '../../src/server/core_server';
import type { CoreRequest } from '../../src/server/router';
import { signRequest } from '../../src/auth/canonical';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import {
  registerPublicKeyResolver,
  resetMiddlewareState,
} from '../../src/auth/middleware';
import {
  registerService,
  registerDevice as registerDeviceDID,
  resetCallerTypeState,
  setDeviceRoleResolver,
} from '../../src/auth/caller_type';
import {
  InMemoryWorkflowRepository,
  setWorkflowRepository,
  getWorkflowRepository,
} from '../../src/workflow/repository';
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

describe('agent intent validation — POST /v1/agent/validate + status', () => {
  let agent: Actor;
  let router: ReturnType<typeof createCoreRouter>;

  beforeEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();

    const brain = makeActor(TEST_ED25519_SEED);
    agent = makeActor(randomBytes(32));

    registerPublicKeyResolver((d) => {
      if (d === brain.did) return brain.pub;
      if (d === agent.did) return agent.pub;
      return null;
    });
    registerService(brain.did, 'brain');
    registerDeviceDID(agent.did, 'agent-1');
    setDeviceRoleResolver((d) => (d === agent.did ? 'agent' : null));

    setWorkflowRepository(new InMemoryWorkflowRepository());
    router = createCoreRouter();
  });

  afterEach(() => {
    setWorkflowRepository(null);
    resetMiddlewareState();
    resetCallerTypeState();
  });

  /** Sign + send a request as the test agent. */
  async function send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const bodyBytes =
      body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
    const headers = signRequest(method, path, '', bodyBytes, agent.seed, agent.did);
    const req: CoreRequest = {
      method,
      path,
      query: {},
      params: {},
      headers: {
        'x-did': headers['X-DID']!,
        'x-timestamp': headers['X-Timestamp']!,
        'x-nonce': headers['X-Nonce']!,
        'x-signature': headers['X-Signature']!,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : body,
      rawBody: bodyBytes,
    };
    const res = await router.handle(req);
    return { status: res.status, body: (res.body as Record<string, unknown>) ?? {} };
  }

  /** Convenience — every validate request needs `type: 'agent_intent'`. */
  function intent(action: string, target: string, extra: Record<string, unknown> = {}): unknown {
    return { type: 'agent_intent', action, target, ...extra };
  }

  describe('SAFE actions (synchronous auto_approve, no proposal)', () => {
    it('search → 200 auto_approve/SAFE', async () => {
      const res = await send('POST', '/v1/agent/validate', intent('search', 'best ergonomic chair'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        action: 'auto_approve',
        risk: 'SAFE',
        approved: true,
        requires_approval: false,
      });
      expect(res.body.proposal_id).toBeUndefined();
    });
  });

  describe('BLOCKED actions (synchronous deny, no proposal)', () => {
    it('read_vault → 200 deny/BLOCKED', async () => {
      const res = await send('POST', '/v1/agent/validate', intent('read_vault', 'health records'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        action: 'deny',
        risk: 'BLOCKED',
        approved: false,
        requires_approval: false,
      });
      expect(res.body.proposal_id).toBeUndefined();
    });
  });

  describe('MODERATE/HIGH actions (flag_for_review, proposal created)', () => {
    it('send_email → 200 flag_for_review/MODERATE with proposal_id', async () => {
      const res = await send(
        'POST',
        '/v1/agent/validate',
        intent('send_email', 'draft resignation letter to HR', { session: 'ses_abc' }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        action: 'flag_for_review',
        risk: 'MODERATE',
        approved: false,
        requires_approval: true,
      });
      expect(res.body.proposal_id).toMatch(/^prop-intent-/);
    });

    it('transfer_money → 200 flag_for_review/HIGH', async () => {
      const res = await send(
        'POST',
        '/v1/agent/validate',
        intent('transfer_money', '500 to vendor account'),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        action: 'flag_for_review',
        risk: 'HIGH',
        approved: false,
        requires_approval: true,
      });
      expect(res.body.proposal_id).toMatch(/^prop-intent-/);
    });

    it('approval task is created with intent_validation payload tag', async () => {
      const res = await send(
        'POST',
        '/v1/agent/validate',
        intent('send_email', 'send X to Y', { session: 'ses_xyz' }),
      );
      const id = res.body.proposal_id as string;
      const repo = getWorkflowRepository()!;
      const task = repo.getById(id);
      expect(task).not.toBeNull();
      expect(task!.kind).toBe('approval');
      expect(task!.status).toBe('pending_approval');
      expect(task!.origin).toBe('agent');
      const payload = JSON.parse(task!.payload) as Record<string, unknown>;
      expect(payload.type).toBe('intent_validation');
      expect(payload.action).toBe('send_email');
      expect(payload.risk_level).toBe('MODERATE');
    });

    it('agent_did is taken from X-DID header, not request body', async () => {
      // The body claims one DID; the signed request comes from
      // `agent.did`. The route must trust the signature, not the body.
      const res = await send(
        'POST',
        '/v1/agent/validate',
        intent('send_email', 'X', { agent_did: 'did:plc:imposter' }),
      );
      const id = res.body.proposal_id as string;
      const repo = getWorkflowRepository()!;
      const task = repo.getById(id);
      const payload = JSON.parse(task!.payload) as Record<string, unknown>;
      expect(payload.agent_did).toBe(agent.did);
      expect(payload.agent_did).not.toBe('did:plc:imposter');
    });
  });

  describe('status poll lifecycle', () => {
    it('pending → approve → status=approved', async () => {
      const submit = await send(
        'POST',
        '/v1/agent/validate',
        intent('send_email', 'send X'),
      );
      const id = submit.body.proposal_id as string;

      let s = await send('GET', `/v1/intent/proposals/${id}/status`);
      expect(s.body.status).toBe('pending');
      expect(s.body.id).toBe(id);
      expect(s.body.kind).toBe('intent');
      expect(s.body.action).toBe('send_email');

      // Operator approves — workflow state pending_approval → queued.
      const repo = getWorkflowRepository()!;
      repo.transition(id, 'pending_approval', 'queued' as never, Date.now());

      s = await send('GET', `/v1/intent/proposals/${id}/status`);
      expect(s.body.status).toBe('approved');
    });

    it('pending → cancel → status=denied', async () => {
      const submit = await send(
        'POST',
        '/v1/agent/validate',
        intent('transfer_money', '500 to vendor'),
      );
      const id = submit.body.proposal_id as string;

      const repo = getWorkflowRepository()!;
      repo.transition(id, 'pending_approval', 'cancelled' as never, Date.now());

      const s = await send('GET', `/v1/intent/proposals/${id}/status`);
      expect(s.body.status).toBe('denied');
    });

    it('unknown proposal id → 404', async () => {
      const s = await send('GET', '/v1/intent/proposals/prop-intent-bogus/status');
      expect(s.status).toBe(404);
      expect(s.body.error).toBe('unknown proposal_id');
    });

    it('non-intent approval task → 404 (not surfaced through proposals endpoint)', async () => {
      // Stuff a service_query approval task into the workflow store
      // and confirm it doesn't bleed through the proposal status
      // endpoint — the proposals surface is intent-only, like Python's.
      const repo = getWorkflowRepository()!;
      repo.create({
        id: 'apr-svc-1',
        kind: 'approval',
        status: 'pending_approval',
        priority: 'normal',
        description: 'service query',
        payload: JSON.stringify({ type: 'service_query_execution' }),
        result_summary: '',
        policy: '',
        origin: 'agent',
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const s = await send('GET', '/v1/intent/proposals/apr-svc-1/status');
      expect(s.status).toBe(404);
      expect(s.body.error).toBe('unknown proposal_id');
    });
  });

  describe('input validation', () => {
    it('missing type → 400', async () => {
      const res = await send('POST', '/v1/agent/validate', { action: 'search', target: 'X' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agent_intent');
    });

    it('wrong type → 400', async () => {
      const res = await send('POST', '/v1/agent/validate', {
        type: 'reason',
        action: 'search',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agent_intent');
    });

    it('missing action → 400', async () => {
      const res = await send('POST', '/v1/agent/validate', { type: 'agent_intent', target: 'X' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('action');
    });

    it('repository not wired → 503 on MODERATE+ (no proposal can be created)', async () => {
      setWorkflowRepository(null);
      const res = await send('POST', '/v1/agent/validate', intent('send_email', 'X'));
      expect(res.status).toBe(503);
    });

    it('repository not wired but action is SAFE → 200 (no proposal needed)', async () => {
      setWorkflowRepository(null);
      const res = await send('POST', '/v1/agent/validate', intent('search', 'X'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        action: 'auto_approve',
        risk: 'SAFE',
        approved: true,
        requires_approval: false,
      });
    });
  });
});
