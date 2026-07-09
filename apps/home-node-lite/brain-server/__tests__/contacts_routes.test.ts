/**
 * `/api/v1/contacts` Fastify route — the SPA's contact-directory data layer,
 * a thin proxy over CoreClient.listContacts (mobile reads the in-process
 * directory instead). Drives the route with a MockCoreClient so a
 * handler/path/shape regression fails here without standing up core-server.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { type Contact } from '@dina/core';
import { MockCoreClient } from '@dina/test-harness';

import { registerContactApiRoutes } from '../src/routes/contacts';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerContactApiRoutes(app, { core });
  return app;
}

function contact(over: Partial<Contact> = {}): Contact {
  const now = 1_700_000_000_000;
  return {
    personId: 'person-1',
    did: 'did:plc:abc',
    displayName: 'Sancho',
    trustLevel: 'verified',
    sharingTier: 'summary',
    relationship: 'unknown',
    dataResponsibility: 'external',
    aliases: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
    preferredFor: [],
    ...over,
  } as Contact;
}

describe('Brain server — /api/v1/contacts HTTP wiring', () => {
  it('GET /contacts returns { contacts } from the CoreClient', async () => {
    const core = new MockCoreClient();
    core.listContactsResult = [contact({ did: 'did:plc:abc', displayName: 'Sancho' })];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { contacts: Contact[] };
      expect(body.contacts).toHaveLength(1);
      expect(body.contacts[0]?.displayName).toBe('Sancho');
    } finally {
      await app.close();
    }
  });

  it('GET /contacts returns { contacts: [] } for an empty directory', async () => {
    const core = new MockCoreClient();
    core.listContactsResult = [];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { contacts: Contact[] }).contacts).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('surfaces a Core failure as 502 (never masks it as an empty list)', async () => {
    const core = new MockCoreClient();
    core.throwOn.listContacts = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });

  it('DELETE /contacts/:did forwards to CoreClient.removeContact and returns { deleted }', async () => {
    const core = new MockCoreClient();
    core.listContactsResult = [contact({ did: 'did:plc:abc' })];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/contacts/did:plc:abc' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { deleted: boolean }).deleted).toBe(true);
      const call = core.calls.find((c) => c.method === 'removeContact');
      expect(call?.args).toEqual(['did:plc:abc']);
      expect(core.listContactsResult).toHaveLength(0); // mock removed it
    } finally {
      await app.close();
    }
  });

  it('DELETE is idempotent — { deleted: false } when the DID was not a contact', async () => {
    const core = new MockCoreClient();
    core.listContactsResult = [];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/contacts/did:plc:ghost' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { deleted: boolean }).deleted).toBe(false);
    } finally {
      await app.close();
    }
  });
});
