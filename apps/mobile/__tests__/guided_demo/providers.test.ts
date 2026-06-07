/**
 * makeGuidedDemoSeams — the REAL provider seams (minus the LLM-backed `send`).
 * Drives them against the real in-memory chat thread + ApprovalManager and
 * asserts they produce genuine artifacts the live renderers consume:
 *   - postServiceCard → a resolved `service_query` lifecycle message;
 *   - requestApproval/denyApproval → real ApprovalManager state + an actionable
 *     'approval' chat card (createApprovalCard), not just a notification;
 *   - postDemoCard → a scope-bound system chat message.
 */

import { getThread, readLifecycle, resetThreads } from '@dina/brain/chat';
import { getApprovalManager, resetApprovalManager } from '@dina/core';

import { makeGuidedDemoSeams } from '../../src/guided_demo/providers';
import { buildDemoApprovalRequest, buildDemoServiceCard } from '../../src/guided_demo/runner';

beforeEach(() => {
  resetThreads();
  resetApprovalManager();
});

describe('makeGuidedDemoSeams', () => {
  it('postServiceCard posts a real resolved service_query lifecycle', () => {
    const seams = makeGuidedDemoSeams();
    seams.postServiceCard(buildDemoServiceCard(1));
    const thread = getThread('main');
    expect(thread).toHaveLength(1);
    const lc = readLifecycle(thread[0]);
    expect(lc).not.toBeNull();
    expect(lc).toMatchObject({
      kind: 'service_query',
      status: 'resolved',
      capability: 'product_availability',
      serviceName: 'Demo Furniture Availability Provider',
    });
    // The result carries the deterministic furniture availability payload the
    // real card renderer (buildResultCardSpec) maps into a CardSpec.
    expect((lc as { result?: Record<string, unknown> }).result).toMatchObject({
      product: 'ErgoFlex Study Chair',
      available: true,
    });
  });

  it('requestApproval creates a real pending Health approval + actionable chat card; denyApproval resolves it', () => {
    const seams = makeGuidedDemoSeams();
    const req = buildDemoApprovalRequest(42);
    const id = seams.requestApproval(req);
    expect(id).toBe(req.id);
    const mgr = getApprovalManager();
    expect(mgr.getRequest(id)).toMatchObject({ status: 'pending', persona: 'health' });
    // An actionable demo approval card is posted into the chat thread, tagged
    // with metadata.kind='demo_approval' so the renderer dispatches to
    // InlineDemoApprovalCard (a plain 'approval' message with no metadata would
    // not render). The card resolves via the ApprovalManager directly.
    const thread = getThread('main');
    const approvalMsg = thread.find((m) => m.type === 'approval');
    expect(approvalMsg).toBeTruthy();
    expect(approvalMsg!.metadata?.kind).toBe('demo_approval');
    expect(approvalMsg!.metadata?.approvalId).toBe(id);
    seams.denyApproval(id);
    expect(mgr.getRequest(id)?.status).toBe('denied');
  });

  it('postDemoCard posts a system chat message (scope-bound)', () => {
    const seams = makeGuidedDemoSeams();
    seams.postDemoCard('Draft service · Chair availability checker');
    const thread = getThread('main');
    expect(thread).toHaveLength(1);
    expect(thread[0].type).toBe('system');
    expect(thread[0].content).toContain('Draft service');
  });
});
