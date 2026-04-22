/**
 * Task 5.4 — pino sink tests.
 */

import { Writable } from 'node:stream';

import { BrainLogger, type LogRecord } from '../src/brain/brain_logger';
import {
  createBrainPinoLogger,
  createPinoSink,
  type PinoLoggerLike,
} from '../src/brain/pino_sink';

type SpyCall = { method: 'debug' | 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg: string };

function spyLogger(): { logger: PinoLoggerLike; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const make = (method: SpyCall['method']) =>
    (obj: Record<string, unknown>, msg: string) => {
      calls.push({ method, obj, msg });
    };
  return {
    logger: {
      debug: make('debug'),
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
    },
    calls,
  };
}

/** In-memory writable — accumulates JSON lines so tests can assert pino output. */
class LineCapture extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    for (const line of text.split('\n')) {
      if (line !== '') this.lines.push(line);
    }
    cb();
  }
}

describe('createPinoSink (task 5.4)', () => {
  describe('construction', () => {
    it('throws when logger is not an object', () => {
      expect(() => createPinoSink(null as unknown as PinoLoggerLike)).toThrow(/logger/);
      expect(() =>
        createPinoSink('bogus' as unknown as PinoLoggerLike),
      ).toThrow(/logger/);
    });

    it.each(['debug', 'info', 'warn', 'error'] as const)(
      'throws when logger.%s is missing',
      (method) => {
        const base = spyLogger().logger;
        const broken = { ...base } as unknown as PinoLoggerLike;
        (broken as unknown as Record<string, unknown>)[method] = undefined;
        expect(() => createPinoSink(broken)).toThrow(new RegExp(method));
      },
    );
  });

  describe('level routing', () => {
    it.each([
      ['debug', 'debug'],
      ['info', 'info'],
      ['warn', 'warn'],
      ['error', 'error'],
    ] as const)('BrainLogger level %s → pino.%s', (brainLevel, pinoMethod) => {
      const { logger, calls } = spyLogger();
      const sink = createPinoSink(logger);
      const record: LogRecord = {
        level: brainLevel,
        msg: 'm',
        fields: { req_id: 'r-1' },
        extra: {},
        time: 1,
      };
      sink(record);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(pinoMethod);
    });
  });

  describe('field preservation', () => {
    it('canonical fields forwarded at top level with msg unchanged', () => {
      const { logger, calls } = spyLogger();
      const sink = createPinoSink(logger);
      sink({
        level: 'info',
        msg: 'request served',
        fields: { req_id: 'r-1', method: 'POST', path: '/x', status: 200, duration: 12 },
        extra: {},
        time: 1,
      });
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.method).toBe('info');
      expect(call.msg).toBe('request served');
      expect(call.obj).toEqual({
        req_id: 'r-1',
        method: 'POST',
        path: '/x',
        status: 200,
        duration: 12,
      });
      expect(call.obj).not.toHaveProperty('extra');
    });

    it('extras land under `extra` sub-object when present', () => {
      const { logger, calls } = spyLogger();
      const sink = createPinoSink(logger);
      sink({
        level: 'warn',
        msg: 'slow handler',
        fields: { duration: 500 },
        extra: { persona: 'general', attempt: 3 },
        time: 1,
      });
      expect(calls[0]!.obj).toEqual({
        duration: 500,
        extra: { persona: 'general', attempt: 3 },
      });
    });

    it('empty extras do NOT leak an empty `extra` key', () => {
      const { logger, calls } = spyLogger();
      const sink = createPinoSink(logger);
      sink({
        level: 'info',
        msg: 'm',
        fields: { service: 'brain' },
        extra: {},
        time: 1,
      });
      expect(calls[0]!.obj).not.toHaveProperty('extra');
    });

    it('sink is stateless — reusable across child loggers', () => {
      const { logger, calls } = spyLogger();
      const sink = createPinoSink(logger);
      sink({ level: 'info', msg: 'a', fields: {}, extra: {}, time: 1 });
      sink({ level: 'info', msg: 'b', fields: {}, extra: {}, time: 2 });
      expect(calls.map((c) => c.msg)).toEqual(['a', 'b']);
    });
  });

  describe('integration with BrainLogger', () => {
    it('BrainLogger wired to the sink forwards each line to pino methods', () => {
      const { logger, calls } = spyLogger();
      const log = new BrainLogger({
        level: 'info',
        emit: createPinoSink(logger),
        serviceName: 'brain',
      });
      log.info('hello', { requestId: 'r-42' });
      log.warn('uh oh', { durationMs: 99 });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        method: 'info',
        msg: 'hello',
        obj: { req_id: 'r-42', service: 'brain' },
      });
      expect(calls[1]).toMatchObject({
        method: 'warn',
        msg: 'uh oh',
        obj: { duration: 99, service: 'brain' },
      });
    });

    it('level below BrainLogger threshold is dropped before reaching pino', () => {
      const { logger, calls } = spyLogger();
      const log = new BrainLogger({
        level: 'warn',
        emit: createPinoSink(logger),
      });
      log.info('suppressed');
      log.warn('kept');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe('warn');
    });
  });
});

