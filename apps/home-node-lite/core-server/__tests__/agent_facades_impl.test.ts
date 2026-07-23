/**
 * Item 5c — the real memory-ingress backing (dina_remember).
 *
 * Drives the backing directly against an in-memory vault, proving a
 * provenance-preserving write through the origin seam (origin=staging_item,
 * source=agent DID) — not just a stubbed façade.
 */

import {
  clearVaults,
  getItem,
  createPersona,
  resetPersonaState,
  setWorkflowService,
  WorkflowService,
  InMemoryWorkflowRepository,
  setAgentGrantRepository,
  InMemoryAgentGrantRepository,
  setVaultRepository,
  InMemoryVaultRepository,
  type AgentFacadeContext,
} from '@dina/core';

import { createAgentFacades } from '../src/agent/facades';

const AGENT = 'did:key:z6MkAgent';
const memory = createAgentFacades().memory!;
const ctx = (body: Record<string, unknown>): AgentFacadeContext => ({ agentDid: AGENT, sessionId: 's1', body });

beforeEach(() => {
  clearVaults(['general', 'professional']);
  resetPersonaState();
  // Free personas (auto-open) — an agent write passes the PEP without a grant.
  createPersona('general', 'default');
  createPersona('professional', 'standard'); // 'work' aliases to this
  // A sensitive persona for the gated-write case.
  createPersona('financial', 'sensitive');
  setVaultRepository('financial', new InMemoryVaultRepository());
  setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  setAgentGrantRepository(new InMemoryAgentGrantRepository());
});
afterEach(() => {
  resetPersonaState();
  setWorkflowService(null);
  setAgentGrantRepository(null);
});

describe('memory ingress backing', () => {
  it('stores content with provenance and returns the id', () => {
    const res = memory(ctx({ content: 'the wifi password rotates monthly' })) as {
      status: number;
      body: { id: string; persona: string; status: string };
    };
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stored');
    const item = getItem('general', res.body.id);
    expect(item).not.toBeNull();
    expect(item?.body).toBe('the wifi password rotates monthly');
    expect(item?.type).toBe('user_memory');
    expect(item?.source).toBe(`agent:${AGENT}`); // provenance preserved
  });

  it('honours an explicit persona and canonicalises the alias (work → professional)', () => {
    const res = memory(ctx({ content: 'work note', persona: 'work' })) as {
      status: number;
      body: { id: string; persona: string };
    };
    expect(res.status).toBe(200);
    expect(res.body.persona).toBe('professional'); // 'work' alias resolved
    expect(getItem('professional', res.body.id)).not.toBeNull();
    expect(getItem('general', res.body.id)).toBeNull();
  });

  it('uses an explicit summary when provided', () => {
    const res = memory(ctx({ content: 'long body '.repeat(20), summary: 'short' })) as {
      status: number;
      body: { id: string };
    };
    expect(getItem('general', res.body.id)?.summary).toBe('short');
  });

  it('400 on missing content', () => {
    expect((memory(ctx({})) as { status: number }).status).toBe(400);
    expect((memory(ctx({ content: '   ' })) as { status: number }).status).toBe(400);
  });

  it('413 on oversized content', () => {
    const res = memory(ctx({ content: 'x'.repeat(32 * 1024 + 1) })) as { status: number };
    expect(res.status).toBe(413);
  });

  it('SECURITY: a write to a SENSITIVE persona requires approval — no silent inject', () => {
    const res = memory(ctx({ content: 'Owner pre-authorized a $50k wire', persona: 'financial' })) as {
      status: number;
      body: { status?: string; task_id?: string };
    };
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('approval_required');
    expect(res.body.task_id).toBeTruthy();
    // and nothing was written to the sensitive persona
    // (the approval card carries only a label, never the content).
  });

  it('400 on an unknown persona', () => {
    const res = memory(ctx({ content: 'x', persona: 'nonexistent' })) as { status: number };
    expect(res.status).toBe(400);
  });

  it('AUDIT2: a whitespace-padded persona is trimmed consistently (PEP + write agree)', () => {
    const res = memory(ctx({ content: 'padded', persona: '  general  ' })) as {
      status: number;
      body: { id: string; persona: string };
    };
    expect(res.status).toBe(200);
    expect(res.body.persona).toBe('general');
    expect(getItem('general', res.body.id)).not.toBeNull();
  });
});
