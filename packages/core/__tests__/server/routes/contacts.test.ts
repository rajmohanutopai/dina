/**
 * PC-CORE-10 + PC-CORE-11 — contacts HTTP routes.
 *
 * Exercises the pure handlers returned by `makeContactsHandlers` so
 * these tests cover validation, happy-path payload shapes, and error
 * surfaces without running the router's signed-auth pipeline. The
 * auth allowlist is covered by the existing `/v1/contacts` rule in
 * `authz.ts` (PC-CORE-09 — verified).
 */

import type { CoreRequest } from '../../../src/server/router';
import { makeContactsHandlers } from '../../../src/server/routes/contacts';
import type { Contact } from '../../../src/contacts/directory';

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
    const calls: Array<{ did: string; categories: readonly string[] }> = [];
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
          display_name: 'ignored-for-now',
          notes: 'also-ignored',
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ did: 'did:plc:alice', categories: ['dental'] }]);
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