describe('createBrainPinoLogger (task 5.4)', () => {
  it('rejects unknown level', () => {
    expect(() =>
      createBrainPinoLogger({ level: 'bogus' as unknown as 'info' }),
    ).toThrow(/invalid level/);
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const)(
    'accepts pino level %s',
    (level) => {
      const logger = createBrainPinoLogger({ level });
      expect(logger.level).toBe(level);
    },
  );

  it('binds service name at the root', () => {
    const cap = new LineCapture();
    const logger = createBrainPinoLogger({
      level: 'info',
      destination: cap,
      serviceName: 'brain-test',
    });
    logger.info({ req_id: 'r-1' }, 'boot');
    expect(cap.lines).toHaveLength(1);
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed.service).toBe('brain-test');
    expect(parsed.req_id).toBe('r-1');
    expect(parsed.msg).toBe('boot');
    expect(parsed.level).toBe('info');
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  });

  it('default serviceName is "brain"', () => {
    const cap = new LineCapture();
    const logger = createBrainPinoLogger({ level: 'info', destination: cap });
    logger.info({}, 'x');
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed.service).toBe('brain');
  });

  it('respects level threshold — debug suppressed at info', () => {
    const cap = new LineCapture();
    const logger = createBrainPinoLogger({ level: 'info', destination: cap });
    logger.debug({}, 'quiet');
    logger.info({}, 'loud');
    expect(cap.lines).toHaveLength(1);
    expect(JSON.parse(cap.lines[0]!).msg).toBe('loud');
  });

  it('renders level as string label (matches Go slog)', () => {
    const cap = new LineCapture();
    const logger = createBrainPinoLogger({ level: 'warn', destination: cap });
    logger.warn({}, 'w');
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed.level).toBe('warn'); // NOT the numeric 40
  });

  it('rejects pretty + destination combo (avoids silent drop)', () => {
    const cap = new LineCapture();
    expect(() =>
      createBrainPinoLogger({ level: 'info', pretty: true, destination: cap }),
    ).toThrow(/pretty.*destination/i);
  });

  it('full integration: BrainLogger + sink + pino writes canonical JSON', () => {
    const cap = new LineCapture();
    const pinoLogger = createBrainPinoLogger({
      level: 'info',
      destination: cap,
      serviceName: 'brain',
    });
    const log = new BrainLogger({
      level: 'info',
      emit: createPinoSink(pinoLogger),
    });
    log.info('served', {
      requestId: 'r-99',
      method: 'POST',
      path: '/api/v1/ask',
      statusCode: 200,
      latencyMs: 42,
    });

    expect(cap.lines).toHaveLength(1);
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed).toMatchObject({
      service: 'brain',
      level: 'info',
      msg: 'served',
      req_id: 'r-99',
      method: 'POST',
      path: '/api/v1/ask',
      status: 200,
      duration: 42,
    });
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
