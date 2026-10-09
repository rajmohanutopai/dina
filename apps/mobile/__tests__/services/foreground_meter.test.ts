import { startForegroundMeter } from '../../src/services/foreground_meter';

function harness(active: boolean) {
  let t = 1_000_000;
  let tick: (() => void) | null = null;
  let listener: ((a: boolean) => void) | null = null;
  const credits: number[] = [];
  const stop = startForegroundMeter({
    isActive: () => active,
    subscribe: (cb) => {
      listener = cb;
      return () => undefined;
    },
    onCredit: (ms) => credits.push(ms),
    nowMs: () => t,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => undefined,
  });
  return {
    credits,
    stop,
    advance: (ms: number) => void (t += ms),
    tick: () => tick?.(),
    change: (a: boolean) => listener?.(a),
  };
}

describe('foreground time (REAL_LIFE_FIXES §14.4 A)', () => {
  it('a ten-second session is credited in full when the app leaves', () => {
    const h = harness(true);
    h.advance(10_000);
    h.change(false);
    expect(h.credits).toEqual([10_000]);
  });

  it('a late timer after a suspension credits nothing', () => {
    const h = harness(true);
    h.advance(5_000);
    h.change(false);
    h.advance(3_600_000); // suspended an hour
    h.tick(); // fires late, on resume
    expect(h.credits).toEqual([5_000]);
  });

  it('checkpoints split a long session without double counting; stop credits the rest', () => {
    const h = harness(true);
    h.advance(15_000);
    h.tick();
    h.advance(7_000);
    h.stop();
    expect(h.credits).toEqual([15_000, 7_000]);
  });

  it('starting in the background counts nothing until the app becomes active', () => {
    const h = harness(false);
    h.advance(60_000);
    h.tick();
    h.change(true);
    h.advance(4_000);
    h.change(false);
    expect(h.credits).toEqual([4_000]);
  });
});
