/**
 * Tab-bar badge formatter (task 5.69).
 *
 * Pins `formatBadgeCount` — pure function, no React, easy to assert
 * against. The hook itself wraps `useState`+`useEffect`+`subscribe`;
 * its behaviour is the formatter + the inbox subscription, both of
 * which are independently covered (the inbox suite covers subscribe,
 * this suite covers the cap).
 */

import { formatBadgeCount } from '../../src/hooks/useNotificationsBadge';

describe('formatBadgeCount (5.69 tab-bar badge formatter)', () => {
  it('returns undefined for zero — hides the badge', () => {
    expect(formatBadgeCount(0)).toBeUndefined();
  });

  it('returns undefined for negative or non-finite — defensive', () => {
    expect(formatBadgeCount(-1)).toBeUndefined();
    expect(formatBadgeCount(NaN)).toBeUndefined();
    expect(formatBadgeCount(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('returns the digit string for 1-9', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(5)).toBe('5');
    expect(formatBadgeCount(9)).toBe('9');
  });

  it('caps at "9+" for 10 and above', () => {
    expect(formatBadgeCount(10)).toBe('9+');
    expect(formatBadgeCount(99)).toBe('9+');
    expect(formatBadgeCount(1000)).toBe('9+');
  });

  it('floors fractional counts before stringifying', () => {
    // The hook always returns integers, but the formatter is
    // standalone and worth being safe.
    expect(formatBadgeCount(3.7)).toBe('3');
  });
});
