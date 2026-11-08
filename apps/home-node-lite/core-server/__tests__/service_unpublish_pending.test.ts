/**
 * docs/STATE_MACHINES.md SERVICE-1: a listing deleted while the PDS is down is
 * removed from the PDS after a restart, though no row names it any more.
 */

import {
  InMemoryServiceConfigRepository,
  resetServiceConfigState,
  setServiceConfigDurable,
  setServiceConfigRepository,
  clearServiceConfigDurable,
  type ServiceConfig,
} from '@dina/core';
import pino from 'pino';

import { wireServiceProfilePublisher } from '../src/appview/wire_publisher';

const CONFIG: ServiceConfig = {
  isDiscoverable: true,
  discoverability: 'public',
  status: 'active',
  name: 'Salon',
  capabilities: {
    appointment_book: {
      mcpServer: 'salon',
      mcpTool: 'appointment_book',
      responsePolicy: 'review',
      category: 'appointments',
    },
  },
};
const IDENTITY = {
  did: 'did:plc:salon',
  handle: 'salon.test',
  password: 'password',
  email: 'e@x.com',
  pdsUrl: 'https://pds.test',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

function fakePds() {
  const records = new Map<string, unknown>();
  const state = { online: true };
  const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (!state.online) throw new Error('offline');
    if (url.includes('createSession')) {
      return json(200, { did: IDENTITY.did, accessJwt: 'a', refreshJwt: 'r', handle: IDENTITY.handle });
    }
    if (url.includes('getRecord')) {
      const rkey = new URL(url).searchParams.get('rkey') ?? '';
      return records.has(rkey)
        ? json(200, { uri: `at://x/${rkey}`, cid: 'c', value: records.get(rkey) })
        : json(400, { error: 'RecordNotFound' });
    }
    if (url.includes('putRecord')) {
      const b = JSON.parse(init?.body ?? '{}') as { rkey: string; record: unknown };
      records.set(b.rkey, b.record);
      return json(200, { uri: `at://x/${b.rkey}`, cid: 'c' });
    }
    if (url.includes('deleteRecord')) {
      const b = JSON.parse(init?.body ?? '{}') as { rkey: string };
      records.delete(b.rkey);
      return json(200, {});
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { records, state, fetchImpl };
}

const logger = pino({ level: 'silent' }) as never;
const wire = (fetchImpl: typeof fetch) =>
  wireServiceProfilePublisher({ pdsIdentity: IDENTITY as never, logger, fetch: fetchImpl });

describe('a listing deleted during a PDS outage', () => {
  let repo: InMemoryServiceConfigRepository;

  beforeEach(() => {
    resetServiceConfigState();
    repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
  });

  afterEach(() => {
    setServiceConfigRepository(null);
    resetServiceConfigState();
  });

  it('leaves the PDS after a restart, and nothing is owed after that', async () => {
    await setServiceConfigDurable(CONFIG, 'salon');
    const pds = fakePds();
    const first = wire(pds.fetchImpl);
    await settle();
    expect(pds.records.has('salon')).toBe(true);
    pds.state.online = false;
    await clearServiceConfigDurable('salon');
    await settle();
    first.dispose();
    expect(await repo.listPendingUnpublish()).toEqual(['salon']);

    pds.state.online = true;
    const second = wire(pds.fetchImpl);
    await settle();
    second.dispose();
    expect(pds.records.has('salon')).toBe(false);
    expect(await repo.listPendingUnpublish()).toEqual([]);
  }, 30000);

  it('a normal delete owes nothing once it lands', async () => {
    await setServiceConfigDurable(CONFIG, 'salon');
    const pds = fakePds();
    const live = wire(pds.fetchImpl);
    await settle();
    await clearServiceConfigDurable('salon');
    await settle();
    live.dispose();
    expect(pds.records.has('salon')).toBe(false);
    expect(await repo.listPendingUnpublish()).toEqual([]);
  }, 30000);

  it('the same rkey saved again is published, not removed, after a restart', async () => {
    await setServiceConfigDurable(CONFIG, 'salon');
    const pds = fakePds();
    const first = wire(pds.fetchImpl);
    await settle();
    pds.state.online = false;
    await clearServiceConfigDurable('salon');
    await settle();
    first.dispose();
    await setServiceConfigDurable(CONFIG, 'salon');
    expect(await repo.listPendingUnpublish()).toEqual([]);
    pds.state.online = true;
    const second = wire(pds.fetchImpl);
    await settle();
    second.dispose();
    expect(pds.records.has('salon')).toBe(true);
  }, 30000);
});
