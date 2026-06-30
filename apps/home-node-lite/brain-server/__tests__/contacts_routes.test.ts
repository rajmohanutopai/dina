/**
 * `/api/v1/contacts[...]` Fastify routes — thin proxy over the CoreClient the
 * SPA's People tab + add-contact flow use. Driven with a (stateful)
 * MockCoreClient so a handler/path/shape regression fails here without standing
 * up core-server. core-server owns the directory; the proxy does no contact
 * logic of its own.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { MockCoreClient } from '@dina/test-harness';

import { registerContactsApiRoutes } from '../src/routes/contacts';

import type { Contact } from '@dina/core';


function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerContactsApiRoutes(app, { core });
  return app;
}

function contact(did: string, displayName: string): Contact {
  return {
    personId: `person:${did}`,
    did,
    displayName,
    trustLevel: 'verified',
    sharingTier: 'summary',
    relationship: 'unknown',
    dataResponsibility: 'external',
    aliases: [],
    notes: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('Brain server — /api/v1/contacts HTTP wiring', () => {
  it('GET /contacts → { contacts } from CoreClient.contactList', async () => {
    const core = new MockCoreClient();
    core.contactListResult = [contact('did:plc:a', 'Alonso'), contact('did:plc:s', 'Sancho')];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { contacts: Contact[] };
      expect(body.contacts.map((c) => c.displayName)).toEqual(['Alonso', 'Sancho']);
    } finally {
      await app.close();
    }
  });

  it('POST /contacts → forwards did/display_name/trust_level → { contact, created }', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/contacts',
        payload: { did: 'did:plc:s', display_name: 'Sancho', trust_level: 'trusted' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { contact: Contact; created: boolean };
      expect(body.created).toBe(true);
      expect(body.contact.did).toBe('did:plc:s');
      const call = core.calls.find((c) => c.method === 'contactAdd');
      expect(call?.args).toEqual(['did:plc:s', 'Sancho', 'trusted']);
    } finally {
      await app.close();
    }
  });

  it('POST /contacts → 400 when did is missing (never reaches Core)', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/contacts',
        payload: { display_name: 'No DID' },
      });
      expect(res.statusCode).toBe(400);
      expect(core.calls.some((c) => c.method === 'contactAdd')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('DELETE /contacts/:did → { deleted } from CoreClient.contactDelete', async () => {
    const core = new MockCoreClient();
    core.contactDeleteResult = true;
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/contacts/did%3Aplc%3As' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { deleted: boolean }).deleted).toBe(true);
      const call = core.calls.find((c) => c.method === 'contactDelete');
      expect(call?.args[0]).toBe('did:plc:s'); // Fastify decodes the path param
    } finally {
      await app.close();
    }
  });

  it('PUT /contacts/:did → forwards preferred_for tri-state → { ok }', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/contacts/did%3Aplc%3Ad',
        payload: { preferred_for: ['dentist'] },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);
      const call = core.calls.find((c) => c.method === 'updateContact');
      expect(call?.args[0]).toBe('did:plc:d');
      expect(call?.args[1]).toEqual({ preferredFor: ['dentist'] });
    } finally {
      await app.close();
    }
  });

  it('PUT /contacts/:did → 400 when preferred_for is not a string array', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/contacts/did%3Aplc%3Ad',
        payload: { preferred_for: [1, 2] },
      });
      expect(res.statusCode).toBe(400);
      expect(core.calls.some((c) => c.method === 'updateContact')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('GET /contacts/lookup?q → { contact } (static path wins over :did)', async () => {
    const core = new MockCoreClient();
    core.contactLookupResult = { sancho: contact('did:plc:s', 'Sancho') };
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/lookup?q=Sancho' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { contact: Contact }).contact.did).toBe('did:plc:s');
      // Confirms the lookup route matched, NOT the `:did` delete/update param route.
      expect(core.calls.find((c) => c.method === 'contactLookup')?.args[0]).toBe('Sancho');
    } finally {
      await app.close();
    }
  });

  it('GET /contacts/by-preference → { contacts }; missing category → 400', async () => {
    const core = new MockCoreClient();
    core.contactsByPreferenceResult = { dentist: [contact('did:plc:d', 'Dr Carl')] };
    const app = makeApp(core);
    try {
      const ok = await app.inject({
        method: 'GET',
        url: '/api/v1/contacts/by-preference?category=dentist',
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { contacts: Contact[] }).contacts).toHaveLength(1);

      const bad = await app.inject({ method: 'GET', url: '/api/v1/contacts/by-preference' });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // 502 is exercised on a MUTATION path (contactAdd), which genuinely THROWS in
  // production. The contact *reads* (list/lookup/by-preference) + contactDelete
  // fail-soft in the real HttpCoreTransport (return []/null/false, never throw),
  // so a core outage surfaces to the People tab as an empty list — NOT a 502.
  // Asserting a 502 on GET would be false confidence (only the mock throws there);
  // the read fail-soft itself is covered in http_transport.test.ts.
  it('maps a CoreClient mutation failure to 502 (contactAdd throws in production)', async () => {
    const core = new MockCoreClient();
    core.throwOn.contactAdd = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/contacts',
        payload: { did: 'did:plc:s', display_name: 'Sancho' },
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });
});
