/**
 * The server's Tier 1 adapter runs a task for the listing its payload names
 * (design §7.3): Brain gets that listing's config, never the default one's.
 * A task naming no listing is the default one, as a D2D query that names
 * none means; a task naming a listing it cannot read fails before Brain is
 * asked anything.
 */

import { pino } from 'pino';

import { resetServiceConfigState, setServiceConfig, type WorkflowTask } from '@dina/core';
import { buildServiceQueryExecutionPayload, type ServiceConfig } from '@dina/protocol';

import { makeHttpTier1Runner } from '../src/workflow/http_tier1_runner';

const timetable = (instruction: string): ServiceConfig => ({
  isDiscoverable: true,
  discoverability: 'public',
  status: 'active',
  name: 'Bus 42',
  capabilities: { eta_query: { responsePolicy: 'auto', instruction, category: 'transit' } },
});

function taskNaming(serviceUri: string | undefined): WorkflowTask {
  const payload = buildServiceQueryExecutionPayload({
    from_did: 'a2a:client-1',
    query_id: 'q-1',
    capability: 'eta_query',
    params: { route_id: '42' },
    ...(serviceUri === undefined ? {} : { service_uri: serviceUri }),
  });
  return { id: 'a2a:in-exec-q-1-g0', payload: JSON.stringify(payload) } as unknown as WorkflowTask;
}

describe('the Tier 1 adapter runs for the listing the task names (§7.3)', () => {
  let sent: { config: ServiceConfig | null }[];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as { config: ServiceConfig | null });
    return new Response('{"result":{"eta_minutes":4}}', { status: 200 });
  }) as unknown as typeof fetch;
  const runner = () => makeHttpTier1Runner({ brainUrl: 'http://brain.test', logger: pino({ level: 'silent' }) as never, fetchImpl });

  beforeEach(() => {
    sent = [];
    resetServiceConfigState();
    setServiceConfig(timetable('Answer from the default timetable.'), 'self');
    setServiceConfig(timetable('Answer from the night timetable.'), 'night');
  });
  afterEach(() => resetServiceConfigState());

  const instructionSent = () => sent.map((s) => s.config?.capabilities.eta_query?.instruction);

  it('a task naming a listing gets that listing’s config', async () => {
    await runner()('eta_query', { route_id: '42' }, taskNaming('at://did:plc:node/com.dinakernel.service.profile/night'));
    expect(instructionSent()).toEqual(['Answer from the night timetable.']);
  });

  it('a task naming none gets the default listing’s', async () => {
    await runner()('eta_query', { route_id: '42' }, taskNaming(undefined));
    expect(instructionSent()).toEqual(['Answer from the default timetable.']);
  });

  it('a task naming a listing it cannot read fails, and Brain is asked nothing', async () => {
    for (const uri of ['night', 'at://did:plc:node/app.bsky.feed.post/night', 'at://did:plc:node/com.dinakernel.service.profile/..']) {
      await expect(runner()('eta_query', { route_id: '42' }, taskNaming(uri))).rejects.toThrow(/not a listing reference/);
    }
    expect(sent).toEqual([]);
  });
});
