/**
 * `createPersonaGuard` — unit tests for the per-ask approval factory
 * built in 5.21-E.
 */

import { ApprovalManager } from '../../../core/src/approval/manager';
import {
  createPersona,
  openPersona,
  resetPersonaState,
} from '../../../core/src/persona/service';
import {
  approvalIdFor,
  createPersonaGuard,
} from '../../src/composition/persona_guard';

const REQUESTER = 'did:key:z6MkAlonsoTester';
const ASK_ID = 'ask-1';
const FROZEN_NOW_MS = 1_750_000_000_000;

beforeEach(() => {
  resetPersonaState();
});

describe('createPersonaGuard — construction', () => {
  it('rejects missing approvalManager', () => {
    expect(() =>
      createPersonaGuard({
        // @ts-expect-error testing runtime validation
        approvalManager: undefined,
        askId: ASK_ID,
        requesterDid: REQUESTER,
      }),
    ).toThrow('approvalManager is required');
  });

  it('rejects empty askId', () => {
    expect(() =>
      createPersonaGuard({
        approvalManager: new ApprovalManager(),
        askId: '',
        requesterDid: REQUESTER,
      }),
    ).toThrow('askId must be a non-empty string');
  });

  it('rejects empty requesterDid', () => {
    expect(() =>
      createPersonaGuard({
        approvalManager: new ApprovalManager(),
        askId: ASK_ID,
        requesterDid: '   ',
      }),
    ).toThrow('requesterDid must be a non-empty string');
  });
});

describe('createPersonaGuard — tier policy', () => {
  it('returns null for default tier (open)', () => {
    createPersona('general', 'default');
    const guard = createPersonaGuard({
      approvalManager: new ApprovalManager(),
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    expect(guard('general')).toBeNull();
  });

  it('returns null for standard tier', () => {
    createPersona('work', 'standard');
    const guard = createPersonaGuard({
      approvalManager: new ApprovalManager(),
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    expect(guard('work')).toBeNull();
  });

  it('returns null for unknown persona (lets accessibility check handle it)', () => {
    const guard = createPersonaGuard({
      approvalManager: new ApprovalManager(),
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    expect(guard('does_not_exist')).toBeNull();
  });

  it('returns approvalId for sensitive tier', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    const result = guard('health');
    expect(result).toBe('appr-ask-1-health');
  });

  it('returns approvalId for locked tier', () => {
    createPersona('financial', 'locked');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    expect(guard('financial')).toBe('appr-ask-1-financial');
  });
});

describe('createPersonaGuard — approval registration', () => {
  it('mints a pending approval with the right shape', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
      nowMsFn: () => FROZEN_NOW_MS,
    });
    guard('health');

    const req = am.getRequest('appr-ask-1-health');
    expect(req).toBeDefined();
    expect(req).toMatchObject({
      id: 'appr-ask-1-health',
      action: 'vault_read',
      requester_did: REQUESTER,
      persona: 'health',
      reason: expect.stringContaining('persona "health"'),
      status: 'pending',
      created_at: FROZEN_NOW_MS,
    });
  });

  it('embeds the askId in the reason text', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: 'ask-xyz',
      requesterDid: REQUESTER,
    });
    guard('health');
    const req = am.getRequest('appr-ask-xyz-health');
    expect(req?.reason).toContain('ask-xyz');
  });

  it('is idempotent on a re-call with pending approval', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    const id1 = guard('health');
    const id2 = guard('health');
    expect(id1).toBe(id2);
    // Only one approval registered.
    expect(am.listPending()).toHaveLength(1);
  });

  it('mints distinct approval ids for distinct personas in the same ask', () => {
    createPersona('health', 'sensitive');
    createPersona('financial', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    expect(guard('health')).toBe('appr-ask-1-health');
    expect(guard('financial')).toBe('appr-ask-1-financial');
    expect(am.listPending()).toHaveLength(2);
  });

  it('mints distinct approval ids for the same persona across different asks', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard1 = createPersonaGuard({
      approvalManager: am,
      askId: 'ask-1',
      requesterDid: REQUESTER,
    });
    const guard2 = createPersonaGuard({
      approvalManager: am,
      askId: 'ask-2',
      requesterDid: REQUESTER,
    });
    expect(guard1('health')).toBe('appr-ask-1-health');
    expect(guard2('health')).toBe('appr-ask-2-health');
    expect(am.listPending()).toHaveLength(2);
  });
});

describe('createPersonaGuard — resume cycle (consume on second call)', () => {
  it('returns null after operator approves (single-scope consumed)', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });

    // First call: mint pending.
    const id = guard('health');
    expect(id).toBe('appr-ask-1-health');

    // Operator approves single-scope.
    am.approveRequest(id!, 'single', 'did:operator');

    // Second call: consume + allow.
    expect(guard('health')).toBeNull();

    // Approval was consumed (single-scope removes the record).
    expect(am.getRequest(id!)).toBeUndefined();
  });

  it('returns null on every subsequent call when operator approved session-scope', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    const id = guard('health')!;
    am.approveRequest(id, 'session', 'did:operator');

    // Multiple subsequent reads — all allowed.
    expect(guard('health')).toBeNull();
    expect(guard('health')).toBeNull();
    expect(guard('health')).toBeNull();
    // Session-scope NOT consumed by consumeSingle.
    expect(am.getRequest(id)?.status).toBe('approved');
  });

  it('a third read after single-scope consume mints a fresh approval', () => {
    // Single-shot semantics: after consume, the approval is gone. A
    // subsequent LLM tool call has to ask the operator again.
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });

    const firstId = guard('health')!;
    am.approveRequest(firstId, 'single', 'did:operator');
    expect(guard('health')).toBeNull(); // consume

    // Third call: no approval exists → mint fresh pending.
    const thirdId = guard('health');
    expect(thirdId).toBe('appr-ask-1-health'); // same deterministic id
    expect(am.getRequest(thirdId!)?.status).toBe('pending');
  });

  it('a denied approval surfaces approvalId so the loop bails predictably', () => {
    createPersona('health', 'sensitive');
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    const id = guard('health')!;
    am.denyRequest(id);

    // Subsequent read still surfaces the approval id — caller can
    // inspect manager state to detect 'denied' and translate to a
    // hard failure if desired.
    expect(guard('health')).toBe(id);
    expect(am.getRequest(id)?.status).toBe('denied');
  });
});

describe('approvalIdFor', () => {
  it('exposes the deterministic id derivation', () => {
    expect(approvalIdFor('ask-42', 'financial')).toBe('appr-ask-42-financial');
  });
});

describe('createPersonaGuard — interaction with persona unlock state', () => {
  it('treats sensitive persona as approval-required regardless of isOpen', () => {
    // Even if the persona was previously unlocked (DEK in RAM), the
    // gate still requires per-call approval — that's the whole point
    // of the sensitive tier (auditable per-access, not a free-for-all
    // until lock).
    createPersona('health', 'sensitive');
    openPersona('health', true); // simulate operator-approved unlock
    const am = new ApprovalManager();
    const guard = createPersonaGuard({
      approvalManager: am,
      askId: ASK_ID,
      requesterDid: REQUESTER,
    });
    expect(guard('health')).toBe('appr-ask-1-health');
  });
});
