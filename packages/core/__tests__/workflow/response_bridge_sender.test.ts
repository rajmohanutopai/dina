/**
 * CORE-P3-I03 — Response Bridge wiring tests.
 *
 * Exercises the happy path (bridge context → D2D call), malformed
 * resultJSON handling, send-failure isolation, and the end-to-end
 * composition with a real `WorkflowService`.
 */

import {
  makeServiceResponseBridgeSender,
  type ResponseBridgeD2DSender,
} from '../../src/workflow/response_bridge_sender';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, type ServiceQueryBridgeContext } from '../../src/workflow/service';
import { WorkflowTaskKind } from '../../src/workflow/domain';
import type { ServiceResponseBody } from '../../src/d2d/service_bodies';

interface SendCall {
  to: string;
  body: ServiceResponseBody;
}

function makeSender(overrides?: { error?: Error; calls?: SendCall[] }): ResponseBridgeD2DSender {
  return async (to, body) => {
    overrides?.calls?.push({ to, body });
    if (overrides?.error) throw overrides.error;
  };
}

const SAMPLE_CTX: ServiceQueryBridgeContext = {
  taskId: 'svc-exec-1',
  fromDID: 'did:plc:requester',
  queryId: 'q-1',
  capability: 'eta_query',
  ttlSeconds: 60,
  resultJSON: '{"eta_minutes":45,"vehicle_type":"Bus","route_name":"42"}',
  serviceName: 'Bus 42',
};

describe('makeServiceResponseBridgeSender — construction', () => {
  it('rejects missing sendResponse', () => {
    expect(() =>
      makeServiceResponseBridgeSender({
        sendResponse: undefined as unknown as ResponseBridgeD2DSender,
      }),
    ).toThrow(/sendResponse/);
  });
});

describe('makeServiceResponseBridgeSender — happy path', () => {
  it('emits a well-formed service.response body from the bridge context', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
    });
    await bridge(SAMPLE_CTX);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      to: 'did:plc:requester',
      body: {
        query_id: 'q-1',
        capability: 'eta_query',
        status: 'success',
        result: { eta_minutes: 45, vehicle_type: 'Bus', route_name: '42' },
        ttl_seconds: 60,
      },
    });
  });

  it('preserves non-default ttl_seconds unchanged (payload TTL, not hardcoded)', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
    });
    await bridge({ ...SAMPLE_CTX, ttlSeconds: 120 });
    expect(calls[0].body.ttl_seconds).toBe(120);
  });

  it('sends body with undefined result when resultJSON is empty (summary-only completion)', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
    });
    await bridge({ ...SAMPLE_CTX, resultJSON: '' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.result).toBeUndefined();
    expect(calls[0].body.status).toBe('success');
  });
});

describe('makeServiceResponseBridgeSender — status derivation (issue #11)', () => {
  it('forwards status=unavailable verbatim when the runner tagged its result', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
    });
    await bridge({
      ...SAMPLE_CTX,
      resultJSON: JSON.stringify({
        status: 'unavailable',
        error: 'schedule_offline',
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.status).toBe('unavailable');
    expect(calls[0].body.error).toBe('schedule_offline');
  });

  it('forwards status=error verbatim including the error string', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
    });
    await bridge({
      ...SAMPLE_CTX,
      resultJSON: JSON.stringify({
        status: 'error',
        error: 'params_invalid: lat out of range',
      }),
    });
    expect(calls[0].body.status).toBe('error');
    expect(calls[0].body.error).toBe('params_invalid: lat out of range');
  });

  it('unwraps an explicit success envelope and surfaces the nested result', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
    });
    await bridge({
      ...SAMPLE_CTX,
      resultJSON: JSON.stringify({
        status: 'success',
        result: { eta_minutes: 7 },
      }),
    });
    expect(calls[0].body.status).toBe('success');
    expect(calls[0].body.result).toEqual({ eta_minutes: 7 });
  });

  it('wraps a plain object result as success (no opt-in status field)', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
    });
    await bridge({
      ...SAMPLE_CTX,
      resultJSON: JSON.stringify({ eta_minutes: 45 }),
    });
    expect(calls[0].body.status).toBe('success');
    expect(calls[0].body.result).toEqual({ eta_minutes: 45 });
  });
});

