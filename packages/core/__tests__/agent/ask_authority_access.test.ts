/**
 * REAL_LIFE_FIXES §0.1 B + §3 — Core decides an agent/device ask's persona
 * access, and enforces it on the reads Brain makes for that ask.
 *
 * Covers: the `check` mode raises nothing; `request` raises one card per
 * agent + session + persona and reuses it while pending; "Approve Once"
 * serves only the ask it was raised for (every read of it), "Approve"
 * serves the session and ends with it; reads carrying the authority are
 * judged as the requester; nothing gated reaches the ToC.
 */

import {
  activateAgentPersonaGrant,
  reserveAgentPersonaGrant,
} from '../../src/agent/access';
import {
  bindAskAuthority,
  mintAskAuthority,
  resetAskAuthorities,
  resolveAskAuthority,
} from '../../src/agent/ask_authority';
import { InMemoryAgentGrantRepository, setAgentGrantRepository } from '../../src/agent/grant_repository';
import { createPersona, openPersona, resetPersonaState } from '../../src/persona/service';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerAgentPersonaAccessRoute } from '../../src/server/routes/agent_persona_access';
import { registerVaultRoutes } from '../../src/server/routes/vault';
import { SessionRegistry, setSessionRegistry } from '../../src/session/registry';
import { clearVaults, storeItem } from '../../src/vault/crud';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, getWorkflowService, setWorkflowService } from '../../src/workflow/service';

const AGENT = 'did:key:z6MkAgentAlpha';

function brainReq(
  method: CoreRequest['method'],
  path: string,
  opts: { body?: unknown; query?: Record<string, string>; callerType?: CoreRequest['callerType'] } = {},
): CoreRequest {
  return {
    method,
    path,
    query: opts.query ?? {},
    headers: {},
    body: opts.body,
    rawBody: new TextEncoder().encode(JSON.stringify(opts.body ?? {})),
    params: {},
    trustedInProcess: true,
    callerType: opts.callerType ?? 'brain',
    callerDID: 'did:key:brain',
  };
}

let router: CoreRouter;
let sessions: SessionRegistry;
let grants: InMemoryAgentGrantRepository;

function startSession(host: string): string {
  return sessions.start({ agentDid: AGENT, hostSessionId: host }).sessionId;
}

function authorityFor(sessionId: string, askId: string): string {
  const a = mintAskAuthority({ requesterDid: AGENT, sessionId });
  bindAskAuthority(a.id, askId);
  return a.id;
}

