/**
 * Mobile Scenario 5 — Bus Driver end-to-end (README demo flow).
 *
 * Pipeline mirrored:
 *   User: "when does bus 42 reach Castro?"
 *     ↓ (the agentic ask LLM loop — simulated here deterministically)
 *   1. geocode("Castro, SF") → {lat, lng}
 *   2. search_provider_services({capability: 'eta_query', lat, lng})
 *        → BusDriver profile with DID, capability schema, schema_hash
 *   3. query_service({operator_did, capability, params: {route_id, location}})
 *        → orchestrator.issueQueryToDID → D2D service.query envelope on
 *          the wire, workflow task id returned
 *   4. Later, the response workflow event lands in the chat thread
 *      (covered separately by the workflow-event consumer tests).
 *
 * This test walks steps 1–3 deterministically with stubbed network
 * deps — the fetch call, the AppView client, and the orchestrator all
 * return canned results. The agentic loop is NOT invoked (no real
 * LLM); instead we drive the tool sequence the LLM WOULD drive.
 *
 * What this catches vs the simulator:
 *   - Tool composition: schema_hash flows from search_provider_services
 *     → query_service with the correct nested shape
 *   - Required-field validation inside each tool
 *   - Orchestrator wiring: the outbound D2D params are byte-exact
 *
 * What simulator still catches:
 *   - Real LLM decides the tool sequence (nondeterministic, token-bound)
 *   - Real MsgBox transport carries the envelope to BusDriver
 *   - BusDriver's own /task execution (OpenClaw in the demo)
 *   - Response-event delivery back into the chat thread
 */

import {
  createGeocodeTool,
  createSearchProviderServicesTool,
  createQueryServiceTool,
} from '../../src/reasoning/bus_driver_tools';
import type { ServiceProfile } from '../../src/appview_client/http';
import type { ServiceQueryOrchestrator } from '../../src/service/service_query_orchestrator';

