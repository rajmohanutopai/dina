/**
 * dnd_policy tests.
 */

import {
  computeQuietEndSec,
  evaluateDnd,
  isQuietNow,
  type DndPolicyInput,
  type QuietHours,
} from '../src/brain/dnd_policy';

const EPOCH_UTC_MIDNIGHT = 1_700_000_000; // approx.
function atUtcMinute(min: number): number {
  // A fixed reference unix-sec that's at UTC midnight-ish:
  // 1_700_000_000 = 2023-11-14T22:13:20 UTC. Shift so sec=0 at an arbitrary UTC midnight.
  return 1_700_006_400 + min * 60; // 1_700_006_400 = 2023-11-15T00:00:00 UTC
}

describe('evaluateDnd — input validation', () => {
  it.each([
    ['null', null],
    ['non-object', 'bogus'],
  ] as const)('%s → default_deliver', (_l, bad) => {
    const r = evaluateDnd(bad as unknown as DndPolicyInput);
    expect(r.action).toBe('deliver');
    expect(r.reason).toBe('default_deliver');
  });

  it('non-finite nowSec → default_deliver (fail-open, not suppress)', () => {
    const r = evaluateDnd({ nowSec: Number.NaN, priority: 'engagement' });
    expect(r.action).toBe('deliver');
  });

  it('invalid priority → default_deliver', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'bogus' as DndPolicyInput['priority'],
    });
    expect(r.action).toBe('deliver');
  });
});

describe('evaluateDnd — block + allow lists', () => {
  it('block list → suppress regardless of priority', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'fiduciary',
      senderId: 'did:plc:spam',
      blockList: ['did:plc:spam'],
    });
    expect(r.action).toBe('suppress');
    expect(r.reason).toBe('block_list');
  });

  it('allow list → deliver even under focus mode', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'engagement',
      senderId: 'did:plc:trusted',
      allowList: ['did:plc:trusted'],
      userState: 'focus',
    });
    expect(r.action).toBe('deliver');
    expect(r.reason).toBe('allow_list');
  });

  it('block + allow on same id → block wins', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'solicited',
      senderId: 'did:plc:conflict',
      blockList: ['did:plc:conflict'],
      allowList: ['did:plc:conflict'],
    });
    expect(r.action).toBe('suppress');
    expect(r.reason).toBe('block_list');
  });
});

describe('evaluateDnd — fiduciary break-through', () => {
  it('fiduciary delivers regardless of focus mode', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'fiduciary',
      userState: 'focus',
    });
    expect(r.action).toBe('deliver');
    expect(r.reason).toBe('fiduciary_break_through');
  });

  it('fiduciary delivers regardless of quiet hours', () => {
    const quiet: QuietHours = { startMin: 0, endMin: 1440 }; // all day
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'fiduciary',
      quietHours: quiet,
    });
    expect(r.action).toBe('deliver');
  });
});

describe('evaluateDnd — user state', () => {
  it('offline → defer', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'engagement',
      userState: 'offline',
    });
    expect(r.action).toBe('defer');
    expect(r.reason).toBe('user_offline');
  });

  it('focus + solicited → defer', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'solicited',
      userState: 'focus',
    });
    expect(r.action).toBe('defer');
    expect(r.reason).toBe('focus_mode');
  });

  it('focus + engagement → suppress', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'engagement',
      userState: 'focus',
    });
    expect(r.action).toBe('suppress');
    expect(r.reason).toBe('focus_mode');
  });

  it('online + engagement + no quiet → deliver', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'engagement',
      userState: 'online',
    });
    expect(r.action).toBe('deliver');
    expect(r.reason).toBe('default_deliver');
  });

  it('away (non-focus) still delivers if no quiet/allow/block', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'engagement',
      userState: 'away',
    });
    expect(r.action).toBe('deliver');
  });
});

