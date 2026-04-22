/**
 * service_query orchestrator tests (GAP.md #21 closure).
 */

import type {
  PreflightCandidate,
  PreflightOutcome,
  PreflightVerdict,
} from '../src/appview/service_query_preflight';
import {
  DEFAULT_TTL_SECONDS,
  createServiceQuery,
  type ProviderResponseEnvelope,
  type QueryBody,
  type ServiceQueryRequest,
} from '../src/brain/service_query';

function candidate(overrides: Partial<PreflightCandidate> = {}): PreflightCandidate {
  return {
    operatorDid: 'did:plc:provider',
    name: 'Provider',
    capability: 'eta_query',
    schemaHash: 'hash-v1',
    distanceKm: 1,
    ...overrides,
  };
}

function proceedVerdict(
  c: PreflightCandidate = candidate(),
): PreflightVerdict {
  return {
    candidate: c,
    trust: { score: 0.9, confidence: 0.8, ring: 2 },
    decision: {
      action: 'proceed',
      level: 'high',
      score: 0.9,
      confidence: 0.8,
      reasons: [],
    },
    error: null,
  };
}

function validReq(
  overrides: Partial<ServiceQueryRequest> = {},
): ServiceQueryRequest {
  return {
    capability: 'eta_query',
    params: { route_id: '42' },
    preflight: { capability: 'eta_query', context: 'read' },
    ...overrides,
  };
}

describe('createServiceQuery — construction', () => {
  it.each([
    ['preflightFn', { sendFn: jest.fn(), refreshProfileFn: jest.fn() }],
    ['sendFn', { preflightFn: jest.fn(), refreshProfileFn: jest.fn() }],
    ['refreshProfileFn', { preflightFn: jest.fn(), sendFn: jest.fn() }],
  ] as const)('throws without %s', (missing, bad) => {
    expect(() =>
      createServiceQuery(
        bad as unknown as Parameters<typeof createServiceQuery>[0],
      ),
    ).toThrow(new RegExp(missing));
  });

  it('DEFAULT_TTL_SECONDS is 60', () => {
    expect(DEFAULT_TTL_SECONDS).toBe(60);
  });
});

describe('createServiceQuery — input validation', () => {
  const noop = async () => {
    throw new Error('unreachable');
  };
  const run = createServiceQuery({
    preflightFn: noop as never,
    sendFn: noop as never,
    refreshProfileFn: noop as never,
  });

  it.each([
    ['null', null],
    ['empty capability', { ...validReq(), capability: '' }],
    ['non-object params', { ...validReq(), params: 'bogus' as unknown as Record<string, unknown> }],
    ['missing preflight', { ...validReq(), preflight: undefined as unknown as ServiceQueryRequest['preflight'] }],
    ['negative ttl', { ...validReq(), ttlSeconds: -1 }],
    ['fraction ttl', { ...validReq(), ttlSeconds: 1.5 }],
  ] as const)('%s → invalid_input', async (_l, bad) => {
    const r = await run(bad as ServiceQueryRequest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_input');
  });
});

describe('createServiceQuery — preflight paths', () => {
  it('preflight search_failed → preflight_failed', async () => {
    const preflight: PreflightOutcome = { ok: false, reason: 'search_failed', error: 'dns' };
    const run = createServiceQuery({
      preflightFn: async () => preflight,
      sendFn: jest.fn() as never,
      refreshProfileFn: jest.fn() as never,
    });
    const r = await run(validReq());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('preflight_failed');
      expect(r.detail).toBe('dns');
    }
  });

  it('no verdicts → preflight_no_candidates', async () => {
    const run = createServiceQuery({
      preflightFn: async () => ({ ok: true, verdicts: [], hasProceed: false }),
      sendFn: jest.fn() as never,
      refreshProfileFn: jest.fn() as never,
    });
    const r = await run(validReq());
    if (!r.ok) expect(r.reason).toBe('preflight_no_candidates');
    else throw new Error('expected failure');
  });

  it('verdicts but none proceed → preflight_no_proceed', async () => {
    const avoidVerdict: PreflightVerdict = {
      candidate: candidate(),
      trust: { score: 0.1, confidence: 0.1 },
      decision: {
        action: 'avoid',
        level: 'low',
        score: 0.1,
        confidence: 0.1,
        reasons: ['untrusted'],
      },
      error: null,
    };
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [avoidVerdict],
        hasProceed: false,
      }),
      sendFn: jest.fn() as never,
      refreshProfileFn: jest.fn() as never,
    });
    const r = await run(validReq());
    if (!r.ok) expect(r.reason).toBe('preflight_no_proceed');
  });
});

