/**
 * ServiceQueryOrchestrator tests.
 *
 * Covers:
 *   - Search + rank + hand off to `coreClient.sendServiceQuery`.
 *   - Returns immediately with dispatch identifiers (no awaiting a response).
 *   - No pending registry, no timeouts, no correlation — the response path
 *     is owned by Guardian/Core.
 *   - Validation errors (capability_required, params_required) fire before
 *     AppView is hit.
 *   - `no_candidate` error when AppView returns nothing.
 *   - `send_failed` wraps coreClient errors.
 *   - Forwards schema_hash from the chosen profile.
 *   - Respects custom ttlSeconds; falls back to capability default otherwise.
 *   - Propagates `deduped` from Core's response.
 *   - Stable queryId: uses the one we generate even if Core echoes a blank.
 */

import {
  ServiceQueryOrchestrator,
  ServiceOrchestratorError,
} from '../../src/service/service_query_orchestrator';
import type {
  AppViewClient,
  ServiceProfile,
  SearchServicesParams,
} from '../../src/appview_client/http';
import type { CoreClient, ServiceQueryResult as SendServiceQueryResult } from '@dina/core';

function stubAppView(
  services: ServiceProfile[],
  seen?: SearchServicesParams[],
): Pick<AppViewClient, 'searchServices'> {
  return {
    searchServices: async (p) => {
      seen?.push(p);
      return services;
    },
  };
}

interface CoreSend {
  toDID: string;
  capability: string;
  params: unknown;
  queryId: string;
  ttlSeconds: number;
  serviceName?: string;
  originChannel?: string;
  schemaHash?: string;
}

function stubCore(overrides?: {
  sendError?: Error;
  result?: SendServiceQueryResult;
  seen?: CoreSend[];
}): Pick<CoreClient, 'sendServiceQuery'> {
  return {
    sendServiceQuery: async (req) => {
      overrides?.seen?.push(req as CoreSend);
      if (overrides?.sendError) throw overrides.sendError;
      return overrides?.result ?? { taskId: 'sq-1', queryId: req.queryId, deduped: false };
    },
  };
}

const BUS_SERVICE: ServiceProfile = {
  did: 'did:plc:bus42',
  name: 'Bus 42',
  capabilities: ['eta_query'],
  isDiscoverable: true,
  capabilitySchemas: {
    eta_query: {
      params: { type: 'object' },
      result: { type: 'object' },
      schemaHash: 'hash-v1',
    },
  },
};

describe('ServiceQueryOrchestrator — construction', () => {
  it('rejects missing appViewClient', () => {
    expect(
      () =>
        new ServiceQueryOrchestrator({
          appViewClient: undefined as unknown as AppViewClient,
          coreClient: stubCore(),
        }),
    ).toThrow(/appViewClient/);
  });

  it('rejects missing coreClient', () => {
    expect(
      () =>
        new ServiceQueryOrchestrator({
          appViewClient: stubAppView([]),
          coreClient: undefined as unknown as CoreClient,
        }),
    ).toThrow(/coreClient/);
  });
});

