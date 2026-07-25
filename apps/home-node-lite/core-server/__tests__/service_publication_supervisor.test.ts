import pino from 'pino';

import {
  InMemoryServiceConfigRepository,
  resetServiceConfigState,
  setServiceConfigDurable,
  setServiceConfigRepository,
  type ServiceConfig,
} from '@dina/core';

import { wireServiceProfilePublisher } from '../src/appview/wire_publisher';

const CONFIG: ServiceConfig = {
  isDiscoverable: true,
  discoverability: 'public',
  status: 'active',
  name: 'Alonso Salon',
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
  email: 'salon@example.com',
  pdsUrl: 'https://pds.test',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('durable service publication supervisor', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    resetServiceConfigState();
  });

  afterEach(() => {
    setServiceConfigRepository(null);
    resetServiceConfigState();
    jest.useRealTimers();
  });

  it('records a transient failure, retries, then persists the PDS receipt', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    await setServiceConfigDurable(CONFIG, 'salon');

    let online = false;
    const fetchImpl: typeof fetch = jest.fn(async (input) => {
      const url = String(input);
      if (!online) throw new Error('offline details');
      if (url.includes('createSession')) {
        return jsonResponse(200, {
          accessJwt: 'jwt',
          did: IDENTITY.did,
        });
      }
      return jsonResponse(200, {
        uri: 'at://did:plc:salon/com.dinakernel.service.profile/salon',
        cid: 'bafy-published',
      });
    }) as unknown as typeof fetch;

    const wired = wireServiceProfilePublisher({
      pdsIdentity: IDENTITY,
      logger: pino({ level: 'silent' }),
      fetch: fetchImpl,
    });
    try {
      await flush();
      expect(await repo.getPublicationStatus('salon')).toMatchObject({
        state: 'pending',
        error: expect.stringContaining('offline'),
        nextRetryAtMs: expect.any(Number),
      });

      online = true;
      await jest.advanceTimersByTimeAsync(2_000);
      await flush();

      expect(await repo.getPublicationStatus('salon')).toEqual({
        state: 'published',
        uri: 'at://did:plc:salon/com.dinakernel.service.profile/salon',
        cid: 'bafy-published',
        error: null,
        attemptedAtMs: expect.any(Number),
        nextRetryAtMs: null,
      });
    } finally {
      wired.dispose();
    }
  });

  it('marks a known-only listing as intentionally not published', async () => {
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    await setServiceConfigDurable(
      {
        ...CONFIG,
        isDiscoverable: false,
        discoverability: 'known_only',
      },
      'private',
    );
    const fetchImpl = jest.fn(async (input) => {
      const url = String(input);
      if (url.includes('createSession')) {
        return jsonResponse(200, { accessJwt: 'jwt', did: IDENTITY.did });
      }
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const wired = wireServiceProfilePublisher({
      pdsIdentity: IDENTITY,
      logger: pino({ level: 'silent' }),
      fetch: fetchImpl,
    });
    try {
      await flush();
      expect(await repo.getPublicationStatus('private')).toMatchObject({
        state: 'not_published',
        error: null,
      });
      expect((fetchImpl as jest.Mock).mock.calls.some(([url]) => String(url).includes('putRecord'))).toBe(false);
    } finally {
      wired.dispose();
    }
  });
});