describe('makeServiceResponseBridgeSender — error paths', () => {
  it('on unparseable JSON: fires onMalformedResult AND sends an error service.response (issue #16)', async () => {
    const calls: SendCall[] = [];
    const malformed: Array<{ ctx: ServiceQueryBridgeContext; err: Error }> = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
      onMalformedResult: (ctx, err) => malformed.push({ ctx, err }),
    });
    await bridge({ ...SAMPLE_CTX, resultJSON: '{not json' });
    // Observability hook still fires for telemetry.
    expect(malformed).toHaveLength(1);
    expect(malformed[0].ctx.queryId).toBe('q-1');
    // AND a real error envelope is delivered so the requester stops
    // waiting on TTL expiry. Previously this path silently dropped.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.status).toBe('error');
    expect(calls[0].body.error).toMatch(/malformed_result:/);
  });

  it('invokes onSendError AND re-throws when the transport rejects (durability contract)', async () => {
    // Review (main-dina 4848a934): the bridge MUST throw on send
    // failure so `WorkflowService.bridgeServiceQueryCompletion` can
    // distinguish "delivered — clear the stash" from "failed — leave
    // for retry." The observability hook still fires for telemetry.
    const errors: Array<{ ctx: ServiceQueryBridgeContext; err: Error }> = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ error: new Error('ECONNRESET') }),
      onSendError: (ctx, err) => errors.push({ ctx, err }),
    });
    await expect(bridge(SAMPLE_CTX)).rejects.toThrow(/ECONNRESET/);
    expect(errors).toHaveLength(1);
    expect(errors[0].err.message).toBe('ECONNRESET');
  });

  it('re-throws send errors even with no hook installed (durability contract)', async () => {
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ error: new Error('silent failure') }),
    });
    await expect(bridge(SAMPLE_CTX)).rejects.toThrow(/silent failure/);
  });
});

describe('makeServiceResponseBridgeSender — end-to-end with WorkflowService', () => {
  it('fires on delegation completion with the canonical payload', async () => {
    const calls: SendCall[] = [];
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => 1_700_000_000_000,
      responseBridgeSender: makeServiceResponseBridgeSender({
        sendResponse: makeSender({ calls }),
      }),
    });

    service.create({
      id: 'svc-exec-1',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: JSON.stringify({
        type: 'service_query_execution',
        from_did: 'did:plc:requester',
        query_id: 'q-1',
        capability: 'eta_query',
        ttl_seconds: 60,
        service_name: 'Bus 42',
        params: { location: { lat: 37.77, lng: -122.41 } },
      }),
    });
    service.complete(
      'svc-exec-1',
      '{"eta_minutes":45,"vehicle_type":"Bus","route_name":"42"}',
      'responded',
    );

    // Give the bridge's async invocation a tick to land.
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('did:plc:requester');
    expect(calls[0].body).toEqual({
      query_id: 'q-1',
      capability: 'eta_query',
      status: 'success',
      result: { eta_minutes: 45, vehicle_type: 'Bus', route_name: '42' },
      ttl_seconds: 60,
    });
  });

  it('does NOT fire for non-delegation tasks or wrong-typed payloads', async () => {
    const calls: SendCall[] = [];
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => 1_700_000_000_000,
      responseBridgeSender: makeServiceResponseBridgeSender({
        sendResponse: makeSender({ calls }),
      }),
    });
    service.create({
      id: 'gen-1',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      // payload.type is not service_query_execution
      payload: JSON.stringify({ type: 'generic_job' }),
    });
    service.complete('gen-1', '{"ok":true}', 'done');
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GAP-SH-05 — result-schema validation via injected validator
// ---------------------------------------------------------------------------

