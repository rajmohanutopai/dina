/**
 * `RepositoryPersonResolver` — covers the three high-level lookups
 * (resolveByDID / resolveBySurface / confirmedSurfacesMap) plus the
 * displayName fallback chain. Backed by the real SQLCipher harness so
 * the underlying repo queries (JOIN, normalize, status filtering)
 * are exercised end-to-end.
 */

import { RepositoryPersonResolver } from '../../src/people/resolver';

import { openPeopleHarness, type PeopleHarness } from './_harness';

import type { ExtractionPersonLink, ExtractionResult } from '../../src/people/domain';

function lc(canonicalName: string, surfaces: ExtractionPersonLink['surfaces']): ExtractionPersonLink {
  return { canonicalName, relationshipHint: '', sourceExcerpt: '', surfaces };
}

function ext(opts: { sourceItemId: string; results: ExtractionPersonLink[] }): ExtractionResult {
  return {
    sourceItemId: opts.sourceItemId,
    extractorVersion: 'v1',
    results: opts.results,
  };
}

describe('RepositoryPersonResolver', () => {
  let harness: PeopleHarness;
  let resolver: RepositoryPersonResolver;

  beforeEach(() => {
    harness = openPeopleHarness();
    resolver = new RepositoryPersonResolver(harness.repo);
  });

  afterEach(() => {
    harness.cleanup();
  });

  describe('resolveByDID', () => {
    it('returns null for the empty string', () => {
      expect(resolver.resolveByDID('')).toBeNull();
    });

    it('returns null for unknown DIDs', () => {
      expect(resolver.resolveByDID('did:plc:nobody')).toBeNull();
    });

    it('resolves a bound contact DID and returns confirmed surfaces only', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Sancho Garcia', [
              { surface: 'Sancho Garcia', surfaceType: 'name', confidence: 'high' },
              { surface: 'Sancho', surfaceType: 'nickname', confidence: 'high' },
              { surface: 'Sanch', surfaceType: 'nickname', confidence: 'medium' },
            ]),
          ],
        }),
      );
      const sancho = harness.repo.listPeople()[0];
      harness.repo.linkContact(sancho.personId, 'did:plc:sancho');

      const resolved = resolver.resolveByDID('did:plc:sancho');
      expect(resolved).not.toBeNull();
      expect(resolved?.canonicalName).toBe('Sancho Garcia');
      expect(resolved?.contactDid).toBe('did:plc:sancho');
      // Only confirmed surfaces (Sancho Garcia + Sancho); the
      // suggested "Sanch" alias must be filtered out.
      const surfaceForms = resolved?.surfaces.map((s) => s.surface).sort();
      expect(surfaceForms).toEqual(['Sancho', 'Sancho Garcia']);
    });

    it('returns null when the person is rejected even if the DID is bound', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [lc('Mute', [{ surface: 'Mute', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      const person = harness.repo.listPeople()[0];
      harness.repo.linkContact(person.personId, 'did:plc:mute');
      harness.repo.rejectPerson(person.personId);

      // findByContactDid filters status != 'rejected'; resolver inherits.
      expect(resolver.resolveByDID('did:plc:mute')).toBeNull();
    });
  });

  describe('resolveBySurface', () => {
    it('returns empty array for blank input', () => {
      expect(resolver.resolveBySurface('')).toEqual([]);
      expect(resolver.resolveBySurface('   ')).toEqual([]);
    });

    it('matches a confirmed surface case-insensitively', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Sancho', [
              { surface: 'Sancho', surfaceType: 'name', confidence: 'high' },
              { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
            ]),
          ],
        }),
      );
      const result = resolver.resolveBySurface('My Brother');
      expect(result).toHaveLength(1);
      expect(result[0].canonicalName).toBe('Sancho');
      expect(result[0].surfaces.some((s) => s.surface === 'my brother')).toBe(true);
    });

    it('returns multiple people sharing a normalized surface', () => {
      // Two unrelated people both named "Alex".
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Alex Reyes', [
              { surface: 'Alex Reyes', surfaceType: 'name', confidence: 'high' },
              { surface: 'Alex', surfaceType: 'nickname', confidence: 'high' },
            ]),
          ],
        }),
      );
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-2',
          results: [
            lc('Alex Wong', [
              { surface: 'Alex Wong', surfaceType: 'name', confidence: 'high' },
              { surface: 'Alex', surfaceType: 'nickname', confidence: 'high' },
            ]),
          ],
        }),
      );
      const result = resolver.resolveBySurface('Alex');
      expect(result.map((p) => p.canonicalName).sort()).toEqual([
        'Alex Reyes',
        'Alex Wong',
      ]);
    });

    it('skips suggested surfaces (only confirmed resolve)', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Maybe', [{ surface: 'Maybe', surfaceType: 'name', confidence: 'medium' }]),
          ],
        }),
      );
      // Surface is suggested → should NOT resolve.
      expect(resolver.resolveBySurface('Maybe')).toEqual([]);
    });

    it('returns the person when only the surface (not the person) was manually confirmed', () => {
      // Mirrors the parity behaviour: `resolveConfirmedSurfaces`
      // accepts surface-confirmed even on a still-suggested person.
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Pending', [
              { surface: 'Pending', surfaceType: 'name', confidence: 'medium' },
            ]),
          ],
        }),
      );
      const person = harness.repo.listPeople()[0];
      const surfaceId = person.surfaces?.[0].id;
      if (surfaceId === undefined) throw new Error('expected a seeded surface');
      harness.repo.confirmSurface(person.personId, surfaceId);

      const result = resolver.resolveBySurface('Pending');
      expect(result).toHaveLength(1);
      expect(result[0].personId).toBe(person.personId);
    });
  });

  describe('confirmedSurfacesMap', () => {
    it('returns the same map shape as the underlying repo', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Sancho', [
              { surface: 'Sancho', surfaceType: 'name', confidence: 'high' },
              { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
            ]),
          ],
        }),
      );
      const map = resolver.confirmedSurfacesMap();
      expect(map.get('sancho')).toHaveLength(1);
      expect(map.get('my brother')).toHaveLength(1);
    });
  });

  describe('displayName', () => {
    it('returns null for unknown ids and DIDs', () => {
      expect(resolver.displayName('')).toBeNull();
      expect(resolver.displayName('person-ghost')).toBeNull();
      expect(resolver.displayName('did:plc:ghost')).toBeNull();
    });

    it('uses canonical_name when set', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Sancho Garcia', [
              { surface: 'Sancho', surfaceType: 'name', confidence: 'high' },
            ]),
          ],
        }),
      );
      const person = harness.repo.listPeople()[0];
      expect(resolver.displayName(person.personId)).toBe('Sancho Garcia');
    });

    it('looks up by DID when given a did: prefix', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Alonso', [{ surface: 'Alonso', surfaceType: 'name', confidence: 'high' }]),
          ],
        }),
      );
      const person = harness.repo.listPeople()[0];
      harness.repo.linkContact(person.personId, 'did:plc:alonso');
      expect(resolver.displayName('did:plc:alonso')).toBe('Alonso');
    });

    it('falls back to a confirmed name surface when canonical_name is empty', () => {
      // Force a person with empty canonical_name by providing only a
      // role_phrase-style surface as the canonical source.
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            {
              canonicalName: '',
              relationshipHint: '',
              sourceExcerpt: '',
              surfaces: [
                { surface: 'Sanch', surfaceType: 'name', confidence: 'high' },
              ],
            },
          ],
        }),
      );
      const person = harness.repo.listPeople()[0];
      expect(resolver.displayName(person.personId)).toBe('Sanch');
    });

    it('falls back to a nickname when no name surface exists', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            {
              canonicalName: '',
              relationshipHint: '',
              sourceExcerpt: '',
              surfaces: [
                { surface: 'Sanch', surfaceType: 'nickname', confidence: 'high' },
              ],
            },
          ],
        }),
      );
      const person = harness.repo.listPeople()[0];
      expect(resolver.displayName(person.personId)).toBe('Sanch');
    });

    it('returns null when only suggested surfaces exist', () => {
      harness.repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            {
              canonicalName: '',
              relationshipHint: '',
              sourceExcerpt: '',
              surfaces: [
                { surface: 'whisper', surfaceType: 'name', confidence: 'medium' },
              ],
            },
          ],
        }),
      );
      const person = harness.repo.listPeople()[0];
      expect(resolver.displayName(person.personId)).toBeNull();
    });
  });
});
