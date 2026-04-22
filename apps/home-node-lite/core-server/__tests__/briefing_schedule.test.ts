/**
 * briefing_schedule tests.
 */

import {
  BriefingSchedule,
  BriefingScheduleError,
  DEFAULT_ANCHOR_LOCAL_MIN,
} from '../src/brain/briefing_schedule';

class Clock {
  private t = 0;
  now = (): number => this.t;
  set(t: number): void { this.t = t; }
  advance(sec: number): void { this.t += sec; }
}

/** Seconds at UTC midnight on an arbitrary reference day (2023-11-15). */
const UTC_DAY_ZERO = 1_700_006_400;

function utcMinute(dayOffset: number, minuteOfDay: number): number {
  return UTC_DAY_ZERO + dayOffset * 86400 + minuteOfDay * 60;
}

describe('BriefingSchedule — construction', () => {
  it.each([
    ['invalid anchor neg', { anchorLocalMinutes: -1 }],
    ['invalid anchor 1440', { anchorLocalMinutes: 1440 }],
    ['fraction anchor', { anchorLocalMinutes: 7.5 }],
    ['tz too big', { tzOffsetMin: 2000 }],
    ['mismatched quiet start/end', { quietStartLocalMin: 600 }],
    ['invalid quiet range', { quietStartLocalMin: -1, quietEndLocalMin: 100 }],
    ['invalid quiet end', { quietStartLocalMin: 100, quietEndLocalMin: 1440 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => new BriefingSchedule(bad)).toThrow(BriefingScheduleError);
  });

  it('DEFAULT_ANCHOR_LOCAL_MIN is 07:30', () => {
    expect(DEFAULT_ANCHOR_LOCAL_MIN).toBe(7 * 60 + 30);
  });
});

describe('BriefingSchedule — first run', () => {
  it('anchor still ahead today → fires today at anchor', () => {
    const clock = new Clock();
    clock.set(utcMinute(0, 6 * 60)); // 06:00 UTC
    const sched = new BriefingSchedule({
      anchorLocalMinutes: 7 * 60 + 30,
      tzOffsetMin: 0,
      nowSecFn: clock.now,
    });
    const dec = sched.nextFireSec();
    expect(dec.fireAtSec).toBe(utcMinute(0, 7 * 60 + 30));
    expect(dec.reason).toBe('first_run');
  });

  it('anchor already passed today + never delivered → fires tomorrow at anchor', () => {
    const clock = new Clock();
    clock.set(utcMinute(0, 10 * 60));
    const sched = new BriefingSchedule({
      anchorLocalMinutes: 7 * 60 + 30,
      nowSecFn: clock.now,
    });
    const dec = sched.nextFireSec();
    expect(dec.fireAtSec).toBe(utcMinute(1, 7 * 60 + 30));
  });
});

describe('BriefingSchedule — post-delivery', () => {
  it('delivered today → next fire is tomorrow at anchor', () => {
    const clock = new Clock();
    const sched = new BriefingSchedule({ nowSecFn: clock.now });
    clock.set(utcMinute(0, 7 * 60 + 30));
    sched.markDelivered();
    // Still same day, later.
    clock.set(utcMinute(0, 12 * 60));
    const dec = sched.nextFireSec();
    expect(dec.fireAtSec).toBe(utcMinute(1, 7 * 60 + 30));
    expect(dec.reason).toBe('same_day_deferred_to_next_anchor');
  });

  it('delivered yesterday + today anchor ahead → fires today at anchor', () => {
    const clock = new Clock();
    const sched = new BriefingSchedule({ nowSecFn: clock.now });
    clock.set(utcMinute(0, 7 * 60 + 30));
    sched.markDelivered();
    clock.set(utcMinute(1, 6 * 60)); // next day, 06:00
    expect(sched.nextFireSec().fireAtSec).toBe(utcMinute(1, 7 * 60 + 30));
  });

  it('delivered yesterday + today anchor already passed → fires now', () => {
    const clock = new Clock();
    const sched = new BriefingSchedule({ nowSecFn: clock.now });
    clock.set(utcMinute(0, 7 * 60 + 30));
    sched.markDelivered();
    clock.set(utcMinute(1, 10 * 60)); // next day, 10:00
    const dec = sched.nextFireSec();
    expect(dec.fireAtSec).toBe(utcMinute(1, 10 * 60));
    expect(dec.reason).toBe('anchor_passed_deferred_to_next_anchor');
  });
});

describe('BriefingSchedule — on-demand', () => {
  it('triggerNow causes on-demand fire at now', () => {
    const clock = new Clock();
    clock.set(utcMinute(0, 6 * 60));
    const sched = new BriefingSchedule({ nowSecFn: clock.now });
    sched.triggerNow();
    const dec = sched.nextFireSec();
    expect(dec.kind).toBe('on_demand');
    expect(dec.fireAtSec).toBe(utcMinute(0, 6 * 60));
  });

  it('markDelivered clears pending on-demand', () => {
    const clock = new Clock();
    const sched = new BriefingSchedule({ nowSecFn: clock.now });
    sched.triggerNow();
    expect(sched.hasPendingOnDemand()).toBe(true);
    sched.markDelivered(utcMinute(0, 6 * 60));
    expect(sched.hasPendingOnDemand()).toBe(false);
  });

  it('nextFireSec is idempotent — calling twice returns same answer', () => {
    const clock = new Clock();
    clock.set(utcMinute(0, 6 * 60));
    const sched = new BriefingSchedule({ nowSecFn: clock.now });
    const a = sched.nextFireSec();
    const b = sched.nextFireSec();
    expect(a.fireAtSec).toBe(b.fireAtSec);
  });
});

describe('BriefingSchedule — quiet hours', () => {
  it('anchor inside quiet window → deferred to quiet end', () => {
    const clock = new Clock();
    clock.set(utcMinute(0, 6 * 60));
    const sched = new BriefingSchedule({
      anchorLocalMinutes: 7 * 60 + 30,
      quietStartLocalMin: 7 * 60,
      quietEndLocalMin: 8 * 60,
      nowSecFn: clock.now,
    });
    const dec = sched.nextFireSec();
    expect(dec.reason).toBe('deferred_quiet_hours');
    expect(dec.fireAtSec).toBe(utcMinute(0, 8 * 60));
  });

  it('anchor outside quiet window → fires at anchor', () => {
    const clock = new Clock();
    clock.set(utcMinute(0, 6 * 60));
    const sched = new BriefingSchedule({
      anchorLocalMinutes: 7 * 60 + 30,
      quietStartLocalMin: 22 * 60,
      quietEndLocalMin: 23 * 60,
      nowSecFn: clock.now,
    });
    expect(sched.nextFireSec().fireAtSec).toBe(utcMinute(0, 7 * 60 + 30));
  });

  it('cross-midnight quiet window handled', () => {
    // Anchor 01:00, quiet 22:00→02:00 → defer to 02:00.
    const clock = new Clock();
    clock.set(utcMinute(0, 0)); // 00:00
    const sched = new BriefingSchedule({
      anchorLocalMinutes: 60,
      quietStartLocalMin: 22 * 60,
      quietEndLocalMin: 2 * 60,
      nowSecFn: clock.now,
    });
    const dec = sched.nextFireSec();
    expect(dec.reason).toBe('deferred_quiet_hours');
    // Anchor is 01:00; that's inside 22-02 window → defer to 02:00.
    expect(dec.fireAtSec).toBe(utcMinute(0, 2 * 60));
  });
});

describe('BriefingSchedule — introspection', () => {
  it('lastDelivered is null until set', () => {
    const sched = new BriefingSchedule();
    expect(sched.lastDelivered()).toBeNull();
  });

  it('markDelivered with explicit timestamp', () => {
    const sched = new BriefingSchedule();
    sched.markDelivered(12345);
    expect(sched.lastDelivered()).toBe(12345);
  });

  it('markDelivered with NaN is a no-op', () => {
    const sched = new BriefingSchedule();
    sched.markDelivered(Number.NaN);
    expect(sched.lastDelivered()).toBeNull();
  });
});

describe('BriefingSchedule — tz offset', () => {
  it('PST anchor 07:30 fires at 15:30 UTC', () => {
    const clock = new Clock();
    clock.set(utcMinute(0, 0));
    const sched = new BriefingSchedule({
      anchorLocalMinutes: 7 * 60 + 30,
      tzOffsetMin: -480, // PST = UTC-8
      nowSecFn: clock.now,
    });
    const dec = sched.nextFireSec();
    // Local 00:00 PST = 08:00 UTC, local 07:30 = 15:30 UTC same-day.
    expect(dec.fireAtSec).toBe(utcMinute(0, 15 * 60 + 30));
  });
});
