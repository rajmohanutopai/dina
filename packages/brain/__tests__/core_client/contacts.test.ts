/**
 * Brain Core Client — contacts endpoints (PC-BRAIN-01 + PC-BRAIN-02).
 *
 *   findContactsByPreference(category) — GET /v1/contacts/by-preference
 *   updateContact(did, { preferredFor })  — PUT /v1/contacts/:did
 *
 * Follows the same mockFetch pattern as `core_client/memory.test.ts`.
 */

import { BrainCoreClient } from '../../src/core_client/http';
import { TEST_ED25519_SEED } from '@dina/test-harness';

function mockFetch(status: number, body: unknown = {}): jest.Mock {
  return jest.fn(
    async () =>
      ({
        status,
        text: async () => JSON.stringify(body),
      }) as Response,
  );
}

const baseConfig = {
  coreURL: 'http://localhost:8100',
  privateKey: TEST_ED25519_SEED,
  did: 'did:key:z6MkBrainService',
  maxRetries: 0,
};

// ---------------------------------------------------------------------------
// findContactsByPreference
// ---------------------------------------------------------------------------

describe('BrainCoreClient.findContactsByPreference (PC-BRAIN-01)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const drcarl = {
    did: 'did:plc:drcarl',
    displayName: "Dr Carl's Clinic",
    trustLevel: 'trusted',
    sharingTier: 'summary',
    relationship: 'acquaintance',
    dataResponsibility: 'external',
    aliases: ['Dr Carl'],
    notes: '',
    createdAt: 0,
    updatedAt: 0,
    preferredFor: ['dental'],
  };

  it('GETs /v1/contacts/by-preference with the category query param', async () => {
    const fetch = mockFetch(200, { contacts: [drcarl], count: 1 });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const contacts = await client.findContactsByPreference('dental');
    expect(contacts).toEqual([drcarl]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain('/v1/contacts/by-preference?category=dental');
    expect(init?.method).toBe('GET');
  });

  it('trims whitespace before sending', async () => {
    const fetch = mockFetch(200, { contacts: [], count: 0 });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.findContactsByPreference('  dental  ');
    expect(String(fetch.mock.calls[0][0])).toContain('category=dental');
    // Ensure no stray whitespace leaks into the URL.
    expect(String(fetch.mock.calls[0][0])).not.toMatch(/category=\s+dental/);
  });

  it('short-circuits to [] on empty / whitespace-only category (no wire call)', async () => {
    const fetch = mockFetch(500, { error: 'should not be hit' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    expect(await client.findContactsByPreference('')).toEqual([]);
    expect(await client.findContactsByPreference('   ')).toEqual([]);
    expect(await client.findContactsByPreference('\t\n')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns [] when the response body has no `contacts` field', async () => {
    const fetch = mockFetch(200, {});
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    expect(await client.findContactsByPreference('dental')).toEqual([]);
  });

  it('returns [] when `contacts` is null (Go nil-slice emits null, not [])', async () => {
    const fetch = mockFetch(200, { contacts: null });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    expect(await client.findContactsByPreference('dental')).toEqual([]);
  });

  it('returns [] on non-200 status (fail-soft — the resolver tool is documented to fall back)', async () => {
    const fetch = mockFetch(500, { error: 'boom' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    expect(await client.findContactsByPreference('dental')).toEqual([]);
  });

  it('returns [] when the transport throws (network / timeout)', async () => {
    const fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    expect(await client.findContactsByPreference('dental')).toEqual([]);
  });

  it('URL-encodes the category (handles categories with special chars)', async () => {
    const fetch = mockFetch(200, { contacts: [], count: 0 });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.findContactsByPreference('real estate');
    // URLSearchParams encodes the space as +.
    expect(String(fetch.mock.calls[0][0])).toContain('category=real+estate');
  });
});

// ---------------------------------------------------------------------------
// updateContact
// ---------------------------------------------------------------------------

describe('BrainCoreClient.updateContact (PC-BRAIN-02)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('PUTs /v1/contacts/:did with preferred_for body', async () => {
    const fetch = mockFetch(200, { status: 'updated' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.updateContact('did:plc:alice', { preferredFor: ['dental', 'tax'] });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain('/v1/contacts/did%3Aplc%3Aalice');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(init!.body as string);
    expect(body.preferred_for).toEqual(['dental', 'tax']);
  });

  it('sends preferred_for=[] when the caller passes an empty array (clear-all semantics)', async () => {
    // Tri-state: the `!== undefined` check must NOT swallow `[]`.
    const fetch = mockFetch(200, { status: 'updated' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.updateContact('did:plc:alice', { preferredFor: [] });
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body).toHaveProperty('preferred_for');
    expect(body.preferred_for).toEqual([]);
  });

  it("OMITS preferred_for when caller passes undefined (don't touch)", async () => {
    const fetch = mockFetch(200, { status: 'updated' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.updateContact('did:plc:alice', {});
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect('preferred_for' in body).toBe(false);
  });

  it('copies the array before sending (caller mutations do not leak)', async () => {
    const fetch = mockFetch(200, { status: 'updated' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const cats = ['dental'];
    await client.updateContact('did:plc:alice', { preferredFor: cats });
    // Mutate after the call — the body sent should NOT change.
    cats.push('tax');
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.preferred_for).toEqual(['dental']);
  });

  it('encodes the DID into the URL path', async () => {
    const fetch = mockFetch(200, { status: 'updated' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.updateContact('did:web:ex/ample?x=1', { preferredFor: ['dental'] });
    // did:web:ex/ample?x=1 must be encoded — forward slash + query
    // sigil would otherwise fragment the URL.
    expect(String(fetch.mock.calls[0][0])).toContain(encodeURIComponent('did:web:ex/ample?x=1'));
  });

  it('throws on missing / empty DID (caller bug)', async () => {
    const client = new BrainCoreClient({ ...baseConfig, fetch: mockFetch(200) });
    await expect(client.updateContact('', { preferredFor: ['dental'] })).rejects.toThrow(
      /did is required/,
    );
    await expect(client.updateContact('   ', { preferredFor: ['dental'] })).rejects.toThrow(
      /did is required/,
    );
  });

  it('throws on non-2xx (server-side 404 / 500)', async () => {
    const fetch = mockFetch(404, { error: 'contact not found' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await expect(
      client.updateContact('did:plc:ghost', { preferredFor: ['dental'] }),
    ).rejects.toThrow();
  });

  it('throws on 5xx', async () => {
    const fetch = mockFetch(503, { error: 'db down' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await expect(
      client.updateContact('did:plc:alice', { preferredFor: ['dental'] }),
    ).rejects.toThrow(/503/);
  });
});
