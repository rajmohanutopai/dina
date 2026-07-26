/**
 * ServiceHandler tests.
 */

import {
  WorkflowConflictError,
  type ServiceConfig,
  type ServiceReasoningSubmitter,
} from '@dina/core';

import {
  ServiceHandler,
  type ServiceHandlerCoreClient,
  type ServiceRejectResponder,
} from '../../src/service/service_handler';
import { canonicalCapabilitySchemaHash } from '../../src/service/service_publisher';

interface CreateCall {
  id: string;
  kind: string;
  description: string;
  payload: unknown;
  origin?: string;
  correlationId?: string;
  expiresAtSec?: number;
  initialState?: string;
  /** Runner-lane routing — 'dina.local' for Tier 1, the mcpServer otherwise. */
  requestedRunner?: string;
}

function stubCore(overrides?: { nextCreateError?: Error; nextCancelError?: Error }): {
  client: ServiceHandlerCoreClient;
  createCalls: CreateCall[];
  cancelCalls: { id: string; reason?: string }[];
  respondCalls: unknown[];
  nextCreateError: Error | null;
  nextCancelError: Error | null;
} {
  const createCalls: CreateCall[] = [];
  const cancelCalls: { id: string; reason?: string }[] = [];
  const respondCalls: unknown[] = [];
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
  reasoningSubmitter?: ServiceReasoningSubmitter;
  rejectResponder?: ServiceRejectResponder;
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
    ...(opts.reasoningSubmitter === undefined
      ? {}
      : { reasoningSubmitter: opts.reasoningSubmitter }),
    ...(opts.rejectResponder === undefined ? {} : { rejectResponder: opts.rejectResponder }),
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

  // SERVICES_LAUNCH_ARCHITECTURE.md Part 1, Layer 5 — alias↔canonical at
  // the provider. The bug this guards: consumer discovery hands out the
  // CANONICAL capability, Core's D2D ingress (`isCapabilityConfigured`)
  // accepts it on a canonical match against the provider's alias config,
  // and Brain's handler must AGREE — else Core accepts and Brain then
  // can't find the config (drops every query for an alias-configured
  // provider).
  it('Layer 5: ALIAS-configured provider accepts a CANONICAL inbound query', async () => {
    // Provider configured itself under the alias `bus_eta` (+ matching
    // alias-keyed schema); the requester's discovery sends canonical
    // `eta_query`. Must resolve, validate, and create the task.
    const aliasConfig: ServiceConfig = {
      isDiscoverable: true,
      name: 'Bus 42',
      capabilities: {
        bus_eta: {
          mcpServer: 'transit',
          mcpTool: 'get_eta',
          responsePolicy: 'auto',
          schemaHash: 'hash-v1',
        },
      },
      capabilitySchemas: {
        bus_eta: baseConfig.capabilitySchemas!.eta_query,
      },
    };
    const core = stubCore();
    const handler = makeHandler({ core, config: aliasConfig, uuid: 'u-alias' });
    await handler.handleQuery(REQUESTER, { ...validQuery, capability: 'eta_query' });
    // Accepted: a delegation task was created (not dropped).
    expect(core.createCalls).toHaveLength(1);
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.service_name).toBe('Bus 42');
  });

  it('Layer 5: CANONICAL-configured provider accepts an ALIAS inbound query', async () => {
    // Symmetric case — provider canonical, requester still holding an alias.
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'u-alias2' });
    await handler.handleQuery(REQUESTER, { ...validQuery, capability: 'bus_eta' });
    expect(core.createCalls).toHaveLength(1);
  });

  it('Layer 5: a DIFFERENT canonical does NOT cross (no accidental accept)', async () => {
    const core = stubCore();
    const handler = makeHandler({ core });
    // appointment_status is a different canonical — must still drop.
    await handler.handleQuery(REQUESTER, {
      ...validQuery,
      capability: 'appointment_status',
    });
    expect(core.createCalls).toHaveLength(0);
  });

  it('EXECUTES an active KNOWN_ONLY listing (Core grant-gated it at ingress; Brain executes)', async () => {
    // P1: the Brain's execution gate is `active` (any discoverability) — NOT
    // `isListingPublishable` (which excludes known_only). AUTHORIZATION for a
    // known_only query happened at Core ingress (a matching service_grant for
    // the authenticated caller); the Brain only EXECUTES what Core admitted, so
    // it must NOT re-drop known_only (the double-gate that previously killed
    // grant-authorized known_only queries). isDiscoverable=false + no explicit
    // discoverability → known_only; status defaults to active → executes.
    const core = stubCore();
    const handler = makeHandler({
      core,
      config: { ...baseConfig, isDiscoverable: false },
    });
    await handler.handleQuery(REQUESTER, validQuery);
    expect(core.createCalls).toHaveLength(1);
  });

  // The execution gate is `active` (any discoverability); authorization is Core's
  // job (public → discoverable, unlisted → service_uri, known_only → grant). A
  // paused/draft listing is still dropped (not active).
  it('ACCEPTS an active UNLISTED listing (reached by service_uri, must execute)', async () => {
    const core = stubCore();
    const handler = makeHandler({
      core,
      config: {
        ...baseConfig,
        isDiscoverable: false,
        discoverability: 'unlisted',
        status: 'active',
      },
    });
    await handler.handleQuery(REQUESTER, validQuery);
    expect(core.createCalls).toHaveLength(1);
  });

  it('DROPS a PAUSED listing even when public (per-listing OFF switch)', async () => {
    const core = stubCore();
    const handler = makeHandler({
      core,
      config: { ...baseConfig, discoverability: 'public', status: 'paused' },
    });
    await handler.handleQuery(REQUESTER, validQuery);
    expect(core.createCalls).toHaveLength(0);
  });

  it('DROPS a DRAFT listing (saved, not live)', async () => {
    const core = stubCore();
    const handler = makeHandler({
      core,
      config: { ...baseConfig, discoverability: 'public', status: 'draft' },
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
    const logs: Record<string, unknown>[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
    const logEntries: Record<string, unknown>[] = [];
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
    const logEntries: Record<string, unknown>[] = [];
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
    const notifications: { taskId: string; approveCommand: string }[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
    const seen: Record<string, unknown>[] = [];
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
    const seen: Record<string, unknown>[] = [];
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
    const seen: Record<string, unknown>[] = [];
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
    const seen: Record<string, unknown>[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'service.query.approval_cancel_failed',
        reason: 'approval_cleanup_failed',
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('already terminal');
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

describe('ServiceHandler — service_uri threading (P1, multi-listing per DID)', () => {
  const LISTING = 'at://did:plc:provider/com.dinakernel.service.profile/store-2';

  it('auto-path delegation payload carries service_uri', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'uuid-uri-1' });
    await handler.handleQuery(REQUESTER, { ...validQuery, service_uri: LISTING });
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.service_uri).toBe(LISTING);
  });

  it('auto-path omits service_uri when the requester sent none', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'uuid-uri-2' });
    await handler.handleQuery(REQUESTER, validQuery);
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.service_uri).toBeUndefined();
  });

  it('approval-path payload carries service_uri so it survives to the delegation', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'uuid-uri-3' });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-uri-review',
      capability: 'route_info', // responsePolicy=review
      params: { route_id: 'r-1' },
      ttl_seconds: 60,
      service_uri: LISTING,
      grant_id: 'grant-review-1',
    });
    const call = core.createCalls[0];
    expect(call.kind).toBe('approval');
    const payload = JSON.parse(call.payload as string);
    expect(payload.service_uri).toBe(LISTING);
    expect(payload.grant_id).toBe('grant-review-1');
  });

  it('executeAndRespond forwards service_uri from the approval payload into the delegation', async () => {
    const core = stubCore();
    const handler = makeHandler({ core, uuid: 'svc-uri-approval' });
    await handler.executeAndRespond('approval-task-uri', {
      from_did: REQUESTER,
      query_id: 'q-uri-exec',
      capability: 'route_info',
      params: { route_id: 'r-1' },
      ttl_seconds: 60,
      mcp_tool: 'get_route',
      service_uri: LISTING,
      grant_id: 'grant-review-1',
    });
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.service_uri).toBe(LISTING);
    expect(payload.grant_id).toBe('grant-review-1');
  });
});