async function check(authority: string, personas: string[]): Promise<Record<string, string>> {
  const res = await router.handle(
    brainReq('POST', '/v1/agent/persona-access', {
      body: { ask_authority: authority, op: 'check', personas },
    }),
  );
  if (res.status !== 200) throw new Error(`check ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { decisions: Record<string, string> }).decisions;
}

async function request(authority: string, persona: string): Promise<{ decision: string; task_id?: string }> {
  const res = await router.handle(
    brainReq('POST', '/v1/agent/persona-access', {
      body: { ask_authority: authority, op: 'request', persona },
    }),
  );
  return res.body as { decision: string; task_id?: string };
}

async function approve(taskId: string, scope: 'single' | 'session'): Promise<void> {
  const task = getWorkflowService()!.store().getById(taskId)!;
  const grant = reserveAgentPersonaGrant(task, Date.now(), scope);
  getWorkflowService()!.approve(taskId);
  await activateAgentPersonaGrant(grant!, Date.now());
}

function pendingApprovals(): number {
  return getWorkflowService()!
    .store()
    .listByKindAndState('approval', 'pending_approval' as never, 100).length;
}

beforeEach(() => {
  resetPersonaState();
  resetAskAuthorities();
  clearVaults(['general', 'health', 'finance']);
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  createPersona('finance', 'locked');
  for (const p of ['general', 'health', 'finance']) openPersona(p, true);
  storeItem('general', { id: 'g1', type: 'note', summary: 'the garden gate code is 4471' });
  storeItem('health', { id: 'h1', type: 'note', summary: 'LDL 3.9 at the March check' });
  setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  grants = new InMemoryAgentGrantRepository();
  setAgentGrantRepository(grants);
  // Session end revokes the session's grants, as the hosts wire it.
  sessions = new SessionRegistry(() => Date.now(), (session) => {
    grants.revokeForSession(session.agentDid, session.sessionId, Date.now());
  });
  setSessionRegistry(sessions);
  router = new CoreRouter();
  registerVaultRoutes(router);
  registerAgentPersonaAccessRoute(router);
});

afterEach(() => {
  setAgentGrantRepository(null);
  setWorkflowService(null);
  setSessionRegistry(null);
  resetAskAuthorities();
  resetPersonaState();
});

describe('check never raises a card (§3.2)', () => {
  it('reports free tiers allowed and gated tiers gated, creating nothing', async () => {
    const s = startSession('h1');
    const a = authorityFor(s, 'ask-1');
    expect(await check(a, ['general', 'health', 'finance'])).toEqual({
      general: 'allowed',
      health: 'gated',
      finance: 'gated',
    });
    expect(pendingApprovals()).toBe(0);
  });

  it('refuses an unknown or session-ended authority', async () => {
    const s = startSession('h2');
    const a = authorityFor(s, 'ask-2');
    sessions.end(s, AGENT);
    expect(resolveAskAuthority(a)).toBeNull();
    const res = await router.handle(
      brainReq('POST', '/v1/agent/persona-access', {
        body: { ask_authority: a, op: 'check', personas: ['general'] },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('request raises one card per agent + session + persona (§3.2)', () => {
  it('reuses the pending card across asks in the same session', async () => {
    const s = startSession('h3');
    const first = await request(authorityFor(s, 'ask-a'), 'health');
    const second = await request(authorityFor(s, 'ask-b'), 'health');
    expect(first.decision).toBe('approval_required');
    expect(second.task_id).toBe(first.task_id);
    expect(pendingApprovals()).toBe(1);
  });

  it('a new session gets its own card', async () => {
    const one = await request(authorityFor(startSession('h4'), 'ask-c'), 'health');
    const two = await request(authorityFor(startSession('h5'), 'ask-d'), 'health');
    expect(two.task_id).not.toBe(one.task_id);
  });

  it('each persona is gated on its own', async () => {
    const s = startSession('h6');
    const a = authorityFor(s, 'ask-e');
    const h = await request(a, 'health');
    await approve(h.task_id!, 'session');
    expect((await check(a, ['health', 'finance'])).finance).toBe('gated');
  });
});

describe('grant scopes (§3.3)', () => {
  it('Approve Once serves every read of its own ask and no other ask', async () => {
    const s = startSession('h7');
    const asked = authorityFor(s, 'ask-once');
    const card = await request(asked, 'health');
    await approve(card.task_id!, 'single');

    // The ask that raised the card: allowed, for repeated reads.
    expect((await check(asked, ['health'])).health).toBe('allowed');
    expect((await check(asked, ['health'])).health).toBe('allowed');
    // Another ask in the same session: gated again.
    const next = authorityFor(s, 'ask-next');
    expect((await check(next, ['health'])).health).toBe('gated');
  });

  it('Approve serves later asks in the session, and ends with the session', async () => {
    const s = startSession('h8');
    const card = await request(authorityFor(s, 'ask-s1'), 'health');
    await approve(card.task_id!, 'session');
    const later = authorityFor(s, 'ask-s2');
    expect((await check(later, ['health'])).health).toBe('allowed');

    sessions.end(s, AGENT);
    const fresh = authorityFor(startSession('h8'), 'ask-s3');
    expect((await check(fresh, ['health'])).health).toBe('gated');
  });
});

describe('reads carrying the authority are judged as the requester (§0.1 B)', () => {
  it('a gated persona read is refused without raising a card', async () => {
    const a = authorityFor(startSession('h9'), 'ask-r1');
    const res = await router.handle(
      brainReq('POST', '/v1/vault/query', {
        query: { persona: 'health', ask_authority: a },
        body: { text: 'LDL' },
      }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('persona_gated');
  });

  it('an allowed persona read goes ahead', async () => {
    const a = authorityFor(startSession('h10'), 'ask-r2');
    const res = await router.handle(
      brainReq('POST', '/v1/vault/query', {
        query: { persona: 'general', ask_authority: a },
        body: { text: 'gate' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('only Brain may present an authority', async () => {
    const a = authorityFor(startSession('h11'), 'ask-r3');
    const res = await router.handle(
      brainReq('GET', '/v1/vault/list', {
        query: { persona: 'general', ask_authority: a },
        callerType: 'device',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('an invalid authority is refused, never read as the owner', async () => {
    const res = await router.handle(
      brainReq('GET', '/v1/vault/list', { query: { persona: 'health', ask_authority: 'aa-nope' } }),
    );
    expect(res.status).toBe(403);
  });
});


describe('Core names the ask before Brain runs (dual review, 2026-10-08)', () => {
  it('a card raised inside the ask carries its ask id, and Approve Once serves that ask alone', async () => {
    const { registerAskRoutes } = await import('../../src/server/routes/ask');
    const session = startSession('host-once');
    let raisedTask = '';
    let askAuthority = '';
    registerAskRoutes(router, {
      handler: {
        // A tool asks for Health during Brain's fast path, before the route returns.
        handleAsk: async (input) => {
          askAuthority = input.askAuthority ?? '';
          raisedTask = (await request(askAuthority, 'health')).task_id ?? '';
          return { status: 202, body: { status: 'in_flight', request_id: input.requestIdHeader } };
        },
        handleStatus: async () => ({ status: 200, body: { status: 'complete' } }),
      },
    });
    const res = await router.handle(
      { ...brainReq('POST', '/api/v1/ask', { body: { prompt: 'my LDL?', session_id: session }, callerType: 'agent' }), callerDID: AGENT },
    );
    expect(res.status).toBe(202);
    const card = JSON.parse(getWorkflowService()!.store().getById(raisedTask)!.payload) as { ask_id?: string };
    expect(card.ask_id).toBe((res.body as { request_id: string }).request_id);
    await approve(raisedTask, 'single');
    expect((await check(askAuthority, ['health'])).health).toBe('allowed');
    // Another ask in the same session is not covered by Approve Once.
    expect((await check(authorityFor(session, 'another-ask-id-0000'), ['health'])).health).not.toBe('allowed');
  });
});
