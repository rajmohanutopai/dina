/**
 * ServiceHandler tests.
 */

import { ServiceHandler, type ServiceHandlerCoreClient } from '../../src/service/service_handler';
// ServiceHandler catches `WorkflowConflictError` from `@dina/core`.
// The test throws the same class so `instanceof` matches.
import { WorkflowConflictError } from '@dina/core';
import type { ServiceConfig } from '../../../core/src/service/service_config';

interface CreateCall {
  id: string;
  kind: string;
  description: string;
  payload: unknown;
  origin?: string;
  correlationId?: string;
  expiresAtSec?: number;
  initialState?: string;
}

function stubCore(overrides?: { nextCreateError?: Error; nextCancelError?: Error }): {
  client: ServiceHandlerCoreClient;
  createCalls: CreateCall[];
  cancelCalls: Array<{ id: string; reason?: string }>;
  respondCalls: Array<unknown>;
  nextCreateError: Error | null;
  nextCancelError: Error | null;
} {
  const createCalls: CreateCall[] = [];
  const cancelCalls: Array<{ id: string; reason?: string }> = [];
  const respondCalls: Array<unknown> = [];
  let nextCreateError: Error | null = overrides?.nextCreateError ?? null;
  let nextCancelError: Error | null = overrides?.nextCancelError ?? null;
  const client = {
    async createWorkflowTask(input: CreateCall) {
      if (nextCreateError !== null) {
        const err = nextCreateError;
        nextCreateError = null;
        throw err;
      }
      createCalls.push(input);
      return { task: { id: input.id } as never, deduped: false };
    },
    async cancelWorkflowTask(id: string, reason?: string) {
      if (nextCancelError !== null) {
        const err = nextCancelError;
        nextCancelError = null;
        throw err;
      }
      cancelCalls.push({ id, reason });
      return {} as never;
    },
    async sendServiceRespond(..._args: unknown[]) {
      respondCalls.push(_args);
      return { status: 'sent', taskId: '', alreadyProcessed: false };
    },
  } as unknown as ServiceHandlerCoreClient;
  return {
    client,
    createCalls,
    cancelCalls,
    respondCalls,
    get nextCreateError() {
      return nextCreateError;
    },
    set nextCreateError(e: Error | null) {
      nextCreateError = e;
    },
    get nextCancelError() {
      return nextCancelError;
    },
    set nextCancelError(e: Error | null) {
      nextCancelError = e;
    },
  };
}

const baseConfig: ServiceConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  capabilities: {
    eta_query: {
      mcpServer: 'transit',
      mcpTool: 'get_eta',
      responsePolicy: 'auto',
      schemaHash: 'hash-v1',
    },
    route_info: {
      mcpServer: 'transit',
      mcpTool: 'get_route',
      responsePolicy: 'review',
    },
  },
  capabilitySchemas: {
    eta_query: {
      params: {
        type: 'object',
        required: ['location'],
        properties: {
          location: {
            type: 'object',
            required: ['lat', 'lng'],
            properties: {
              lat: { type: 'number', minimum: -90, maximum: 90 },
              lng: { type: 'number', minimum: -180, maximum: 180 },
            },
          },
        },
      },
      result: { type: 'object' },
      schemaHash: 'hash-v1',
    },
  },
};

const REQUESTER = 'did:plc:requester';

const validQuery = {
  query_id: 'q-1',
  capability: 'eta_query',
  params: { location: { lat: 37.77, lng: -122.41 } },
  ttl_seconds: 60,
  // GAP-SH-01: once the provider publishes a schema, requesters must
  // pin a hash. `baseConfig.capabilitySchemas.eta_query.schemaHash` is
  // `'hash-v1'`; echo that here so baseline tests pass the contract.
  schema_hash: 'hash-v1',
};

function makeHandler(opts: {
  core: ReturnType<typeof stubCore>;
  config?: ServiceConfig | null;
  nowSec?: number;
  uuid?: string;
  notifier?: Parameters<typeof ServiceHandler.prototype.handleQuery>[0] extends infer _
    ? never
    : never;
}) {
  const uuids = (opts.uuid ?? 'uuid-seq').split(',');
  let i = 0;
  return new ServiceHandler({
    coreClient: opts.core.client,
    readConfig: () => opts.config ?? baseConfig,
    nowSecFn: () => opts.nowSec ?? 1_700_000_000,
    generateUUID: () => uuids[i++ % uuids.length],
  });
}

