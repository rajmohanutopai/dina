/**
 * People-store contract — parity-critical invariants any
 * implementation must honor to stay in lockstep with main Dina's Go
 * `SQLitePersonStore` (`core/internal/adapter/sqlite/person_store.go`).
 *
 * **What this is.** A reusable Jest suite. Call `runPersonStoreContract`
 * inside a `describe` block, hand it a harness that produces fresh
 * `PeopleRepository` instances, and the suite re-emits every parity
 * check. New implementations (a future Go importer, a Rust port, a
 * Swift mobile core) plug in the same way.
 *
 * **Why a contract suite vs scenario tests.** From the user's memory:
 * "contract tests over scenario tests — when simulator catches a bug
 * Jest missed, add the iterating contract/parity test, not just the
 * scenario fix." Each invariant pinned here closes a *class* of
 * divergence. If a Go reference change adds a new behavior, the
 * contract grows; every implementation re-runs and divergence is
 * visible immediately.
 *
 * **What's IN scope.**
 *   - Idempotency keying — `(sourceItemId, extractorVersion, fingerprint)`
 *     is the dedup tuple. Same fingerprint twice → `skipped: true`.
 *   - Fingerprint determinism — order of surfaces inside a link must
 *     not change the hash; surface-text changes must.
 *   - Person promotion — a high-confidence surface promotes a
 *     suggested person to confirmed (CASE rule, mirrors Go).
 *   - Surface upsert — `(personId, normalizedSurface)` is the natural
 *     key; existing rows update in place (no duplicates).
 *   - Role-phrase routing — confirmed `role_phrase` wins over a
 *     confirmed name match in `findOrAssignPersonId`. A single
 *     extraction with two role phrases owned by distinct people
 *     surfaces a conflict on the second one.
 *   - Confirmed-surface resolution — `resolveConfirmedSurfaces` uses
 *     `p.status != 'rejected'` (NOT `= 'confirmed'`); a manually-
 *     confirmed surface on a still-suggested person resolves.
 *   - Garbage-collect guard — a suggested person with any confirmed
 *     surface is spared (operator touched it).
 *   - Merge semantics — surfaces move to `keepId`; `mergeId` is
 *     tombstoned (status=rejected); merge-into-self is a no-op.
 *   - Lifecycle filtering — `listPeople` and `findByContactDid` hide
 *     rejected; `getPerson.surfaces` excludes rejected entries.
 *
 * **What's OUT of scope.** Defensive return-false branches for
 * unknown ids, explicit error-message wording, internal SQL quirks.
 * Those are implementation-specific and live in
 * `__tests__/people/repository.test.ts`. The contract is the wire
 * between implementations, not their internals.
 */

import { computeExtractionFingerprint, type PeopleRepository } from './repository';

import type {
  ExtractionPersonLink,
  ExtractionResult,
  ExtractionSurfaceEntry,
} from './domain';

/** Factory returning a fresh, empty repo for each test case. */
export interface PersonStoreContractHarness {
  /**
   * Build a fresh repo + return a cleanup hook (idempotent). The
   * suite calls `makeRepo` in `beforeEach` and `cleanup` in
   * `afterEach`, so every contract case starts from an empty graph.
   */
  makeRepo(): { repo: PeopleRepository; cleanup?: () => void };
}

/**
 * Run the parity contract against the supplied repo factory. Call
 * inside a top-level `describe` block:
 *
 *   describe('SQLitePeopleRepository — Go parity contract', () => {
 *     runPersonStoreContract({ makeRepo: () => buildSqliteRepo() });
 *   });
 */
