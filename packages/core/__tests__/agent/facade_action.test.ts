import {
  FACADE_ACTION_APPROVAL_TYPE,
  MAX_PENDING_FACADE_ACTIONS_PER_AGENT,
  createFacadeActionApproval,
  facadeActionTaskId,
  parseFacadeActionApprovalPayload,
} from '../../src/agent/facade_action';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const AGENT = 'did:key:z6MkAgent';
const SESSION = 'session-1';

function create(
  requestId = 'request-0001',
  actionPayload: Record<string, unknown> = {
    recipient_did: 'did:plc:bob',
    body: { text: 'Hello Bob' },
  },
) {
  return createFacadeActionApproval({
    action: 'talk',
    agentDid: AGENT,
    sessionId: SESSION,
    requestId,
    actionPayload,
    displayTitle: 'Send a message to Bob',
    displayDetail: 'Hello Bob',
    nowMs: 1_700_000_000_000,
  });
}

describe('facade action approval', () => {
  beforeEach(() => {
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  });

  afterEach(() => setWorkflowService(null));

  it('creates one durable, bounded pending approval', () => {
    const result = create();
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.task).toMatchObject({
      id: facadeActionTaskId(AGENT, SESSION, 'talk', 'request-0001'),
      kind: 'approval',
      status: 'pending_approval',
      origin: 'agent',
      session_name: SESSION,
    });
    expect(result.payload).toMatchObject({
      type: FACADE_ACTION_APPROVAL_TYPE,
      action: 'talk',
      agent_did: AGENT,
      session: SESSION,
      request_id: 'request-0001',
    });
    expect(parseFacadeActionApprovalPayload(result.task.payload)).toEqual(result.payload);
  });

  it('replays identical semantics and rejects request-id reuse with changed semantics', () => {
    expect(create().kind).toBe('created');
    expect(create().kind).toBe('existing');
    expect(
      create('request-0001', {
        recipient_did: 'did:plc:bob',
        body: { text: 'A different message' },
      }),
    ).toEqual({
      kind: 'conflict',
      taskId: facadeActionTaskId(AGENT, SESSION, 'talk', 'request-0001'),
    });
  });

  it('counts pending actions for the owning agent even behind other agents rows', () => {
    for (let i = 0; i < 30; i++) {
      const result = createFacadeActionApproval({
        action: 'talk',
        agentDid: `did:key:zOther${i}`,
        sessionId: 'other-session',
        requestId: `other-${String(i).padStart(4, '0')}`,
        actionPayload: { recipient_did: 'did:plc:x', body: { text: 'x' } },
        displayTitle: 'Send a message',
        displayDetail: 'x',
      });
      expect(result.kind).toBe('created');
    }
    for (let i = 0; i < MAX_PENDING_FACADE_ACTIONS_PER_AGENT; i++) {
      expect(create(`request-${String(i).padStart(4, '0')}`).kind).toBe('created');
    }
    expect(create('request-over-cap').kind).toBe('too_many_pending');
  });

  it('rejects malformed and display-spoofing persisted payloads', () => {
    expect(parseFacadeActionApprovalPayload('{')).toBeNull();
    expect(
      parseFacadeActionApprovalPayload(
        JSON.stringify({
          type: FACADE_ACTION_APPROVAL_TYPE,
          action: 'talk',
          agent_did: AGENT,
          session: SESSION,
          request_id: 'request-0001',
          payload_hash: 'a'.repeat(64),
          display_title: 'Send\u202Etxt.exe',
          display_detail: 'hello',
          action_payload: {},
        }),
      ),
    ).toBeNull();
  });

  it('accepts the review action without widening the payload contract', () => {
    const result = createFacadeActionApproval({
      action: 'review',
      agentDid: AGENT,
      sessionId: SESSION,
      requestId: 'review-request-0001',
      actionPayload: {
        record: {
          subject: { type: 'product', name: 'Chair' },
          category: 'product:chair',
          sentiment: 'positive',
        },
      },
      displayTitle: 'Publish a review of Chair',
      displayDetail: 'Positive review',
    });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(parseFacadeActionApprovalPayload(result.task.payload)?.action).toBe('review');
  });

  it.each(['service_publish', 'service_invoke'] as const)(
    'accepts the %s action without widening the payload contract',
    (action) => {
      const result = createFacadeActionApproval({
        action,
        agentDid: AGENT,
        sessionId: SESSION,
        requestId: `${action}-request`,
        actionPayload: { bounded: true },
        displayTitle: action === 'service_publish' ? 'Publish service' : 'Invoke service',
        displayDetail: 'Exact approved service action',
      });
      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(parseFacadeActionApprovalPayload(result.task.payload)?.action).toBe(action);
    },
  );
});
