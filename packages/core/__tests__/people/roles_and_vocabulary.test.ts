/**
 * REAL_LIFE_FIXES §5 — relationship words are roles, role reuse never
 * overwrites a name, renames reach the person, and "preferred for" matches
 * a role and its service.
 */

import { preferredForKey } from '../../src/contacts/preferred_for';
import { parseRelationshipPhrase } from '../../src/people/relationship_words';

import { openPeopleHarness, type PeopleHarness } from './_harness';

import type { ExtractionPersonLink, ExtractionResult } from '../../src/people/domain';

let n = 0;
function apply(h: PeopleHarness, canonicalName: string, surfaces: ExtractionPersonLink['surfaces']) {
  const result: ExtractionResult = {
    sourceItemId: `item-${++n}`,
    extractorVersion: 'v1',
    results: [{ canonicalName, relationshipHint: '', sourceExcerpt: '', surfaces }],
  };
  return h.repo.applyExtraction(result);
}
const name = (s: string) => ({ surface: s, surfaceType: 'name' as const, confidence: 'high' as const });
const role = (s: string) => ({ surface: s, surfaceType: 'role_phrase' as const, confidence: 'high' as const });

let h: PeopleHarness;
beforeEach(() => {
  h = openPeopleHarness();
});
afterEach(() => h.cleanup());

describe('relationship phrases', () => {
  it.each([
    ['my mom', { owner: 'self', role: 'mom', phrase: 'my mom' }],
    ['Our boss', { owner: 'self', role: 'boss', phrase: 'my boss' }],
    ['Mum', { owner: 'self', role: 'mum', phrase: 'my mum' }],
    ["Sancho's mother", { owner: 'Sancho', role: 'mother', phrase: "sancho's mother" }],
    ['Juno', null],
    ['my friend Juno', null],
    ["Emma's birthday", null],
  ])('%s', (text, expected) => {
    expect(parseRelationshipPhrase(text)).toEqual(expected);
  });
});