describe('ServiceHandler.handleQuery — auto path', () => {
  it('creates a delegation task with the canonical payload', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'uuid-abc', nowSec: 1_000 });

    await handler.handleQuery(REQUESTER, validQuery);

    expect(core.createCalls).toHaveLength(1);
    const call = core.createCalls[0];
    expect(call.id).toBe('svc-exec-uuid-abc');
    expect(call.kind).toBe('delegation');
    expect(call.origin).toBe('d2d');
    expect(call.correlationId).toBe('q-1');
    expect(call.expiresAtSec).toBe(1_060); // nowSec + ttl
    const payload = JSON.parse(call.payload as string);
    expect(payload.type).toBe('service_query_execution');
    expect(payload.from_did).toBe(REQUESTER);
    expect(payload.query_id).toBe('q-1');
    expect(payload.service_name).toBe('Bus 42');
  });

  it('includes schema_hash in the payload when the query supplied one', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'u1' });

    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      schema_hash: 'hash-v1',
    });

    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.schema_hash).toBe('hash-v1');
  });

  it('drops silently when capability is not configured', async () => {
    const core = stubCore();
    const handler = makeHandler({ core });
    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      capability: 'unknown_cap',
    });
    expect(core.createCalls).toHaveLength(0);
  });

  it('drops when isDiscoverable is false', async () => {
    const core = stubCore();
    const handler = makeHandler({
      core,
      config: { ...baseConfig, isDiscoverable: false },
    });
    await handler.handleQuery(REQUESTER, validQuery);
    expect(core.createCalls).toHaveLength(0);
  });

  it('drops on schema_hash mismatch', async () => {
    const core = stubCore();
    const handler = makeHandler({ core });
    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      schema_hash: 'stale-hash',
    });
    expect(core.createCalls).toHaveLength(0);
  });

  it('GAP-SH-01: rejects missing schema_hash when provider has published a hash', async () => {
    // Published schema has `schemaHash: 'hash-v1'`. A requester that
    // omits `schema_hash` (or sends `''`) is rejected as
    // `schema_hash_required` — a stale client must not be allowed to
    // skip version safety.
    const core = stubCore();
    const logs: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      logger: (e) => {
        logs.push(e);
      },
      generateUUID: () => 'u1',
    });
    const { schema_hash: _omit, ...queryWithoutHash } = validQuery;
    await handler.handleQuery(REQUESTER, queryWithoutHash);
    expect(core.createCalls).toHaveLength(0);
    const rejection = logs.find((l) => l.event === 'service.query.rejected');
    expect(rejection).toBeDefined();
    expect(rejection!.message).toBe('schema_hash_required');
  });

  it('GAP-SH-01: also rejects empty schema_hash string', async () => {
    const core = stubCore();
    const logs: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      logger: (e) => {
        logs.push(e);
      },
      generateUUID: () => 'u1',
    });
    await handler.handleQuery(REQUESTER, { ...validQuery, schema_hash: '' });
    expect(core.createCalls).toHaveLength(0);
    expect(logs.find((l) => l.event === 'service.query.rejected')!.message).toBe(
      'schema_hash_required',
    );
  });

  it('GAP-SH-01: missing hash is permitted when provider has no versioned schemaHash', async () => {
    // When the provider advertises no hash (empty string), there is
    // nothing to pin — requester may omit.
    const core = stubCore();
    const config: ServiceConfig = {
      ...baseConfig,
      capabilitySchemas: {
        eta_query: {
          params: baseConfig.capabilitySchemas!.eta_query.params,
          result: { type: 'object' },
          schemaHash: '',
        },
      },
    };
    const handler = makeHandler({ core, config });
    const { schema_hash: _omit, ...queryWithoutHash } = validQuery;
    await handler.handleQuery(REQUESTER, queryWithoutHash);
    expect(core.createCalls).toHaveLength(1);
  });

  it('GAP-SH-02: drops on invalid params (via published-schema validator)', async () => {
    // Published schema declares `lat` in [-90, 90]. `lat: 999` violates
    // the bound and is caught by the published-schema validator, not
    // the registry fallback.
    const core = stubCore();
    const handler = makeHandler({ core });
    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      params: { location: { lat: 999, lng: 0 } }, // lat out of range
    });
    expect(core.createCalls).toHaveLength(0);
  });

  it('checks schema_hash BEFORE params validation (BRAIN-P3-P04 — cheap filter first)', async () => {
    // Bad schema_hash AND invalid params. If check order reverses, the
    // emitted rejection would carry a `lat`-related message instead of
    // `schema_version_mismatch`. Pins the ordering via the log sink.
    const core = stubCore();
    const logs: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      logger: (e) => {
        logs.push(e);
      },
      generateUUID: () => 'u1',
    });
    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      schema_hash: 'stale-hash',
      params: { location: { lat: 999, lng: 0 } }, // would also fail params check
    });
    expect(core.createCalls).toHaveLength(0);
    const rejection = logs.find((l) => l.event === 'service.query.rejected');
    expect(rejection).toBeDefined();
    expect(rejection!.message).toBe('schema_version_mismatch');
  });

  it('WM-BRAIN-06b: strips undeclared params before dispatch + logs dropped keys', async () => {
    // Uses an unregistered capability so the registry-level validator
    // is skipped and the strip is the only filter in play. Published
    // schema declares `stop_id` + `route_id`; the query supplies those
    // plus a bogus `admin_token` / `debug` the client invented. Only
    // the declared keys must reach the task payload, and the dropped
    // keys must appear in a structured log event.
    const core = stubCore();
    const logEntries: Array<Record<string, unknown>> = [];
    const config: ServiceConfig = {
      ...baseConfig,
      capabilities: {
        price_check: {
          mcpServer: 'market',
          mcpTool: 'get_price',
          responsePolicy: 'auto',
          schemaHash: 'hash-p1',
        },
      },
      capabilitySchemas: {
        price_check: {
          params: {
            type: 'object',
            properties: {
              stop_id: { type: 'string' },
              route_id: { type: 'string' },
            },
          },
          result: { type: 'object' },
          schemaHash: 'hash-p1',
        },
      },
    };
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => config,
      nowSecFn: () => 1_000,
      generateUUID: () => 'u',
      logger: (e) => logEntries.push(e),
    });

    await handler.handleQuery(REQUESTER, {
      query_id: 'q-1',
      capability: 'price_check',
      params: { stop_id: 'stop-42', route_id: 'r-7', admin_token: 'leak-me', debug: true },
      ttl_seconds: 60,
      schema_hash: 'hash-p1',
    });

    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.params).toEqual({ stop_id: 'stop-42', route_id: 'r-7' });
    // admin_token + debug never reach the task payload (or the provider).
    expect('admin_token' in payload.params).toBe(false);
    expect('debug' in payload.params).toBe(false);

    const strip = logEntries.find((e) => e.event === 'service.query.params_stripped');
    expect(strip).toBeDefined();
    expect(strip!.capability).toBe('price_check');
    expect(strip!.query_id).toBe('q-1');
    expect(strip!.dropped).toEqual(expect.arrayContaining(['admin_token', 'debug']));
    expect((strip!.dropped as string[]).length).toBe(2);
  });

  it('WM-BRAIN-06b: does not log when no params are dropped', async () => {
    const core = stubCore();
    const logEntries: Array<Record<string, unknown>> = [];
    const config: ServiceConfig = {
      ...baseConfig,
      capabilities: {
        price_check: {
          mcpServer: 'market',
          mcpTool: 'get_price',
          responsePolicy: 'auto',
          schemaHash: 'hash-p1',
        },
      },
      capabilitySchemas: {
        price_check: {
          params: {
            type: 'object',
            properties: { stop_id: { type: 'string' } },
          },
          result: { type: 'object' },
          schemaHash: 'hash-p1',
        },
      },
    };
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => config,
      nowSecFn: () => 1_000,
      generateUUID: () => 'u',
      logger: (e) => logEntries.push(e),
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-2',
      capability: 'price_check',
      params: { stop_id: 'x' },
      ttl_seconds: 60,
      schema_hash: 'hash-p1',
    });
    expect(logEntries.find((e) => e.event === 'service.query.params_stripped')).toBeUndefined();
  });

  it('WM-BRAIN-06b: pass-through when schema has no properties (no whitelist)', async () => {
    // Schema declares `params: { type: 'object' }` with no
    // `properties` map — nothing to filter against. The full client
    // params object survives untouched.
    const core = stubCore();
    const config: ServiceConfig = {
      ...baseConfig,
      capabilities: {
        price_check: {
          mcpServer: 'market',
          mcpTool: 'get_price',
          responsePolicy: 'auto',
          schemaHash: 'hash-p1',
        },
      },
      capabilitySchemas: {
        price_check: {
          params: { type: 'object' },
          result: { type: 'object' },
          schemaHash: 'hash-p1',
        },
      },
    };
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => config,
      nowSecFn: () => 1_000,
      generateUUID: () => 'u',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-3',
      capability: 'price_check',
      params: { whatever: 'goes' },
      ttl_seconds: 60,
      schema_hash: 'hash-p1',
    });
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.params).toEqual({ whatever: 'goes' });
  });

  it('WM-BRAIN-06a: auto-path payload carries mcp_tool at the top level (not in schema snapshot)', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'uuid-abc' });
    await handler.handleQuery(REQUESTER, validQuery);

    const payload = JSON.parse(core.createCalls[0].payload as string);
    // baseConfig declares eta_query.mcpTool = 'get_eta'
    expect(payload.mcp_tool).toBe('get_eta');
    // And it's a top-level key — not a nested field on the schema snapshot.
    expect(payload.schema_hash).toBeDefined();
    expect(typeof payload.mcp_tool).toBe('string');
    // The schema-hash value is whatever the caller supplied — we are
    // only checking the structural separation here.
  });

  it('WM-BRAIN-06a: approval-path payload also carries mcp_tool', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'uuid-r1' });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-2',
      capability: 'route_info', // responsePolicy=review
      params: { route_id: 'r-1' },
      ttl_seconds: 60,
    });
    const call = core.createCalls[0];
    expect(call.kind).toBe('approval');
    const payload = JSON.parse(call.payload as string);
    // baseConfig declares route_info.mcpTool = 'get_route'
    expect(payload.mcp_tool).toBe('get_route');
  });

  it('WM-BRAIN-06a: executeAndRespond forwards mcp_tool from the approval payload into the delegation', async () => {
    // Mirror the shape Guardian hands us: approval payload includes
    // mcp_tool. The fresh delegation task must carry it through.
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'svc-approval-1' });
    await handler.executeAndRespond('approval-task-1', {
      from_did: REQUESTER,
      query_id: 'q-3',
      capability: 'route_info',
      params: { route_id: 'r-1' },
      ttl_seconds: 60,
      schema_hash: 'hash-r1',
      service_name: 'Bus 42',
      mcp_tool: 'get_route',
    });
    expect(core.createCalls).toHaveLength(1);
    expect(core.createCalls[0].id).toBe('svc-exec-from-approval-task-1');
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.mcp_tool).toBe('get_route');
  });

  it('WM-BRAIN-06b: strips in the review/approval path too', async () => {
    const core = stubCore();
    const config: ServiceConfig = {
      ...baseConfig,
      capabilities: {
        price_check_review: {
          mcpServer: 'market',
          mcpTool: 'get_price',
          responsePolicy: 'review',
          schemaHash: 'hash-pr1',
        },
      },
      capabilitySchemas: {
        price_check_review: {
          params: {
            type: 'object',
            properties: { route_id: { type: 'string' } },
          },
          result: { type: 'object' },
          schemaHash: 'hash-pr1',
        },
      },
    };
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => config,
      nowSecFn: () => 1_000,
      generateUUID: () => 'u',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-4',
      capability: 'price_check_review',
      params: { route_id: 'r-1', bogus: 'x' },
      ttl_seconds: 60,
      schema_hash: 'hash-pr1',
    });
    // Approval task was created (single call, kind='approval'),
    // payload.params filtered.
    expect(core.createCalls[0].kind).toBe('approval');
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.params).toEqual({ route_id: 'r-1' });
  });

  it('drops silently on invalid body (no task created)', async () => {
    const core = stubCore();
    const handler = makeHandler({ core });
    await handler.handleQuery(REQUESTER, {
      capability: 'eta_query',
      ttl_seconds: 60,
      // no query_id or params
    });
    expect(core.createCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // GAP-SH-03 — execution payload carries schema_snapshot
  // -------------------------------------------------------------------

  it('GAP-SH-03: auto-path payload includes schema_snapshot frozen at create time', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'u1' });
    await handler.handleQuery(REQUESTER, validQuery);
    const payload = JSON.parse(core.createCalls[0].payload as string);
    // GAP-WIRE-01: snapshot uses snake_case per main-dina.
    expect(payload.schema_snapshot).toEqual({
      params: baseConfig.capabilitySchemas!.eta_query.params,
      result: baseConfig.capabilitySchemas!.eta_query.result,
      schema_hash: 'hash-v1',
    });
  });

  it('GAP-SH-03: schema_snapshot is omitted when no schema is published', async () => {
    // route_info has no entry in baseConfig.capabilitySchemas → no snapshot.
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'u1' });
    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      capability: 'route_info',
      params: { route_id: 'r-1' },
      schema_hash: undefined,
    });
    const call = core.createCalls[0];
    const payload = JSON.parse(call.payload as string);
    expect(payload.schema_snapshot).toBeUndefined();
  });

  it('GAP-SH-03: schema_snapshot is frozen — later config flips do not retroactively mutate it', async () => {
    // Mutate the config AFTER handleQuery returns. The persisted
    // payload is JSON — it should not track live-config changes.
    let currentConfig: ServiceConfig = { ...baseConfig };
    const core = stubCore();
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => currentConfig,
      nowSecFn: () => 1_000,
      generateUUID: () => 'u1',
    });
    await handler.handleQuery(REQUESTER, validQuery);
    const snapshotBefore = JSON.parse(core.createCalls[0].payload as string).schema_snapshot;

    // Flip the config's schema out from under the handler.
    currentConfig = {
      ...baseConfig,
      capabilitySchemas: {
        eta_query: {
          params: { type: 'object' },
          result: { type: 'object' },
          schemaHash: 'hash-v2',
        },
      },
    };
    const snapshotAfter = JSON.parse(core.createCalls[0].payload as string).schema_snapshot;
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  // -------------------------------------------------------------------
  // GAP-SH-04 — approval payload carries schema_snapshot +
  // executeAndRespond forwards it into the delegation
  // -------------------------------------------------------------------

  it('GAP-SH-04: approval-path payload includes schema_snapshot', async () => {
    const core = stubCore();
    const config: ServiceConfig = {
      ...baseConfig,
      capabilities: {
        price_check_review: {
          mcpServer: 'market',
          mcpTool: 'get_price',
          responsePolicy: 'review',
          schemaHash: 'hash-pr1',
        },
      },
      capabilitySchemas: {
        price_check_review: {
          params: { type: 'object', properties: { route_id: { type: 'string' } } },
          result: { type: 'object', properties: { price: { type: 'number' } } },
          schemaHash: 'hash-pr1',
        },
      },
    };
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => config,
      nowSecFn: () => 1_000,
      generateUUID: () => 'u',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-4',
      capability: 'price_check_review',
      params: { route_id: 'r-1' },
      ttl_seconds: 60,
      schema_hash: 'hash-pr1',
    });
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.schema_snapshot).toEqual({
      params: config.capabilitySchemas!.price_check_review.params,
      result: config.capabilitySchemas!.price_check_review.result,
      schema_hash: 'hash-pr1',
    });
  });

  it('GAP-SH-04: executeAndRespond forwards schema_snapshot from the approval payload into the delegation', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'u1' });
    const snapshot = {
      params: { type: 'object', required: ['route_id'] },
      result: { type: 'object', required: ['price'] },
      schema_hash: 'hash-pr1',
    };
    await handler.executeAndRespond('approval-task-9', {
      from_did: REQUESTER,
      query_id: 'q-9',
      capability: 'route_info',
      params: { route_id: 'r-9' },
      ttl_seconds: 60,
      schema_hash: 'hash-pr1',
      service_name: 'Bus 42',
      mcp_tool: 'get_route',
      schema_snapshot: snapshot,
    });
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.schema_snapshot).toEqual(snapshot);
  });
});

