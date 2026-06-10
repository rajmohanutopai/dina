/**
 * Relations-tab membership — "being a contact is NOT being a relation"
 * (user-reported 2026-06-10: a bus depot added as a service contact
 * appeared in Relations between the user's daughter and a friend).
 */

import { isRelation, relationsOnly } from '../../src/services/people_relations';

import type { Person, PersonSurface } from '@dina/core';


function person(overrides: Partial<Person>): Person {
  return {
    personId: 'person-x',
    canonicalName: 'X',
    contactDid: '',
    relationshipHint: '',
    status: 'confirmed',
    createdFrom: 'llm',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function surface(surfaceType: PersonSurface['surfaceType']): PersonSurface {
  return {
    id: 1,
    personId: 'person-x',
    surface: 's',
    normalizedSurface: 's',
    surfaceType,
    status: 'confirmed',
    confidence: 'high',
    sourceItemId: '',
  } as PersonSurface;
}

describe('isRelation', () => {
  it('service contact (DID-bound, no relational evidence) is NOT a relation — the bus depot case', () => {
    const busDepot = person({
      canonicalName: 'Bus Depot 42',
      contactDid: 'did:plc:sluk5vdtwgfmu2ad24pluqnx',
      createdFrom: 'user',
      surfaces: [surface('name')],
    });
    expect(isRelation(busDepot)).toBe(false);
  });

  it('vault-born person with no DID is a relation (Mia)', () => {
    expect(isRelation(person({ canonicalName: 'Mia' }))).toBe(true);
  });

  it('relationship hint qualifies a DID-bound contact (Emma · daughter)', () => {
    const emma = person({
      canonicalName: 'Emma',
      contactDid: 'did:plc:emma',
      relationshipHint: 'daughter',
      createdFrom: 'user',
    });
    expect(isRelation(emma)).toBe(true);
  });

  it('vault-extracted evidence graduates a contact into Relations (role_phrase/alias)', () => {
    const sancho = person({
      canonicalName: 'Sancho',
      contactDid: 'did:plc:sancho',
      createdFrom: 'user',
      surfaces: [surface('name'), surface('role_phrase')],
    });
    expect(isRelation(sancho)).toBe(true);
  });

  it('relationsOnly filters the list shape used by the screen', () => {
    const rows = [
      person({ personId: 'p1', canonicalName: 'Bus Depot 42', contactDid: 'did:plc:bus', surfaces: [surface('name')] }),
      person({ personId: 'p2', canonicalName: 'Mia' }),
      person({ personId: 'p3', canonicalName: 'Emma', contactDid: 'did:plc:e', relationshipHint: 'daughter' }),
    ];
    expect(relationsOnly(rows).map((p) => p.canonicalName)).toEqual(['Mia', 'Emma']);
  });
});
