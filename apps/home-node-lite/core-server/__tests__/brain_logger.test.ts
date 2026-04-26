/**
 * Task 5.52 — BrainLogger tests.
 */

import {
  BrainLogger,
  type LogRecord,
} from '../src/brain/brain_logger';
import {
  newRootTrace,
  withTrace,
  withChildTrace,
} from '@dina/brain/src/diagnostics/trace_correlation';

/** Sink that captures records for assertion. */
function sink(): { records: LogRecord[]; emit: (r: LogRecord) => void } {
  const records: LogRecord[] = [];
  return {
    records,
    emit: (r) => {
      records.push(r);
    },
  };
}

describe('BrainLogger (task 5.52)', () => {
  describe('construction', () => {
    it('throws without emit', () => {
      expect(
        () =>
          new BrainLogger({
            emit: undefined as unknown as (r: LogRecord) => void,
          }),
      ).toThrow(/emit/);
    });
  });

  describe('levels', () => {
    it('default level is info — debug lines dropped', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.debug('hidden');
      log.info('shown');
      expect(s.records).toHaveLength(1);
      expect(s.records[0]!.msg).toBe('shown');
    });

    it('custom level=warn drops info + debug', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit, level: 'warn' });
      log.debug('x');
      log.info('y');
      log.warn('z');
      log.error('e');
      expect(s.records.map((r) => r.level)).toEqual(['warn', 'error']);
    });

    it('debug level shows everything', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit, level: 'debug' });
      log.debug('a');
      log.info('b');
      log.warn('c');
      log.error('d');
      expect(s.records).toHaveLength(4);
    });
  });

  describe('canonical field names', () => {
    it('emits top-level fields under Core slog names', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.info('http request', {
        method: 'GET',
        path: '/api/v1/ask',
        status: 200,
        duration: 42,
      });
      expect(s.records[0]!.fields).toEqual({
        method: 'GET',
        path: '/api/v1/ask',
        status: 200,
        duration: 42,
        service: 'brain',
      });
    });

    it.each([
      ['request_id', 'req_id'],
      ['requestId', 'req_id'],
      ['requestID', 'req_id'],
      ['reqId', 'req_id'],
      ['parentId', 'parent_id'],
      ['parentID', 'parent_id'],
      ['duration_ms', 'duration'],
      ['durationMs', 'duration'],
      ['latency', 'duration'],
      ['latency_ms', 'duration'],
      ['latencyMs', 'duration'],
      ['http_status', 'status'],
      ['httpStatus', 'status'],
      ['statusCode', 'status'],
      ['error_message', 'error'],
      ['err', 'error'],
      ['service_name', 'service'],
      ['serviceName', 'service'],
    ])('alias %s → canonical %s', (alias, canonical) => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.info('x', { [alias]: 'value' });
      expect(s.records[0]!.fields[canonical]).toBe('value');
      expect(s.records[0]!.fields[alias]).toBeUndefined();
    });

    it('unknown fields land in extra', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.info('x', { custom_field: 'value', foo: 42 });
      expect(s.records[0]!.fields.service).toBe('brain'); // canonical stays at top
      expect(s.records[0]!.extra).toEqual({ custom_field: 'value', foo: 42 });
    });
  });

  describe('error field handling', () => {
    it('Error instance → error.message', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.error('failed', { error: new Error('boom') });
      expect(s.records[0]!.fields.error).toBe('boom');
      expect(s.records[0]!.fields.stack).toBeUndefined();
    });

    it('includeStack=true attaches Error stack', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit, includeStack: true });
      log.error('failed', { error: new Error('boom') });
      expect(s.records[0]!.fields.error).toBe('boom');
      expect(typeof s.records[0]!.fields.stack).toBe('string');
    });

    it('string error passes through', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.error('failed', { error: 'direct message' });
      expect(s.records[0]!.fields.error).toBe('direct message');
    });

    it('non-string/non-Error error is stringified', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.error('failed', { error: 42 });
      expect(s.records[0]!.fields.error).toBe('42');
    });

    it('err alias works the same', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.error('failed', { err: new Error('alias works') });
      expect(s.records[0]!.fields.error).toBe('alias works');
    });
  });

  describe('trace auto-enrichment', () => {
    it('attaches req_id + parent_id from TraceContext', async () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      const root = newRootTrace(() => 1000);
      await withTrace(root, async () => {
        await withChildTrace(async () => {
          log.info('in child scope');
        });
      });
      const rec = s.records[0]!;
      expect(rec.fields.req_id).toBeDefined();
      expect(rec.fields.parent_id).toBe(root.requestId);
    });

    it('only req_id when no parent', async () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      const root = newRootTrace(() => 1000);
      await withTrace(root, async () => {
        log.info('in root scope');
      });
      expect(s.records[0]!.fields.req_id).toBe(root.requestId);
      expect(s.records[0]!.fields.parent_id).toBeUndefined();
    });

    it('no trace → no req_id injected', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.info('outside any scope');
      expect(s.records[0]!.fields.req_id).toBeUndefined();
    });

    it('explicit req_id wins over auto-enrichment', async () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      const root = newRootTrace(() => 1000);
      await withTrace(root, async () => {
        log.info('x', { req_id: 'explicit-id' });
      });
      expect(s.records[0]!.fields.req_id).toBe('explicit-id');
    });
  });

  describe('base fields', () => {
    it('baseFields attach to every record', () => {
      const s = sink();
      const log = new BrainLogger({
        emit: s.emit,
        baseFields: { did: 'did:plc:self' },
      });
      log.info('a');
      log.info('b');
      for (const r of s.records) {
        expect(r.fields.did).toBe('did:plc:self');
      }
    });

    it('per-call fields override baseFields', () => {
      const s = sink();
      const log = new BrainLogger({
        emit: s.emit,
        baseFields: { did: 'did:plc:self' },
      });
      log.info('x', { did: 'did:plc:override' });
      expect(s.records[0]!.fields.did).toBe('did:plc:override');
    });
  });

  describe('child logger', () => {
    it('inherits base fields + adds new ones', () => {
      const s = sink();
      const parent = new BrainLogger({
        emit: s.emit,
        baseFields: { did: 'did:plc:root' },
      });
      const child = parent.child({ path: '/api/v1/ask' });
      child.info('x');
      expect(s.records[0]!.fields.did).toBe('did:plc:root');
      expect(s.records[0]!.fields.path).toBe('/api/v1/ask');
    });

    it('child overrides parent bindings when same key used', () => {
      const s = sink();
      const parent = new BrainLogger({
        emit: s.emit,
        baseFields: { service: 'brain' },
      });
      const child = parent.child({ service: 'brain-admin' });
      child.info('x');
      expect(s.records[0]!.fields.service).toBe('brain-admin');
    });

    it('child inherits level + emit + includeStack', () => {
      const s = sink();
      const parent = new BrainLogger({
        emit: s.emit,
        level: 'warn',
        includeStack: true,
      });
      const child = parent.child({});
      child.info('dropped');
      child.warn('shown');
      expect(s.records).toHaveLength(1);
      child.error('with-stack', { error: new Error('x') });
      expect(s.records[1]!.fields.stack).toBeDefined();
    });
  });

  describe('service name', () => {
    it('default service field is "brain"', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.info('x');
      expect(s.records[0]!.fields.service).toBe('brain');
    });

    it('custom serviceName honoured', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit, serviceName: 'brain-admin' });
      log.info('x');
      expect(s.records[0]!.fields.service).toBe('brain-admin');
    });

    it('caller-supplied service overrides default', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.info('x', { service: 'forwarder' });
      expect(s.records[0]!.fields.service).toBe('forwarder');
    });
  });

  describe('record shape', () => {
    it('includes level + msg + time + fields + extra', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit, nowMsFn: () => 42 });
      log.info('hello', { custom: 'x' });
      expect(s.records[0]).toEqual({
        level: 'info',
        msg: 'hello',
        time: 42,
        fields: { service: 'brain' },
        extra: { custom: 'x' },
      });
    });

    it('undefined values are stripped', () => {
      const s = sink();
      const log = new BrainLogger({ emit: s.emit });
      log.info('x', { status: undefined, method: 'GET' });
      expect(s.records[0]!.fields.status).toBeUndefined();
      expect(s.records[0]!.fields.method).toBe('GET');
      expect('status' in s.records[0]!.fields).toBe(false);
    });
  });

  describe('realistic HTTP request log', () => {
    it('reflects a real request signature', async () => {
      const s = sink();
      const log = new BrainLogger({
        emit: s.emit,
        baseFields: { did: 'did:plc:brain' },
      });
      const root = newRootTrace(() => 1000);
      await withTrace(root, async () => {
        log.info('http request done', {
          method: 'POST',
          path: '/api/v1/ask',
          status: 200,
          latency_ms: 123,
        });
      });
      const fields = s.records[0]!.fields;
      expect(fields).toMatchObject({
        method: 'POST',
        path: '/api/v1/ask',
        status: 200,
        duration: 123,
        did: 'did:plc:brain',
        service: 'brain',
        req_id: root.requestId,
      });
    });
  });
});