describe('ServiceHandler.handleQuery — review path', () => {
  it('creates an approval task (not delegation) for review-policy capability', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'u1', nowSec: 1_000 });

    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      capability: 'route_info',
      schema_hash: undefined,
    });

    expect(core.createCalls).toHaveLength(1);
    const call = core.createCalls[0];
    expect(call.kind).toBe('approval');
    expect(call.id).toMatch(/^approval-/);
    // Seeded in `pending_approval` so the operator's /service_approve
    // command (pending_approval → queued) fires without an extra hop.
    expect(call.initialState).toBe('pending_approval');
    // Invariant: NO delegation task is created on the review path. The
    // delegation only appears later, after approval → executeAndRespond.
    expect(core.createCalls.filter((c) => c.kind === 'delegation')).toHaveLength(0);

    // Payload shape matters: Guardian extracts these fields when it sees
    // the approved event and calls executeAndRespond. A silent regression
    // that dropped query_id / capability would break the whole flow.
    expect(call.correlationId).toBe('q-1');
    expect(call.expiresAtSec).toBe(1_060); // nowSec + ttl
    const payload = JSON.parse(call.payload as string);
    expect(payload).toMatchObject({
      type: 'service_query_execution',
      from_did: REQUESTER,
      query_id: 'q-1',
      capability: 'route_info',
      ttl_seconds: 60,
      service_name: 'Bus 42',
    });
  });

  it('auto-path delegation task enters `queued` state so paired agents can claim it', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'u1' });
    await handler.handleQuery(REQUESTER, validQuery);
    expect(core.createCalls[0].kind).toBe('delegation');
    expect(core.createCalls[0].initialState).toBe('queued');
  });

  it('fires the notifier with the approve command', async () => {
    const core = stubCore();
    const notifications: Array<{ taskId: string; approveCommand: string }> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      notifier: (n) => {
        notifications.push(n);
      },
      generateUUID: () => 'u1',
    });

    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      capability: 'route_info',
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].taskId).toBe('approval-u1');
    expect(notifications[0].approveCommand).toBe('/service_approve approval-u1');
  });

  it('isolates notifier errors (create still succeeds)', async () => {
    const core = stubCore();
    const logs: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      notifier: () => {
        throw new Error('notifier broke');
      },
      logger: (e) => {
        logs.push(e);
      },
      generateUUID: () => 'u1',
    });

    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      capability: 'route_info',
    });

    expect(core.createCalls).toHaveLength(1);
    expect(logs.some((l) => l.event === 'service.query.notifier_threw')).toBe(true);
  });
});

