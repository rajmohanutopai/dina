/**
 * service_handler tests (GAP.md #19 closure).
 */

import {
  handleInboundQuery,
  validateParams,
  type CapabilityConfig,
  type InboundQuery,
  type ServiceHandlerConfig,
} from '../src/brain/service_handler';

function baseQuery(overrides: Partial<InboundQuery> = {}): InboundQuery {
  return {
    queryId: 'q-1',
    fromDid: 'did:plc:alice',
    capability: 'eta_query',
    schemaHash: 'a1b2c3',
    params: { route_id: '42' },
    receivedAt: 1_700_000_000,
    ...overrides,
  };
}

function etaCapability(overrides: Partial<CapabilityConfig> = {}): CapabilityConfig {
  return {
    name: 'eta_query',
    schemaHash: 'a1b2c3',
    paramsSchema: {
      type: 'object',
      properties: { route_id: { type: 'string' } },
      required: ['route_id'],
    },
    policy: 'auto',
    ...overrides,
  };
}

describe('handleInboundQuery — malformed queries', () => {
  it.each([
    ['null', null],
    ['non-object', 'bogus'],
    ['empty queryId', baseQuery({ queryId: '' })],
    ['non-DID fromDid', baseQuery({ fromDid: 'alice' })],
    ['empty capability', baseQuery({ capability: '' })],
    ['empty schemaHash', baseQuery({ schemaHash: '' })],
    ['non-object params', baseQuery({ params: 'bogus' as unknown as Record<string, unknown> })],
    ['non-finite receivedAt', baseQuery({ receivedAt: Number.NaN })],
  ] as const)('%s → reject malformed_query', (_l, bad) => {
    const config: ServiceHandlerConfig = { capabilities: [etaCapability()] };
    const r = handleInboundQuery(bad as InboundQuery, config);
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.body.error).toBe('malformed_query');
    }
  });
});

describe('handleInboundQuery — capability resolution', () => {
  it('unknown capability → reject', () => {
    const r = handleInboundQuery(
      baseQuery({ capability: 'unsupported' }),
      { capabilities: [etaCapability()] },
    );
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.body.error).toBe('unknown_capability');
      expect(r.body.detail).toBe('unsupported');
    }
  });

  it('schema_hash mismatch → reject', () => {
    const r = handleInboundQuery(
      baseQuery({ schemaHash: 'stale' }),
      { capabilities: [etaCapability({ schemaHash: 'current' })] },
    );
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.body.error).toBe('schema_version_mismatch');
      expect(r.body.detail).toContain('current');
      expect(r.body.detail).toContain('stale');
    }
  });
});

describe('handleInboundQuery — params validation', () => {
  it('missing required → reject invalid_params', () => {
    const r = handleInboundQuery(
      baseQuery({ params: {} }),
      { capabilities: [etaCapability()] },
    );
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.body.error).toBe('invalid_params');
      expect(r.body.detail).toContain('route_id');
    }
  });

  it('wrong type → reject', () => {
    const r = handleInboundQuery(
      baseQuery({ params: { route_id: 42 } }),
      { capabilities: [etaCapability()] },
    );
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.body.error).toBe('invalid_params');
      expect(r.body.detail).toContain('expected string');
    }
  });

  it('unknown property with additionalProperties=false → reject', () => {
    const cap = etaCapability({
      paramsSchema: {
        type: 'object',
        properties: { route_id: { type: 'string' } },
        required: ['route_id'],
        additionalProperties: false,
      },
    });
    const r = handleInboundQuery(
      baseQuery({ params: { route_id: '42', bogus: true } }),
      { capabilities: [cap] },
    );
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.body.detail).toContain('bogus');
    }
  });

  it('accepts extra properties when additionalProperties is omitted (default true)', () => {
    const r = handleInboundQuery(
      baseQuery({ params: { route_id: '42', extra: 'ok' } }),
      { capabilities: [etaCapability()] },
    );
    expect(r.action).toBe('delegate');
  });
});