describe('evaluateDnd — quiet hours', () => {
  it('inside quiet + solicited → defer with resumeAtSec', () => {
    // quiet 10:00-11:00 UTC; now 10:30.
    const quiet: QuietHours = { startMin: 600, endMin: 660 };
    const nowSec = atUtcMinute(630);
    const r = evaluateDnd({ nowSec, priority: 'solicited', quietHours: quiet });
    expect(r.action).toBe('defer');
    expect(r.reason).toBe('quiet_hours');
    // Should resume at 11:00 — 30 minutes = 1800 seconds later.
    expect(r.resumeAtSec).toBe(atUtcMinute(660));
  });

  it('inside quiet + engagement → suppress', () => {
    const quiet: QuietHours = { startMin: 600, endMin: 660 };
    const nowSec = atUtcMinute(630);
    const r = evaluateDnd({ nowSec, priority: 'engagement', quietHours: quiet });
    expect(r.action).toBe('suppress');
    expect(r.reason).toBe('engagement_suppressed');
  });

  it('outside quiet → deliver', () => {
    const quiet: QuietHours = { startMin: 600, endMin: 660 };
    const nowSec = atUtcMinute(700); // 11:40, after quiet ends.
    const r = evaluateDnd({ nowSec, priority: 'engagement', quietHours: quiet });
    expect(r.action).toBe('deliver');
  });

  it('cross-midnight quiet window (22:00-07:00): 23:00 quiet', () => {
    const quiet: QuietHours = { startMin: 22 * 60, endMin: 7 * 60 };
    const nowSec = atUtcMinute(23 * 60); // 23:00 UTC
    const r = evaluateDnd({ nowSec, priority: 'solicited', quietHours: quiet });
    expect(r.action).toBe('defer');
    // Resume at 07:00 next day → +8h = 28_800s.
    expect(r.resumeAtSec).toBe(atUtcMinute(23 * 60) + 8 * 3600);
  });

  it('cross-midnight quiet window: 03:00 still quiet', () => {
    const quiet: QuietHours = { startMin: 22 * 60, endMin: 7 * 60 };
    const nowSec = atUtcMinute(3 * 60);
    const r = evaluateDnd({ nowSec, priority: 'solicited', quietHours: quiet });
    expect(r.action).toBe('defer');
    expect(r.resumeAtSec).toBe(atUtcMinute(7 * 60));
  });

  it('cross-midnight quiet window: 12:00 NOT quiet', () => {
    const quiet: QuietHours = { startMin: 22 * 60, endMin: 7 * 60 };
    const nowSec = atUtcMinute(12 * 60);
    const r = evaluateDnd({ nowSec, priority: 'engagement', quietHours: quiet });
    expect(r.action).toBe('deliver');
  });

  it('tzOffsetMin shifts the window', () => {
    // Quiet 22-07 in UTC-8 (PST) means in UTC that's 06:00-15:00.
    const quiet: QuietHours = { startMin: 22 * 60, endMin: 7 * 60, tzOffsetMin: -480 };
    // nowSec = 10:00 UTC = 02:00 PST → PST in [22:00, 07:00] ≠ yes (02:00).
    const nowSec = atUtcMinute(10 * 60);
    const r = evaluateDnd({ nowSec, priority: 'solicited', quietHours: quiet });
    expect(r.action).toBe('defer');
  });
});

describe('isQuietNow', () => {
  it('returns false for zero-length window', () => {
    expect(isQuietNow(atUtcMinute(300), { startMin: 300, endMin: 300 })).toBe(false);
  });

  it('returns false for invalid quiet shape', () => {
    expect(isQuietNow(atUtcMinute(300), { startMin: -1, endMin: 100 })).toBe(false);
    expect(isQuietNow(atUtcMinute(300), { startMin: 100, endMin: 1441 })).toBe(false);
  });
});

describe('computeQuietEndSec', () => {
  it('returns null when not currently quiet', () => {
    const quiet: QuietHours = { startMin: 100, endMin: 200 };
    expect(computeQuietEndSec(atUtcMinute(300), quiet)).toBeNull();
  });
});

describe('evaluateDnd — rule ordering', () => {
  it('block list wins over fiduciary', () => {
    // Intentional: a sender you've blocked can't deliver even critical signals.
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'fiduciary',
      senderId: 'spam',
      blockList: ['spam'],
    });
    expect(r.action).toBe('suppress');
  });

  it('allow list wins over block list only if block NOT present', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'engagement',
      senderId: 'ok',
      allowList: ['ok'],
      blockList: ['someone-else'],
    });
    expect(r.action).toBe('deliver');
  });

  it('fiduciary beats focus mode', () => {
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'fiduciary',
      userState: 'focus',
    });
    expect(r.action).toBe('deliver');
  });

  it('offline beats focus state', () => {
    // userState 'offline' is checked before 'focus' — so even when both,
    // offline deferral applies. We can only set one state, but the
    // priority check confirms the rule path.
    const r = evaluateDnd({
      nowSec: 1,
      priority: 'solicited',
      userState: 'offline',
    });
    expect(r.reason).toBe('user_offline');
  });
});