describe('ServiceHandler.handleQuery — inboundNotifier (provider-side chat visibility)', () => {
  it('fires for the auto path with kind="execution" after task creation', async () => {
    const core = stubCore();
    const seen: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      inboundNotifier: (n) => {
        seen.push(n);
      },
      generateUUID: () => 'u1',
    });

    await handler.handleQuery(REQUESTER, validQuery);

    expect(core.createCalls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      kind: 'execution',
      taskId: 'svc-exec-u1',
      fromDID: REQUESTER,
      capability: 'eta_query',
      serviceName: 'Bus 42',
    });
  });

  it('fires for the review path with kind="approval"', async () => {
    const core = stubCore();
    const seen: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      inboundNotifier: (n) => {
        seen.push(n);
      },
      generateUUID: () => 'u1',
    });

    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      capability: 'route_info',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'approval',
      taskId: 'approval-u1',
      capability: 'route_info',
    });
  });

  it('does NOT fire when the query is rejected (unknown capability)', async () => {
    const core = stubCore();
    const seen: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      inboundNotifier: (n) => {
        seen.push(n);
      },
      generateUUID: () => 'u1',
    });

    await handler.handleQuery(REQUESTER, { ...validQuery, capability: 'unknown_cap' });

    expect(core.createCalls).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it('does NOT fire when the query is rejected for schema hash mismatch', async () => {
    const core = stubCore();
    const seen: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      inboundNotifier: (n) => {
        seen.push(n);
      },
      generateUUID: () => 'u1',
    });

    await handler.handleQuery(REQUESTER, { ...validQuery, schema_hash: 'stale' });

    expect(seen).toHaveLength(0);
  });

  it('isolates inboundNotifier errors — task creation still succeeds, error is logged', async () => {
    const core = stubCore();
    const logs: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      inboundNotifier: () => {
        throw new Error('chat-thread broke');
      },
      logger: (e) => {
        logs.push(e);
      },
      generateUUID: () => 'u1',
    });

    await handler.handleQuery(REQUESTER, validQuery);

    expect(core.createCalls).toHaveLength(1);
    expect(logs.some((l) => l.event === 'service.query.inbound_notifier_threw')).toBe(true);
  });
});

