/**
 * The names Brain hides from a cloud model (docs/PII_ARCHITECTURE_V2.md §5.1,
 * §5.2): what Core includes and leaves out, and the route.
 */

import { resetContactDirectory } from '../../src/contacts/directory';
import { setPeopleRepository, type PeopleRepository } from '../../src/people/repository';
import { buildPiiNameGroups, readPiiNameGroups } from '../../src/pii/names';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerPIIRoutes } from '../../src/server/routes/pii';

import type { Contact } from '../../src/contacts/directory';
import type { Person, PersonSurface, SurfaceType, SurfaceStatus } from '../../src/people/domain';

let surfaceId = 0;
function surface(
  surface: string,
  surfaceType: SurfaceType,
  status: SurfaceStatus = 'confirmed',
): PersonSurface {
  return {
    id: ++surfaceId,
    personId: '',
    surface,
    normalizedSurface: surface.toLowerCase(),
    surfaceType,
    status,
    confidence: 'high',
    sourceItemId: '',
    sourceExcerpt: '',
    extractorVersion: '',
  } as PersonSurface;
}

function person(
  personId: string,
  canonicalName: string,
  surfaces: PersonSurface[],
  status: Person['status'] = 'confirmed',
  relationshipHint = '',
): Person {
  return {
    personId,
    canonicalName,
    contactDid: '',
    relationshipHint,
    status,
    createdFrom: 'llm',
    createdAt: 0,
    updatedAt: 0,
    surfaces,
  };
}

function contact(
  personId: string,
  did: string,
  displayName: string,
  aliases: string[] = [],
): Contact {
  return { personId, did, displayName, aliases } as unknown as Contact;
}

describe('buildPiiNameGroups', () => {
  it('names, nicknames and aliases, grouped by person; role phrases and rejected surfaces left out', () => {
    const groups = buildPiiNameGroups(
      [
        person('p1', 'Emma Watson', [
          surface('Emma', 'nickname'),
          surface('Em', 'alias', 'suggested'),
          surface('my daughter', 'role_phrase'),
          surface('Emmy', 'nickname', 'rejected'),
        ]),
        person('p2', 'Sancho', []),
      ],
      [],
    );
    expect(groups).toEqual([
      { group: 1, names: ['Emma Watson', 'Emma', 'Em'] },
      { group: 2, names: ['Sancho'] },
    ]);
  });

  it('a rejected person is left out', () => {
    expect(buildPiiNameGroups([person('p1', 'Nobody', [], 'rejected')], [])).toEqual([]);
  });

  it('a relationship word, alone or after "my", is never hidden; a real name is', () => {
    const groups = buildPiiNameGroups(
      [
        person('p1', 'Mom', [
          surface('my mom', 'alias'),
          surface('Amma', 'nickname'),
          surface('Lakshmi', 'name'),
        ]),
      ],
      [],
    );
    // "Amma" is on no list and this person has no hint, so it is hidden: the safe side.
    expect(groups).toEqual([{ group: 1, names: ['Amma', 'Lakshmi'] }]);
  });

  it("the person's own relationship hint, in the owner's language, is left visible", () => {
    const groups = buildPiiNameGroups(
      [
        person(
          'p1',
          'Lakshmi',
          [surface('Amma', 'nickname'), surface('my amma', 'alias')],
          'confirmed',
          'Amma',
        ),
      ],
      [],
    );
    expect(groups).toEqual([{ group: 1, names: ['Lakshmi'] }]);
  });

  it('a person really called Nana stays hidden: given names are never on the list', () => {
    const groups = buildPiiNameGroups(
      [person('p1', 'Nana Mensah', [surface('Nana', 'nickname')], 'confirmed', 'friend')],
      [],
    );
    expect(groups).toEqual([{ group: 1, names: ['Nana Mensah', 'Nana'] }]);
  });

  it("one person's hint does not unhide another person's name", () => {
    const groups = buildPiiNameGroups(
      [
        person('p1', 'Ravi', [], 'confirmed', 'boss'),
        person('p2', 'Boss', [], 'confirmed', ''),
        person('p3', 'Chief', [], 'confirmed', 'boss'),
      ],
      [],
    );
    // "Boss" is on the list for anyone; "Chief" is hidden because p3's hint is "boss", not "chief".
    expect(groups).toEqual([
      { group: 1, names: ['Ravi'] },
      { group: 2, names: ['Chief'] },
    ]);
  });

  it('a contact joins its person; a contact with no person forms its own group', () => {
    const groups = buildPiiNameGroups(
      [person('p1', 'Sancho Garcia', [])],
      [contact('p1', 'did:plc:s', 'Sancho', ['Sanch']), contact('', 'did:plc:a', 'Albert')],
    );
    expect(groups).toEqual([
      { group: 1, names: ['Sancho Garcia', 'Sancho', 'Sanch'] },
      { group: 2, names: ['Albert'] },
    ]);
  });

  it('a name appears once in the whole list, so no string maps to two people', () => {
    const groups = buildPiiNameGroups(
      [
        person('p1', 'Alex Kim', [surface('Alex', 'nickname')]),
        person('p2', 'Alex Roy', [surface('alex', 'nickname')]),
      ],
      [],
    );
    expect(groups).toEqual([
      { group: 1, names: ['Alex Kim', 'Alex'] },
      { group: 2, names: ['Alex Roy'] },
    ]);
  });

  it('drops one-letter names and squeezes spaces', () => {
    expect(buildPiiNameGroups([person('p1', '  Jo   Ann ', [surface('J', 'alias')])], [])).toEqual([
      { group: 1, names: ['Jo Ann'] },
    ]);
  });
});

describe('readPiiNameGroups', () => {
  it('keeps only well-formed groups of strings', () => {
    expect(
      readPiiNameGroups([
        { group: 1, names: ['Emma', 7, 'x'] },
        { group: 'two', names: ['Bob'] },
        { group: 3, names: 'Carl' },
        null,
        { group: 4, names: ['Dee'] },
      ]),
    ).toEqual([
      { group: 1, names: ['Emma'] },
      { group: 4, names: ['Dee'] },
    ]);
    expect(readPiiNameGroups('nope')).toEqual([]);
  });
});

describe('GET /v1/pii/names', () => {
  const router = new CoreRouter();
  registerPIIRoutes(router);
  const request = {
    method: 'GET',
    path: '/v1/pii/names',
    headers: {},
    query: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
  } as unknown as CoreRequest;

  afterEach(() => {
    setPeopleRepository(null);
    resetContactDirectory();
  });

  it('answers the groups, and nothing else about anyone', async () => {
    setPeopleRepository({
      listPeople: () => [person('p-secret-id', 'Sancho', [surface('Sanch', 'nickname')])],
    } as unknown as PeopleRepository);
    const res = await router.handle(request);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [{ group: 1, names: ['Sancho', 'Sanch'] }] });
    expect(JSON.stringify(res.body)).not.toContain('p-secret-id');
  });

  it('with no people graph wired, answers an empty list', async () => {
    const res = await router.handle(request);
    expect(res).toMatchObject({ status: 200, body: { groups: [] } });
  });
});
