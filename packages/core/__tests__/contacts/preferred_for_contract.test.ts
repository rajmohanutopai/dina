/**
 * Preferred-for contract tests (PC-TEST-03 / TST-CORE-1000..1012).
 *
 * Thirteen cases that pin the behavioural contract for
 * `Contact.preferredFor` end-to-end: directory + repository +
 * HTTP handlers. Each case maps 1:1 to a main-dina TST-CORE-* ID so
 * cross-language audit is easy.
 *
 * Per-module unit tests (`preferred_for.test.ts`,
 * `preferred_for_repository.test.ts`, `server/routes/contacts.test.ts`)
 * also cover this ground — this file is the named-contract umbrella,
 * so a reader opening it can see the V1 acceptance criteria for the
 * preferred-contacts feature at a glance.
 */

import type { CoreRequest } from '../../src/server/router';
import {
  addContact,
  getContact,
  listContacts,
  setPreferredFor,
  getPreferredFor,
  findByPreferredFor,
  resetContactDirectory,
} from '../../src/contacts/directory';
import { setContactRepository } from '../../src/contacts/repository';
import { makeContactsHandlers } from '../../src/server/routes/contacts';

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

describe('Preferred-for contract (PC-TEST-03)', () => {
  beforeEach(() => {
    resetContactDirectory();
    // Run against pure in-memory — no SQL write-through.
    setContactRepository(null);
  });

  // ------------------------------------------------------------------
  // Repository surface
  // ------------------------------------------------------------------

  it('TST-CORE-1000: Set + Get roundtrip returns stored values', () => {
    addContact('did:plc:alice', 'Alice');
    setPreferredFor('did:plc:alice', ['dental', 'tax']);
    expect(getPreferredFor('did:plc:alice')).toEqual(['dental', 'tax']);
  });

  it('TST-CORE-1001: normalisation — lowercase + trim + dedup', () => {
    addContact('did:plc:alice', 'Alice');
    setPreferredFor('did:plc:alice', ['  Dental  ', 'dental', '', 'TAX']);
    expect(getPreferredFor('did:plc:alice')).toEqual(['dental', 'tax']);
  });

  it('TST-CORE-1002: empty input clears all preferences', () => {
    addContact('did:plc:alice', 'Alice');
    setPreferredFor('did:plc:alice', ['dental']);
    setPreferredFor('did:plc:alice', []);
    expect(getPreferredFor('did:plc:alice')).toEqual([]);
  });

  it('TST-CORE-1003: unknown DID on Set / Get throws a clear error', () => {
    expect(() => setPreferredFor('did:plc:ghost', ['dental'])).toThrow(/not found/);
    expect(() => getPreferredFor('did:plc:ghost')).toThrow(/not found/);
  });

  it('TST-CORE-1004: findByPreferredFor("DENTAL") matches case-insensitively', () => {
    addContact('did:plc:alice', 'Alice');
    setPreferredFor('did:plc:alice', ['dental']);
    expect(findByPreferredFor('DENTAL').map((c) => c.did)).toEqual(['did:plc:alice']);
    expect(findByPreferredFor('  Dental  ').map((c) => c.did)).toEqual(['did:plc:alice']);
  });

  it('TST-CORE-1005: findByPreferredFor returns all contacts with the category', () => {
    addContact('did:plc:alice', 'Alice');
    addContact('did:plc:bob', 'Bob');
    setPreferredFor('did:plc:alice', ['tax', 'accounting']);
    setPreferredFor('did:plc:bob', ['tax']);
    const dids = findByPreferredFor('tax')
      .map((c) => c.did)
      .sort();
    expect(dids).toEqual(['did:plc:alice', 'did:plc:bob']);
  });

  it('TST-CORE-1006: findByPreferredFor("") returns [] without throwing', () => {
    addContact('did:plc:alice', 'Alice');
    setPreferredFor('did:plc:alice', ['dental']);
    expect(findByPreferredFor('')).toEqual([]);
    expect(findByPreferredFor('   ')).toEqual([]);
  });

  it('TST-CORE-1007: list() populates preferredFor on every returned contact', () => {
    addContact('did:plc:alice', 'Alice');
    addContact('did:plc:bob', 'Bob');
    setPreferredFor('did:plc:alice', ['dental', 'tax']);
    // Leave Bob without preferences — field must still be accessible
    // (either `[]` or `undefined`) on his contact.
    const contacts = listContacts();
    const alice = contacts.find((c) => c.did === 'did:plc:alice')!;
    const bob = contacts.find((c) => c.did === 'did:plc:bob')!;
    expect(alice.preferredFor).toEqual(['dental', 'tax']);
    // Domain layer treats undefined ↔ [] as interchangeable absence.
    expect(bob.preferredFor ?? []).toEqual([]);
  });

  // ------------------------------------------------------------------
  // HTTP surface
  // ------------------------------------------------------------------

  it('TST-CORE-1008: PUT /v1/contacts/{did} with preferred_for stores the list', async () => {
    addContact('did:plc:alice', 'Alice');
    const { updateContact } = makeContactsHandlers();
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({ preferred_for: ['dental', 'tax'] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(getPreferredFor('did:plc:alice')).toEqual(['dental', 'tax']);
  });

  it('TST-CORE-1009: PUT without preferred_for is a no-op (field preserved)', async () => {
    addContact('did:plc:alice', 'Alice');
    setPreferredFor('did:plc:alice', ['dental']);
    const { updateContact } = makeContactsHandlers();
    // Body lacks `preferred_for` entirely — the tri-state
    // `undefined` arm means "don't touch."
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({}),
      }),
    );
    expect(res.status).toBe(200);
    expect(getPreferredFor('did:plc:alice')).toEqual(['dental']);
  });

  it('TST-CORE-1010: PUT with preferred_for: [] clears the field', async () => {
    addContact('did:plc:alice', 'Alice');
    setPreferredFor('did:plc:alice', ['dental', 'tax']);
    const { updateContact } = makeContactsHandlers();
    const res = await updateContact(
      req({
        method: 'PUT',
        params: { did: 'did:plc:alice' },
        ...jsonBody({ preferred_for: [] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(getPreferredFor('did:plc:alice')).toEqual([]);
  });

  it('TST-CORE-1011: GET /v1/contacts/by-preference?category=dental returns the matching contact', async () => {
    addContact('did:plc:alice', 'Alice');
    addContact('did:plc:bob', 'Bob');
    setPreferredFor('did:plc:alice', ['dental']);
    setPreferredFor('did:plc:bob', ['tax']);
    const { findByPreference } = makeContactsHandlers();
    const res = await findByPreference(
      req({
        method: 'GET',
        query: { category: 'dental' },
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { contacts: Array<{ did: string }>; count: number };
    expect(body.contacts.map((c) => c.did)).toEqual(['did:plc:alice']);
    expect(body.count).toBe(1);
  });

  it('TST-CORE-1012: GET /v1/contacts/by-preference with empty category → 400', async () => {
    const { findByPreference } = makeContactsHandlers();
    // Missing.
    expect((await findByPreference(req({ method: 'GET', query: {} }))).status).toBe(400);
    // Empty string.
    expect(
      (
        await findByPreference(
          req({
            method: 'GET',
            query: { category: '' },
          }),
        )
      ).status,
    ).toBe(400);
    // Whitespace-only.
    expect(
      (
        await findByPreference(
          req({
            method: 'GET',
            query: { category: '   ' },
          }),
        )
      ).status,
    ).toBe(400);
  });
});