describe('ServiceHandler.executeAndRespond', () => {
  const approvalTaskId = 'approval-test';
  const payload = {
    from_did: REQUESTER,
    query_id: 'q-1',
    capability: 'eta_query',
    params: { location: { lat: 0, lng: 0 } },
    ttl_seconds: 60,
    schema_hash: 'hash-v1',
    service_name: 'Bus 42',
  };

  it('creates a fresh delegation task + cancels the approval task', async () => {
    const core = stubCore();
    const handler = makeHandler({ core });

    await handler.executeAndRespond(approvalTaskId, payload);

    expect(core.createCalls).toHaveLength(1);
    expect(core.createCalls[0].id).toBe(`svc-exec-from-${approvalTaskId}`);
    expect(core.createCalls[0].kind).toBe('delegation');
    expect(core.cancelCalls).toEqual([{ id: approvalTaskId, reason: 'executed_via_delegation' }]);
    // BRAIN-P4-T05 invariant: `executeAndRespond` NEVER calls
    // `sendServiceRespond` directly — wire-level response emission is
    // owned by the Response Bridge (CORE-P3-I01/I02) which fires when
    // the delegation task reaches `completed`.
    expect(core.respondCalls).toHaveLength(0);
  });

  it('tolerates an existing delegation task (idempotent retry)', async () => {
    const core = stubCore({
      nextCreateError: new WorkflowConflictError('exists', 'duplicate_id'),
    });
    const handler = makeHandler({ core });
    // First call: create throws WorkflowConflictError → swallowed.
    await handler.executeAndRespond(approvalTaskId, payload);
    // Approval task still cancelled despite the conflict.
    expect(core.cancelCalls).toEqual([{ id: approvalTaskId, reason: 'executed_via_delegation' }]);
  });

  it('bubbles unexpected errors from createWorkflowTask', async () => {
    const core = stubCore({ nextCreateError: new Error('network down') });
    const handler = makeHandler({ core });
    await expect(handler.executeAndRespond(approvalTaskId, payload)).rejects.toThrow(
      /network down/,
    );
  });

  it('BRAIN-P4-T06: calling executeAndRespond twice yields exactly one successful delegation', async () => {
    // Two calls on the same approvalTaskId. First succeeds (create OK).
    // Second hits WorkflowConflictError on create (swallowed) + may also
    // hit a terminal approval task (tolerated). Net: one delegation on
    // the books, one successful cancel event — matching Guardian retry.
    const core = stubCore();
    const handler = makeHandler({ core });

    // First execution — both create + cancel succeed.
    await handler.executeAndRespond(approvalTaskId, payload);
    expect(core.createCalls).toHaveLength(1);
    expect(core.cancelCalls).toHaveLength(1);

    // Second execution — simulate Core reporting the delegation already
    // exists (deterministic id is the whole point).
    core.nextCreateError = new WorkflowConflictError('exists', 'duplicate_id');
    await handler.executeAndRespond(approvalTaskId, payload);

    // Still exactly one successful create on the books — the second's
    // throw happened before the stub recorded it. The two cancels are OK
    // (the real repo is idempotent on cancel of a cancelled task).
    expect(core.createCalls).toHaveLength(1);
    expect(core.createCalls[0].id).toBe(`svc-exec-from-${approvalTaskId}`);
  });

  it('tolerates an already-cancelled approval task (log-only)', async () => {
    const core = stubCore({
      nextCancelError: new Error('already terminal'),
    });
    const logs: Array<Record<string, unknown>> = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => baseConfig,
      logger: (e) => {
        logs.push(e);
      },
    });

    await handler.executeAndRespond(approvalTaskId, payload);

    expect(core.createCalls).toHaveLength(1); // delegation still created
    expect(logs.some((l) => l.event === 'service.query.approval_cancel_failed')).toBe(true);
  });

  it('throws WorkflowValidationError-like error on incomplete payload', async () => {
    const core = stubCore();
    const handler = makeHandler({ core });
    await expect(
      handler.executeAndRespond(approvalTaskId, {
        ...payload,
        query_id: '',
      }),
    ).rejects.toThrow(/incomplete payload/);
  });
});
