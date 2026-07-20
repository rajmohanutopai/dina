/**
 * PSVC-0 — `buildWatchPollHandler`: a due watch maps to a `service.query` and is
 * sent through the CoreClient requester lane (NOT raw D2D).
 */

import {
  buildWatchPollHandler,
  watchPollToServiceQuery,
} from '../../src/watch/poll_query';

import type { ServiceQueryClientRequest, ServiceQueryResult } from '../../src/client/core-client';
import type { WatchPollPayload } from '../../src/watch/payload';
import type { WorkflowTask } from '../../src/workflow/domain';

const payload: WatchPollPayload = {
  type: 'watch_poll',
  subscription_id: 'sub-1',
  persona: 'general',
  service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
  provider_did: 'did:plc:prov',
  capability: 'flight_status',
  query: { flight: 'BA117' },
  poll_interval_sec: 300,
};

const fakeTask = { id: 'watch-1' } as WorkflowTask;

describe('watchPollToServiceQuery', () => {
  it('maps a watch payload to a requester service.query', () => {
    const req = watchPollToServiceQuery(payload, 'q-1');
    expect(req).toEqual({
      toDID: 'did:plc:prov',
      capability: 'flight_status',
      queryId: 'q-1',
      params: { flight: 'BA117' },
      ttlSeconds: 300, // TTL = cadence, so a stale poll expires before the next
      serviceUri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      originChannel: 'watch:sub-1',
    });
  });

  it('clamps a cadence longer than MAX_SERVICE_TTL to the wire TTL cap (81B-05)', () => {
    // An hourly watch keeps its local cadence but must send a wire ttl ≤ 300, else
    // the service-query route (MAX_SERVICE_TTL=300) rejects every poll.
    const req = watchPollToServiceQuery({ ...payload, poll_interval_sec: 3600 }, 'q-2');
    expect(req.ttlSeconds).toBe(300);
  });
});

describe('buildWatchPollHandler', () => {
  it('sends the query via coreClient.sendServiceQuery with a minted queryId', async () => {
    const calls: ServiceQueryClientRequest[] = [];
    const coreClient = {
      sendServiceQuery: async (req: ServiceQueryClientRequest): Promise<ServiceQueryResult> => {
        calls.push(req);
        return { status: 'sent' } as unknown as ServiceQueryResult;
      },
    };
    let n = 0;
    const onPoll = buildWatchPollHandler(coreClient, { queryIdFn: () => `q-${++n}` });

    await onPoll(fakeTask, payload);
    await onPoll(fakeTask, payload);

    expect(calls).toHaveLength(2);
    expect(calls[0].queryId).toBe('q-1');
    expect(calls[1].queryId).toBe('q-2'); // a fresh correlation id per fire
    expect(calls[0].toDID).toBe('did:plc:prov');
    expect(calls[0].capability).toBe('flight_status');
  });

  it('propagates a send failure (the sweeper isolates + reschedules)', async () => {
    const coreClient = {
      sendServiceQuery: async (): Promise<ServiceQueryResult> => {
        throw new Error('unreachable');
      },
    };
    const onPoll = buildWatchPollHandler(coreClient);
    await expect(onPoll(fakeTask, payload)).rejects.toThrow('unreachable');
  });
});
