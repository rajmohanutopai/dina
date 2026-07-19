/**
 * recallSenderSubjectMemories — the structured did→person→subjects recall
 * that seeds the agentic loop. Covers BOTH runtimes:
 *   - in-process (mobile): local people + vault repos
 *   - out-of-process (home-node-lite): people + vault HTTP read backends
 */

import {
  setPeopleRepository,
  setVaultRepository,
  resetVaultRepositories,
  InMemoryVaultRepository,
  addContact,
  resetContactDirectory,
  type Person,
} from '@dina/core';
import { makeVaultItem, makeFakePeopleRepo } from '@dina/test-harness';

import {
  setPeopleReadBackend,
  setVaultReadBackend,
  setContactReadBackend,
} from '../../src/vault_context/assembly';
import {
  recallSenderSubjectMemories,
  resolveSenderIdentity,
} from '../../src/vault_context/subject_recall';

describe('recallSenderSubjectMemories', () => {
  afterEach(() => {
    setPeopleRepository(null);
    setPeopleReadBackend(null);
    setVaultReadBackend(null);
    resetVaultRepositories();
  });

  it('in-process: resolves DID → person → subject-linked memories', async () => {
    const people = makeFakePeopleRepo();
    setPeopleRepository(people);
    const personId = people.upsertContactPerson('did:plc:quixote', 'Don Quixote');

    const vault = new InMemoryVaultRepository();
    setVaultRepository('general', vault);
    const pref = makeVaultItem({ summary: 'loves eggs and bacon', content_l0: 'loves eggs and bacon' });
    vault.storeItemSync(pref);
    vault.linkSubjectSync(pref.id, personId);

    const out = await recallSenderSubjectMemories('did:plc:quixote', ['general'], 5);
    expect(out).toEqual(['loves eggs and bacon']);
  });

  it('out-of-process: resolves through the people + vault HTTP backends', async () => {
    // No in-process repos — force the backend path.
    setPeopleRepository(null);
    resetVaultRepositories();

    setPeopleReadBackend({
      peopleList: async () => [],
      peopleFindByName: async () => [],
      peopleResolveByDid: async (did) =>
        did === 'did:plc:quixote'
          ? ({ personId: 'p-quixote', canonicalName: 'Don Quixote' } as unknown as Person)
          : null,
    });

    const calls: { persona: string; personId: string }[] = [];
    setVaultReadBackend({
      vaultQuery: async () => ({ items: [], count: 0 }),
      vaultItemsForPerson: async (persona, pid) => {
        calls.push({ persona, personId: pid });
        return pid === 'p-quixote'
          ? [{ id: 'i1', type: 'note', persona, content_l0: 'loves eggs and bacon' }]
          : [];
      },
    });

    const out = await recallSenderSubjectMemories('did:plc:quixote', ['general'], 5);
    expect(out).toEqual(['loves eggs and bacon']);
    expect(calls).toEqual([{ persona: 'general', personId: 'p-quixote' }]);
  });

  it('returns [] for an unknown sender / empty inputs', async () => {
    setPeopleRepository(makeFakePeopleRepo());
    expect(await recallSenderSubjectMemories('', ['general'], 5)).toEqual([]);
    expect(await recallSenderSubjectMemories('did:plc:nobody', ['general'], 5)).toEqual([]);
    expect(await recallSenderSubjectMemories('did:plc:nobody', [], 5)).toEqual([]);
  });
});

describe('resolveSenderIdentity', () => {
  afterEach(() => {
    setContactReadBackend(null);
    setPeopleRepository(null);
    resetContactDirectory();
  });

  it('out-of-process (lite): resolves name + relationship via the contact backend', async () => {
    // The lite gap: Brain's in-process directory is empty; contacts live in
    // Core and are reached over `contactLookup`. No in-process directory here.
    setContactReadBackend({
      contactLookup: async (q: string) =>
        q === 'did:plc:raju'
          ? ({ did: 'did:plc:raju', displayName: 'Raju', relationship: 'friend' } as never)
          : null,
    });
    expect(await resolveSenderIdentity('did:plc:raju')).toEqual({
      name: 'Raju',
      relationship: 'friend',
    });
  });

  it('out-of-process: bare name when the contact relationship is unknown', async () => {
    setContactReadBackend({
      contactLookup: async () =>
        ({ did: 'did:plc:x', displayName: 'Albert', relationship: 'unknown' } as never),
    });
    expect(await resolveSenderIdentity('did:plc:x')).toEqual({ name: 'Albert' });
  });

  it('out-of-process: null when the backend has no such contact', async () => {
    setContactReadBackend({ contactLookup: async () => null });
    expect(await resolveSenderIdentity('did:plc:nobody')).toBeNull();
  });

  it('in-process (mobile): resolves through Core’s local contact directory', async () => {
    setPeopleRepository(makeFakePeopleRepo()); // addContact needs a wired people repo
    addContact('did:plc:raju', 'Raju', 'verified', 'summary', 'friend');
    expect(await resolveSenderIdentity('did:plc:raju')).toEqual({
      name: 'Raju',
      relationship: 'friend',
    });
  });

  it('returns null for a non-DID (no lookup attempted)', async () => {
    expect(await resolveSenderIdentity('')).toBeNull();
    expect(await resolveSenderIdentity('not-a-did')).toBeNull();
  });
});