describe('makeServiceResponseBridgeSender — GAP-SH-05 result validation', () => {
  const resultSchema = {
    type: 'object',
    required: ['eta_minutes'],
    properties: {
      eta_minutes: { type: 'number', minimum: 0 },
    },
  };

  const snapshotCtx: ServiceQueryBridgeContext = {
    ...SAMPLE_CTX,
    resultJSON: JSON.stringify({ eta_minutes: 45 }),
    schemaSnapshot: {
      params: { type: 'object' },
      result: resultSchema,
      schema_hash: 'hash-v1',
    },
  };

  // Minimal stand-in for the brain validator. The bootstrap wires in
  // the real thing; here we just need "returns null on match, string on mismatch."
  const fakeValidator = (value: unknown, schema: unknown): string | null => {
    const s = schema as { required?: string[]; properties?: Record<string, { minimum?: number }> };
    if (value === null || typeof value !== 'object') return 'must be an object';
    const obj = value as Record<string, unknown>;
    for (const req of s.required ?? []) {
      if (!(req in obj)) return `${req}: required`;
    }
    for (const [k, v] of Object.entries(obj)) {
      const prop = s.properties?.[k];
      if (prop?.minimum !== undefined && typeof v === 'number' && v < prop.minimum) {
        return `${k}: must be ≥ ${prop.minimum}`;
      }
    }
    return null;
  };

  it('passes through when the runner result matches the snapshot', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
      validateResult: fakeValidator,
    });
    await bridge(snapshotCtx);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.status).toBe('success');
    expect((calls[0].body.result as Record<string, unknown>).eta_minutes).toBe(45);
  });

  it('converts a schema violation into a result_schema_violation error response', async () => {
    const calls: SendCall[] = [];
    const failures: Array<{ error: string }> = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
      validateResult: fakeValidator,
      onResultValidationFailure: (_ctx, error) => failures.push({ error }),
    });
    await bridge({
      ...snapshotCtx,
      resultJSON: JSON.stringify({ eta_minutes: -5 }), // violates `minimum: 0`
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.status).toBe('error');
    expect(calls[0].body.error).toMatch(/result_schema_violation:/);
    expect(failures).toHaveLength(1);
  });

  it('skips validation when no schema_snapshot is present in the context', async () => {
    // No snapshot means the provider never published a schema for this
    // capability. Legacy path — pass through as success.
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
      validateResult: fakeValidator,
    });
    await bridge({
      ...SAMPLE_CTX,
      resultJSON: JSON.stringify({ eta_minutes: -5 }), // would fail if validated
    });
    expect(calls[0].body.status).toBe('success');
  });

  it('skips validation when no validateResult is wired (legacy core)', async () => {
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
      // validateResult intentionally omitted
    });
    await bridge({
      ...snapshotCtx,
      resultJSON: JSON.stringify({ eta_minutes: -5 }),
    });
    expect(calls[0].body.status).toBe('success');
  });

  it('passes non-success runner responses through unchanged (no revalidation)', async () => {
    // A runner-returned `error` body must reach the requester faithfully
    // — it wasn't claiming to match the schema, so revalidation would
    // replace a useful error message with "result_schema_violation".
    const calls: SendCall[] = [];
    const bridge = makeServiceResponseBridgeSender({
      sendResponse: makeSender({ calls }),
      validateResult: fakeValidator,
    });
    await bridge({
      ...snapshotCtx,
      resultJSON: JSON.stringify({ status: 'error', error: 'upstream timed out' }),
    });
    expect(calls[0].body.status).toBe('error');
    expect(calls[0].body.error).toBe('upstream timed out');
  });

  it('end-to-end: WorkflowService forwards payload.schema_snapshot to the validator', async () => {
    const calls: SendCall[] = [];
    const failures: string[] = [];
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: makeServiceResponseBridgeSender({
        sendResponse: makeSender({ calls }),
        validateResult: fakeValidator,
        onResultValidationFailure: (_ctx, err) => failures.push(err),
      }),
    });
    service.create({
      id: 'svc-exec-99',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: JSON.stringify({
        type: 'service_query_execution',
        from_did: 'did:plc:requester',
        query_id: 'q-99',
        capability: 'eta_query',
        params: {},
        ttl_seconds: 60,
        service_name: 'Bus 42',
        schema_snapshot: {
          params: { type: 'object' },
          result: resultSchema,
          schema_hash: 'hash-v1',
        },
      }),
    });
    service.complete('svc-exec-99', JSON.stringify({ eta_minutes: -1 }), 'done');
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.status).toBe('error');
    expect(calls[0].body.error).toMatch(/result_schema_violation:/);
    expect(failures).toHaveLength(1);
  });
});
