/**
 * Producer bridges that fan into the unified notifications inbox (5.66).
 *
 * Reminder + nudge bridges are tested via their host hooks
 * (`useReminderFireWatcher.test.ts` + `useChatNudges.test.ts` in
 * `apps/mobile`). This suite covers the brain-side bridges:
 *   - approval-manager → inbox
 *   - briefing-history → inbox
 */

import {
  installApprovalInboxBridge,
  installWorkflowApprovalInboxBridge,
  subscribeBriefingEvents,
} from '../../src/notifications/bridges';
import {
  appendNotification,
  listNotifications,
  resetNotifications,
} from '../../src/notifications/inbox';
import { ApprovalManager } from '../../../core/src/approval/manager';
import { InMemoryWorkflowRepository } from '../../../core/src/workflow/repository';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
  type WorkflowTask,
} from '../../../core/src/workflow/domain';

function approvalTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  const now = 1_700_000_000_000;
  return {
    id: 'apr-1',
    kind: WorkflowTaskKind.Approval,
    status: WorkflowTaskState.PendingApproval,
    priority: WorkflowTaskPriority.Normal,
    description: 'send_email: Send Q4 report to legal',
    payload: JSON.stringify({ type: 'intent_validation' }),
    result_summary: '',
    policy: '',
    origin: 'agent',
    expires_at: Math.floor(now / 1_000) + 1_800, // 30 min
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('Notifications inbox bridges (5.66)', () => {
  beforeEach(() => {
    resetNotifications();
  });

  describe('installApprovalInboxBridge', () => {
    it('appends an approval-kind notification on every requestApproval', () => {
      const mgr = new ApprovalManager();
      installApprovalInboxBridge(mgr);

      mgr.requestApproval({
        id: 'appr-1',
        action: 'vault_search',
        requester_did: 'did:key:z6MkAlice',
        persona: 'general',
        reason: 'Search for "rent"',
        preview: '',
        created_at: 1234,
      });

      const items = listNotifications();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 'appr-1',
        kind: 'approval',
        title: 'vault_search',
        body: 'Search for "rent"',
        sourceId: 'appr-1',
        deepLink: 'dina://approvals/appr-1',
        firedAt: 1234,
      });
    });

    it('falls back to preview when reason is empty', () => {
      const mgr = new ApprovalManager();
      installApprovalInboxBridge(mgr);
      mgr.requestApproval({
        id: 'appr-2',
        action: 'memory_touch',
        requester_did: 'did:key:z6MkBob',
        persona: 'general',
        reason: '',
        preview: 'Update Bob\'s phone number',
        created_at: 0,
      });
      expect(listNotifications()[0]!.body).toBe("Update Bob's phone number");
    });

    it('disposer detaches the listener', () => {
      const mgr = new ApprovalManager();
      const off = installApprovalInboxBridge(mgr);
      off();
      mgr.requestApproval({
        id: 'after-off',
        action: 'x',
        requester_did: 'd',
        persona: 'general',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      expect(listNotifications()).toHaveLength(0);
    });

    it('upsert idempotency — bridge passes the approval id, so a re-emitted request does not duplicate the inbox entry', () => {
      const mgr = new ApprovalManager();
      installApprovalInboxBridge(mgr);
      mgr.requestApproval({
        id: 'appr-3',
        action: 'a',
        requester_did: 'd',
        persona: 'general',
        reason: 'r',
        preview: '',
        created_at: 0,
      });
      // Manually upsert the same id (simulating a cold-start replay
      // scenario) — should NOT produce a second entry, and should NOT
      // fire `appended` again per inbox.upsert semantics.
      appendNotification({
        id: 'appr-3',
        kind: 'approval',
        title: 'a',
        body: 'r',
        sourceId: 'appr-3',
      });
      expect(listNotifications().filter((i) => i.id === 'appr-3')).toHaveLength(1);
    });
  });

  describe('installWorkflowApprovalInboxBridge', () => {
    it('appends an approval-kind notification on every kind=approval task creation', () => {
      const repo = new InMemoryWorkflowRepository();
      installWorkflowApprovalInboxBridge(repo);

      repo.create(
        approvalTask({
          id: 'prop-intent-abc',
          description: 'send_email: Send Q4 report',
        }),
      );

      const items = listNotifications();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 'prop-intent-abc',
        kind: 'approval',
        title: 'send_email: Send Q4 report',
        body: '',
        sourceId: 'prop-intent-abc',
        deepLink: 'dina://approvals/prop-intent-abc',
        firedAt: 1_700_000_000_000,
      });
    });

    it('translates expires_at from seconds to milliseconds for the inbox', () => {
      const repo = new InMemoryWorkflowRepository();
      installWorkflowApprovalInboxBridge(repo);
      repo.create(approvalTask({ id: 'apr-exp', expires_at: 1_700_000_900 }));
      expect(listNotifications()[0]!.expiresAt).toBe(1_700_000_900_000);
    });

    it('omits expiresAt when the task has no expiry', () => {
      const repo = new InMemoryWorkflowRepository();
      installWorkflowApprovalInboxBridge(repo);
      repo.create(approvalTask({ id: 'apr-noexp', expires_at: undefined }));
      expect(listNotifications()[0]!.expiresAt).toBeUndefined();
    });

    it('falls back to "Approval requested (id)" when description is empty', () => {
      const repo = new InMemoryWorkflowRepository();
      installWorkflowApprovalInboxBridge(repo);
      repo.create(approvalTask({ id: 'apr-noname', description: '' }));
      expect(listNotifications()[0]!.title).toBe('Approval requested (apr-noname)');
    });

    it('does NOT fire for non-approval tasks (delegation, service_query, …)', () => {
      const repo = new InMemoryWorkflowRepository();
      installWorkflowApprovalInboxBridge(repo);
      repo.create(
        approvalTask({
          id: 'sq-1',
          kind: WorkflowTaskKind.ServiceQuery,
          status: WorkflowTaskState.Created,
        }),
      );
      repo.create(
        approvalTask({
          id: 'del-1',
          kind: WorkflowTaskKind.Delegation,
          status: WorkflowTaskState.Created,
        }),
      );
      expect(listNotifications()).toHaveLength(0);
    });

    it('disposer detaches the listener', () => {
      const repo = new InMemoryWorkflowRepository();
      const off = installWorkflowApprovalInboxBridge(repo);
      off();
      repo.create(approvalTask({ id: 'after-off' }));
      expect(listNotifications()).toHaveLength(0);
    });

    it('idempotent on re-fire — using task.id ensures a second emit upserts', () => {
      const repo = new InMemoryWorkflowRepository();
      installWorkflowApprovalInboxBridge(repo);
      repo.create(approvalTask({ id: 'apr-idem' }));
      // Simulate a cold-start replay where the inbox sees the same id again.
      appendNotification({
        id: 'apr-idem',
        kind: 'approval',
        title: 'send_email: Send Q4 report to legal',
        body: '',
        sourceId: 'apr-idem',
      });
      expect(listNotifications().filter((i) => i.id === 'apr-idem')).toHaveLength(1);
    });

    it('coexists with installApprovalInboxBridge — each bridge owns its source', () => {
      const repo = new InMemoryWorkflowRepository();
      const mgr = new ApprovalManager();
      installWorkflowApprovalInboxBridge(repo);
      installApprovalInboxBridge(mgr);

      repo.create(approvalTask({ id: 'apr-workflow', description: 'review service.query' }));
      mgr.requestApproval({
        id: 'apr-mgr',
        action: 'vault_search',
        requester_did: 'did:key:zX',
        persona: 'general',
        reason: 'Search foo',
        preview: '',
        created_at: 5,
      });

      const ids = listNotifications().map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining(['apr-workflow', 'apr-mgr']));
      expect(ids).toHaveLength(2);
    });
  });

  describe('subscribeBriefingEvents', () => {
    it('appends a briefing-kind notification on a recorded event', () => {
      const listener = subscribeBriefingEvents();
      listener({
        kind: 'recorded',
        entry: {
          id: 'bh-1',
          persona: 'health',
          sentAtMs: 9999,
          itemCount: 3,
          headline: "Today's items",
        },
      });
      const items = listNotifications();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 'bh-1',
        kind: 'briefing',
        title: "Today's items",
        body: '3 items for /health',
        sourceId: 'bh-1',
        deepLink: 'dina://briefings/bh-1',
        firedAt: 9999,
      });
    });

    it('falls back to "Daily briefing" when headline is missing', () => {
      const listener = subscribeBriefingEvents();
      listener({
        kind: 'recorded',
        entry: {
          id: 'bh-2',
          persona: 'general',
          sentAtMs: 1000,
          itemCount: 1,
        },
      });
      expect(listNotifications()[0]).toMatchObject({
        title: 'Daily briefing',
        body: '1 item for /general',
      });
    });

    it('ignores non-recorded events', () => {
      const listener = subscribeBriefingEvents();
      listener({ kind: 'purged' });
      listener({ kind: 'evicted' });
      expect(listNotifications()).toHaveLength(0);
    });

    it('ignores recorded events with no entry payload', () => {
      const listener = subscribeBriefingEvents();
      listener({ kind: 'recorded' });
      expect(listNotifications()).toHaveLength(0);
    });
  });
});
