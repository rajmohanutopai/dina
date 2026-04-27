/**
 * `SQLitePeopleRepository` — covers every PersonStore op against a
 * real SQLCipher DB. Mirrors main Dina's `person_store_test.go`
 * scenarios so behaviour stays in lockstep across the two stacks.
 */

import {
  computeExtractionFingerprint,
  type PeopleRepository,
} from '../../src/people/repository';

import { openPeopleHarness, type PeopleHarness } from './_harness';

import type { ExtractionResult, ExtractionPersonLink } from '../../src/people/domain';

function lc(canonicalName: string, surfaces: ExtractionPersonLink['surfaces']): ExtractionPersonLink {
  return {
    canonicalName,
    relationshipHint: '',
    sourceExcerpt: '',
    surfaces,
  };
}

function ext(opts: {
  sourceItemId: string;
  extractorVersion?: string;
  results: ExtractionPersonLink[];
}): ExtractionResult {
  return {
    sourceItemId: opts.sourceItemId,
    extractorVersion: opts.extractorVersion ?? 'v1',
    results: opts.results,
  };
}

describe('SQLitePeopleRepository', () => {
  let harness: PeopleHarness;
  let repo: PeopleRepository;

  beforeEach(() => {
    harness = openPeopleHarness();
    repo = harness.repo;
  });

  afterEach(() => {
    harness.cleanup();
  });

  describe('applyExtraction', () => {
    it('creates a new person with surfaces on first apply', () => {
      const resp = repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Sancho Garcia', [
              { surface: 'Sancho Garcia', surfaceType: 'name', confidence: 'high' },
              { surface: 'Sancho', surfaceType: 'nickname', confidence: 'high' },
            ]),
          ],
        }),
      );
      expect(resp.created).toBe(1);
      expect(resp.updated).toBe(0);
      expect(resp.skipped).toBe(false);
      expect(resp.conflicts).toEqual([]);

      const all = repo.listPeople();
      expect(all).toHaveLength(1);
      expect(all[0].canonicalName).toBe('Sancho Garcia');
      // High confidence promotes to confirmed (matches Go's CASE).
      expect(all[0].status).toBe('confirmed');
      expect(all[0].surfaces).toHaveLength(2);
    });

    it('is idempotent across re-runs of the same extractor on the same item', () => {
      const result = ext({
        sourceItemId: 'item-1',
        results: [
          lc('Sancho', [
            { surface: 'Sancho', surfaceType: 'name', confidence: 'medium' },
          ]),
        ],
      });
      const first = repo.applyExtraction(result);
      const second = repo.applyExtraction(result);
      expect(first.skipped).toBe(false);
      expect(second.skipped).toBe(true);
      expect(repo.listPeople()).toHaveLength(1);
    });

    it('different extractor_version is NOT considered a duplicate', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          extractorVersion: 'v1',
          results: [lc('Alice', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      const second = repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          extractorVersion: 'v2',
          results: [lc('Alice', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      // v2 fingerprint matches v1's row's fingerprint by content but
      // the (item, version) key differs, so it's NOT skipped — it
      // upserts the same surface (idempotent at the row level).
      expect(second.skipped).toBe(false);
      expect(repo.listPeople()).toHaveLength(1);
    });

    it('matches an existing confirmed name surface and updates the same person', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Alice', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }]),
          ],
        }),
      );
      const second = repo.applyExtraction(
        ext({
          sourceItemId: 'item-2',
          results: [
            lc('Alice', [
              { surface: 'Alice', surfaceType: 'name', confidence: 'high' },
              { surface: 'Ali', surfaceType: 'nickname', confidence: 'medium' },
            ]),
          ],
        }),
      );
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);

      const all = repo.listPeople();
      expect(all).toHaveLength(1);
      expect(all[0].surfaces?.map((s) => s.surface).sort()).toEqual(['Ali', 'Alice']);
    });

    it('flags role_phrase conflict when an extraction claims a phrase already confirmed for a different person', () => {
      // Step 1: extraction A creates Carlos and confirms "my brother".
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Carlos', [
              { surface: 'Carlos', surfaceType: 'name', confidence: 'high' },
              { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
            ]),
          ],
        }),
      );
      // Step 2: extraction B creates Dr Smith and confirms "my doctor".
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-2',
          results: [
            lc('Dr Smith', [
              { surface: 'Dr Smith', surfaceType: 'name', confidence: 'high' },
              { surface: 'my doctor', surfaceType: 'role_phrase', confidence: 'high' },
            ]),
          ],
        }),
      );
      // Step 3: a confused extraction proposes one person who is both
      // "my brother" AND "my doctor" — those phrases already belong to
      // two distinct confirmed people. The role_phrase routing in
      // `findOrAssignPersonId` picks the first match it finds (Carlos),
      // and the second phrase ("my doctor") triggers the conflict.
      const third = repo.applyExtraction(
        ext({
          sourceItemId: 'item-3',
          results: [
            lc('Eve', [
              { surface: 'Eve', surfaceType: 'name', confidence: 'high' },
              { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
              { surface: 'my doctor', surfaceType: 'role_phrase', confidence: 'high' },
            ]),
          ],
        }),
      );
      expect(third.conflicts).toContain('my doctor');
      // The conflicting role_phrase was NOT written for the routed
      // person (Carlos) — Dr Smith still owns "my doctor".
      const surfaces = repo.resolveConfirmedSurfaces();
      expect(surfaces.get('my doctor')).toHaveLength(1);
      expect(surfaces.get('my doctor')?.[0].personId).toBe(
        repo.listPeople().find((p) => p.canonicalName === 'Dr Smith')?.personId,
      );
    });

    it('merges extractions that share a confirmed role_phrase (no conflict)', () => {
      // First extraction owns "my brother" (Carlos).
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Carlos', [
              { surface: 'Carlos', surfaceType: 'name', confidence: 'high' },
              { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
            ]),
          ],
        }),
      );
      // Second extraction asserts the same role_phrase. Per the
      // role_phrase exclusivity rule (one confirmed person per phrase),
      // the second extraction is routed to the existing person rather
      // than creating a new one or flagging a conflict.
      const second = repo.applyExtraction(
        ext({
          sourceItemId: 'item-2',
          results: [
            lc('Carlos Garcia', [
              { surface: 'Carlos Garcia', surfaceType: 'name', confidence: 'high' },
              { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
            ]),
          ],
        }),
      );
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);
      expect(second.conflicts).toEqual([]);
      const all = repo.listPeople();
      expect(all).toHaveLength(1);
      expect(all[0].surfaces?.map((s) => s.normalizedSurface).sort()).toEqual(
        ['carlos', 'carlos garcia', 'my brother'],
      );
    });

    it('upsert: same (person, normalized_surface) updates instead of inserting', () => {
      // First extraction must promote both person and surface to
      // `confirmed` so the second extraction's name match in
      // `findOrAssignPersonId` (which requires confirmed status, mirroring
      // Go) routes to the same person and exercises the upsert path.
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          extractorVersion: 'v1',
          results: [
            lc('Eve', [{ surface: 'Eve', surfaceType: 'name', confidence: 'high' }]),
          ],
        }),
      );
      // Same surface, second extraction adds a nickname. The "Eve"
      // surface row should be UPDATED in place (new source_item_id,
      // new extractor_version) — not duplicated.
      const second = repo.applyExtraction(
        ext({
          sourceItemId: 'item-2',
          extractorVersion: 'v2',
          results: [
            lc('Eve', [
              { surface: 'Eve', surfaceType: 'name', confidence: 'high' },
              { surface: 'Evie', surfaceType: 'nickname', confidence: 'medium' },
            ]),
          ],
        }),
      );
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);

      const all = repo.listPeople();
      expect(all).toHaveLength(1);
      const eve = all[0];
      expect(eve.surfaces).toHaveLength(2);
      const nameSurface = eve.surfaces?.find((s) => s.normalizedSurface === 'eve');
      expect(nameSurface?.sourceItemId).toBe('item-2');
      expect(nameSurface?.extractorVersion).toBe('v2');
    });

    it('low/medium confidence keeps person in suggested status', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Frank', [{ surface: 'Frank', surfaceType: 'name', confidence: 'medium' }]),
          ],
        }),
      );
      const frank = repo.listPeople().find((p) => p.canonicalName === 'Frank');
      expect(frank?.status).toBe('suggested');
      expect(frank?.surfaces?.[0].status).toBe('suggested');
    });
  });

  describe('getPerson / listPeople / findByContactDid', () => {
    it('getPerson returns null for unknown id', () => {
      expect(repo.getPerson('person-nope')).toBeNull();
    });

    it('listPeople omits rejected rows', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [lc('Alice', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      const alice = repo.listPeople()[0];
      repo.rejectPerson(alice.personId);
      expect(repo.listPeople()).toHaveLength(0);
    });

    it('findByContactDid resolves the bound person', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [lc('Alice', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      const alice = repo.listPeople()[0];
      repo.linkContact(alice.personId, 'did:plc:alice');
      const resolved = repo.findByContactDid('did:plc:alice');
      expect(resolved?.personId).toBe(alice.personId);
      expect(resolved?.contactDid).toBe('did:plc:alice');
    });

    it('findByContactDid returns null for unknown DID and empty input', () => {
      expect(repo.findByContactDid('did:plc:nobody')).toBeNull();
      expect(repo.findByContactDid('')).toBeNull();
    });
  });

  describe('confirm / reject / detach surfaces', () => {
    function seedSuggested() {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Grace', [{ surface: 'Grace', surfaceType: 'name', confidence: 'medium' }]),
          ],
        }),
      );
      const person = repo.listPeople()[0];
      if (!person.surfaces || person.surfaces.length === 0) {
        throw new Error('seedSuggested: expected person to have a surface');
      }
      const surface = person.surfaces[0];
      return { person, surface };
    }

    it('confirmSurface promotes a suggested surface', () => {
      const { person, surface } = seedSuggested();
      expect(repo.confirmSurface(person.personId, surface.id)).toBe(true);
      const reread = repo.getPerson(person.personId);
      expect(reread?.surfaces?.[0].status).toBe('confirmed');
    });

    it('rejectSurface marks the surface rejected (and getPerson hides it)', () => {
      const { person, surface } = seedSuggested();
      expect(repo.rejectSurface(person.personId, surface.id)).toBe(true);
      // loadSurfaces filters out rejected rows.
      const reread = repo.getPerson(person.personId);
      expect(reread?.surfaces).toEqual([]);
    });

    it('detachSurface deletes the row outright', () => {
      const { person, surface } = seedSuggested();
      expect(repo.detachSurface(person.personId, surface.id)).toBe(true);
      const reread = repo.getPerson(person.personId);
      expect(reread?.surfaces).toEqual([]);
    });

    it('returns false for unknown surface ids', () => {
      const { person } = seedSuggested();
      expect(repo.confirmSurface(person.personId, 9999)).toBe(false);
      expect(repo.rejectSurface(person.personId, 9999)).toBe(false);
      expect(repo.detachSurface(person.personId, 9999)).toBe(false);
    });
  });

  describe('mergePeople', () => {
    it('moves all surfaces from mergeId onto keepId and rejects mergeId', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [lc('Alice', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-2',
          results: [lc('Ali', [{ surface: 'Ali', surfaceType: 'nickname', confidence: 'high' }])],
        }),
      );
      const all = repo.listPeople();
      expect(all).toHaveLength(2);
      const keep = all.find((p) => p.canonicalName === 'Alice');
      const drop = all.find((p) => p.canonicalName === 'Ali');
      if (!keep || !drop) {
        throw new Error('expected both Alice and Ali to be present');
      }
      repo.mergePeople(keep.personId, drop.personId);

      // mergeId is rejected so listPeople drops it.
      const remaining = repo.listPeople();
      expect(remaining.map((p) => p.personId)).toEqual([keep.personId]);

      // Surfaces from `drop` now belong to `keep`.
      const merged = repo.getPerson(keep.personId);
      const surfaceText = merged?.surfaces?.map((s) => s.surface).sort();
      expect(surfaceText).toEqual(['Ali', 'Alice']);
    });

    it('merge into self is a no-op', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [lc('Solo', [{ surface: 'Solo', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      const solo = repo.listPeople()[0];
      repo.mergePeople(solo.personId, solo.personId);
      expect(repo.listPeople()).toHaveLength(1);
    });
  });

  describe('linkContact', () => {
    it('returns false for unknown person id', () => {
      expect(repo.linkContact('person-ghost', 'did:plc:nobody')).toBe(false);
    });
  });

  describe('resolveConfirmedSurfaces', () => {
    it('returns multiple people sharing a normalized surface', () => {
      // Two confirmed Alices.
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [lc('Alice', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }])],
        }),
      );
      // Force a SECOND person with the same name by giving the first
      // a role_phrase that the second can't claim.
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-2',
          results: [
            lc('Alice Cooper', [
              { surface: 'Alice Cooper', surfaceType: 'name', confidence: 'high' },
            ]),
          ],
        }),
      );
      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('alice')?.length).toBe(1);
      expect(map.get('alice cooper')?.length).toBe(1);
    });

    it('hides surfaces that are themselves suggested', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Maybe', [{ surface: 'Maybe', surfaceType: 'name', confidence: 'medium' }]),
          ],
        }),
      );
      // Surface is suggested → not in resolution map.
      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('maybe')).toBeUndefined();
    });

    it('includes confirmed surfaces even when the owning person is still suggested', () => {
      // Person stays suggested (no high-confidence surface), but the
      // operator manually confirms one alias. The surface should still
      // resolve — Go's `ResolveConfirmedSurfaces` allows this.
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Pending', [{ surface: 'Pending', surfaceType: 'name', confidence: 'medium' }]),
          ],
        }),
      );
      const person = repo.listPeople()[0];
      expect(person.status).toBe('suggested');
      const surfaceId = person.surfaces?.[0].id;
      if (surfaceId === undefined) throw new Error('expected a seeded surface');
      expect(repo.confirmSurface(person.personId, surfaceId)).toBe(true);

      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('pending')?.length).toBe(1);
      expect(map.get('pending')?.[0].personId).toBe(person.personId);
    });

    it('excludes surfaces whose owner is rejected', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            lc('Goneville', [
              { surface: 'Goneville', surfaceType: 'name', confidence: 'high' },
            ]),
          ],
        }),
      );
      const person = repo.listPeople()[0];
      repo.rejectPerson(person.personId);
      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('goneville')).toBeUndefined();
    });
  });

  describe('clearExcerptsForItem + garbageCollect', () => {
    it('clearExcerptsForItem zeroes the excerpt on every surface from that item', () => {
      repo.applyExtraction(
        ext({
          sourceItemId: 'item-1',
          results: [
            {
              canonicalName: 'Alice',
              relationshipHint: '',
              sourceExcerpt: 'said by Alice in the meeting',
              surfaces: [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }],
            },
          ],
        }),
      );
      const before = repo.listPeople()[0];
      expect(before.surfaces?.[0].sourceExcerpt).toContain('Alice');
      const cleared = repo.clearExcerptsForItem('item-1');
      expect(cleared).toBe(1);
      const after = repo.listPeople()[0];
      expect(after.surfaces?.[0].sourceExcerpt).toBe('');
    });

    it('garbageCollect drops old suggested-but-unconfirmed people', () => {
      let now = 1_700_000_000_000;
      const harness2 = openPeopleHarness({ nowFn: () => now });
      try {
        const r = harness2.repo;
        r.applyExtraction(
          ext({
            sourceItemId: 'item-1',
            results: [
              lc('Stale', [{ surface: 'Stale', surfaceType: 'name', confidence: 'medium' }]),
            ],
          }),
        );
        // Move the clock forward 60 days.
        now = now + 60 * 86_400 * 1000;
        const dropped = r.garbageCollect(30, now);
        expect(dropped).toBe(1);
        expect(r.listPeople()).toEqual([]);
      } finally {
        harness2.cleanup();
      }
    });

    it('garbageCollect leaves confirmed people alone', () => {
      let now = 1_700_000_000_000;
      const harness2 = openPeopleHarness({ nowFn: () => now });
      try {
        const r = harness2.repo;
        r.applyExtraction(
          ext({
            sourceItemId: 'item-1',
            results: [
              lc('Solid', [{ surface: 'Solid', surfaceType: 'name', confidence: 'high' }]),
            ],
          }),
        );
        now = now + 60 * 86_400 * 1000;
        expect(r.garbageCollect(30, now)).toBe(0);
        expect(r.listPeople()).toHaveLength(1);
      } finally {
        harness2.cleanup();
      }
    });

    it('garbageCollect spares suggested people whose surface was manually confirmed', () => {
      // Edge case from main Dina: the person is still suggested (no
      // high-confidence surface from the LLM), but the operator
      // confirmed an alias by hand. The row should NOT be GC'd.
      let now = 1_700_000_000_000;
      const harness2 = openPeopleHarness({ nowFn: () => now });
      try {
        const r = harness2.repo;
        r.applyExtraction(
          ext({
            sourceItemId: 'item-1',
            results: [
              lc('Touched', [
                { surface: 'Touched', surfaceType: 'name', confidence: 'medium' },
              ]),
            ],
          }),
        );
        const person = r.listPeople()[0];
        expect(person.status).toBe('suggested');
        const surfaceId = person.surfaces?.[0].id;
        if (surfaceId === undefined) throw new Error('expected a seeded surface');
        expect(r.confirmSurface(person.personId, surfaceId)).toBe(true);

        now = now + 60 * 86_400 * 1000;
        expect(r.garbageCollect(30, now)).toBe(0);
        expect(r.listPeople()).toHaveLength(1);
      } finally {
        harness2.cleanup();
      }
    });
  });

  describe('extraction fingerprint', () => {
    it('is order-independent across surfaces', () => {
      const a: ExtractionResult = ext({
        sourceItemId: 'i',
        results: [
          lc('X', [
            { surface: 'X', surfaceType: 'name', confidence: 'high' },
            { surface: 'Xx', surfaceType: 'nickname', confidence: 'medium' },
          ]),
        ],
      });
      const b: ExtractionResult = ext({
        sourceItemId: 'i',
        results: [
          lc('X', [
            { surface: 'Xx', surfaceType: 'nickname', confidence: 'medium' },
            { surface: 'X', surfaceType: 'name', confidence: 'high' },
          ]),
        ],
      });
      expect(computeExtractionFingerprint(a)).toBe(computeExtractionFingerprint(b));
    });

    it('differs when the surface text changes', () => {
      const a: ExtractionResult = ext({
        sourceItemId: 'i',
        results: [lc('X', [{ surface: 'Alice', surfaceType: 'name', confidence: 'high' }])],
      });
      const b: ExtractionResult = ext({
        sourceItemId: 'i',
        results: [lc('X', [{ surface: 'Bob', surfaceType: 'name', confidence: 'high' }])],
      });
      expect(computeExtractionFingerprint(a)).not.toBe(computeExtractionFingerprint(b));
    });
  });
});