describe('handleInboundQuery — response policies', () => {
  it('auto + delegation → task spec', () => {
    const r = handleInboundQuery(baseQuery(), {
      capabilities: [etaCapability()],
      makeTaskIdFn: () => 'task-abc',
    });
    expect(r.action).toBe('delegate');
    if (r.action === 'delegate') {
      expect(r.taskSpec.suggestedTaskId).toBe('task-abc');
      expect(r.taskSpec.kind).toBe('auto_delegation');
      expect(r.taskSpec.params).toEqual({ route_id: '42' });
      expect(r.taskSpec.queryId).toBe('q-1');
      expect(r.taskSpec.fromDid).toBe('did:plc:alice');
    }
  });

  it('auto + cannedResponse → respond directly', () => {
    const cap = etaCapability({
      cannedResponse: { pong: true, ts: 42 },
      paramsSchema: { type: 'object', properties: {}, required: [] },
    });
    const r = handleInboundQuery(
      baseQuery({ capability: 'eta_query', params: {} }),
      { capabilities: [cap] },
    );
    expect(r.action).toBe('respond');
    if (r.action === 'respond') {
      expect(r.body).toEqual({
        queryId: 'q-1',
        status: 'success',
        result: { pong: true, ts: 42 },
      });
    }
  });

  it('review policy → review task spec', () => {
    const r = handleInboundQuery(baseQuery(), {
      capabilities: [etaCapability({ policy: 'review' })],
    });
    expect(r.action).toBe('review');
    if (r.action === 'review') {
      expect(r.taskSpec.kind).toBe('review_pending_approval');
    }
  });

  it('deny policy → reject', () => {
    const r = handleInboundQuery(baseQuery(), {
      capabilities: [etaCapability({ policy: 'deny' })],
    });
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.body.error).toBe('policy_deny');
    }
  });

  it('canned response payload is defensively copied', () => {
    const canned = { pong: true };
    const cap = etaCapability({
      cannedResponse: canned,
      paramsSchema: { type: 'object', properties: {}, required: [] },
    });
    const r = handleInboundQuery(
      baseQuery({ params: {} }),
      { capabilities: [cap] },
    );
    if (r.action === 'respond') {
      (r.body.result as { pong: boolean }).pong = false;
    }
    expect(canned.pong).toBe(true);
  });
});

describe('handleInboundQuery — task spec', () => {
  it('params in task spec are a copy of incoming params', () => {
    const incoming = { route_id: '42' };
    const r = handleInboundQuery(
      baseQuery({ params: incoming }),
      { capabilities: [etaCapability()] },
    );
    if (r.action === 'delegate') {
      r.taskSpec.params.route_id = 'mutated';
    }
    expect(incoming.route_id).toBe('42');
  });

  it('default task id derived from queryId when makeTaskIdFn absent', () => {
    const r = handleInboundQuery(
      baseQuery({ queryId: 'q-xyz' }),
      { capabilities: [etaCapability()] },
    );
    if (r.action === 'delegate') {
      expect(r.taskSpec.suggestedTaskId).toBe('svc-task-q-xyz');
    }
  });

  it('receivedAt is echoed', () => {
    const r = handleInboundQuery(
      baseQuery({ receivedAt: 1_800_000_000 }),
      { capabilities: [etaCapability()] },
    );
    if (r.action === 'delegate') {
      expect(r.taskSpec.receivedAt).toBe(1_800_000_000);
    }
  });
});

describe('validateParams — reusable validator', () => {
  it('returns all errors in one pass', () => {
    const errors = validateParams(
      { a: 1 }, // a should be string; b is missing
      {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    );
    expect(errors.length).toBe(2);
  });

  it.each([
    ['string', 'x'],
    ['number', 3.14],
    ['integer', 7],
    ['boolean', true],
    ['array', [1, 2]],
    ['object', { k: 'v' }],
  ] as const)('type check — %s matches', (type, value) => {
    const errors = validateParams(
      { v: value },
      {
        type: 'object',
        properties: { v: { type: type as 'string' } },
        required: ['v'],
      },
    );
    expect(errors).toEqual([]);
  });

  it('integer rejects non-integer numbers', () => {
    const errors = validateParams(
      { v: 1.5 },
      {
        type: 'object',
        properties: { v: { type: 'integer' } },
        required: ['v'],
      },
    );
    expect(errors.length).toBe(1);
  });

  it('object type rejects arrays and null', () => {
    const e1 = validateParams(
      { v: [1] },
      {
        type: 'object',
        properties: { v: { type: 'object' } },
        required: ['v'],
      },
    );
    expect(e1.length).toBe(1);
    const e2 = validateParams(
      { v: null as unknown as Record<string, unknown> },
      {
        type: 'object',
        properties: { v: { type: 'object' } },
        required: ['v'],
      },
    );
    expect(e2.length).toBe(1);
  });
});
