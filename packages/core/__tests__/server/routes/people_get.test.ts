/**
 * GET /v1/people  +  GET /v1/people/find — read-only surface used by
 * Brain's reasoning agent to resolve named individuals via the people
 * graph (instead of keyword-searching the vault). Exercises the pure
 * handlers returned by `makePeopleHandlers` so auth + body-size paths
 * stay out of scope (covered by the existing applyExtraction tests).
 */

import type { CoreRequest } from '../../../src/server/router';
import { makePeopleHandlers } from '../../../src/server/routes/people';
import type {
  ApplyExtractionResponse,
  ExtractionResult,
  Person,
  PersonSurface,
} from '../../../src/people/domain';
import type { PeopleRepository } from '../../../src/people/repository';
import {
  InMemoryVaultRepository,
  setVaultRepository,
  getVaultRepository,
} from '../../../src/vault/repository';

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

function surface(
  personId: string,
  surfaceText: string,
  overrides: Partial<PersonSurface> = {},
): PersonSurface {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    personId,
    surface: surfaceText,
    normalizedSurface: surfaceText.toLowerCase(),
    surfaceType: 'name',
    status: 'confirmed',
    confidence: 'high',
    sourceItemId: '',
    sourceExcerpt: '',
    extractorVersion: 'test-1',
    createdFrom: 'llm',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function personFixture(
  personId: string,
  canonicalName: string,
  relationshipHint: string,
  surfaces: PersonSurface[],
): Person {
  return {
    personId,
    canonicalName,
    contactDid: '',
    relationshipHint,
    status: 'confirmed',
    createdFrom: 'llm',
    createdAt: 0,
    updatedAt: 0,
    surfaces,
  };
}

class StubRepo implements PeopleRepository {
  constructor(private readonly people: Person[]) {}
  listPeople(): Person[] {
    return this.people;
  }
  applyExtraction(_: ExtractionResult): ApplyExtractionResponse {
    return { created: 0, updated: 0, conflicts: [], skipped: false };
  }
  getPerson(id: string): Person | null {
    return this.people.find((p) => p.personId === id) ?? null;
  }
  findByContactDid(_: string): Person | null {
    return null;
  }
  resolveByIdentity(_type: string, _value: string): Person | null {
    return null;
  }
  upsertIdentity(): void {
    /* no-op */
  }
  listIdentities() {
    return [];
  }
  confirmPerson(): boolean {
    return false;
  }
  rejectPerson(): boolean {
    return false;
  }
  confirmSurface(): boolean {
    return false;
  }
  rejectSurface(): boolean {
    return false;
  }
  detachSurface(): boolean {
    return false;
  }
  mergePeople(): void {
    /* no-op */
  }
  deletePerson(): boolean {
    return false;
  }
  linkContact(): boolean {
    return false;
  }
  upsertContactPerson(): string {
    return '';
  }
  resolveConfirmedSurfaces(): Map<string, PersonSurface[]> {
    return new Map();
  }
  clearExcerptsForItem(): number {
    return 0;
  }
  garbageCollect(): number {
    return 0;
  }
}

const emma = personFixture('p-emma', 'Emma', 'daughter', [
  surface('p-emma', 'Emma'),
  surface('p-emma', 'Em'),
]);
const alex1 = personFixture('p-alex-1', 'Alex Lee', 'colleague', [
  surface('p-alex-1', 'Alex'),
]);
const alex2 = personFixture('p-alex-2', 'Alex Garcia', 'cousin', [
  surface('p-alex-2', 'Alex'),
]);
const rejected = personFixture('p-r', 'Old Name', '', [
  surface('p-r', 'Emma', { status: 'rejected' }),
]);

describe('GET /v1/people', () => {
  it('returns the full list from the repository', async () => {
    const { list } = makePeopleHandlers({ resolveRepo: () => new StubRepo([emma, alex1]) });
    const res = await list();
    expect(res.status).toBe(200);
    const body = res.body as { people: Person[] };
    expect(body.people).toHaveLength(2);
    expect(body.people[0]?.canonicalName).toBe('Emma');
  });

  it('returns 503 when the repository is not wired', async () => {
    const { list } = makePeopleHandlers({ resolveRepo: () => null });
    const res = await list();
    expect(res.status).toBe(503);
  });
});

describe('GET /v1/people/find?surface=...', () => {
  it('returns 400 when the surface query is missing', async () => {
    const { find } = makePeopleHandlers({ resolveRepo: () => new StubRepo([emma]) });
    const res = await find(req({ query: {} }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when the surface query is blank', async () => {
    const { find } = makePeopleHandlers({ resolveRepo: () => new StubRepo([emma]) });
    const res = await find(req({ query: { surface: '   ' } }));
    expect(res.status).toBe(400);
  });

  it('matches case-insensitively against normalizedSurface', async () => {
    const { find } = makePeopleHandlers({ resolveRepo: () => new StubRepo([emma]) });
    const res = await find(req({ query: { surface: 'EMMA' } }));
    expect(res.status).toBe(200);
    expect((res.body as { people: Person[] }).people).toHaveLength(1);
  });

  it('returns multiple matches when several people share a surface', async () => {
    const { find } = makePeopleHandlers({
      resolveRepo: () => new StubRepo([emma, alex1, alex2]),
    });
    const res = await find(req({ query: { surface: 'Alex' } }));
    const body = res.body as { people: Person[] };
    expect(body.people.map((p) => p.canonicalName).sort()).toEqual(['Alex Garcia', 'Alex Lee']);
  });

  it('skips surfaces flagged as rejected', async () => {
    const { find } = makePeopleHandlers({
      resolveRepo: () => new StubRepo([rejected]),
    });
    const res = await find(req({ query: { surface: 'Emma' } }));
    expect((res.body as { people: Person[] }).people).toHaveLength(0);
  });

  it('returns an empty array when no surface matches', async () => {
    const { find } = makePeopleHandlers({ resolveRepo: () => new StubRepo([emma]) });
    const res = await find(req({ query: { surface: 'Nobody' } }));
    expect(res.status).toBe(200);
    expect((res.body as { people: Person[] }).people).toEqual([]);
  });
});

describe('POST /v1/people/apply-extraction — out-of-process subject linking', () => {
  it('links vault_item_subjects in the given persona for each resolved person', async () => {
    // A repo whose applyExtraction reports the resolved person_ids (the
    // real SQLite repo does this); the handler must then write the
    // structured recall edge into the named persona's vault.
    const repo = {
      applyExtraction: (): ApplyExtractionResponse => ({
        created: 1,
        updated: 0,
        conflicts: [],
        skipped: false,
        personIds: ['person-quixote'],
      }),
    } as unknown as PeopleRepository;

    const vault = new InMemoryVaultRepository();
    setVaultRepository('general', vault);
    try {
      const { applyExtraction } = makePeopleHandlers({ resolveRepo: () => repo });
      const body = {
        sourceItemId: 'item-quixote-pref',
        extractorVersion: 'v1',
        results: [],
        persona: 'general',
      };
      const res = await applyExtraction(
        req({
          method: 'POST',
          query: {},
          body,
          rawBody: new TextEncoder().encode(JSON.stringify(body)),
        }),
      );
      expect(res.status).toBe(200);
      // The subject edge was written into the persona vault.
      expect(getVaultRepository('general')?.getItemIdsForPersonSync('person-quixote')).toEqual([
        'item-quixote-pref',
      ]);
    } finally {
      setVaultRepository('general', null);
    }
  });
});
