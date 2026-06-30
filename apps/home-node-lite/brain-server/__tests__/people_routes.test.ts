/**
 * `/api/v1/people[...]` Fastify routes — thin READ-ONLY proxy over the
 * CoreClient people methods the SPA's Relations tab uses. Driven with a
 * (stateful) MockCoreClient so a handler/path/shape regression fails here
 * without standing up core-server. core-server owns the graph.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { MockCoreClient } from '@dina/test-harness';

import { registerPeopleApiRoutes } from '../src/routes/people';

import type { Person } from '@dina/core';


function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerPeopleApiRoutes(app, { core });
  return app;
}

function person(personId: string, name: string, did = ''): Person {
  return {
    personId,
    canonicalName: name,
    contactDid: did,
    relationshipHint: '',
    status: 'confirmed',
    createdFrom: 'manual',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('Brain server — /api/v1/people HTTP wiring', () => {
  it('GET /people → { people } from CoreClient.peopleList', async () => {
    const core = new MockCoreClient();
    core.peopleListResult = [person('p1', 'Alonso'), person('p2', 'Sancho')];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/people' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { people: Person[] }).people.map((p) => p.canonicalName)).toEqual([
        'Alonso',
        'Sancho',
      ]);
    } finally {
      await app.close();
    }
  });

  it('GET /people/find?surface → forwards surface → { people }; missing surface → 400', async () => {
    const core = new MockCoreClient();
    core.peopleListResult = [
      {
        ...person('p1', 'Dr Carl'),
        surfaces: [{ surface: 'carl', normalizedSurface: 'carl', status: 'confirmed' }],
      } as Person,
    ];
    const app = makeApp(core);
    try {
      const ok = await app.inject({ method: 'GET', url: '/api/v1/people/find?surface=carl' });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { people: Person[] }).people).toHaveLength(1);
      expect(core.calls.find((c) => c.method === 'peopleFindByName')?.args[0]).toBe('carl');

      const bad = await app.inject({ method: 'GET', url: '/api/v1/people/find' });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GET /people/by-did?did → { person }; missing did → 400 (static path, not :id)', async () => {
    const core = new MockCoreClient();
    core.peopleListResult = [person('p1', 'Sancho', 'did:plc:s')];
    const app = makeApp(core);
    try {
      const ok = await app.inject({ method: 'GET', url: '/api/v1/people/by-did?did=did%3Aplc%3As' });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { person: Person | null }).person?.personId).toBe('p1');
      expect(core.calls.find((c) => c.method === 'peopleResolveByDid')?.args[0]).toBe('did:plc:s');

      const bad = await app.inject({ method: 'GET', url: '/api/v1/people/by-did' });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('maps a CoreClient failure to 502', async () => {
    const core = new MockCoreClient();
    core.throwOn.peopleList = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/people' });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });
});