describe('createServiceQuery — happy path', () => {
  it('success response → ok outcome with retried:false', async () => {
    const seen: Array<{ toDid: string; body: QueryBody }> = [];
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) => {
        seen.push(input);
        return {
          queryId: input.body.query_id,
          status: 'success',
          result: { eta_minutes: 12 },
        } as ProviderResponseEnvelope;
      },
      refreshProfileFn: jest.fn() as never,
      makeQueryIdFn: () => 'q-fixed',
    });

    const r = await run(validReq());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.queryId).toBe('q-fixed');
      expect(r.retried).toBe(false);
      expect(r.result).toEqual({ eta_minutes: 12 });
      expect(r.candidate.operatorDid).toBe('did:plc:provider');
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.schema_hash).toBe('hash-v1');
    expect(seen[0]!.body.ttl_seconds).toBe(60);
  });

  it('picks the first verdict with action=proceed (not first in list)', async () => {
    const avoidFirst: PreflightVerdict = {
      candidate: candidate({ operatorDid: 'did:plc:lowtrust', name: 'Low', schemaHash: 'x' }),
      trust: { score: 0.1, confidence: 0.1 },
      decision: {
        action: 'avoid', level: 'low', score: 0.1, confidence: 0.1, reasons: [],
      },
      error: null,
    };
    const goodSecond = proceedVerdict(
      candidate({ operatorDid: 'did:plc:trusted', schemaHash: 'h1' }),
    );
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [avoidFirst, goodSecond],
        hasProceed: true,
      }),
      sendFn: async (input) => ({
        queryId: input.body.query_id,
        status: 'success',
        result: { picked: input.toDid },
      }),
      refreshProfileFn: jest.fn() as never,
    });
    const r = await run(validReq());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidate.operatorDid).toBe('did:plc:trusted');
  });

  it('ttlSeconds override flows into the body', async () => {
    let captured: QueryBody | null = null;
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) => {
        captured = input.body;
        return {
          queryId: input.body.query_id,
          status: 'success',
          result: { ok: true },
        };
      },
      refreshProfileFn: jest.fn() as never,
    });
    await run(validReq({ ttlSeconds: 5 }));
    expect(captured!.ttl_seconds).toBe(5);
  });

  it('params are defensively copied into the body', async () => {
    const params = { route_id: '42' };
    let captured: QueryBody | null = null;
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) => {
        captured = input.body;
        return { queryId: input.body.query_id, status: 'success', result: {} };
      },
      refreshProfileFn: jest.fn() as never,
    });
    await run(validReq({ params }));
    captured!.params.route_id = 'mutated';
    expect(params.route_id).toBe('42');
  });
});

describe('createServiceQuery — schema-mismatch retry', () => {
  it('retries once after mismatch → success', async () => {
    let attempts = 0;
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            queryId: input.body.query_id,
            status: 'error',
            error: 'schema_version_mismatch',
          };
        }
        return {
          queryId: input.body.query_id,
          status: 'success',
          result: { ok: true, hash: input.body.schema_hash },
        };
      },
      refreshProfileFn: async () => ({ ok: true, schemaHash: 'hash-v2' }),
    });
    const r = await run(validReq());
    expect(r.ok).toBe(true);
    expect(attempts).toBe(2);
    if (r.ok) {
      expect(r.retried).toBe(true);
      expect((r.result as { hash: string }).hash).toBe('hash-v2');
    }
  });

  it('retry still mismatches → schema_mismatch_after_retry', async () => {
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) => ({
        queryId: input.body.query_id,
        status: 'error',
        error: 'schema_version_mismatch',
      }),
      refreshProfileFn: async () => ({ ok: true, schemaHash: 'hash-v3' }),
    });
    const r = await run(validReq());
    if (!r.ok) expect(r.reason).toBe('schema_mismatch_after_retry');
  });

  it('refresh fails → schema_mismatch_after_retry', async () => {
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) => ({
        queryId: input.body.query_id,
        status: 'error',
        error: 'schema_version_mismatch',
      }),
      refreshProfileFn: async () => ({ ok: false }),
    });
    const r = await run(validReq());
    if (!r.ok) {
      expect(r.reason).toBe('schema_mismatch_after_retry');
      expect(r.detail).toBe('profile refresh failed');
    }
  });
});

describe('createServiceQuery — provider error + transport', () => {
  it('provider error → provider_error reason', async () => {
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) => ({
        queryId: input.body.query_id,
        status: 'error',
        error: 'rate_limited',
        detail: 'try again later',
      }),
      refreshProfileFn: jest.fn() as never,
    });
    const r = await run(validReq());
    if (!r.ok) {
      expect(r.reason).toBe('provider_error');
      expect(r.detail).toBe('rate_limited');
    }
  });

  it('sendFn throws → transport_failed', async () => {
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async () => {
        throw new Error('socket hang up');
      },
      refreshProfileFn: jest.fn() as never,
    });
    const r = await run(validReq());
    if (!r.ok) {
      expect(r.reason).toBe('transport_failed');
      expect(r.detail).toBe('socket hang up');
    }
  });

  it('unexpected envelope shape → provider_error', async () => {
    const run = createServiceQuery({
      preflightFn: async () => ({
        ok: true,
        verdicts: [proceedVerdict()],
        hasProceed: true,
      }),
      sendFn: async (input) =>
        ({
          queryId: input.body.query_id,
          status: 'success' as const,
        } as ProviderResponseEnvelope), // missing result
      refreshProfileFn: jest.fn() as never,
    });
    const r = await run(validReq());
    if (!r.ok) expect(r.reason).toBe('provider_error');
  });
});
