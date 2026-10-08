/**
 * REAL_LIFE_FIXES §14.4 E — the requester reads AppView's liveness: notes for
 * the model, and fallbacks that prefer live providers.
 */

import { availabilityNote, createQueryServiceTool } from '../../src/reasoning/service_tools';

import type { ServiceProfile } from '../../src/appview_client/http';

const NOW = Date.parse('2026-10-08T12:00:00Z');

describe('availability notes', () => {
  it('says nothing for a fresh provider or an older AppView', () => {
    expect(availabilityNote({ liveness: 'fresh', lastSeenAt: '2026-10-08T11:00:00Z' }, NOW)).toBeUndefined();
    expect(availabilityNote({}, NOW)).toBeUndefined();
  });

  it('names how long a stale or expired provider has been silent, from the real observation', () => {
    expect(availabilityNote({ liveness: 'stale', lastSeenAt: '2026-10-03T12:00:00Z' }, NOW)).toBe(
      'This provider has not been seen for 5 days; it may not answer.',
    );
    expect(availabilityNote({ liveness: 'expired', lastSeenAt: null }, NOW)).toBe(
      'This provider has not been seen lately; it will probably not answer.',
    );
    expect(availabilityNote({ liveness: 'unknown' }, NOW)).toMatch(/older version/);
  });
});

describe('fallbacks prefer live providers', () => {
  const p = (did: string, liveness: ServiceProfile['liveness']): ServiceProfile => ({
    did,
    name: did,
    capabilities: ['eta_query'],
    isDiscoverable: true,
    liveness,
    uri: `at://${did}/com.dinakernel.service.profile/self`,
  });

  it('skips stale and silent fallbacks when a live one exists', async () => {
    const issued: { fallbacks?: { toDID: string }[] }[] = [];
    const tool = createQueryServiceTool({
      orchestrator: {
        issueQueryToDID: async (req: { fallbacks?: { toDID: string }[] }) => {
          issued.push(req);
          return { taskId: 't', queryId: 'q', toDID: 'did:plc:chosen', serviceName: 'x', deduped: false };
        },
      } as never,
      appViewClient: {
        searchServices: async () => [p('did:plc:chosen', 'fresh'), p('did:plc:old', 'stale'), p('did:plc:live2', 'fresh'), p('did:plc:legacy', 'unknown')],
      },
    });
    await tool.execute({ operator_did: 'did:plc:chosen', capability: 'eta_query', params: {}, service_uri: 'at://did:plc:chosen/com.dinakernel.service.profile/self' });
    expect(issued[0]?.fallbacks?.map((f) => f.toDID)).toEqual(['did:plc:live2']);
  });

  it('with no live fallback, the others are still a last resort', async () => {
    const issued: { fallbacks?: { toDID: string }[] }[] = [];
    const tool = createQueryServiceTool({
      orchestrator: {
        issueQueryToDID: async (req: { fallbacks?: { toDID: string }[] }) => {
          issued.push(req);
          return { taskId: 't', queryId: 'q', toDID: 'did:plc:chosen', serviceName: 'x', deduped: false };
        },
      } as never,
      appViewClient: { searchServices: async () => [p('did:plc:chosen', 'fresh'), p('did:plc:old', 'stale')] },
    });
    await tool.execute({ operator_did: 'did:plc:chosen', capability: 'eta_query', params: {}, service_uri: 'at://did:plc:chosen/com.dinakernel.service.profile/self' });
    expect(issued[0]?.fallbacks?.map((f) => f.toDID)).toEqual(['did:plc:old']);
  });
});
