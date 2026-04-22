/**
 * debounce_throttle tests.
 */

import {
  DebounceThrottleError,
  debounce,
  throttle,
} from '../src/brain/debounce_throttle';

class FakeTimer {
  private t = 0;
  private timers = new Map<number, { fireAt: number; fn: () => void }>();
  private id = 0;

  now = (): number => this.t;

  set = (fn: () => void, ms: number): number => {
    const handle = ++this.id;
    this.timers.set(handle, { fireAt: this.t + ms, fn });
    return handle;
  };

  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.t + ms;
    while (true) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, { fireAt }] of this.timers) {
        if (fireAt <= target && fireAt < nextAt) {
          nextId = id;
          nextAt = fireAt;
        }
      }
      if (nextId === null) break;
      const entry = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = entry.fireAt;
      entry.fn();
    }
    this.t = target;
  }
}

function rig() {
  const timer = new FakeTimer();
  return {
    timer,
    opts: {
      setTimerFn: timer.set,
      clearTimerFn: timer.clear,
      nowMsFn: timer.now,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// debounce
// ══════════════════════════════════════════════════════════════════════

describe('debounce — validation', () => {
  it('rejects non-function', () => {
    expect(() =>
      debounce(null as unknown as () => void, 100),
    ).toThrow(DebounceThrottleError);
  });

  it.each([
    ['negative ms', -1],
    ['NaN ms', Number.NaN],
    ['Infinity ms', Number.POSITIVE_INFINITY],
  ] as const)('rejects %s', (_l, ms) => {
    expect(() => debounce(() => {}, ms)).toThrow(DebounceThrottleError);
  });

  it('rejects maxWaitMs less than ms', () => {
    expect(() =>
      debounce(() => {}, 100, { maxWaitMs: 50 }),
    ).toThrow(/maxWaitMs/);
  });
});

describe('debounce — behavior', () => {
  it('single call fires after ms', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const d = debounce(spy, 100, opts);
    d('a');
    timer.advance(50);
    expect(spy).not.toHaveBeenCalled();
    timer.advance(50);
    expect(spy).toHaveBeenCalledWith('a');
  });

  it('burst only fires once with last args', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const d = debounce(spy, 100, opts);
    d('a');
    timer.advance(50);
    d('b');
    timer.advance(50);
    d('c');
    timer.advance(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('pending() true between call and fire', () => {
    const { timer, opts } = rig();
    const d = debounce<[string]>(() => {}, 100, opts);
    expect(d.pending()).toBe(false);
    d('a');
    expect(d.pending()).toBe(true);
    timer.advance(100);
    expect(d.pending()).toBe(false);
  });

  it('cancel drops pending call', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const d = debounce(spy, 100, opts);
    d('a');
    d.cancel();
    timer.advance(200);
    expect(spy).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });

  it('flush fires pending immediately', () => {
    const { opts } = rig();
    const spy = jest.fn();
    const d = debounce(spy, 1000, opts);
    d('a');
    d.flush();
    expect(spy).toHaveBeenCalledWith('a');
    expect(d.pending()).toBe(false);
  });

  it('flush with no pending is a no-op', () => {
    const spy = jest.fn();
    const d = debounce(spy, 100);
    d.flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('maxWaitMs forces call despite continuous bursting', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const d = debounce(spy, 100, { ...opts, maxWaitMs: 300 });
    d('1');
    timer.advance(80);
    d('2');
    timer.advance(80);
    d('3');
    timer.advance(80);
    d('4');
    // Total elapsed: 240ms + next advance of 100 → 340 → maxWait 300 fired.
    timer.advance(100);
    expect(spy).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// throttle
// ══════════════════════════════════════════════════════════════════════

describe('throttle — validation', () => {
  it('rejects non-function', () => {
    expect(() =>
      throttle(null as unknown as () => void, 100),
    ).toThrow(DebounceThrottleError);
  });

  it('rejects leading + trailing both false', () => {
    expect(() =>
      throttle(() => {}, 100, { leading: false, trailing: false }),
    ).toThrow(/leading/);
  });
});

describe('throttle — leading + trailing (default)', () => {
  it('first call fires immediately', () => {
    const { opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 100, opts);
    t('a');
    expect(spy).toHaveBeenCalledWith('a');
  });

  it('bursts within window deferred to trailing edge', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 100, opts);
    t('a');
    t('b');
    t('c');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('a');
    timer.advance(100);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith('c');
  });

  it('calls after window fire again (leading)', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 100, opts);
    t('a');
    timer.advance(150);
    t('b');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 'a');
    expect(spy).toHaveBeenNthCalledWith(2, 'b');
  });
});

describe('throttle — leading only', () => {
  it('fires immediately; trailing discarded', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 100, { ...opts, trailing: false });
    t('a');
    t('b');
    t('c');
    timer.advance(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('a');
  });
});

describe('throttle — trailing only', () => {
  it('first call does NOT fire immediately', () => {
    const { opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 100, { ...opts, leading: false });
    t('a');
    expect(spy).not.toHaveBeenCalled();
  });

  it('trailing call fires last args at end of window', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 100, { ...opts, leading: false });
    t('a');
    t('b');
    t('c');
    timer.advance(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
  });
});

describe('throttle — cancel + flush', () => {
  it('cancel drops pending trailing', () => {
    const { timer, opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 100, opts);
    t('a');
    t('b');
    t.cancel();
    timer.advance(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('a');
  });

  it('flush fires pending trailing immediately', () => {
    const { opts } = rig();
    const spy = jest.fn();
    const t = throttle(spy, 1000, opts);
    t('a');
    t('b');
    t.flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith('b');
    expect(t.pending()).toBe(false);
  });

  it('pending reflects queued trailing', () => {
    const { opts } = rig();
    const t = throttle<[string]>(() => {}, 100, opts);
    t('a');
    expect(t.pending()).toBe(false); // first call fired immediately
    t('b');
    expect(t.pending()).toBe(true);
  });
});
