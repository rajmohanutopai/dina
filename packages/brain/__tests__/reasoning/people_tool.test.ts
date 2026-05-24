/**
 * `find_person` agent tool — unit tests covering the two backend
 * paths: (1) in-process repo (mobile / tests / no backend), (2) remote
 * `PeopleReadBackend` (home-node-lite, HTTP-routed via brain-server).
 */

import { createFindPersonTool } from '../../src/reasoning/people_tool';
import {
  setPeopleReadBackend,
} from '../../src/vault_context/assembly';
import { setPeopleRepository } from '@dina/core';
import type {
  ApplyExtractionResponse,
  ExtractionResult,
  Person,
  PersonSurface,
  PeopleRepository,
} from '@dina/core';

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
    sourceItemId: 'src-1',
    sourceExcerpt: 'in-context excerpt',
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
  findByContactDid(): Person | null {
    return null;
  }
  resolveByIdentity(): Person | null {
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
  surface('p-emma', 'Em', { sourceItemId: 'src-2' }),
]);

const alex1 = personFixture('p-alex-1', 'Alex Lee', 'colleague', [
  surface('p-alex-1', 'Alex', { sourceItemId: 'src-alex-1' }),
]);
const alex2 = personFixture('p-alex-2', 'Alex Garcia', 'cousin', [
  surface('p-alex-2', 'Alex', { sourceItemId: 'src-alex-2' }),
]);

describe('createFindPersonTool — in-process repo (mobile path)', () => {
  beforeEach(() => {
    setPeopleReadBackend(null);
  });
  afterEach(() => {
    setPeopleRepository(null);
  });

  it('rejects empty / blank name', async () => {
    setPeopleRepository(new StubRepo([emma]));
    const tool = createFindPersonTool();
    expect(await tool.execute({ name: '' })).toEqual({ error: 'name is required' });
    expect(await tool.execute({ name: '   ' })).toEqual({ error: 'name is required' });
  });

  it('returns empty matches when no repo is wired', async () => {
    setPeopleRepository(null);
    const tool = createFindPersonTool();
    expect(await tool.execute({ name: 'Emma' })).toEqual({ name: 'Emma', matches: [] });
  });

  it('returns the matched person with canonical name + relationship + surfaces', async () => {
    setPeopleRepository(new StubRepo([emma]));
    const tool = createFindPersonTool();
    const out = (await tool.execute({ name: 'emma' })) as {
      name: string;
      matches: Array<{
        canonicalName: string;
        relationshipHint: string;
        surfaces: Array<{ surface: string }>;
      }>;
    };
    expect(out.name).toBe('emma');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.canonicalName).toBe('Emma');
    expect(out.matches[0]?.relationshipHint).toBe('daughter');
    expect(out.matches[0]?.surfaces.map((s) => s.surface).sort()).toEqual(['Em', 'Emma']);
  });

  it('returns every match when surfaces collide across people', async () => {
    setPeopleRepository(new StubRepo([alex1, alex2]));
    const tool = createFindPersonTool();
    const out = (await tool.execute({ name: 'Alex' })) as {
      matches: Array<{ canonicalName: string }>;
    };
    expect(out.matches.map((m) => m.canonicalName).sort()).toEqual([
      'Alex Garcia',
      'Alex Lee',
    ]);
  });

  it('honours maxResults', async () => {
    setPeopleRepository(new StubRepo([alex1, alex2]));
    const tool = createFindPersonTool({ maxResults: 1 });
    const out = (await tool.execute({ name: 'Alex' })) as {
      matches: unknown[];
      truncated: boolean;
    };
    expect(out.matches).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });
});

describe('createFindPersonTool — remote backend (lite path)', () => {
  afterEach(() => {
    setPeopleReadBackend(null);
  });

  it('routes through the registered backend instead of the in-process repo', async () => {
    const calls: string[] = [];
    setPeopleReadBackend({
      peopleList: async () => [emma],
      peopleFindByName: async (name) => {
        calls.push(name);
        return [emma];
      },
    });
    // Repo would also match, but the remote backend takes precedence.
    setPeopleRepository(new StubRepo([]));
    const tool = createFindPersonTool();
    const out = (await tool.execute({ name: 'Emma' })) as {
      matches: Array<{ canonicalName: string }>;
    };
    expect(calls).toEqual(['Emma']);
    expect(out.matches[0]?.canonicalName).toBe('Emma');
  });
});