describe('ServiceQueryOrchestrator.issueQuery — validation', () => {
  it('capability_required', async () => {
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore(),
    });
    await expect(orch.issueQuery({ capability: '', params: {} })).rejects.toThrow(
      ServiceOrchestratorError,
    );
  });

  it('params_required (null and undefined)', async () => {
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore(),
    });
    await expect(orch.issueQuery({ capability: 'eta_query', params: null })).rejects.toThrow(
      /params is required/,
    );
    await expect(
      orch.issueQuery({
        capability: 'eta_query',
        params: undefined as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/params is required/);
  });

  it("rejects params that fail the capability's sender-side schema check (main-dina 9b1c4a47)", async () => {
    // eta_query expects `{ location: { lat, lng } }`. An empty object
    // should be rejected BEFORE we hit Core so a mis-shaped tool call
    // doesn't consume a round-trip.
    //
    // Provider publishes NO schemaHash — that's the "hashes agree (or
    // no hash)" branch where our local validator runs. A mismatched
    // hash would skip validation instead (see next test).
    const profile: ServiceProfile = {
      ...BUS_SERVICE,
      capabilitySchemas: undefined,
    };
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([profile]),
      coreClient: stubCore({ seen: coreSeen }),
    });
    await expect(orch.issueQuery({ capability: 'eta_query', params: {} })).rejects.toMatchObject({
      code: 'params_invalid',
    });
    // Crucially: no round-trip happened. The check is sender-side.
    expect(coreSeen).toHaveLength(0);
  });

  it('skips sender-side validation when the provider advertises a different schema_hash (review #2)', async () => {
    // The provider's published schema_hash doesn't match our local
    // hash for eta_query → the provider is on a different schema
    // version. Running our stale validator against their schema
    // could reject payloads they'd legitimately accept, so defer to
    // them. Verifies the query still dispatches even when params
    // would fail OUR validator.
    const otherVersion: ServiceProfile = {
      ...BUS_SERVICE,
      capabilitySchemas: {
        eta_query: {
          params: { type: 'object' },
          result: { type: 'object' },
          // Bogus hash that will not match our locally-computed hash.
          schemaHash: 'hash-future-v99',
        },
      },
    };
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([otherVersion]),
      coreClient: stubCore({ seen: coreSeen }),
    });
    await orch.issueQuery({
      capability: 'eta_query',
      params: {}, // Would fail our validator if it ran.
    });
    expect(coreSeen).toHaveLength(1);
    expect(coreSeen[0].schemaHash).toBe('hash-future-v99');
  });

  it('issueQueryToDID always validates locally regardless of caller-supplied schema_hash (review #5)', async () => {
    // The `query_service` LLM tool forwards whatever schema_hash the
    // model emits. Letting a bogus / hallucinated hash disable the
    // local validator would defeat the guard. `issueQueryToDID`
    // always runs the local check when a capability is registered —
    // the hash still rides the wire for the provider's version
    // check, but we do NOT trust it to gate our own validator.
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore({ seen: coreSeen }),
    });
    // Bogus hash supplied → still rejected because we ignore the
    // caller's hash for gating.
    await expect(
      orch.issueQueryToDID({
        toDID: 'did:plc:bus42',
        capability: 'eta_query',
        params: {},
        schemaHash: 'hash-future-v99',
      }),
    ).rejects.toMatchObject({ code: 'params_invalid' });
    // And without a hash — same result.
    await expect(
      orch.issueQueryToDID({
        toDID: 'did:plc:bus42',
        capability: 'eta_query',
        params: {},
      }),
    ).rejects.toMatchObject({ code: 'params_invalid' });
    expect(coreSeen).toHaveLength(0);
  });

  it('issueQueryToDID forwards the caller-supplied schema_hash on the wire even though it does NOT gate validation', async () => {
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore({ seen: coreSeen }),
    });
    await orch.issueQueryToDID({
      toDID: 'did:plc:bus42',
      capability: 'eta_query',
      params: { location: { lat: 0, lng: 0 } }, // valid — passes our validator
      schemaHash: 'hash-provider-v2',
    });
    expect(coreSeen).toHaveLength(1);
    expect(coreSeen[0].schemaHash).toBe('hash-provider-v2');
  });

  it('skips validation for unregistered capabilities (deferred to provider)', async () => {
    // When a capability has no local registry entry, the Go behaviour
    // is "validate when schema is present" — skip the check and let
    // the provider's validator handle it. Verifies we don't over-
    // restrict: arbitrary capability names stay shippable.
    const unknownCap: ServiceProfile = {
      ...BUS_SERVICE,
      capabilities: ['some_future_cap'],
      capabilitySchemas: undefined,
    };
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([unknownCap]),
      coreClient: stubCore({ seen: coreSeen }),
    });
    await orch.issueQuery({
      capability: 'some_future_cap',
      params: { anything: true },
    });
    expect(coreSeen).toHaveLength(1);
  });
});

