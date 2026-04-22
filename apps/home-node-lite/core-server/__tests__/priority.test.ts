/**
 * Task 5.48 — priority-enum unification tests.
 */

import {
  NOTIFY_PRIORITY_ENGAGEMENT,
  NOTIFY_PRIORITY_FIDUCIARY,
  NOTIFY_PRIORITY_SOLICITED,
  PRIORITY_RANK,
  comparePriority,
  isMoreUrgent,
  type NotifyPriority,
} from '../src/brain/priority';
import type { GuardianPriority } from '../src/brain/guardian_loop';
import type { NudgePriority } from '../src/brain/nudge_assembler';

describe('priority re-exports (task 5.48)', () => {
  it('constants are the canonical strings', () => {
    expect(NOTIFY_PRIORITY_FIDUCIARY).toBe('fiduciary');
    expect(NOTIFY_PRIORITY_SOLICITED).toBe('solicited');
    expect(NOTIFY_PRIORITY_ENGAGEMENT).toBe('engagement');
  });

  it('GuardianPriority is an alias of NotifyPriority', () => {
    const p: NotifyPriority = 'fiduciary';
    const g: GuardianPriority = p; // type-check: aliased
    expect(g).toBe('fiduciary');
  });

  it('NudgePriority is an alias of NotifyPriority', () => {
    const p: NotifyPriority = 'solicited';
    const n: NudgePriority = p;
    expect(n).toBe('solicited');
  });

  it('PRIORITY_RANK orders fiduciary < solicited < engagement', () => {
    expect(PRIORITY_RANK.fiduciary).toBe(0);
    expect(PRIORITY_RANK.solicited).toBe(1);
    expect(PRIORITY_RANK.engagement).toBe(2);
  });

  it('PRIORITY_RANK is frozen', () => {
    expect(Object.isFrozen(PRIORITY_RANK)).toBe(true);
  });
});

describe('comparePriority', () => {
  it('negative when a is more urgent', () => {
    expect(comparePriority('fiduciary', 'solicited')).toBeLessThan(0);
    expect(comparePriority('solicited', 'engagement')).toBeLessThan(0);
    expect(comparePriority('fiduciary', 'engagement')).toBeLessThan(0);
  });

  it('positive when a is less urgent', () => {
    expect(comparePriority('engagement', 'fiduciary')).toBeGreaterThan(0);
    expect(comparePriority('solicited', 'fiduciary')).toBeGreaterThan(0);
  });

  it('zero when equal', () => {
    expect(comparePriority('solicited', 'solicited')).toBe(0);
  });

  it('sorts a list most-urgent-first', () => {
    const list: NotifyPriority[] = ['engagement', 'fiduciary', 'solicited'];
    list.sort(comparePriority);
    expect(list).toEqual(['fiduciary', 'solicited', 'engagement']);
  });
});

describe('isMoreUrgent', () => {
  it('fiduciary > solicited > engagement', () => {
    expect(isMoreUrgent('fiduciary', 'solicited')).toBe(true);
    expect(isMoreUrgent('solicited', 'engagement')).toBe(true);
    expect(isMoreUrgent('fiduciary', 'engagement')).toBe(true);
  });

  it('reflexive: a is NOT more urgent than itself', () => {
    expect(isMoreUrgent('fiduciary', 'fiduciary')).toBe(false);
  });

  it('less-urgent direction returns false', () => {
    expect(isMoreUrgent('engagement', 'fiduciary')).toBe(false);
  });
});
