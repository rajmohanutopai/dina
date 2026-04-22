/**
 * service_wiring.test.ts — chat-command wiring.
 *
 * Validates that `wireServiceOrchestrator`:
 *   - installs a chat `/service` handler that dispatches via `issueQuery`
 *   - formats the ack per the user-facing convention
 *   - maps pre-send failures to friendly strings
 *   - disposes cleanly
 */

import {
  ServiceOrchestratorError,
  ServiceQueryOrchestrator,
  type IssueQueryRequest,
  type IssueQueryResult,
} from '../../src/service/service_query_orchestrator';
import { errorToAck, wireServiceOrchestrator } from '../../src/service/service_wiring';
import { handleChat } from '../../src/chat/orchestrator';

function stubOrchestrator(impl: (req: IssueQueryRequest) => Promise<IssueQueryResult>): {
  orchestrator: ServiceQueryOrchestrator;
  calls: IssueQueryRequest[];
} {
  const calls: IssueQueryRequest[] = [];
  const orchestrator = {
    async issueQuery(req: IssueQueryRequest) {
      calls.push(req);
      return impl(req);
    },
  } as unknown as ServiceQueryOrchestrator;
  return { orchestrator, calls };
}

const OK_RESULT: IssueQueryResult = {
  queryId: 'q-1',
  taskId: 'svc-q-1',
  toDID: 'did:plc:provider',
  serviceName: 'Bus 42',
  deduped: false,
};

describe('wireServiceOrchestrator — construction', () => {
  it('rejects missing orchestrator', () => {
    expect(() =>
      wireServiceOrchestrator({
        orchestrator: undefined as unknown as ServiceQueryOrchestrator,
      }),
    ).toThrow(/orchestrator/);
  });
});

describe('wireServiceOrchestrator — chat handler', () => {
  it('installs a handler that issues queries via the orchestrator', async () => {
    const { orchestrator, calls } = stubOrchestrator(async () => OK_RESULT);
    const dispose = wireServiceOrchestrator({ orchestrator });
    try {
      const ack = (await handleChat('/service eta_query next bus')).response;
      expect(ack).toContain('Bus 42');
      expect(calls).toHaveLength(1);
      expect(calls[0].capability).toBe('eta_query');
      expect(calls[0].params).toEqual({ text: 'next bus' });
      expect(calls[0].originChannel).toBe('chat');
    } finally {
      dispose();
    }
  });

  it('default ack differentiates deduped queries', async () => {
    const { orchestrator } = stubOrchestrator(async () => ({
      ...OK_RESULT,
      deduped: true,
    }));
    const dispose = wireServiceOrchestrator({ orchestrator });
    try {
      const ack = (await handleChat('/service eta_query again')).response;
      expect(ack).toContain('Still asking Bus 42');
    } finally {
      dispose();
    }
  });

  it('applies custom buildRequest adapter', async () => {
    const { orchestrator, calls } = stubOrchestrator(async () => OK_RESULT);
    const dispose = wireServiceOrchestrator({
      orchestrator,
      buildRequest: (capability, payload) => ({
        capability,
        params: { question: payload, viewerLoc: 'test' },
        viewer: { lat: 37.77, lng: -122.41 },
        radiusKm: 2,
      }),
    });
    try {
      await handleChat('/service eta_query when?');
      expect(calls[0].params).toEqual({ question: 'when?', viewerLoc: 'test' });
      expect(calls[0].viewer).toEqual({ lat: 37.77, lng: -122.41 });
      expect(calls[0].radiusKm).toBe(2);
    } finally {
      dispose();
    }
  });

  it('applies custom formatAck', async () => {
    const { orchestrator } = stubOrchestrator(async () => OK_RESULT);
    const dispose = wireServiceOrchestrator({
      orchestrator,
      formatAck: ({ serviceName, queryId }) => `Dispatched to ${serviceName} (query ${queryId}).`,
    });
    try {
      const ack = (await handleChat('/service eta_query go')).response;
      expect(ack).toBe('Dispatched to Bus 42 (query q-1).');
    } finally {
      dispose();
    }
  });

  it('maps no_candidate error to a friendly ack', async () => {
    const { orchestrator } = stubOrchestrator(async () => {
      throw new ServiceOrchestratorError('no cand', 'no_candidate');
    });
    const dispose = wireServiceOrchestrator({ orchestrator });
    try {
      const ack = (await handleChat('/service eta_query ?')).response;
      expect(ack).toBe('No public service advertises "eta_query" right now.');
    } finally {
      dispose();
    }
  });

  it('maps send_failed error to a friendly ack', async () => {
    const { orchestrator } = stubOrchestrator(async () => {
      throw new ServiceOrchestratorError('HTTP 502', 'send_failed');
    });
    const dispose = wireServiceOrchestrator({ orchestrator });
    try {
      const ack = (await handleChat('/service eta_query ?')).response;
      expect(ack).toBe("Couldn't reach the service: HTTP 502.");
    } finally {
      dispose();
    }
  });

  it('maps unknown errors through the default catch-all', async () => {
    const { orchestrator } = stubOrchestrator(async () => {
      throw new Error('mystery');
    });
    const dispose = wireServiceOrchestrator({ orchestrator });
    try {
      const ack = (await handleChat('/service eta_query ?')).response;
      expect(ack).toContain("Couldn't start service query");
      expect(ack).toContain('mystery');
    } finally {
      dispose();
    }
  });

  it('disposer unregisters the handler so subsequent /service commands fall back', async () => {
    const { orchestrator } = stubOrchestrator(async () => OK_RESULT);
    const dispose = wireServiceOrchestrator({ orchestrator });
    dispose();
    const ack = (await handleChat('/service eta_query ?')).response;
    expect(ack).toContain("isn't wired up");
  });
});

describe('errorToAck — direct', () => {
  it('handles capability_required / params_required', () => {
    const e1 = new ServiceOrchestratorError('capability is required', 'capability_required');
    const e2 = new ServiceOrchestratorError('params is required', 'params_required');
    expect(errorToAck('x', e1)).toBe("Can't run service query: capability is required.");
    expect(errorToAck('x', e2)).toBe("Can't run service query: params is required.");
  });

  it('stringifies non-Error objects', () => {
    expect(errorToAck('x', 'bare string')).toBe("Couldn't start service query: bare string");
    expect(errorToAck('x', 42)).toBe("Couldn't start service query: 42");
  });
});
