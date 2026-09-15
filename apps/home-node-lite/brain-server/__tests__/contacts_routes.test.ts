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

  /**
   * §5.D — the web half of the trade-details capture path. Without these two
   * routes the web screen read an empty form over a contact Core holds and
   * saved into a 404, silently.
   */
  it('GET /contacts/lookup resolves one contact from Core', async () => {
    const core = new MockCoreClient();
    core.contactLookupResult = { 'did:plc:abc': contact({ did: 'did:plc:abc', legalName: 'ChairMaker LLP' }) };
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/lookup?q=did:plc:abc' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { contact: Contact }).contact.legalName).toBe('ChairMaker LLP');
    } finally {
      await app.close();
    }
  });

  it('GET /contacts/lookup refuses an empty q', async () => {
    const app = makeApp(new MockCoreClient());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/lookup?q=%20' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PUT /contacts/:did forwards the tri-state wire to CoreClient.updateContact', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/contacts/did:plc:abc',
        payload: {
          legal_name: 'ChairMaker LLP',
          registrations: [{ scheme: 'gstin', value: '27AAPFU0939F1ZV' }],
          billing_address: { line1: '4 Kalasipalya Road', city: 'Bengaluru', postal_code: '560002', country: 'IN' },
        },
      });
      expect(res.statusCode).toBe(200);
      const call = core.calls.find((c) => c.method === 'updateContact');
      expect(call?.args[0]).toBe('did:plc:abc');
      expect(call?.args[1]).toEqual({
        legalName: 'ChairMaker LLP',
        registrations: [{ scheme: 'gstin', value: '27AAPFU0939F1ZV' }],
        billingAddress: { line1: '4 Kalasipalya Road', city: 'Bengaluru', postalCode: '560002', country: 'IN' },
      });
      // Absent fields stay absent: a tri-state wire must not become a clear.
      expect(call?.args[1]).not.toHaveProperty('phone');
      expect(call?.args[1]).not.toHaveProperty('preferredFor');
    } finally {
      await app.close();
    }
  });

  it('PUT /contacts/:did passes Core’s refusal FINDINGS through, not a bare 502', async () => {
    const core = new MockCoreClient();
    core.throwOn.updateContact = Object.assign(new Error('refused'), {
      status: 400,
      body: {
        error: 'identity_invalid',
        findings: [{ refusal: 'malformed_registration', field: 'registrations[0]', detail: 'bad' }],
      },
    });
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/contacts/did:plc:abc',
        payload: { registrations: [{ scheme: 'gstin', value: 'nope' }] },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; findings: { field: string }[] };
      expect(body.error).toBe('identity_invalid');
      expect(body.findings[0].field).toBe('registrations[0]');
    } finally {
      await app.close();
    }
  });

  it('PUT /contacts/:did answers 502 when Core is unreachable (no findings to show)', async () => {
    const core = new MockCoreClient();
    core.throwOn.updateContact = new Error('socket hang up');
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/contacts/did:plc:abc',
        payload: { legal_name: 'x' },
      });
      expect(res.statusCode).toBe(502);
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
