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
  subscribeBriefingEvents,
} from '../../src/notifications/bridges';
import {
  appendNotification,
  listNotifications,
  resetNotifications,
} from '../../src/notifications/inbox';
import { ApprovalManager } from '../../../core/src/approval/manager';

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
