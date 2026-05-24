/**
 * Lightweight in-memory `PeopleRepository` for tests that exercise the
 * contact directory but don't need full people-graph behaviour.
 *
 * The contact directory resolves did→person through the people graph
 * (contact policy is person-keyed), so any test that calls
 * `addContact`/`getContact` needs a wired people repo. Suites that test
 * people-graph semantics proper use the real SQLite repo; this fake
 * just provides a faithful 1-DID-per-person mapping so directory calls
 * resolve. Shared across `@dina/core` and `@dina/brain` test suites.
 */

import type { PeopleRepository, Person, PersonIdentity } from '@dina/core';

export function makeFakePeopleRepo(): PeopleRepository {
  const didToPerson = new Map<string, string>(); // did -> personId
  const names = new Map<string, string>(); // personId -> canonical name
  let seq = 0;

  const didFor = (personId: string): string => {
    for (const [did, pid] of didToPerson) if (pid === personId) return did;
    return '';
  };
  const personFor = (personId: string): Person | null => {
    if (!names.has(personId)) return null;
    return {
      personId,
      canonicalName: names.get(personId) ?? '',
      contactDid: didFor(personId),
      relationshipHint: '',
      status: 'confirmed',
      createdFrom: 'user',
      createdAt: 0,
      updatedAt: 0,
      surfaces: [],
    };
  };

  return {
    upsertContactPerson(did: string, displayName: string): string {
      if (did === '') throw new Error('upsertContactPerson: did is required');
      const trimmed = displayName.trim();
      if (trimmed === '') throw new Error('upsertContactPerson: displayName is required');
      let pid = didToPerson.get(did);
      if (pid === undefined) {
        pid = `person-fake-${seq++}`;
        didToPerson.set(did, pid);
      }
      names.set(pid, trimmed);
      return pid;
    },
    resolveByIdentity(identityType: string, identityValue: string): Person | null {
      if (identityType !== 'did' || identityValue === '') return null;
      const pid = didToPerson.get(identityValue);
      return pid === undefined ? null : personFor(pid);
    },
    findByContactDid(did: string): Person | null {
      return this.resolveByIdentity('did', did);
    },
    listIdentities(personId: string): PersonIdentity[] {
      const out: PersonIdentity[] = [];
      for (const [did, pid] of didToPerson) {
        if (pid === personId) {
          out.push({
            identityId: 0,
            personId,
            identityType: 'did',
            identityValue: did,
            verified: true,
            primary: true,
            createdAt: 0,
            updatedAt: 0,
          });
        }
      }
      return out;
    },
    upsertIdentity(personId: string, identityType: string, identityValue: string): void {
      if (identityType === 'did') didToPerson.set(identityValue, personId);
    },
    linkContact(personId: string, contactDid: string): boolean {
      if (contactDid === '' || !names.has(personId)) return false;
      didToPerson.set(contactDid, personId);
      return true;
    },
    getPerson(personId: string): Person | null {
      return personFor(personId);
    },
    listPeople(): Person[] {
      return [...names.keys()].map(personFor).filter((p): p is Person => p !== null);
    },
    // Methods the contact directory never calls — minimal stand-ins.
    applyExtraction: () => ({ created: 0, updated: 0, conflicts: [], skipped: false }),
    confirmPerson: () => false,
    rejectPerson: () => false,
    confirmSurface: () => false,
    rejectSurface: () => false,
    detachSurface: () => false,
    mergePeople: () => undefined,
    deletePerson: () => false,
    resolveConfirmedSurfaces: () => new Map(),
    clearExcerptsForItem: () => 0,
    garbageCollect: () => 0,
  };
}