describe('roles, not people (§5.1)', () => {
  it('"Mom" as a name becomes a role-only person with no name', () => {
    apply(h, 'Mom', [name('Mom')]);
    const [p] = h.repo.listPeople();
    expect(p?.canonicalName).toBe('');
    expect(p?.surfaces?.map((s) => [s.surfaceType, s.normalizedSurface])).toEqual([['role_phrase', 'my mom']]);
  });

  it('a later real name fills in the same person', () => {
    apply(h, '', [role('my mom')]);
    apply(h, 'Maria', [name('Maria'), role('my mom')]);
    const people = h.repo.listPeople();
    expect(people).toHaveLength(1);
    expect(people[0]?.canonicalName).toBe('Maria');
  });

  it('two siblings introduced one after another stay two people', () => {
    apply(h, 'Tom', [name('Tom'), role('my brother')]);
    apply(h, 'Sam', [name('Sam'), role('my brother')]);
    expect(h.repo.listPeople().map((p) => p.canonicalName).sort()).toEqual(['Sam', 'Tom']);
  });

  it('a bare role held by two people creates no empty person', () => {
    apply(h, 'Tom', [name('Tom'), role('my brother')]);
    apply(h, 'Sam', [name('Sam'), role('my brother')]);
    apply(h, '', [role('my brother')]);
    expect(h.repo.listPeople()).toHaveLength(2);
  });

  it('a fuller name is the same person and is kept', () => {
    apply(h, 'Carlos Garcia', [name('Carlos Garcia'), role('my brother')]);
    apply(h, 'Carlos', [name('Carlos'), role('my brother')]);
    const people = h.repo.listPeople();
    expect(people).toHaveLength(1);
    expect(people[0]?.canonicalName).toBe('Carlos Garcia');
  });

  it('a person linked by role under a name is found by that name later', () => {
    apply(h, 'Emma', [role('my daughter')]);
    apply(h, 'Emma', [name('Emma')]);
    const people = h.repo.listPeople();
    expect(people).toHaveLength(1);
    expect(people[0]?.surfaces?.map((s) => s.normalizedSurface).sort()).toEqual(['emma', 'my daughter']);
  });

  it('the repair pass gives a named person its name as a surface', () => {
    h.adapter.execute(
      `INSERT INTO people (person_id, canonical_name, relationship_hint, status, created_from, created_at, updated_at, data_scope)
       VALUES ('p-named', 'Emma', 'daughter', 'confirmed', 'llm', 1, 1, 'user')`,
    );
    expect(h.repo.repairRelationshipNames()).toBe(1);
    expect(h.repo.listPeople().find((p) => p.personId === 'p-named')?.surfaces?.map((s) => s.normalizedSurface)).toEqual(['emma']);
    expect(h.repo.repairRelationshipNames()).toBe(0);
  });

  it("'my daughter' finds the one person introduced as the owner's daughter", () => {
    h.repo.applyExtraction({
      sourceItemId: `item-${++n}`,
      extractorVersion: 'v1',
      results: [{ canonicalName: 'Emma', relationshipHint: 'daughter', sourceExcerpt: '', surfaces: [name('Emma')] }],
    });
    apply(h, '', [role('my daughter')]);
    const people = h.repo.listPeople();
    expect(people).toHaveLength(1);
    expect(people[0]?.surfaces?.map((s) => s.normalizedSurface).sort()).toEqual(['emma', 'my daughter']);
  });

  it('two daughters: a bare "my daughter" picks neither', () => {
    for (const nm of ['Emma', 'Lily']) {
      h.repo.applyExtraction({
        sourceItemId: `item-${++n}`,
        extractorVersion: 'v1',
        results: [{ canonicalName: nm, relationshipHint: 'daughter', sourceExcerpt: '', surfaces: [name(nm)] }],
      });
    }
    apply(h, '', [role('my daughter')]);
    expect(h.repo.listPeople().filter((p) => p.surfaces?.some((s) => s.normalizedSurface === 'my daughter'))).toHaveLength(1);
    expect(h.repo.listPeople().find((p) => p.canonicalName === 'Emma')?.surfaces?.some((s) => s.normalizedSurface === 'my daughter')).toBe(false);
  });

  it("Sancho's mother is never the owner's mother", () => {
    h.repo.applyExtraction({
      sourceItemId: `item-${++n}`,
      extractorVersion: 'v1',
      results: [{ canonicalName: '', relationshipHint: 'mother', sourceExcerpt: '', surfaces: [role("Sancho's mother")] }],
    });
    apply(h, '', [role('my mother')]);
    expect(h.repo.listPeople()).toHaveLength(2);
  });

  it("'my mother' and 'Sancho's mother' stay apart", () => {
    apply(h, '', [role('my mother')]);
    apply(h, '', [role("Sancho's mother")]);
    expect(h.repo.listPeople()).toHaveLength(2);
  });

  it('the repair pass turns stored "Mom" people into role-only people', () => {
    // Simulate an old row written before the rule existed.
    h.adapter.execute(
      `INSERT INTO people (person_id, canonical_name, relationship_hint, status, created_from, created_at, updated_at, data_scope)
       VALUES ('p-old', 'Mom', '', 'confirmed', 'llm', 1, 1, 'user')`,
    );
    expect(h.repo.repairRelationshipNames()).toBe(1);
    expect(h.repo.listPeople().find((p) => p.personId === 'p-old')?.canonicalName).toBe('');
    expect(h.repo.repairRelationshipNames()).toBe(0);
  });
});

describe('preferred-for vocabulary (§5.3)', () => {
  it.each([
    ['plumber', 'plumbing'],
    ['plumbing', 'plumbing'],
    ['Plumbers', 'plumbing'],
    ['dentist', 'dental'],
    ['dentists', 'dental'],
    ['accounting', 'tax'],
    ['accountant', 'tax'],
    ['dog walker', 'dog_walker'],
  ])('%s → %s', (input, key) => {
    expect(preferredForKey(input)).toBe(key);
  });
});

describe('a contact rename reaches the person (§5.2)', () => {
  it('the new name and the old name both find the person; aliases too', async () => {
    const { setPeopleRepository } = await import('../../src/people/repository');
    const dir = await import('../../src/contacts/directory');
    setPeopleRepository(h.repo);
    dir.resetContactDirectory();
    try {
      dir.addContact('did:plc:sancho123', 'Sancho');
      dir.updateContact('did:plc:sancho123', { displayName: 'Sancho Panza' });
      const [p] = h.repo.listPeople();
      expect(p?.canonicalName).toBe('Sancho Panza');
      const surfaces = (p?.surfaces ?? []).map((s) => s.normalizedSurface);
      expect(surfaces).toEqual(expect.arrayContaining(['sancho panza', 'sancho']));

      dir.addAlias('did:plc:sancho123', 'Sanch');
      const withAlias = h.repo.listPeople()[0]?.surfaces?.map((s) => [s.surfaceType, s.normalizedSurface]);
      expect(withAlias).toEqual(expect.arrayContaining([['alias', 'sanch']]));
    } finally {
      dir.resetContactDirectory();
      setPeopleRepository(null);
    }
  });
});