function mockFetchOnce(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('mobile Scenario 5 — Bus Driver end-to-end', () => {
  const BUS_DRIVER_DID = 'did:plc:busdriver';
  const BUS_DRIVER_PROFILE: ServiceProfile = {
    did: BUS_DRIVER_DID,
    name: 'SF Transit Authority',
    capabilities: ['eta_query'],
    responsePolicy: { eta_query: 'auto' },
    capabilitySchemas: {
      eta_query: {
        params: {
          type: 'object',
          required: ['route_id', 'location'],
          properties: {
            route_id: { type: 'string' },
            location: {
              type: 'object',
              required: ['lat', 'lng'],
              properties: {
                lat: { type: 'number' },
                lng: { type: 'number' },
              },
            },
          },
        },
        result: { type: 'object' },
        schemaHash: 'sha256:busdriver-eta-v1',
        description: 'ETA to next stop on a given bus route',
        defaultTtlSeconds: 120,
      },
    },
    isDiscoverable: true,
    distanceKm: 2.3,
  };

  it('full flow: geocode → search → query_service dispatches correct payload', async () => {
    // ── Step 1: geocode ────────────────────────────────────────────────
    const geocode = createGeocodeTool({
      fetch: mockFetchOnce([
        {
          lat: '37.762',
          lon: '-122.435',
          display_name: 'Castro, San Francisco, California, USA',
        },
      ]),
      minGapMs: 0,
    });
    const loc = (await geocode.execute({ address: 'Castro, SF' })) as {
      lat: number;
      lng: number;
      display_name: string;
    };
    expect(loc).toMatchObject({ lat: 37.762, lng: -122.435 });

    // ── Step 2: search_provider_services ───────────────────────────────
    const search = createSearchProviderServicesTool({
      appViewClient: {
        async searchServices(params) {
          // AppView saw the correct capability + coords the geocode produced
          expect(params).toMatchObject({
            capability: 'eta_query',
            lat: loc.lat,
            lng: loc.lng,
          });
          return [BUS_DRIVER_PROFILE];
        },
      },
    });
    const providers = (await search.execute({
      capability: 'eta_query',
      lat: loc.lat,
      lng: loc.lng,
      radius_km: 5,
    })) as Array<{
      did: string;
      name: string;
      capability_schemas: Record<
        string,
        { schema_hash: string; params_schema: Record<string, unknown> }
      >;
    }>;

    expect(providers.length).toBe(1);
    const busDriver = providers[0]!;
    expect(busDriver.did).toBe(BUS_DRIVER_DID);
    expect(busDriver.capability_schemas.eta_query!.schema_hash).toBe(
      'sha256:busdriver-eta-v1',
    );

    // ── Step 3: query_service — dispatches through orchestrator ────────
    // Capture what the orchestrator received so we can pin the wire
    // contract between tool → orchestrator → sendD2D. The real
    // orchestrator interface speaks camelCase (toDID / schemaHash);
    // snake_case shows up only on the wire after the client call.
    const dispatched: Array<{
      toDID: string;
      capability: string;
      params: Record<string, unknown>;
      schemaHash: string | undefined;
      serviceName: string | undefined;
    }> = [];
    const orchestrator = {
      async issueQueryToDID(args: {
        toDID: string;
        capability: string;
        params: Record<string, unknown>;
        schemaHash?: string;
        serviceName?: string;
        ttlSeconds?: number;
      }): Promise<{
        queryId: string;
        taskId: string;
        toDID: string;
        serviceName: string;
        deduped: boolean;
      }> {
        dispatched.push({
          toDID: args.toDID,
          capability: args.capability,
          params: args.params,
          schemaHash: args.schemaHash,
          serviceName: args.serviceName,
        });
        return {
          queryId: 'q-abc123',
          taskId: 'wf-task-42',
          toDID: args.toDID,
          serviceName: args.serviceName ?? args.toDID,
          deduped: false,
        };
      },
    } as unknown as Parameters<typeof createQueryServiceTool>[0]['orchestrator'];

    const queryTool = createQueryServiceTool({ orchestrator });
    const ack = (await queryTool.execute({
      operator_did: busDriver.did,
      capability: 'eta_query',
      params: { route_id: '42', location: { lat: loc.lat, lng: loc.lng } },
      schema_hash: busDriver.capability_schemas.eta_query!.schema_hash,
      service_name: busDriver.name,
    })) as {
      task_id: string;
      query_id: string;
      to_did: string;
      service_name: string;
      deduped: boolean;
      status: 'pending';
    };

    // The LLM-facing ack must have task_id so the "Asking Bus 42…"
    // surface the user sees can correlate when the response arrives.
    expect(ack.task_id).toBe('wf-task-42');
    expect(ack.query_id).toBe('q-abc123');
    expect(ack.status).toBe('pending');

    // And the orchestrator got the exact params the LLM asked to dispatch.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({
      toDID: BUS_DRIVER_DID,
      capability: 'eta_query',
      params: { route_id: '42', location: { lat: 37.762, lng: -122.435 } },
      schemaHash: 'sha256:busdriver-eta-v1',
      serviceName: 'SF Transit Authority',
    });
  });

  it('query_service rejects missing params (LLM must fill them)', async () => {
    const orchestrator = {
      issueQueryToDID: async () => ({
        queryId: 'n/a',
        taskId: 'n/a',
        toDID: 'n/a',
        serviceName: 'n/a',
        deduped: false,
      }),
    } as unknown as Parameters<typeof createQueryServiceTool>[0]['orchestrator'];
    const tool = createQueryServiceTool({ orchestrator });

    // No params at all
    await expect(
      tool.execute({ operator_did: BUS_DRIVER_DID, capability: 'eta_query' } as Record<
        string,
        unknown
      >),
    ).rejects.toThrow(/params is required/);

    // Wrong-type params (array instead of object)
    await expect(
      tool.execute({
        operator_did: BUS_DRIVER_DID,
        capability: 'eta_query',
        params: ['not-an-object'],
      }),
    ).rejects.toThrow(/object/);
  });

  it('search_provider_services propagates schema_hash so requester can pin it on outbound query', async () => {
    // Core correctness: without schema_hash, the provider side can't
    // detect a version mismatch between published schema + the
    // request's shape. Any regression that drops the hash off the
    // search result's per-capability block breaks the retry loop
    // documented in docs/designs/SF_TRANSIT_DEMO.md.
    const search = createSearchProviderServicesTool({
      appViewClient: { async searchServices() {
        return [BUS_DRIVER_PROFILE];
      } },
    });
    const [profile] = (await search.execute({ capability: 'eta_query' })) as Array<{
      capability_schemas: Record<string, { schema_hash: string }>;
    }>;

    expect(profile.capability_schemas.eta_query!.schema_hash).toBe(
      'sha256:busdriver-eta-v1',
    );
  });

  it('no candidates → search_provider_services returns empty array (not throw)', async () => {
    // When the AppView has no matches, the tool must return [] so the
    // LLM can tell the user "no transit service in range" instead of
    // crashing the agentic loop with an exception.
    const search = createSearchProviderServicesTool({
      appViewClient: { async searchServices() {
        return [];
      } },
    });
    const result = await search.execute({ capability: 'eta_query', lat: 0, lng: 0 });
    expect(result).toEqual([]);
  });
});
