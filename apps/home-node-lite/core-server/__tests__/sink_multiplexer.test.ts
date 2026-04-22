/**
 * sink_multiplexer tests.
 */

import { BrainLogger, type LogRecord } from '../src/brain/brain_logger';
import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  createSinkMultiplexer,
  type SinkMultiplexerEvent,
  type SinkMultiplexerOptions,
} from '../src/brain/sink_multiplexer';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    level: 'info',
    msg: 'hi',
    fields: {},
    extra: {},
    time: 0,
    ...overrides,
  };
}

describe('createSinkMultiplexer — construction', () => {
  it.each([
    ['null opts', null],
    ['non-array sinks', { sinks: 'x' as unknown as SinkMultiplexerOptions['sinks'] }],
    ['empty sinks', { sinks: [] }],
    ['missing emit', { sinks: [{ name: 's' } as unknown as SinkMultiplexerOptions['sinks'][number]] }],
    ['bad minLevel', { sinks: [{ emit: () => {}, minLevel: 'bogus' as 'info' }] }],
    ['zero maxConsecutiveFailures', {
      sinks: [{ emit: () => {} }],
      maxConsecutiveFailures: 0,
    }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      createSinkMultiplexer(
        bad as unknown as Parameters<typeof createSinkMultiplexer>[0],
      ),
    ).toThrow();
  });

  it('DEFAULT_MAX_CONSECUTIVE_FAILURES is 5', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBe(5);
  });
});

describe('sink_multiplexer — dispatch', () => {
  it('fans out to every sink', () => {
    const a: LogRecord[] = [];
    const b: LogRecord[] = [];
    const mux = createSinkMultiplexer({
      sinks: [{ emit: (r) => a.push(r) }, { emit: (r) => b.push(r) }],
    });
    mux.emit(record({ msg: 'hello' }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('per-sink minLevel drops records below threshold', () => {
    const all: LogRecord[] = [];
    const errorsOnly: LogRecord[] = [];
    const mux = createSinkMultiplexer({
      sinks: [
        { emit: (r) => all.push(r) },
        { emit: (r) => errorsOnly.push(r), minLevel: 'error' },
      ],
    });
    mux.emit(record({ level: 'info' }));
    mux.emit(record({ level: 'error' }));
    expect(all).toHaveLength(2);
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0]!.level).toBe('error');
  });

  it('error in one sink does not prevent others from receiving', () => {
    const good: LogRecord[] = [];
    const mux = createSinkMultiplexer({
      sinks: [
        { name: 'bad', emit: () => { throw new Error('bad'); } },
        { name: 'good', emit: (r) => good.push(r) },
      ],
    });
    mux.emit(record());
    expect(good).toHaveLength(1);
  });

  it('successful emit resets consecutiveFailures counter', () => {
    let failOnce = true;
    let successCount = 0;
    const events: SinkMultiplexerEvent[] = [];
    const mux = createSinkMultiplexer({
      maxConsecutiveFailures: 3,
      onEvent: (e) => events.push(e),
      sinks: [
        {
          name: 'flaky',
          emit: () => {
            if (failOnce) {
              failOnce = false;
              throw new Error('flake');
            }
            successCount++;
          },
        },
      ],
    });
    mux.emit(record()); // fails
    mux.emit(record()); // succeeds → reset
    mux.emit(record()); // succeeds
    expect(successCount).toBe(2);
    const broken = events.filter((e) => e.kind === 'sink_broken');
    expect(broken).toHaveLength(0);
    const recovered = events.filter((e) => e.kind === 'sink_recovered');
    expect(recovered.length).toBeGreaterThan(0);
  });

  it('N consecutive failures → sink marked broken + skipped', () => {
    const events: SinkMultiplexerEvent[] = [];
    let attempts = 0;
    const mux = createSinkMultiplexer({
      maxConsecutiveFailures: 3,
      onEvent: (e) => events.push(e),
      sinks: [
        {
          name: 'broken',
          emit: () => {
            attempts += 1;
            throw new Error('persistent');
          },
        },
      ],
    });
    for (let i = 0; i < 3; i++) mux.emit(record());
    expect(attempts).toBe(3);
    // Subsequent calls: sink is broken, no more attempts.
    mux.emit(record());
    mux.emit(record());
    expect(attempts).toBe(3);
    const broken = events.filter((e) => e.kind === 'sink_broken');
    expect(broken).toHaveLength(1);
  });

  it('emit_failed event on each throw', () => {
    const events: SinkMultiplexerEvent[] = [];
    const mux = createSinkMultiplexer({
      maxConsecutiveFailures: 3,
      onEvent: (e) => events.push(e),
      sinks: [
        { name: 'bad', emit: () => { throw new Error('x'); } },
      ],
    });
    for (let i = 0; i < 2; i++) mux.emit(record());
    const failures = events.filter((e) => e.kind === 'emit_failed');
    expect(failures).toHaveLength(2);
    if (failures[0] && failures[0].kind === 'emit_failed') {
      expect(failures[0].consecutiveFailures).toBe(1);
    }
  });
});

describe('sink_multiplexer — reset + snapshot', () => {
  it('reset flips broken → healthy + resets counter', () => {
    const mux = createSinkMultiplexer({
      maxConsecutiveFailures: 2,
      sinks: [
        { name: 'bad', emit: () => { throw new Error('x'); } },
      ],
    });
    mux.emit(record());
    mux.emit(record());
    expect(mux.snapshot()[0]!.broken).toBe(true);
    expect(mux.reset('bad')).toBe(true);
    expect(mux.snapshot()[0]!.broken).toBe(false);
    expect(mux.snapshot()[0]!.failures).toBe(0);
  });

  it('reset on healthy sink → false', () => {
    const mux = createSinkMultiplexer({
      sinks: [{ name: 'ok', emit: () => {} }],
    });
    expect(mux.reset('ok')).toBe(false);
  });

  it('reset on unknown sink → false', () => {
    const mux = createSinkMultiplexer({
      sinks: [{ name: 's', emit: () => {} }],
    });
    expect(mux.reset('unknown')).toBe(false);
  });

  it('snapshot reflects sink state', () => {
    const mux = createSinkMultiplexer({
      sinks: [
        { name: 'a', emit: () => {}, minLevel: 'warn' },
        { name: 'b', emit: () => {} }, // default minLevel=debug
      ],
    });
    const snap = mux.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]!.name).toBe('a');
    expect(snap[0]!.minLevel).toBe('warn');
    expect(snap[1]!.minLevel).toBe('debug');
  });

  it('auto-generated sink names when not provided', () => {
    const mux = createSinkMultiplexer({
      sinks: [
        { emit: () => {} },
        { emit: () => {} },
      ],
    });
    const snap = mux.snapshot();
    expect(snap.map((s) => s.name)).toEqual(['sink-0', 'sink-1']);
  });
});

describe('sink_multiplexer — BrainLogger integration', () => {
  it('BrainLogger with multiplexed emit delivers to every sink', () => {
    const a: LogRecord[] = [];
    const b: LogRecord[] = [];
    const mux = createSinkMultiplexer({
      sinks: [{ emit: (r) => a.push(r) }, { emit: (r) => b.push(r) }],
    });
    const log = new BrainLogger({ level: 'info', emit: mux.emit });
    log.info('hello', { requestId: 'r-1' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.fields.req_id).toBe('r-1');
  });
});