describe('ServiceHandler — readConfig(rkey) selects the execution listing (P1a, multi-listing)', () => {
  // Two listings under ONE did, distinct rkeys + distinct capabilities:
  //   self    → eta_query
  //   route-7 → schedule_query
  // The provider must validate/execute a query against the listing named by
  // its service_uri's rkey, NOT against `self`.
  // Namespaced custom capabilities (no registry schema) so the test isolates
  // RKEY SELECTION — not registry param validation. self → com.self.cap,
  // route-7 → com.route7.cap; neither listing offers the other's capability.
  const SELF_CONFIG: ServiceConfig = {
    isDiscoverable: true,
    name: 'Bus 42 (self)',
    capabilities: {
      'com.self.cap': { mcpServer: 'transit', mcpTool: 'get_self', responsePolicy: 'auto' },
    },
  };
  const ROUTE7_CONFIG: ServiceConfig = {
    isDiscoverable: true,
    name: 'Route 7',
    capabilities: {
      'com.route7.cap': { mcpServer: 'transit', mcpTool: 'get_route7', responsePolicy: 'auto' },
    },
  };
  const route7Uri = 'at://did:plc:provider/com.dinakernel.service.profile/route-7';

  function rkeyHandler(core: ReturnType<typeof stubCore>) {
    return new ServiceHandler({
      coreClient: core.client,
      readConfig: (rkey?: string) => (rkey === 'route-7' ? ROUTE7_CONFIG : SELF_CONFIG),
      nowSecFn: () => 1_700_000_000,
      generateUUID: () => 'uuid-rkey',
    });
  }

  it("executes a query against the rkey's listing (com.route7.cap lives only on route-7)", async () => {
    const core = stubCore();
    await rkeyHandler(core).handleQuery(REQUESTER, {
      query_id: 'q-route7',
      capability: 'com.route7.cap',
      params: {},
      ttl_seconds: 60,
      service_uri: route7Uri,
    });
    // Accepted: a task is created, and its service_name comes from route-7.
    expect(core.createCalls).toHaveLength(1);
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.service_name).toBe('Route 7');
    expect(payload.service_uri).toBe(route7Uri);
  });

  it('rejects a capability that exists only on self when the query targets route-7', async () => {
    const core = stubCore();
    // com.self.cap is in SELF_CONFIG, NOT route-7 — with the rkey bound to
    // route-7 the provider must NOT fall back to self and accept it.
    await rkeyHandler(core).handleQuery(REQUESTER, {
      query_id: 'q-wrong-listing',
      capability: 'com.self.cap',
      params: {},
      ttl_seconds: 60,
      service_uri: route7Uri,
    });
    expect(core.createCalls).toHaveLength(0);
  });

  it('falls back to self when the query carries no service_uri', async () => {
    const core = stubCore();
    // No service_uri → rkeyForQuery returns undefined → readConfig defaults to
    // the `self` listing, which offers com.self.cap.
    await rkeyHandler(core).handleQuery(REQUESTER, {
      query_id: 'q-self',
      capability: 'com.self.cap',
      params: {},
      ttl_seconds: 60,
    });
    expect(core.createCalls).toHaveLength(1);
    const payload = JSON.parse(core.createCalls[0].payload as string);
    expect(payload.service_name).toBe('Bus 42 (self)');
  });
});

