/**
 * REQ-03 / TT-10: approving an agent's access card settles it. A card left
 * `queued` kept its idempotency key alive, so the agent's next ask in the session
 * got the old card, with nothing for the owner to tap.
 */

import { requireAgentPersonaAccess } from '../../src/agent/access';
import {
  InMemoryAgentGrantRepository,
  setAgentGrantRepository,
} from '../../src/agent/grant_repository';
import { createPersona, resetPersonaState } from '../../src/persona/service';
import { applyOwnerWorkflowDecision } from '../../src/server/routes/workflow';
import { InMemoryWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const AGENT = 'did:plc:agentprobe1';

function ask(askId: string): ReturnType<typeof requireAgentPersonaAccess> {
  return requireAgentPersonaAccess({
    agentDID: AGENT,
    persona: 'health',
    mode: 'read',
    scope: 'q',
    sessionId: 'sess1',
    askId,
  });
}

describe('approved agent access card', () => {
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowRepository(repo);
    setWorkflowService(new WorkflowService({ repository: repo }));
    setAgentGrantRepository(new InMemoryAgentGrantRepository());
    resetPersonaState();
    createPersona('health', 'sensitive');
  });

  it.each(['single', 'session'] as const)('scope %s: the card ends completed', async (scope) => {
    const first = ask('ask-a');
    if (first.kind !== 'approval_required') throw new Error(first.kind);
    await applyOwnerWorkflowDecision(first.taskId, 'approve', { scope });
    expect(repo.getById(first.taskId)?.status).toBe('completed');
  });

  it('after Approve Once a second ask raises a new card the owner can decide', async () => {
    const first = ask('ask-a');
    if (first.kind !== 'approval_required') throw new Error(first.kind);
    await applyOwnerWorkflowDecision(first.taskId, 'approve', { scope: 'single' });

    expect(ask('ask-a').kind).toBe('allow');

    const second = ask('ask-b');
    if (second.kind !== 'approval_required') throw new Error(second.kind);
    expect(second.taskId).not.toBe(first.taskId);
    expect(repo.getById(second.taskId)?.status).toBe('pending_approval');
  });

  it('Approve still serves the next ask in the session with no card', async () => {
    const first = ask('ask-a');
    if (first.kind !== 'approval_required') throw new Error(first.kind);
    await applyOwnerWorkflowDecision(first.taskId, 'approve', { scope: 'session' });
    expect(ask('ask-b').kind).toBe('allow');
  });
});
