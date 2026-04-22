/**
 * T5.4 — Daily briefing assembly: collect, structure, Silence First.
 *
 * Source: ARCHITECTURE.md Task 5.4
 */

import {
  assembleBriefing,
  setBriefingHour,
  getBriefingHour,
  isBriefingTime,
  markBriefingSent,
  registerEngagementProvider,
  registerApprovalProvider,
  registerMemoryProvider,
  resetBriefingState,
  sortBySourcePriority,
  deduplicateByTitle,
} from '../../src/briefing/assembly';
import type { BriefingItem } from '../../src/briefing/assembly';
import { createReminder, resetReminderState } from '../../../core/src/reminders/service';

describe('Daily Briefing Assembly', () => {
  beforeEach(() => {
    resetBriefingState();
    resetReminderState();
  });

  describe('assembleBriefing', () => {
    it('returns null when nothing to report (Silence First)', () => {
      expect(assembleBriefing()).toBeNull();
    });

    it('includes engagement items from provider', () => {
      registerEngagementProvider(() => [
        { type: 'engagement', title: 'New RSS article', timestamp: Date.now() },
        { type: 'engagement', title: 'Social notification', timestamp: Date.now() },
      ]);
      const briefing = assembleBriefing();
      expect(briefing).not.toBeNull();
      expect(briefing!.sections.engagement).toHaveLength(2);
      expect(briefing!.totalItems).toBe(2);
    });

    it('includes upcoming reminders', () => {
      const now = Date.now();
      createReminder({ message: 'Team standup', due_at: now - 1000, persona: 'work' });
      createReminder({ message: 'Future reminder', due_at: now + 999_999_999, persona: 'work' });
      const briefing = assembleBriefing(now);
      expect(briefing).not.toBeNull();
      // First reminder is due, second is within 24h window
      expect(briefing!.sections.reminders.length).toBeGreaterThanOrEqual(1);
    });

    it('includes pending approvals from provider', () => {
      registerApprovalProvider(() => [
        { type: 'approval', title: 'Unlock health persona', timestamp: Date.now() },
      ]);
      const briefing = assembleBriefing();
      expect(briefing!.sections.approvals).toHaveLength(1);
    });

    it('includes new memories from provider', () => {
      registerMemoryProvider(() => [
        { type: 'memory', title: 'Stored 3 emails', timestamp: Date.now() },
      ]);
      const briefing = assembleBriefing();
      expect(briefing!.sections.memories).toHaveLength(1);
    });

    it('combines all sections with correct total', () => {
      registerEngagementProvider(() => [
        { type: 'engagement', title: 'RSS', timestamp: Date.now() },
      ]);
      registerApprovalProvider(() => [
        { type: 'approval', title: 'Approve', timestamp: Date.now() },
      ]);
      registerMemoryProvider(() => [{ type: 'memory', title: 'New data', timestamp: Date.now() }]);
      const now = Date.now();
      createReminder({ message: 'Reminder', due_at: now - 1000, persona: 'general' });

      const briefing = assembleBriefing(now);
      expect(briefing!.totalItems).toBeGreaterThanOrEqual(4);
    });

    it('has generatedAt timestamp', () => {
      registerEngagementProvider(() => [
        { type: 'engagement', title: 'Item', timestamp: Date.now() },
      ]);
      const before = Date.now();
      const briefing = assembleBriefing();
      expect(briefing!.generatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('briefing time', () => {
    it('default briefing hour is 8 AM', () => {
      expect(getBriefingHour()).toBe(8);
    });

    it('setBriefingHour changes the hour', () => {
      setBriefingHour(7);
      expect(getBriefingHour()).toBe(7);
    });

    it('clamps hour to [0, 23]', () => {
      setBriefingHour(25);
      expect(getBriefingHour()).toBe(23);
      setBriefingHour(-1);
      expect(getBriefingHour()).toBe(0);
    });

    it('isBriefingTime returns true at briefing hour', () => {
      setBriefingHour(8);
      expect(isBriefingTime(8)).toBe(true);
    });

    it('isBriefingTime returns false at other hours', () => {
      setBriefingHour(8);
      expect(isBriefingTime(9)).toBe(false);
      expect(isBriefingTime(7)).toBe(false);
    });

    it('prevents double-send within 23 hours', () => {
      setBriefingHour(8);
      const now = Date.now();
      expect(isBriefingTime(8, now)).toBe(true);
      markBriefingSent(now);
      expect(isBriefingTime(8, now + 1000)).toBe(false);
    });

    it('allows next briefing after 23 hours', () => {
      setBriefingHour(8);
      const now = Date.now();
      markBriefingSent(now);
      const nextDay = now + 23 * 60 * 60 * 1000 + 1000;
      expect(isBriefingTime(8, nextDay)).toBe(true);
    });
  });

  describe('source-priority sorting', () => {
    it('sorts finance before health before rss', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: 'RSS article', source: 'rss', timestamp: 1000 },
        { type: 'engagement', title: 'Bank alert', source: 'finance', timestamp: 1000 },
        { type: 'engagement', title: 'Health update', source: 'health', timestamp: 1000 },
      ];
      const sorted = sortBySourcePriority(items);
      expect(sorted[0].source).toBe('finance');
      expect(sorted[1].source).toBe('health');
      expect(sorted[2].source).toBe('rss');
    });

    it('sorts by timestamp within same priority', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: 'Old', source: 'health', timestamp: 1000 },
        { type: 'engagement', title: 'New', source: 'health', timestamp: 2000 },
      ];
      const sorted = sortBySourcePriority(items);
      expect(sorted[0].title).toBe('New');
      expect(sorted[1].title).toBe('Old');
    });

    it('treats unknown source as low priority', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: 'Unknown', source: 'unknown_source', timestamp: 1000 },
        { type: 'engagement', title: 'Finance', source: 'finance', timestamp: 1000 },
      ];
      const sorted = sortBySourcePriority(items);
      expect(sorted[0].source).toBe('finance');
    });

    it('handles missing source gracefully', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: 'No source', timestamp: 1000 },
        { type: 'engagement', title: 'Health', source: 'health', timestamp: 1000 },
      ];
      const sorted = sortBySourcePriority(items);
      expect(sorted[0].source).toBe('health');
    });

    it('engagement section is sorted in assembled briefing', () => {
      registerEngagementProvider(() => [
        { type: 'engagement', title: 'RSS feed', source: 'rss', timestamp: 1000 },
        { type: 'engagement', title: 'Bank notification', source: 'bank', timestamp: 1000 },
        { type: 'engagement', title: 'Calendar event', source: 'calendar', timestamp: 1000 },
      ]);
      const briefing = assembleBriefing();
      expect(briefing).not.toBeNull();
      expect(briefing!.sections.engagement[0].source).toBe('bank');
      expect(briefing!.sections.engagement[1].source).toBe('calendar');
      expect(briefing!.sections.engagement[2].source).toBe('rss');
    });
  });

  describe('body text deduplication', () => {
    it('removes duplicate titles', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: 'Same item', timestamp: 1000 },
        { type: 'engagement', title: 'Same item', timestamp: 2000 },
        { type: 'engagement', title: 'Different item', timestamp: 1500 },
      ];
      const deduped = deduplicateByTitle(items);
      expect(deduped).toHaveLength(2);
    });

    it('keeps the newest duplicate', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: 'Dup', timestamp: 1000 },
        { type: 'engagement', title: 'Dup', timestamp: 2000 },
      ];
      const deduped = deduplicateByTitle(items);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].timestamp).toBe(2000);
    });

    it('case-insensitive dedup', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: 'Test Item', timestamp: 1000 },
        { type: 'engagement', title: 'test item', timestamp: 2000 },
      ];
      const deduped = deduplicateByTitle(items);
      expect(deduped).toHaveLength(1);
    });

    it('keeps empty titles (no dedup on empty)', () => {
      const items: BriefingItem[] = [
        { type: 'engagement', title: '', timestamp: 1000 },
        { type: 'engagement', title: '', timestamp: 2000 },
      ];
      const deduped = deduplicateByTitle(items);
      expect(deduped).toHaveLength(2);
    });

    it('dedup applied in assembled briefing', () => {
      registerEngagementProvider(() => [
        { type: 'engagement', title: 'Same news', source: 'rss', timestamp: 1000 },
        { type: 'engagement', title: 'Same news', source: 'feed', timestamp: 2000 },
        { type: 'engagement', title: 'Unique news', source: 'rss', timestamp: 1500 },
      ]);
      const briefing = assembleBriefing();
      expect(briefing).not.toBeNull();
      expect(briefing!.sections.engagement).toHaveLength(2);
      expect(briefing!.totalItems).toBe(2);
    });
  });
});