describe('ServiceHandler — Tier 1 execution-plane routing (docs/SERVICE_PROVIDER_TIERS.md)', () => {
  const tier1Config: ServiceConfig = {
    isDiscoverable: true,
    name: "Alonso's Salon",
    capabilities: {
      appointment_availability: {
        responsePolicy: 'auto',
        category: 'appointments',
        instruction: 'Use my appointment notes.',
      },
      eta_query: {
        mcpServer: 'transit',
        mcpTool: 'get_eta',
        responsePolicy: 'auto',
      },
    },
  };

  it("auto path: an instruction-only capability routes to requestedRunner 'dina.local'", async () => {
    const core = stubCore();
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => tier1Config,
      generateUUID: () => 'u-t1',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-t1',
      capability: 'appointment_availability',
      params: { service: 'haircut' },
      ttl_seconds: 120,
    });
    expect(core.createCalls).toHaveLength(1);
    expect(core.createCalls[0].requestedRunner).toBe('dina.local');
  });

  it('auto path: an agent-bound capability routes to its mcpServer', async () => {
    const core = stubCore();
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => tier1Config,
      generateUUID: () => 'u-t2',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-t2',
      capability: 'eta_query',
      params: { route_id: '42' },
      ttl_seconds: 60,
    });
    expect(core.createCalls).toHaveLength(1);
    expect(core.createCalls[0].requestedRunner).toBe('transit');
  });

  it('a capability with NO execution plane is rejected `capability_not_executable` and creates NO task', async () => {
    const core = stubCore();
    const logs: Record<string, unknown>[] = [];
    const noPlane: ServiceConfig = {
      isDiscoverable: true,
      name: 'Broken Svc',
      capabilities: {
        price_check: { responsePolicy: 'auto', category: 'commerce' },
      },
    };
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => noPlane,
      logger: (e) => {
        logs.push(e);
      },
      generateUUID: () => 'u-t3',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-t3',
      capability: 'price_check',
      params: { query: 'mangoes' },
      ttl_seconds: 60,
    });
    expect(core.createCalls).toHaveLength(0);
    const rejection = logs.find((l) => l.event === 'service.query.rejected');
    expect(rejection).toBeDefined();
    expect(rejection!.message).toBe('capability_not_executable');
  });

  it('whitespace-only instruction does NOT count as an execution plane', async () => {
    const core = stubCore();
    const logs: Record<string, unknown>[] = [];
    const wsConfig: ServiceConfig = {
      isDiscoverable: true,
      name: 'WS Svc',
      capabilities: {
        price_check: { responsePolicy: 'auto', category: 'commerce', instruction: '   ' },
      },
    };
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => wsConfig,
      logger: (e) => {
        logs.push(e);
      },
      generateUUID: () => 'u-t4',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-t4',
      capability: 'price_check',
      params: {},
      ttl_seconds: 60,
    });
    expect(core.createCalls).toHaveLength(0);
    expect(logs.find((l) => l.event === 'service.query.rejected')?.message).toBe(
      'capability_not_executable',
    );
  });

  it('canonical-recipe hash is accepted even when the STORED hash is stale (params-only writer heal)', async () => {
    // A config written with the old params-only recipe: stored hash is
    // garbage, but the requester echoes the canonical hash the publisher
    // actually published. checkSchemaHash must accept it.
    const params = { type: 'object', properties: { q: { type: 'string' } } };
    const result = { type: 'object', properties: { a: { type: 'string' } } };
    const canonical = canonicalCapabilitySchemaHash({ params, result, description: 'd' });
    const healedConfig: ServiceConfig = {
      isDiscoverable: true,
      name: 'Heal Svc',
      capabilities: {
        appointment_availability: {
          responsePolicy: 'auto',
          category: 'appointments',
          instruction: 'answer from notes',
          schemaHash: 'stale-params-only-hash',
        },
      },
      capabilitySchemas: {
        appointment_availability: {
          params,
          result,
          schemaHash: 'stale-params-only-hash',
          description: 'd',
        },
      },
    };
    const core = stubCore();
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => healedConfig,
      generateUUID: () => 'u-t5',
    });
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-t5',
      capability: 'appointment_availability',
      params: { q: 'slots' },
      ttl_seconds: 60,
      schema_hash: canonical,
    });
    expect(core.createCalls).toHaveLength(1);
  });
});

