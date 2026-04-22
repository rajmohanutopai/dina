/**
 * Sink multiplexer — fan-out log sink wrapping multiple `LogEmitFn`s.
 *
 * `BrainLogger` (5.52) takes a single `emit: LogEmitFn`. In
 * production Brain writes to pino (stdout) AND to a per-request
 * trace buffer AND optionally to an in-memory ring for admin-UI
 * live-tail. Rather than chain those at each call site, this
 * primitive combines them:
 *
 *   new BrainLogger({emit: createSinkMultiplexer({sinks: [...]})})
 *
 * **Each sink entry** is `{emit, minLevel?, name?}`:
 *
 *   - `emit`     — the delegate.
 *   - `minLevel` — per-sink filter. Drops records below this level
 *                  before calling `emit`. Default: accept all.
 *   - `name`     — label for error isolation events.
 *
 * **Error isolation** — one sink throwing is isolated. The
 * multiplexer catches + fires an error event; the remaining sinks
 * still receive the record.
 *
 * **Consecutive failures mark a sink broken** — after N throws in a
 * row a sink is skipped. A successful emit resets the counter.
 *
 * **Pure state is in the multiplexer itself** — failure counters,
 * broken flags, optional event stream.
 */

import type { LogEmitFn, LogLevel, LogRecord } from './brain_logger';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface SinkConfig {
  emit: LogEmitFn;
  minLevel?: LogLevel;
  name?: string;
}

export type SinkMultiplexerEvent =
  | { kind: 'emit_failed'; sink: string; error: string; consecutiveFailures: number }
  | { kind: 'sink_broken'; sink: string; failures: number }
  | { kind: 'sink_recovered'; sink: string };

export interface SinkMultiplexerOptions {
  sinks: ReadonlyArray<SinkConfig>;
  /** Max consecutive failures before a sink is flagged broken. Default 5. */
  maxConsecutiveFailures?: number;
  onEvent?: (event: SinkMultiplexerEvent) => void;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

interface SinkState {
  name: string;
  emit: LogEmitFn;
  minLevel: LogLevel;
  consecutiveFailures: number;
  broken: boolean;
}

/**
 * Build a fan-out `LogEmitFn`. Exposes an introspector + a reset
 * method alongside so ops tools can view + recover broken sinks.
 */
export function createSinkMultiplexer(opts: SinkMultiplexerOptions): SinkMultiplexer {
  return new SinkMultiplexer(opts);
}

export class SinkMultiplexer {
  private readonly sinks: SinkState[];
  private readonly maxConsecutive: number;
  private readonly onEvent?: (event: SinkMultiplexerEvent) => void;

  constructor(opts: SinkMultiplexerOptions) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('SinkMultiplexer: opts required');
    }
    if (!Array.isArray(opts.sinks)) {
      throw new TypeError('SinkMultiplexer: sinks must be an array');
    }
    if (opts.sinks.length === 0) {
      throw new TypeError('SinkMultiplexer: at least one sink required');
    }
    this.maxConsecutive = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    if (!Number.isInteger(this.maxConsecutive) || this.maxConsecutive < 1) {
      throw new RangeError('maxConsecutiveFailures must be a positive integer');
    }
    this.onEvent = opts.onEvent;
    this.sinks = opts.sinks.map((s, i) => {
      if (!s || typeof s.emit !== 'function') {
        throw new TypeError(`SinkMultiplexer: sinks[${i}].emit must be a function`);
      }
      if (
        s.minLevel !== undefined &&
        s.minLevel !== 'debug' &&
        s.minLevel !== 'info' &&
        s.minLevel !== 'warn' &&
        s.minLevel !== 'error'
      ) {
        throw new TypeError(`SinkMultiplexer: sinks[${i}].minLevel invalid`);
      }
      return {
        name: s.name ?? `sink-${i}`,
        emit: s.emit,
        minLevel: s.minLevel ?? 'debug',
        consecutiveFailures: 0,
        broken: false,
      };
    });
  }

  /** The LogEmitFn callers pass to BrainLogger. */
  get emit(): LogEmitFn {
    return (record: LogRecord) => this.dispatch(record);
  }

  /** Snapshot — one row per sink. */
  snapshot(): Array<{ name: string; minLevel: LogLevel; broken: boolean; failures: number }> {
    return this.sinks.map((s) => ({
      name: s.name,
      minLevel: s.minLevel,
      broken: s.broken,
      failures: s.consecutiveFailures,
    }));
  }

  /** Flag a sink healthy again — used after ops resolves an outage. */
  reset(name: string): boolean {
    const sink = this.sinks.find((s) => s.name === name);
    if (!sink) return false;
    if (!sink.broken && sink.consecutiveFailures === 0) return false;
    sink.broken = false;
    sink.consecutiveFailures = 0;
    this.onEvent?.({ kind: 'sink_recovered', sink: name });
    return true;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private dispatch(record: LogRecord): void {
    for (const sink of this.sinks) {
      if (sink.broken) continue;
      if (LEVEL_ORDER[record.level] < LEVEL_ORDER[sink.minLevel]) continue;
      try {
        sink.emit(record);
        if (sink.consecutiveFailures > 0) {
          sink.consecutiveFailures = 0;
          this.onEvent?.({ kind: 'sink_recovered', sink: sink.name });
        }
      } catch (err) {
        sink.consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.onEvent?.({
          kind: 'emit_failed',
          sink: sink.name,
          error: msg,
          consecutiveFailures: sink.consecutiveFailures,
        });
        if (sink.consecutiveFailures >= this.maxConsecutive) {
          sink.broken = true;
          this.onEvent?.({
            kind: 'sink_broken',
            sink: sink.name,
            failures: sink.consecutiveFailures,
          });
        }
      }
    }
  }
}
