import Fastify, { type FastifyInstance } from 'fastify';

import { AppViewError, type AppViewClient, type ServiceProfile } from '@dina/brain';

import { registerServiceSearchRoutes } from '../src/routes/service_search';

const SERVICE: ServiceProfile = {
  did: 'did:plc:salon',
  uri: 'at://did:plc:salon/com.dinakernel.service.profile/main',
  handle: 'salon.test',
  name: 'Alonso Salon',
  description: 'Appointments',
  capabilities: ['appointment_book'],
  responsePolicy: { appointment_book: 'review' },
  isDiscoverable: true,
};

function makeApp(appView: Pick<AppViewClient, 'searchCapabilities' | 'searchServices'>): FastifyInstance {
  const app = Fastify({ logger: false });
  registerServiceSearchRoutes(app, { appView });
  return app;
}

describe('internal service discovery', () => {
  it('searches a canonical capability without intent expansion', async () => {
    const appView = {
      searchCapabilities: jest.fn(),
      searchServices: jest.fn().mockResolvedValue([SERVICE]),
    };
    const app = makeApp(appView);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/service/search',
        payload: { capability: 'appointment_book', q: 'salon', limit: 3 },
      });
      expect(response.statusCode).toBe(200);
      expect(appView.searchCapabilities).not.toHaveBeenCalled();
      expect(appView.searchServices).toHaveBeenCalledWith({
        capability: 'appointment_book',
        q: 'salon',
        limit: 3,
      });
      expect(response.json()).toMatchObject({
        matches: [{ capability: 'appointment_book', service: { did: SERVICE.did } }],
      });
    } finally {
      await app.close();
    }
  });

  it('expands natural-language intent, bounds candidates, and de-duplicates matches', async () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      canonical: `cap_${i}`,
      description: `Capability ${i}`,
      domain: 'test',
    }));
    const appView = {
      searchCapabilities: jest.fn().mockResolvedValue(candidates),
      searchServices: jest.fn().mockResolvedValue([SERVICE, SERVICE]),
    };
    const app = makeApp(appView);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/service/search',
        payload: { intent: 'book a haircut', lat: 12.9, lng: 77.6, radius_km: 5, limit: 4 },
      });
      expect(response.statusCode).toBe(200);
      expect(appView.searchCapabilities).toHaveBeenCalledWith({
        intent: 'book a haircut',
        lat: 12.9,
        lng: 77.6,
      });
      expect(appView.searchServices).toHaveBeenCalledTimes(4);
      const body = response.json() as { matches: unknown[]; capability_candidates: unknown[] };
      expect(body.matches).toHaveLength(4);
      expect(body.capability_candidates).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it.each([
    [{}, 'provide exactly one'],
    [{ intent: 'x', capability: 'y' }, 'provide exactly one'],
    [{ capability: 'x', lat: 1 }, 'lat and lng'],
    [{ capability: 'x', lat: 91, lng: 0 }, 'lat must be'],
    [{ capability: 'x', radius_km: 501 }, 'radius_km'],
    [{ capability: 'x', limit: 21 }, 'limit must be'],
  ])('rejects malformed bounded input %#', async (payload, error) => {
    const app = makeApp({
      searchCapabilities: jest.fn(),
      searchServices: jest.fn(),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/service/search',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.stringContaining(error) });
    } finally {
      await app.close();
    }
  });

  it('collapses AppView failures to a non-sensitive availability error', async () => {
    const app = makeApp({
      searchCapabilities: jest.fn(),
      searchServices: jest
        .fn()
        .mockRejectedValue(new AppViewError('upstream secret', 500, '/private/path')),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/service/search',
        payload: { capability: 'appointment_book' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'service directory unavailable' });
    } finally {
      await app.close();
    }
  });
});
