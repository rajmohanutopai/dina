/**
 * PC-CORE-10 + PC-CORE-11 — contacts HTTP routes.
 *
 * Exercises the pure handlers returned by `makeContactsHandlers` so
 * these tests cover validation, happy-path payload shapes, and error
 * surfaces without running the router's signed-auth pipeline. The
 * auth allowlist is covered by the existing `/v1/contacts` rule in
 * `authz.ts` (PC-CORE-09 — verified).
 */

import { makeContactsHandlers } from '../../../src/server/routes/contacts';

import type { Contact } from '../../../src/contacts/directory';
import type { CoreRequest } from '../../../src/server/router';

function req(partial: Partial<CoreRequest>): CoreRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    ...partial,
  };
}

function jsonBody(value: unknown): { body: unknown; rawBody: Uint8Array } {
  const s = JSON.stringify(value);
  return { body: value, rawBody: new TextEncoder().encode(s) };
}

function contactFixture(did: string, name: string, preferredFor: string[] = []): Contact {
  return {
    personId: `person-${did}`,
    did,
    displayName: name,
    trustLevel: 'unknown',
    sharingTier: 'summary',
    relationship: 'unknown',
    dataResponsibility: 'external',
    aliases: [],
    notes: '',
    createdAt: 0,
    updatedAt: 0,
    preferredFor,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/contacts — list all (F4: backs the web People/Talk screen, whose
// useContacts reads the directory; the thin-client's is empty so it fetches).
// ---------------------------------------------------------------------------

describe('GET /v1/contacts (list all)', () => {
  it('returns { contacts } from the injected directory (no count field)', async () => {
    const sancho = contactFixture('did:plc:sancho', 'Sancho');
    const { listAll } = makeContactsHandlers({ listContacts: () => [sancho] });
    const res = await listAll(req({ path: '/v1/contacts' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contacts: [sancho] });
    // Distinct from by-preference: the list root omits `count`.
    expect((res.body as Record<string, unknown>).count).toBeUndefined();
  });

  it('returns { contacts: [] } for an empty directory', async () => {
    const { listAll } = makeContactsHandlers({ listContacts: () => [] });
    const res = await listAll(req({ path: '/v1/contacts' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contacts: [] });
  });

  it('is owner-private: brain + admin only, denied for device/agent/connector', async () => {
    const { isAuthorized } = await import('../../../src/auth/authz');
    expect(isAuthorized('brain', 'GET', '/v1/contacts')).toBe(true);
    expect(isAuthorized('admin', 'GET', '/v1/contacts')).toBe(true);
    expect(isAuthorized('device', 'GET', '/v1/contacts')).toBe(false);
    expect(isAuthorized('agent', 'GET', '/v1/contacts')).toBe(false);
    expect(isAuthorized('connector', 'GET', '/v1/contacts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/contacts/by-preference
// ---------------------------------------------------------------------------

describe('GET /v1/contacts/by-preference (PC-CORE-10)', () => {
  it('returns matching contacts + count on success', async () => {
    const carol = contactFixture('did:plc:carol', 'Carol', ['dental']);
    const { findByPreference } = makeContactsHandlers({
      findByPreferredFor: (cat) => (cat === 'dental' ? [carol] : []),
    });
    const res = await findByPreference(
      req({
        method: 'GET',
        query: { category: 'dental' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contacts: [carol], count: 1 });
  });

  it('passes the category through to the resolver (pre-trim, post-route)', async () => {
    const calls: string[] = [];
    const { findByPreference } = makeContactsHandlers({
      findByPreferredFor: (c) => {
        calls.push(c);
        return [];
      },
    });
    await findByPreference(
      req({
        method: 'GET',
        query: { category: '  dental  ' },
      }),
    );
    // Handler trims whitespace before handing off — the resolver
    // itself also normalises, but trimming here short-circuits
    // the 400 on a whitespace-only query.
    expect(calls).toEqual(['dental']);
  });

  it('400 when category is missing', async () => {
    const { findByPreference } = makeContactsHandlers({
      findByPreferredFor: () => [],
    });
    const res = await findByPreference(req({ method: 'GET', query: {} }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'category query parameter is required' });
  });

  it('400 when category is an empty string', async () => {
    const { findByPreference } = makeContactsHandlers({
      findByPreferredFor: () => [],
    });
    const res = await findByPreference(
      req({
        method: 'GET',
        query: { category: '' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when category is whitespace-only', async () => {
    const { findByPreference } = makeContactsHandlers({
      findByPreferredFor: () => [],
    });
    const res = await findByPreference(
      req({
        method: 'GET',
        query: { category: '   \t' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('unknown category returns 200 with empty list (not an error)', async () => {
    const { findByPreference } = makeContactsHandlers({
      findByPreferredFor: () => [],
    });
    const res = await findByPreference(
      req({
        method: 'GET',
        query: { category: 'nonsense' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contacts: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/contacts/:did
// ---------------------------------------------------------------------------

describe('PUT /v1/contacts/:did (PC-CORE-11)', () => {
  function setup() {
    const calls: { did: string; categories: readonly string[] }[] = [];
    const known = new Map<string, Contact>();
    const { updateContact } = makeContactsHandlers({
      getContact: (d) => known.get(d) ?? null,
      setPreferredFor: (did, categories) => {
        calls.push({ did, categories });
      },
    });
    return { updateContact, calls, known };
  }

  it('happy path: preferred_for is forwarded to setPreferredFor', async () => {
    const { updateContact, calls, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({ preferred_for: ['dental', 'tax'] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'updated' });
    expect(calls).toEqual([{ did: 'did:plc:alice', categories: ['dental', 'tax'] }]);
  });

  it('empty preferred_for = [] is forwarded (clear all semantics)', async () => {
    const { updateContact, calls, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice', ['dental']));
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({ preferred_for: [] }),
      }),
    );
    expect(res.status).toBe(200);
    // Critical: [] reaches the repo so the clear operation actually
    // runs. Truthy-checks would swallow this — dedicated test.
    expect(calls).toEqual([{ did: 'did:plc:alice', categories: [] }]);
  });

  it("omitting preferred_for is a no-op (tri-state undefined = don't touch)", async () => {
    const { updateContact, calls, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({}),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('404 on unknown did', async () => {
    const { updateContact } = setup();
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:ghost' },
        ...jsonBody({ preferred_for: ['dental'] }),
      }),
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/not found/);
  });

  it('400 on missing did path param', async () => {
    const { updateContact } = setup();
    const res = await updateContact(
      req({
        method: 'PUT',
        params: {},
        ...jsonBody({ preferred_for: ['dental'] }),
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/did/);
  });

  it('400 on non-object body', async () => {
    const { updateContact, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        body: null,
        rawBody: new TextEncoder().encode('null'),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when preferred_for is not an array', async () => {
    const { updateContact, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({ preferred_for: 'dental' }),
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/array/);
  });

  it('400 when preferred_for contains a non-string entry', async () => {
    const { updateContact, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({ preferred_for: ['dental', 42, 'tax'] }),
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/string/);
  });

  it('413 on oversized body', async () => {
    const { updateContact, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const large = new Uint8Array(16 * 1024 + 1);
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        body: {},
        rawBody: large,
      }),
    );
    expect(res.status).toBe(413);
  });

  it('unknown body fields are silently ignored (forward-compat)', async () => {
    const { updateContact, calls, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({
          preferred_for: ['dental'],
          notes: 'also-ignored',
          frobnicate: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ did: 'did:plc:alice', categories: ['dental'] }]);
  });

  it('trust_level is validated, never silently ignored (a lying "updated" hid it)', async () => {
    const { updateContact, known } = setup();
    known.set('did:plc:alice', contactFixture('did:plc:alice', 'Alice'));
    const bad = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({ trust_level: 'superuser' }),
      }),
    );
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toContain('trust_level');
  });
});

// ---------------------------------------------------------------------------
// PC-CORE-09 — authz posture verification
// ---------------------------------------------------------------------------

describe('PC-CORE-09: /v1/contacts/by-preference authz', () => {
  it('is allowed for brain + admin via the existing /v1/contacts prefix', async () => {
    // This runs outside the router so we're asserting the authz
    // matrix rather than the HTTP pipeline. See authz_matrix.test.ts
    // for the canonical rule coverage — this duplicates the subpath
    // check here so a future narrowing of the prefix rule would
    // trigger a failure in BOTH test files (louder failure mode).
    const { isAuthorized } = await import('../../../src/auth/authz');
    expect(isAuthorized('brain', 'GET', '/v1/contacts/by-preference')).toBe(true);
    expect(isAuthorized('admin', 'GET', '/v1/contacts/by-preference')).toBe(true);
    expect(isAuthorized('device', 'GET', '/v1/contacts/by-preference')).toBe(false);
    expect(isAuthorized('agent', 'GET', '/v1/contacts/by-preference')).toBe(false);
    expect(isAuthorized('connector', 'GET', '/v1/contacts/by-preference')).toBe(false);
  });

  it('is allowed for brain + admin on PUT /v1/contacts/:did too', async () => {
    const { isAuthorized } = await import('../../../src/auth/authz');
    expect(isAuthorized('brain', 'PUT', '/v1/contacts/did:plc:alice')).toBe(true);
    expect(isAuthorized('admin', 'PUT', '/v1/contacts/did:plc:alice')).toBe(true);
    expect(isAuthorized('device', 'PUT', '/v1/contacts/did:plc:alice')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/contacts/lookup
// ---------------------------------------------------------------------------

describe('GET /v1/contacts/lookup', () => {
  const alice = contactFixture('did:plc:alice', 'Alice');

  function handlers() {
    return makeContactsHandlers({
      getContact: (did) => (did === 'did:plc:alice' ? alice : null),
      resolveByName: (name) => (name.toLowerCase() === 'alice' ? alice : null),
      findByAlias: (alias) => (alias.toLowerCase() === 'ali' ? alice : null),
    });
  }

  it('resolves by DID', async () => {
    const res = await handlers().lookup(req({ query: { q: 'did:plc:alice' } }));
    expect(res.status).toBe(200);
    expect((res.body as { contact: Contact }).contact.displayName).toBe('Alice');
  });

  it('resolves by display name then alias', async () => {
    expect((await handlers().lookup(req({ query: { q: 'Alice' } }))).body).toEqual({
      contact: alice,
    });
    expect((await handlers().lookup(req({ query: { q: 'ali' } }))).body).toEqual({
      contact: alice,
    });
  });

  it('returns { contact: null } on no match', async () => {
    const res = await handlers().lookup(req({ query: { q: 'nobody' } }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contact: null });
  });

  it('rejects an empty q', async () => {
    expect((await handlers().lookup(req({ query: {} }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/contacts — trust_level validation
// ---------------------------------------------------------------------------
//
// Regression for the review finding: the route used to cast any string to
// TrustLevel. Since the projection treats anything !== 'blocked' as
// gate-eligible, a bogus value became effectively trusted. The route must now
// validate against the real enum BEFORE calling addContact.

describe('POST /v1/contacts trust_level validation', () => {
  function makeAddHandler() {
    const addContact = jest.fn(
      (did: string, displayName: string, trustLevel?: Contact['trustLevel']) => ({
        contact: { ...contactFixture(did, displayName), trustLevel: trustLevel ?? 'verified' },
        created: true,
      }),
    );
    return { addContact, handler: makeContactsHandlers({ addContact }).addContact };
  }

  function post(body: unknown): CoreRequest {
    return req({ method: 'POST', path: '/v1/contacts', ...jsonBody(body) });
  }

  it.each(['blocked', 'unknown', 'verified', 'trusted'])(
    'accepts the valid trust level %s and passes it through',
    async (level) => {
      const { addContact, handler } = makeAddHandler();
      const res = await handler(post({ did: 'did:plc:abc', trust_level: level }));
      expect(res.status).toBe(200);
      expect(addContact).toHaveBeenCalledWith('did:plc:abc', 'did:plc:abc', level);
    },
  );

  it('defaults to verified when trust_level is omitted', async () => {
    const { addContact, handler } = makeAddHandler();
    const res = await handler(post({ did: 'did:plc:abc' }));
    expect(res.status).toBe(200);
    expect(addContact).toHaveBeenCalledWith('did:plc:abc', 'did:plc:abc', 'verified');
  });

  it.each([
    'trusted-ish',
    'BLOCKED',
    'admin',
    '',
    'verified ',
    123,
    true,
    null,
    {},
  ])('rejects invalid trust_level %p with 400 and never calls addContact', async (level) => {
    const { addContact, handler } = makeAddHandler();
    const res = await handler(post({ did: 'did:plc:abc', trust_level: level }));
    expect(res.status).toBe(400);
    expect(addContact).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/contacts/service-decisions (owner-private decision log)
// ---------------------------------------------------------------------------

describe('GET /v1/contacts/service-decisions', () => {
  const sample = [
    {
      id: 2,
      requesterDid: 'did:plc:alonso',
      capability: 'availability_coordination',
      decision: 'auto_declined' as const,
      reason: 'closeness=unknown',
      createdAt: 200,
    },
    {
      id: 1,
      requesterDid: 'did:plc:sancho',
      capability: 'availability_coordination',
      decision: 'granted' as const,
      reason: 'closeness=close',
      createdAt: 100,
    },
  ];

  it('returns the decision log + count', async () => {
    const { serviceDecisions } = makeContactsHandlers({ listServiceDecisions: () => sample });
    const res = await serviceDecisions(req({ method: 'GET' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ decisions: sample, count: 2 });
  });

  it('passes a positive limit through, clamped to the max', async () => {
    const seen: number[] = [];
    const { serviceDecisions } = makeContactsHandlers({
      listServiceDecisions: (limit) => {
        seen.push(limit);
        return [];
      },
    });
    await serviceDecisions(req({ method: 'GET', query: { limit: '5' } }));
    await serviceDecisions(req({ method: 'GET', query: { limit: '99999' } }));
    await serviceDecisions(req({ method: 'GET', query: { limit: 'garbage' } }));
    // 5 honoured; 99999 clamped to 500; garbage → default 100.
    expect(seen).toEqual([5, 500, 100]);
  });
});

describe('DELETE /v1/contacts/:did (remove a contact)', () => {
  it('removes the contact and returns { deleted: true }', async () => {
    let removed: string | null = null;
    const { deleteContact } = makeContactsHandlers({
      deleteContact: (did) => {
        removed = did;
        return true;
      },
    });
    const res = await deleteContact(req({ method: 'DELETE', params: { did: 'did:plc:x' } }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(removed).toBe('did:plc:x'); // trimmed did reached the directory
  });

  it('is idempotent — { deleted: false } (200, not 404) when the DID was not a contact', async () => {
    const { deleteContact } = makeContactsHandlers({ deleteContact: () => false });
    const res = await deleteContact(req({ method: 'DELETE', params: { did: 'did:plc:ghost' } }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: false });
  });

  it('400 when the did path param is empty — never touches the directory', async () => {
    let called = false;
    const { deleteContact } = makeContactsHandlers({
      deleteContact: () => {
        called = true;
        return true;
      },
    });
    const res = await deleteContact(req({ method: 'DELETE', params: { did: '   ' } }));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

/**
 * §5.D — the counterparty's paper identity on the contact row. The route maps
 * the snake_case wire onto the domain call, applies the three fields in ONE
 * call (so a caller correcting two of them sees both findings), and answers a
 * refusal with the findings rather than a bare 400.
 */
describe('PUT /v1/contacts/:did — the paper identity', () => {
  const DID = 'did:plc:chairmaker99';
  const GSTIN = '27AAPFU0939F1ZV';

  /**
   * A fake that can COMMIT must also be able to JUDGE: the route checks both
   * stores before writing either, so a fixture that only injected the setter
   * would silently reach the real directory.
   */
  function handlersWithPaper(findings: { refusal: string; field: string; detail: string }[] = []) {
    const calls: { did: string; identity: unknown }[] = [];
    const handlers = makeContactsHandlers({
      getContact: (did) => (did === DID ? contactFixture(DID, 'ChairMaker') : null),
      setPreferredFor: () => undefined,
      checkPaperIdentity: () => findings as never,
      checkContactChannels: () => [],
      setContactChannels: () => [],
      setPaperIdentity: (did, identity) => {
        calls.push({ did, identity });
        return findings as never;
      },
    });
    return { handlers, calls };
  }

  it('maps the wire onto the domain call — snake_case in, camelCase out, one call for all three fields', async () => {
    const { handlers, calls } = handlersWithPaper();
    const res = await handlers.updateContact(
      req({
        method: 'PUT',
        path: `/v1/contacts/${DID}`,
        params: { did: DID },
        ...jsonBody({
          legal_name: 'ChairMaker Industries LLP',
          registrations: [{ scheme: 'gstin', value: GSTIN }],
          billing_address: {
            line1: '4 Kalasipalya Road',
            city: 'Bengaluru',
            region: 'Karnataka',
            postal_code: '560002',
            country: 'IN',
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      did: DID,
      identity: {
        legalName: 'ChairMaker Industries LLP',
        registrations: [{ scheme: 'gstin', value: GSTIN }],
        billingAddress: {
          line1: '4 Kalasipalya Road',
          city: 'Bengaluru',
          region: 'Karnataka',
          postalCode: '560002',
          country: 'IN',
        },
      },
    });
  });

  it('passes only the fields the caller named — the others are left alone', async () => {
    const { handlers, calls } = handlersWithPaper();
    await handlers.updateContact(
      req({
        method: 'PUT',
        path: `/v1/contacts/${DID}`,
        params: { did: DID },
        ...jsonBody({ registrations: [] }),
      }),
    );
    expect(calls[0].identity).toEqual({ registrations: [] });
  });

  it('clears the billing address with an explicit null', async () => {
    const { handlers, calls } = handlersWithPaper();
    await handlers.updateContact(
      req({
        method: 'PUT',
        path: `/v1/contacts/${DID}`,
        params: { did: DID },
        ...jsonBody({ billing_address: null }),
      }),
    );
    expect(calls[0].identity).toEqual({ billingAddress: null });
  });

  it('answers a domain refusal with its findings, so the owner sees every problem at once', async () => {
    const { handlers } = handlersWithPaper([
      { refusal: 'malformed_registration', field: 'registrations[0]', detail: 'the gstin does not pass its own format check' },
      { refusal: 'malformed_address', field: 'billing_address.country', detail: 'country must be an ISO-3166-1 alpha-2 code, e.g. IN or US' },
    ]);
    const res = await handlers.updateContact(
      req({
        method: 'PUT',
        path: `/v1/contacts/${DID}`,
        params: { did: DID },
        ...jsonBody({ registrations: [{ scheme: 'gstin', value: '27AAPFU0939F1ZW' }], billing_address: { line1: 'x', city: 'y', country: 'India' } }),
      }),
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: string; findings: { field: string }[] };
    expect(body.error).toBe('identity_invalid');
    expect(body.findings.map((f) => f.field)).toEqual(['registrations[0]', 'billing_address.country']);
  });

  it.each([
    [{ legal_name: 42 }, 'legal_name must be a string'],
    [{ registrations: 'gstin' }, 'registrations must be an array'],
    [{ registrations: [{ scheme: 'gstin' }] }, 'each registration needs a string scheme and value'],
  ])('refuses a malformed body (%j) before the domain is called', async (patch, message) => {
    const { handlers, calls } = handlersWithPaper();
    const res = await handlers.updateContact(
      req({ method: 'PUT', path: `/v1/contacts/${DID}`, params: { did: DID }, ...jsonBody(patch) }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain(message);
    expect(calls).toHaveLength(0);
  });

  it('does not touch the paper identity when the body names none of its fields', async () => {
    const { handlers, calls } = handlersWithPaper();
    const res = await handlers.updateContact(
      req({ method: 'PUT', path: `/v1/contacts/${DID}`, params: { did: DID }, ...jsonBody({ preferred_for: ['chairs'] }) }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('passes the channels to the people-graph writer, tri-state like the rest', async () => {
    const calls: { did: string; channels: unknown }[] = [];
    const handlers = makeContactsHandlers({
      getContact: (did) => (did === DID ? contactFixture(DID, 'ChairMaker') : null),
      checkContactChannels: () => [],
      setContactChannels: (did, channels) => {
        calls.push({ did, channels });
        return [];
      },
    });
    const res = await handlers.updateContact(
      req({
        method: 'PUT',
        path: `/v1/contacts/${DID}`,
        params: { did: DID },
        ...jsonBody({ phone: '+91 98450 12345', email: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ did: DID, channels: { phone: '+91 98450 12345', email: null } }]);
  });

  it('answers a channel refusal with its findings', async () => {
    const handlers = makeContactsHandlers({
      getContact: () => contactFixture(DID, 'ChairMaker'),
      checkContactChannels: () => [
        { refusal: 'malformed_channel', field: 'phone', detail: 'a phone must be 8–15 digits' } as never,
      ],
      setContactChannels: () => [],
    });
    const res = await handlers.updateContact(
      req({ method: 'PUT', path: `/v1/contacts/${DID}`, params: { did: DID }, ...jsonBody({ phone: 'call me' }) }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('identity_invalid');
  });

  it('refuses a channel that is not a string or null before the domain is called', async () => {
    const calls: unknown[] = [];
    const handlers = makeContactsHandlers({
      getContact: () => contactFixture(DID, 'ChairMaker'),
      checkContactChannels: () => [],
      setContactChannels: (did, channels) => {
        calls.push({ did, channels });
        return [];
      },
    });
    const res = await handlers.updateContact(
      req({ method: 'PUT', path: `/v1/contacts/${DID}`, params: { did: DID }, ...jsonBody({ phone: 42 }) }),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('writes NEITHER store when one of them objects — the same refusal means the same thing', async () => {
    const written: string[] = [];
    const handlers = makeContactsHandlers({
      getContact: () => contactFixture(DID, 'ChairMaker'),
      checkPaperIdentity: () => [],
      // The channels object: the paper identity must not be committed either.
      checkContactChannels: () => [
        { refusal: 'malformed_channel', field: 'phone', detail: 'a phone must be 8–15 digits' } as never,
      ],
      setPaperIdentity: () => {
        written.push('paper');
        return [];
      },
      setContactChannels: () => {
        written.push('channels');
        return [];
      },
    });
    const res = await handlers.updateContact(
      req({
        method: 'PUT',
        path: `/v1/contacts/${DID}`,
        params: { did: DID },
        ...jsonBody({ legal_name: 'ChairMaker Industries LLP', phone: 'call me' }),
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('identity_invalid');
    expect(written).toEqual([]);
  });

  it('commits both stores when both are happy', async () => {
    const written: string[] = [];
    const handlers = makeContactsHandlers({
      getContact: () => contactFixture(DID, 'ChairMaker'),
      checkPaperIdentity: () => [],
      checkContactChannels: () => [],
      setPaperIdentity: () => {
        written.push('paper');
        return [];
      },
      setContactChannels: () => {
        written.push('channels');
        return [];
      },
    });
    const res = await handlers.updateContact(
      req({
        method: 'PUT',
        path: `/v1/contacts/${DID}`,
        params: { did: DID },
        ...jsonBody({ legal_name: 'ChairMaker Industries LLP', phone: '+919845012345' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(written).toEqual(['paper', 'channels']);
  });

  it('404s for an unknown contact before any identity work', async () => {
    const { handlers, calls } = handlersWithPaper();
    const res = await handlers.updateContact(
      req({
        method: 'PUT',
        path: '/v1/contacts/did:plc:nobody',
        params: { did: 'did:plc:nobody' },
        ...jsonBody({ legal_name: 'Nobody Ltd' }),
      }),
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
