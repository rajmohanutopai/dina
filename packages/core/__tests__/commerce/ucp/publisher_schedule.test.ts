/** The publisher's upload lifecycle (UCP plan §3.5), with hand-driven timers. */
import {
  startPublisherSchedule,
  type PublicationStatus,
  type ScheduledPublisher,
} from '../../../src/commerce/ucp/publisher';

/** A timer queue the test advances by hand. */
class Timers {
  private items: { at: number; fn: () => void; id: number }[] = [];
  private nowMs = 0;
  private nextId = 0;
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.nextId;
    this.items.push({ at: this.nowMs + ms, fn, id });
    return id;
  };
  clear = (h: unknown): void => {
    this.items = this.items.filter((t) => t.id !== h);
  };
  /** Run the next timer (and let its promise chain settle); returns when it was due. */
  async next(): Promise<number> {
    this.items.sort((a, b) => a.at - b.at);
    const t = this.items.shift();
    if (t === undefined) throw new Error('no timer');
    this.nowMs = t.at;
    t.fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return t.at;
  }
  pending(): number[] {
    return this.items.map((t) => t.at).sort((a, b) => a - b);
  }
  now(): number {
    return this.nowMs;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function fakePublisher(statuses: PublicationStatus[], verify: PublicationStatus[] = []) {
  const calls: string[] = [];
  const p = {
    publish: async () => {
      calls.push('publish');
      return statuses.shift() ?? 'served';
    },
    verifyServed: async () => {
      calls.push('verify');
      return verify.shift() ?? 'served';
    },
    awaitingConfirmation: async () => false,
    nextKeyStepAt: async () => null,
  } satisfies ScheduledPublisher;
  return { p, calls };
}

describe('publisher schedule', () => {
  it('an owner action that throws is a fault to retry, and the schedule keeps going', async () => {
    const timers = new Timers();
    const { p } = fakePublisher(['served']);
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    await timers.next();
    expect(
      await s.act(async () => {
        throw new Error('boom');
      }),
    ).toBe('unreachable');
    expect(timers.pending()).toContain(MIN);
    s.stop();
  });

  it('publishes at boot, then daily once served', async () => {
    const timers = new Timers();
    const { p, calls } = fakePublisher(['served']);
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    expect(await timers.next()).toBe(0);
    expect(calls).toEqual(['publish']);
    expect(timers.pending()).toEqual([HOUR, 24 * HOUR]);
    s.stop();
  });

  it('backs off from one minute, doubling to an hour, while the host is unreachable', async () => {
    const timers = new Timers();
    const at: number[] = [];
    const p = {
      publish: async () => (at.push(timers.now()), 'unreachable' as const),
      verifyServed: async () => 'unreachable' as const,
      awaitingConfirmation: async () => false,
      nextKeyStepAt: async () => null,
    } satisfies ScheduledPublisher;
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    while (at.length < 9) await timers.next();
    const gaps = at.slice(1).map((t, i) => (t - (at[i] as number)) / MIN);
    expect(gaps).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    s.stop();
  });

  it('after standing down, reads the host again hourly (to follow the holder’s keys); a kick runs at once', async () => {
    const timers = new Timers();
    const { p, calls } = fakePublisher(['stood_down', 'served']);
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    await timers.next();
    expect(timers.pending()).toEqual([HOUR, HOUR]); // the hourly check and the next read
    s.kick();
    await timers.next();
    expect(calls).toEqual(['publish', 'publish']);
    s.stop();
  });

  it('republishes at once when the hourly check finds a stale copy', async () => {
    const timers = new Timers();
    const { p, calls } = fakePublisher(['served', 'served'], ['stale']);
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    await timers.next(); // boot publish
    await timers.next(); // the hourly check: stale
    await timers.next(); // the republish it triggers
    expect(calls).toEqual(['publish', 'verify', 'publish']);
    s.stop();
  });

  it('stop clears every timer', async () => {
    const timers = new Timers();
    const { p } = fakePublisher([]);
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    s.stop();
    expect(timers.pending()).toEqual([]);
  });

  it('a kick during a run is not lost: the run is repeated as soon as it ends', async () => {
    const timers = new Timers();
    let release: () => void = () => undefined;
    const runs: string[] = [];
    const p = {
      publish: async () => {
        runs.push('publish');
        if (runs.length === 1) await new Promise<void>((r) => (release = r));
        return 'served' as const;
      },
      verifyServed: async () => 'served' as const,
      awaitingConfirmation: async () => false,
      nextKeyStepAt: async () => null,
    } satisfies ScheduledPublisher;
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    await timers.next(); // the boot run starts and waits
    s.kick(); // the owner changes something meanwhile
    release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(timers.pending()[0]).toBe(0);
    await timers.next();
    expect(runs).toEqual(['publish', 'publish']);
    s.stop();
  });

  it('a pending owner control (stopping) is retried with backoff until it lands', async () => {
    const timers = new Timers();
    const { p, calls } = fakePublisher(['stopping', 'stopping', 'off']);
    const s = startPublisherSchedule(p, { setTimer: timers.set, clearTimer: timers.clear });
    expect(await timers.next()).toBe(0);
    expect(await timers.next()).toBe(MIN);
    expect(await timers.next()).toBe(3 * MIN);
    expect(calls).toEqual(['publish', 'publish', 'publish']);
    // Off: nothing more but the hourly check.
    expect(timers.pending()).toEqual([HOUR]);
    s.stop();
  });
});