describe('ServiceQueryOrchestrator.issueQuery — dispatch', () => {
  it('hands off to coreClient.sendServiceQuery with the canonical request', async () => {
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore({ seen: coreSeen }),
      generateQueryId: () => 'q-deterministic',
    });

    const result = await orch.issueQuery({
      capability: 'eta_query',
      params: { location: { lat: 37.77, lng: -122.41 } },
      ttlSeconds: 90,
      originChannel: 'chat',
    });

    expect(result).toEqual({
      queryId: 'q-deterministic',
      taskId: 'sq-1',
      toDID: 'did:plc:bus42',
      serviceName: 'Bus 42',
      deduped: false,
    });
    expect(coreSeen).toHaveLength(1);
    expect(coreSeen[0]).toEqual({
      toDID: 'did:plc:bus42',
      capability: 'eta_query',
      params: { location: { lat: 37.77, lng: -122.41 } },
      queryId: 'q-deterministic',
      ttlSeconds: 90,
      serviceName: 'Bus 42',
      originChannel: 'chat',
      schemaHash: 'hash-v1',
    });
  });

  it('falls back to the capability default TTL when ttlSeconds is omitted', async () => {
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore({ seen: coreSeen }),
    });
    await orch.issueQuery({
      capability: 'eta_query',
      params: { location: { lat: 0, lng: 0 } },
    });
    // eta_query default is 60s (capability registry).
    expect(coreSeen[0].ttlSeconds).toBe(60);
  });

  it('forwards geo search params to AppView', async () => {
    const appViewSeen: SearchServicesParams[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE], appViewSeen),
      coreClient: stubCore(),
    });
    await orch.issueQuery({
      capability: 'eta_query',
      params: { location: { lat: 37.77, lng: -122.41 } },
      viewer: { lat: 37.77, lng: -122.41 },
      radiusKm: 3,
      q: 'bus',
    });
    expect(appViewSeen[0]).toEqual({
      capability: 'eta_query',
      lat: 37.77,
      lng: -122.41,
      radiusKm: 3,
      q: 'bus',
    });
  });

  it('propagates `deduped` from Core', async () => {
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore({
        result: { taskId: 'sq-42', queryId: 'q-x', deduped: true },
      }),
    });
    const result = await orch.issueQuery({
      capability: 'eta_query',
      params: { location: { lat: 0, lng: 0 } },
    });
    expect(result.deduped).toBe(true);
    expect(result.taskId).toBe('sq-42');
  });

  it('omits schema_hash when the chosen profile has none', async () => {
    const plain: ServiceProfile = {
      ...BUS_SERVICE,
      capabilitySchemas: undefined,
    };
    const coreSeen: CoreSend[] = [];
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([plain]),
      coreClient: stubCore({ seen: coreSeen }),
    });
    await orch.issueQuery({
      capability: 'eta_query',
      params: { location: { lat: 0, lng: 0 } },
    });
    expect(coreSeen[0].schemaHash).toBeUndefined();
  });

  it('throws no_candidate when AppView returns nothing', async () => {
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([]),
      coreClient: stubCore(),
    });
    try {
      await orch.issueQuery({
        capability: 'eta_query',
        params: { location: { lat: 0, lng: 0 } },
      });
      fail('expected no_candidate');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceOrchestratorError);
      expect((err as ServiceOrchestratorError).code).toBe('no_candidate');
    }
  });

  it('wraps sendServiceQuery errors as send_failed', async () => {
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore({ sendError: new Error('network down') }),
    });
    try {
      await orch.issueQuery({
        capability: 'eta_query',
        params: { location: { lat: 0, lng: 0 } },
      });
      fail('expected send_failed');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceOrchestratorError);
      expect((err as ServiceOrchestratorError).code).toBe('send_failed');
      expect((err as Error).message).toMatch(/network down/);
    }
  });

  it('returns synchronously — never awaits a response', async () => {
    // Sanity check: if the orchestrator were polling/awaiting, wiring an
    // unresolved response would hang indefinitely. We don't simulate a
    // response at all and expect the call to resolve.
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore(),
    });
    const result = await Promise.race([
      orch.issueQuery({
        capability: 'eta_query',
        params: { location: { lat: 0, lng: 0 } },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hang')), 50)),
    ]);
    expect((result as { taskId: string }).taskId).toBe('sq-1');
  });

  it('preserves our queryId when Core echoes a blank one', async () => {
    const orch = new ServiceQueryOrchestrator({
      appViewClient: stubAppView([BUS_SERVICE]),
      coreClient: stubCore({
        result: { taskId: 'sq-1', queryId: '', deduped: false },
      }),
      generateQueryId: () => 'q-local',
    });
    const result = await orch.issueQuery({
      capability: 'eta_query',
      params: { location: { lat: 0, lng: 0 } },
    });
    expect(result.queryId).toBe('q-local');
  });
});