export function runPersonStoreContract(harness: PersonStoreContractHarness): void {
  let repo: PeopleRepository;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    const result = harness.makeRepo();
    repo = result.repo;
    cleanup = result.cleanup;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  // ─── Idempotency + fingerprint ──────────────────────────────────────
  describe('idempotency contract', () => {
    it('PARITY: same (sourceItemId, extractorVersion, fingerprint) is skipped on re-apply', () => {
      const ext = makeExtraction('item-1', 'v1', [
        link('Sancho', [
          surface('Sancho', 'name', 'high'),
          surface('my brother', 'role_phrase', 'high'),
        ]),
      ]);
      const first = repo.applyExtraction(ext);
      const second = repo.applyExtraction(ext);
      expect(first.skipped).toBe(false);
      expect(second.skipped).toBe(true);
      expect(repo.listPeople()).toHaveLength(1);
    });

    it('PARITY: changing extractor_version forces a fresh apply (NOT skipped)', () => {
      const r1 = makeExtraction('item-1', 'v1', [
        link('Sancho', [surface('Sancho', 'name', 'high')]),
      ]);
      const r2 = makeExtraction('item-1', 'v2', [
        link('Sancho', [surface('Sancho', 'name', 'high')]),
      ]);
      repo.applyExtraction(r1);
      const second = repo.applyExtraction(r2);
      expect(second.skipped).toBe(false);
      // Same person — `findOrAssignPersonId` matches the confirmed
      // name, not a fresh insert.
      expect(repo.listPeople()).toHaveLength(1);
    });

    it('PARITY: fingerprint is order-independent across surfaces in a link', () => {
      const a = makeExtraction('i', 'v1', [
        link('X', [
          surface('X', 'name', 'high'),
          surface('Xx', 'nickname', 'medium'),
        ]),
      ]);
      const b = makeExtraction('i', 'v1', [
        link('X', [
          surface('Xx', 'nickname', 'medium'),
          surface('X', 'name', 'high'),
        ]),
      ]);
      expect(computeExtractionFingerprint(a)).toBe(computeExtractionFingerprint(b));
    });

    it('PARITY: fingerprint changes when any surface text changes', () => {
      const a = makeExtraction('i', 'v1', [
        link('X', [surface('X', 'name', 'high')]),
      ]);
      const b = makeExtraction('i', 'v1', [
        link('X', [surface('Xy', 'name', 'high')]),
      ]);
      expect(computeExtractionFingerprint(a)).not.toBe(computeExtractionFingerprint(b));
    });
  });

  // ─── Person promotion + surface upsert ──────────────────────────────
  describe('promotion + upsert contract', () => {
    it('PARITY: a single high-confidence surface promotes the person to confirmed', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Sancho', [surface('Sancho', 'name', 'high')]),
        ]),
      );
      const sancho = repo.listPeople()[0];
      expect(sancho.status).toBe('confirmed');
      expect(sancho.surfaces?.[0].status).toBe('confirmed');
    });

    it('PARITY: low/medium confidence keeps the person suggested', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Maybe', [surface('Maybe', 'name', 'medium')]),
        ]),
      );
      const m = repo.listPeople()[0];
      expect(m.status).toBe('suggested');
      expect(m.surfaces?.[0].status).toBe('suggested');
    });

    it('PARITY: same (personId, normalizedSurface) updates in place — no duplicate row', () => {
      // First apply — confirmed surface so the second apply can route
      // to the same person via the name match in findOrAssignPersonId.
      repo.applyExtraction(
        makeExtraction('item-1', 'v1', [
          link('Eve', [surface('Eve', 'name', 'high')]),
        ]),
      );
      // Second apply with a different sourceItemId — the surface
      // upsert lane must update the existing row's source stamps,
      // not insert.
      const second = repo.applyExtraction(
        makeExtraction('item-2', 'v2', [
          link('Eve', [surface('Eve', 'name', 'high')]),
        ]),
      );
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);
      const eve = repo.listPeople()[0];
      expect(eve.surfaces).toHaveLength(1);
      expect(eve.surfaces?.[0].sourceItemId).toBe('item-2');
      expect(eve.surfaces?.[0].extractorVersion).toBe('v2');
    });
  });

  // ─── Role-phrase routing + exclusivity ──────────────────────────────
  describe('role-phrase routing contract', () => {
    it('PARITY: confirmed role_phrase routes the next extraction to the existing person', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Carlos', [
            surface('Carlos', 'name', 'high'),
            surface('my brother', 'role_phrase', 'high'),
          ]),
        ]),
      );
      // A separate item under a different name surface but the same
      // role_phrase — the role_phrase wins and merges into Carlos.
      const second = repo.applyExtraction(
        makeExtraction('i2', 'v1', [
          link('Carlos Garcia', [
            surface('Carlos Garcia', 'name', 'high'),
            surface('my brother', 'role_phrase', 'high'),
          ]),
        ]),
      );
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);
      expect(repo.listPeople()).toHaveLength(1);
    });

    it('PARITY: a single extraction with two role phrases owned by distinct people flags the second as a conflict', () => {
      // Carlos owns "my brother", Dr Smith owns "my doctor".
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Carlos', [
            surface('Carlos', 'name', 'high'),
            surface('my brother', 'role_phrase', 'high'),
          ]),
        ]),
      );
      repo.applyExtraction(
        makeExtraction('i2', 'v1', [
          link('Dr Smith', [
            surface('Dr Smith', 'name', 'high'),
            surface('my doctor', 'role_phrase', 'high'),
          ]),
        ]),
      );
      // A confused link claims BOTH role phrases. Step 1 of
      // findOrAssignPersonId picks the first match (Carlos); the
      // second role_phrase ("my doctor") triggers a conflict.
      const third = repo.applyExtraction(
        makeExtraction('i3', 'v1', [
          link('Eve', [
            surface('Eve', 'name', 'high'),
            surface('my brother', 'role_phrase', 'high'),
            surface('my doctor', 'role_phrase', 'high'),
          ]),
        ]),
      );
      expect(third.conflicts).toContain('my doctor');
      // Dr Smith still owns "my doctor"; Carlos didn't steal it.
      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('my doctor')).toHaveLength(1);
      expect(map.get('my doctor')?.[0].personId).toBe(
        repo.listPeople().find((p) => p.canonicalName === 'Dr Smith')?.personId,
      );
    });
  });

  // ─── Confirmed-surface resolution ───────────────────────────────────
  describe('resolveConfirmedSurfaces contract', () => {
    it('PARITY: includes confirmed surfaces on a still-suggested person (manual surface promotion)', () => {
      // Person stays suggested (medium confidence) but operator
      // confirms one alias by hand. Go's query uses
      // `p.status != 'rejected'`, so the surface still resolves.
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Pending', [surface('Pending', 'name', 'medium')]),
        ]),
      );
      const person = repo.listPeople()[0];
      const surfaceId = person.surfaces?.[0].id;
      if (surfaceId === undefined) throw new Error('expected seeded surface');
      repo.confirmSurface(person.personId, surfaceId);
      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('pending')).toHaveLength(1);
      expect(map.get('pending')?.[0].personId).toBe(person.personId);
    });

    it('PARITY: hides surfaces whose owner is rejected', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Goneville', [surface('Goneville', 'name', 'high')]),
        ]),
      );
      const person = repo.listPeople()[0];
      repo.rejectPerson(person.personId);
      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('goneville')).toBeUndefined();
    });

    it('PARITY: hides suggested surfaces even when the owner is confirmed', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Mixed', [
            surface('Mixed', 'name', 'high'),
            surface('Mxd', 'nickname', 'medium'),
          ]),
        ]),
      );
      const map = repo.resolveConfirmedSurfaces();
      expect(map.get('mixed')).toHaveLength(1);
      expect(map.get('mxd')).toBeUndefined();
    });
  });

  // ─── garbageCollect guard ───────────────────────────────────────────
  //
  // GC is time-dependent. The harness only hands out repos using
  // their default clock (real `Date.now`), so we drive the cutoff
  // from the OTHER side: pass `garbageCollect(0, futureNow)` to make
  // every existing row look stale relative to a cutoff one hour
  // ahead. `maxAgeDays = 0` keeps the math simple (cutoff equals
  // futureNow/1000) and avoids implementations that build their own
  // injected clock from getting tripped up by harness mismatches.
  describe('garbageCollect contract', () => {
    /** Cutoff guaranteed to be after every row's `updated_at`. */
    const futureCutoff = (): number => Date.now() + 60 * 60 * 1000;

    it('PARITY: drops suggested + stale + zero-confirmed-surfaces people', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Stale', [surface('Stale', 'name', 'medium')]),
        ]),
      );
      const dropped = repo.garbageCollect(0, futureCutoff());
      expect(dropped).toBe(1);
      expect(repo.listPeople()).toEqual([]);
    });

    it('PARITY: spares confirmed people regardless of age', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Solid', [surface('Solid', 'name', 'high')]),
        ]),
      );
      expect(repo.garbageCollect(0, futureCutoff())).toBe(0);
      expect(repo.listPeople()).toHaveLength(1);
    });

    it('PARITY: spares suggested people whose surface was manually confirmed', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Touched', [surface('Touched', 'name', 'medium')]),
        ]),
      );
      const person = repo.listPeople()[0];
      const surfaceId = person.surfaces?.[0].id;
      if (surfaceId === undefined) throw new Error('expected seeded surface');
      expect(repo.confirmSurface(person.personId, surfaceId)).toBe(true);
      expect(repo.garbageCollect(0, futureCutoff())).toBe(0);
      expect(repo.listPeople()).toHaveLength(1);
    });
  });

  // ─── Merge semantics ────────────────────────────────────────────────
  describe('mergePeople contract', () => {
    it('PARITY: surfaces move to keepId; mergeId is rejected', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Alice', [surface('Alice', 'name', 'high')]),
        ]),
      );
      repo.applyExtraction(
        makeExtraction('i2', 'v1', [
          link('Ali', [surface('Ali', 'nickname', 'high')]),
        ]),
      );
      const all = repo.listPeople();
      const keep = all.find((p) => p.canonicalName === 'Alice');
      const drop = all.find((p) => p.canonicalName === 'Ali');
      if (!keep || !drop) throw new Error('expected both seeds');
      repo.mergePeople(keep.personId, drop.personId);
      // mergeId is rejected, so listPeople drops it.
      expect(repo.listPeople().map((p) => p.personId)).toEqual([keep.personId]);
      const merged = repo.getPerson(keep.personId);
      expect(merged?.surfaces?.map((s) => s.surface).sort()).toEqual(['Ali', 'Alice']);
    });

    it('PARITY: merge into self is a no-op', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Solo', [surface('Solo', 'name', 'high')]),
        ]),
      );
      const solo = repo.listPeople()[0];
      repo.mergePeople(solo.personId, solo.personId);
      expect(repo.listPeople()).toHaveLength(1);
    });
  });

  // ─── Lifecycle read filters ─────────────────────────────────────────
  describe('lifecycle filter contract', () => {
    it('PARITY: listPeople hides rejected', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Bye', [surface('Bye', 'name', 'high')]),
        ]),
      );
      const person = repo.listPeople()[0];
      repo.rejectPerson(person.personId);
      expect(repo.listPeople()).toEqual([]);
    });

    it('PARITY: findByContactDid hides rejected', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Mute', [surface('Mute', 'name', 'high')]),
        ]),
      );
      const person = repo.listPeople()[0];
      repo.linkContact(person.personId, 'did:plc:mute');
      repo.rejectPerson(person.personId);
      expect(repo.findByContactDid('did:plc:mute')).toBeNull();
    });

    it('PARITY: getPerson.surfaces excludes rejected entries', () => {
      repo.applyExtraction(
        makeExtraction('i1', 'v1', [
          link('Sancho', [
            surface('Sancho', 'name', 'high'),
            surface('Sanch', 'nickname', 'medium'),
          ]),
        ]),
      );
      const sancho = repo.listPeople()[0];
      const nickname = sancho.surfaces?.find((s) => s.surface === 'Sanch');
      if (nickname === undefined) throw new Error('expected nickname surface');
      repo.rejectSurface(sancho.personId, nickname.id);
      const reread = repo.getPerson(sancho.personId);
      expect(reread?.surfaces?.map((s) => s.surface)).toEqual(['Sancho']);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Helpers — kept terse so the contract reads scenario-first.
// ───────────────────────────────────────────────────────────────────────

function surface(
  text: string,
  type: ExtractionSurfaceEntry['surfaceType'],
  confidence: ExtractionSurfaceEntry['confidence'],
): ExtractionSurfaceEntry {
  return { surface: text, surfaceType: type, confidence };
}

function link(canonicalName: string, surfaces: ExtractionSurfaceEntry[]): ExtractionPersonLink {
  return { canonicalName, relationshipHint: '', sourceExcerpt: '', surfaces };
}

function makeExtraction(
  sourceItemId: string,
  extractorVersion: string,
  results: ExtractionPersonLink[],
): ExtractionResult {
  return { sourceItemId, extractorVersion, results };
}