describe('ServiceHandler connected-Brain execution strategy', () => {
  const instructionConfig: ServiceConfig = {
    isDiscoverable: true,
    name: 'Alonso Salon',
    vaultPersona: 'salon',
    capabilities: {
      appointment_availability: {
        responsePolicy: 'auto',
        category: 'appointments',
        instruction: 'Use the salon schedule notes to answer availability.',
      },
    },
  };

  it('offers an instruction-backed read capability to reasoning instead of creating a delegation', async () => {
    const core = stubCore();
    const offered: Parameters<ServiceReasoningSubmitter>[0][] = [];
    const handler = makeHandler({
      core,
      config: instructionConfig,
      reasoningSubmitter: async (input) => {
        offered.push(input);
        return {
          taskId: 'reason-service-1',
          backendId: 'connected-agent',
          deduplicated: false,
        };
      },
    });

    await handler.handleQuery(REQUESTER, {
      query_id: 'q-reason-1',
      capability: 'appointment_availability',
      params: { date: 'tomorrow' },
      ttl_seconds: 120,
    });

    expect(core.createCalls).toHaveLength(0);
    expect(offered).toEqual([
      expect.objectContaining({
        requesterDid: REQUESTER,
        queryId: 'q-reason-1',
        capabilityId: 'appointment_availability',
        params: { date: 'tomorrow' },
        serviceName: 'Alonso Salon',
        vaultPersona: 'salon',
        operatorApproved: false,
        responseSchema: expect.objectContaining({ type: 'object' }),
      }),
    ]);
  });

  it('preserves the Tier-1 fallback when no live reasoning backend accepts the work', async () => {
    const core = stubCore();
    const handler = makeHandler({
      core,
      config: instructionConfig,
      reasoningSubmitter: async () => null,
      uuid: 'fallback',
    });

    await handler.handleQuery(REQUESTER, {
      query_id: 'q-reason-fallback',
      capability: 'appointment_availability',
      params: { date: 'tomorrow' },
      ttl_seconds: 120,
    });

    expect(core.createCalls).toHaveLength(1);
    expect(core.createCalls[0]).toMatchObject({
      id: 'svc-exec-fallback',
      kind: 'delegation',
      requestedRunner: 'dina.local',
    });
  });

  it('returns an error instead of executing changed work under a conflicting query id', async () => {
    const core = stubCore();
    const rejected = jest.fn(async () => undefined);
    const handler = makeHandler({
      core,
      config: instructionConfig,
      reasoningSubmitter: async () => {
        throw Object.assign(new Error('must not reach logs or fallback'), {
          code: 'conflict',
        });
      },
      rejectResponder: rejected,
    });

    await handler.handleQuery(REQUESTER, {
      query_id: 'q-reason-conflict',
      capability: 'appointment_availability',
      params: { date: 'tomorrow' },
      ttl_seconds: 120,
    });

    expect(core.createCalls).toHaveLength(0);
    expect(rejected).toHaveBeenCalledWith(
      REQUESTER,
      expect.objectContaining({
        query_id: 'q-reason-conflict',
        status: 'error',
        error: 'reasoning_request_conflict',
      }),
    );
  });

  it('does not downgrade stale service authority to the legacy executor', async () => {
    const core = stubCore();
    const rejected = jest.fn(async () => undefined);
    const handler = makeHandler({
      core,
      config: instructionConfig,
      reasoningSubmitter: async () => {
        throw Object.assign(new Error('grant or listing changed'), {
          code: 'authority_unavailable',
        });
      },
      rejectResponder: rejected,
    });

    await handler.handleQuery(REQUESTER, {
      query_id: 'q-reason-stale-authority',
      capability: 'appointment_availability',
      params: { date: 'tomorrow' },
      ttl_seconds: 120,
    });

    expect(core.createCalls).toHaveLength(0);
    expect(rejected).toHaveBeenCalledWith(
      REQUESTER,
      expect.objectContaining({
        query_id: 'q-reason-stale-authority',
        status: 'error',
        error: 'service_unavailable',
      }),
    );
  });

  it('does not downgrade unexpected reasoning failures to the legacy executor', async () => {
    const core = stubCore();
    const rejected = jest.fn(async () => undefined);
    const logs: Record<string, unknown>[] = [];
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => instructionConfig,
      reasoningSubmitter: async () => {
        throw new Error('database path and requester content must stay private');
      },
      rejectResponder: rejected,
      logger: (event) => {
        logs.push(event);
      },
    });

    await handler.handleQuery(REQUESTER, {
      query_id: 'q-reason-submit-error',
      capability: 'appointment_availability',
      params: { date: 'tomorrow' },
      ttl_seconds: 120,
    });

    expect(core.createCalls).toHaveLength(0);
    expect(rejected).toHaveBeenCalledWith(
      REQUESTER,
      expect.objectContaining({
        query_id: 'q-reason-submit-error',
        status: 'error',
        error: 'service_unavailable',
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'service.query.reasoning_unavailable',
        reason: 'reasoning_submission_failed',
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('database path');
  });

  it('keeps booking capabilities on the established effect-capable lane', async () => {
    const core = stubCore();
    const offered: unknown[] = [];
    const config: ServiceConfig = {
      ...instructionConfig,
      capabilities: {
        appointment_book: {
          responsePolicy: 'review',
          category: 'appointments',
          instruction: 'Book approved salon appointments.',
        },
      },
    };
    const handler = makeHandler({
      core,
      config,
      reasoningSubmitter: async (input) => {
        offered.push(input);
        return {
          taskId: 'must-not-run',
          backendId: 'connected-agent',
          deduplicated: false,
        };
      },
      uuid: 'booking',
    });

    await handler.executeAndRespond('approval-booking', {
      from_did: REQUESTER,
      query_id: 'q-booking',
      capability: 'appointment_book',
      params: { time: '4pm' },
      ttl_seconds: 120,
      service_name: 'Alonso Salon',
    });

    expect(offered).toHaveLength(0);
    expect(core.createCalls).toHaveLength(1);
    expect(core.createCalls[0]).toMatchObject({
      id: 'svc-exec-from-approval-booking',
      requestedRunner: 'dina.local',
    });
  });

  it('routes an approved read capability to reasoning and then closes the approval task', async () => {
    const core = stubCore();
    const offered: Parameters<ServiceReasoningSubmitter>[0][] = [];
    const reviewConfig: ServiceConfig = {
      ...instructionConfig,
      capabilities: {
        appointment_availability: {
          ...instructionConfig.capabilities.appointment_availability,
          responsePolicy: 'review',
        },
      },
    };
    const handler = makeHandler({
      core,
      config: reviewConfig,
      reasoningSubmitter: async (input) => {
        offered.push(input);
        return {
          taskId: 'reason-approved',
          backendId: 'connected-agent',
          deduplicated: false,
        };
      },
    });

    await handler.executeAndRespond('approval-read', {
      from_did: REQUESTER,
      query_id: 'q-approved-read',
      capability: 'appointment_availability',
      params: { date: 'tomorrow' },
      ttl_seconds: 120,
      service_name: 'Alonso Salon',
    });

    expect(core.createCalls).toHaveLength(0);
    expect(offered[0]).toMatchObject({ operatorApproved: true });
    expect(core.cancelCalls).toEqual([{ id: 'approval-read', reason: 'executed_via_reasoning' }]);
  });
});
