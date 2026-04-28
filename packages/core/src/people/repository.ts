/**
 * People-graph repository — port of
 * `core/internal/adapter/sqlite/person_store.go`. Backs the
 * `PersonStore` interface with SQLite via the shared `DatabaseAdapter`.
 *
 * Sync-by-design — same rationale as `ContactRepository`: thin wrapper
 * over op-sqlite (mobile) / better-sqlite3 (Node) which expose
 * synchronous JSI / FFI calls. Async would force callers to break the
 * "write-then-memory" invariant the contact directory pattern depends
 * on. Pinned in `port_async_gate.test.ts` EXEMPTED list.
 *
 * Behavioural parity with main Dina:
 *   - `applyExtraction` is idempotent per
 *     `(sourceItemId, extractorVersion, fingerprint)`.
 *   - Surface upsert semantics: `(personId, normalizedSurface)` is the
 *     natural key; existing rows update confidence + status + source,
 *     never duplicate.
 *   - Role-phrase exclusivity: a confirmed `role_phrase` may belong to
 *     at most one confirmed person; collisions are reported via
 *     `ApplyExtractionResponse.conflicts` (NOT written) so the UI can
 *     surface them for operator review.
 *   - Person promotion: any high-confidence surface promotes the
 *     person to `confirmed` for that extraction.
 *
 * Fingerprint algorithm matches the Go reference exactly: sort all
 * `<normalizedSurface>:<surfaceType>` pairs across the result, join
 * with `|`, SHA-256, take the first 8 bytes hex-encoded.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { normalizeAlias } from '../contacts/validation';

import {
  type ApplyExtractionResponse,
  type ExtractionResult,
  type Person,
  type PersonStatus,
  type PersonSurface,
  type SurfaceConfidence,
  type SurfaceStatus,
  PERSON_STATUS_CONFIRMED,
  PERSON_STATUS_REJECTED,
  PERSON_STATUS_SUGGESTED,
  SURFACE_STATUS_CONFIRMED,
  SURFACE_STATUS_REJECTED,
  SURFACE_STATUS_SUGGESTED,
} from './domain';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface PeopleRepository {
  applyExtraction(result: ExtractionResult): ApplyExtractionResponse;
  getPerson(personId: string): Person | null;
  listPeople(): Person[];
  /**
   * Lookup by linked contact DID — primary entry point for D2D
   * speaker resolution. Returns the confirmed person whose
   * `contact_did` matches, or null when no person is bound to that
   * DID. When multiple match (shouldn't happen, but the schema
   * doesn't enforce a unique constraint to allow merge windows),
   * returns the most recently updated.
   */
  findByContactDid(did: string): Person | null;
  confirmPerson(personId: string): boolean;
  rejectPerson(personId: string): boolean;
  confirmSurface(personId: string, surfaceId: number): boolean;
  rejectSurface(personId: string, surfaceId: number): boolean;
  detachSurface(personId: string, surfaceId: number): boolean;
  mergePeople(keepId: string, mergeId: string): void;
  deletePerson(personId: string): boolean;
  linkContact(personId: string, contactDid: string): boolean;
  /**
   * Upsert a person directly from a contact-directory entry —
   * `(did, displayName)` come from the People UI's "Add Contact"
   * form, not from an LLM. Creates a confirmed Person row bound to
   * the DID with `displayName` as a confirmed name surface, OR
   * reuses the existing person if one already carries that DID
   * (idempotent — adding the same contact twice doesn't duplicate).
   *
   * Why this lives next to `applyExtraction` rather than going
   * through it: `applyExtraction`'s LLM-shaped contract assigns a
   * random `person_id` and never touches `contact_did`, so a UI-
   * driven contact-add via that path would need a follow-up
   * `linkContact` and an out-of-band person-id lookup. This single
   * call captures the UI intent — "this exact DID is this exact
   * person" — without round-tripping through extraction semantics.
   *
   * Source item id used for the surface is `contact:<did>` so a
   * later `clearExcerptsForItem` for that synthetic id is safe and
   * doesn't collide with vault-item ids.
   *
   * Returns the personId of the upserted (or pre-existing) row.
   */
  upsertContactPerson(did: string, displayName: string): string;
  /**
   * Returns a map keyed by normalized surface. Multiple people may
   * share a normalized name (e.g. two confirmed contacts both named
   * "Alex"); the value is every confirmed surface that resolves to
   * that string.
   */
  resolveConfirmedSurfaces(): Map<string, PersonSurface[]>;
  clearExcerptsForItem(sourceItemId: string): number;
  /**
   * Drop suggested-but-unconfirmed people whose `updated_at` is older
   * than `maxAgeDays`. Used by a periodic sweeper. Returns the count
   * of garbage-collected rows.
   */
  garbageCollect(maxAgeDays: number, nowMs?: number): number;
}

let repo: PeopleRepository | null = null;
export function setPeopleRepository(r: PeopleRepository | null): void {
  repo = r;
}
export function getPeopleRepository(): PeopleRepository | null {
  return repo;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SQLitePeopleRepository implements PeopleRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly nowFn: () => number = Date.now,
  ) {}

  applyExtraction(result: ExtractionResult): ApplyExtractionResponse {
    const fingerprint = computeExtractionFingerprint(result);

    const exists = this.db.query(
      `SELECT 1 AS one FROM person_extraction_log
       WHERE source_item_id = ? AND extractor_version = ? AND fingerprint = ?
       LIMIT 1`,
      [result.sourceItemId, result.extractorVersion, fingerprint],
    );
    if (exists.length > 0) {
      return { created: 0, updated: 0, conflicts: [], skipped: true };
    }

    const response: ApplyExtractionResponse = {
      created: 0,
      updated: 0,
      conflicts: [],
      skipped: false,
    };
    const nowSec = Math.floor(this.nowFn() / 1000);

    this.db.transaction(() => {
      for (const link of result.results) {
        const personId = this.findOrAssignPersonId(link);
        const isNew = !this.personExists(personId);
        const personStatus = link.surfaces.some((s) => s.confidence === 'high')
          ? PERSON_STATUS_CONFIRMED
          : PERSON_STATUS_SUGGESTED;

        if (isNew) {
          this.db.execute(
            `INSERT INTO people (person_id, canonical_name, contact_did,
              relationship_hint, status, created_from, created_at, updated_at)
             VALUES (?, ?, '', ?, ?, 'llm', ?, ?)`,
            [personId, link.canonicalName, link.relationshipHint, personStatus, nowSec, nowSec],
          );
          response.created++;
        } else {
          // Coalesce non-empty fields onto the existing row; promote
          // status to confirmed when this extraction had a high
          // surface (mirrors the Go CASE logic).
          this.db.execute(
            `UPDATE people SET
               canonical_name = CASE WHEN ? = '' THEN canonical_name ELSE ? END,
               relationship_hint = CASE WHEN ? = '' THEN relationship_hint ELSE ? END,
               status = CASE WHEN ? = 'confirmed' THEN 'confirmed' ELSE status END,
               updated_at = ?
             WHERE person_id = ?`,
            [
              link.canonicalName,
              link.canonicalName,
              link.relationshipHint,
              link.relationshipHint,
              personStatus,
              nowSec,
              personId,
            ],
          );
          response.updated++;
        }

        for (const entry of link.surfaces) {
          const norm = normalizeAlias(entry.surface);
          const surfaceStatus: SurfaceStatus =
            entry.confidence === 'high' ? SURFACE_STATUS_CONFIRMED : SURFACE_STATUS_SUGGESTED;

          // Role-phrase exclusivity check — different confirmed person
          // already owns this phrase. Skip the surface; report the
          // conflict for operator review.
          if (entry.surfaceType === 'role_phrase') {
            const conflict = this.db.query(
              `SELECT person_id FROM person_surfaces
               WHERE normalized_surface = ?
                 AND surface_type = 'role_phrase'
                 AND status = 'confirmed'
                 AND person_id != ?
               LIMIT 1`,
              [norm, personId],
            );
            if (conflict.length > 0) {
              response.conflicts.push(entry.surface);
              continue;
            }
          }

          this.upsertSurface({
            personId,
            surface: entry.surface,
            normalizedSurface: norm,
            surfaceType: entry.surfaceType,
            status: surfaceStatus,
            confidence: entry.confidence,
            sourceItemId: result.sourceItemId,
            sourceExcerpt: link.sourceExcerpt,
            extractorVersion: result.extractorVersion,
            nowSec,
          });
        }
      }

      this.db.execute(
        `INSERT OR IGNORE INTO person_extraction_log
           (source_item_id, extractor_version, fingerprint, applied_at)
         VALUES (?, ?, ?, ?)`,
        [result.sourceItemId, result.extractorVersion, fingerprint, nowSec],
      );
    });

    return response;
  }

  getPerson(personId: string): Person | null {
    const rows = this.db.query(
      `SELECT person_id, canonical_name, contact_did, relationship_hint,
              status, created_from, created_at, updated_at
       FROM people WHERE person_id = ? LIMIT 1`,
      [personId],
    );
    if (rows.length === 0) return null;
    const person = rowToPerson(rows[0]);
    person.surfaces = this.loadSurfaces(personId);
    return person;
  }

  listPeople(): Person[] {
    const rows = this.db.query(
      `SELECT person_id, canonical_name, contact_did, relationship_hint,
              status, created_from, created_at, updated_at
       FROM people WHERE status != 'rejected'
       ORDER BY updated_at DESC`,
    );
    return rows.map((row) => {
      const person = rowToPerson(row);
      person.surfaces = this.loadSurfaces(person.personId);
      return person;
    });
  }

  findByContactDid(did: string): Person | null {
    if (did === '') return null;
    const rows = this.db.query(
      `SELECT person_id, canonical_name, contact_did, relationship_hint,
              status, created_from, created_at, updated_at
       FROM people
       WHERE contact_did = ? AND status != 'rejected'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [did],
    );
    if (rows.length === 0) return null;
    const person = rowToPerson(rows[0]);
    person.surfaces = this.loadSurfaces(person.personId);
    return person;
  }

  confirmPerson(personId: string): boolean {
    return this.updatePersonStatus(personId, PERSON_STATUS_CONFIRMED);
  }

  rejectPerson(personId: string): boolean {
    const nowSec = Math.floor(this.nowFn() / 1000);
    let changed = false;
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE person_surfaces SET status = 'rejected', updated_at = ?
         WHERE person_id = ?`,
        [nowSec, personId],
      );
      changed = this.updatePersonStatus(personId, PERSON_STATUS_REJECTED);
    });
    return changed;
  }

  confirmSurface(personId: string, surfaceId: number): boolean {
    return this.updateSurfaceStatus(personId, surfaceId, SURFACE_STATUS_CONFIRMED);
  }

  rejectSurface(personId: string, surfaceId: number): boolean {
    return this.updateSurfaceStatus(personId, surfaceId, SURFACE_STATUS_REJECTED);
  }

  detachSurface(personId: string, surfaceId: number): boolean {
    const before = this.db.query(
      `SELECT 1 AS one FROM person_surfaces WHERE id = ? AND person_id = ? LIMIT 1`,
      [surfaceId, personId],
    );
    if (before.length === 0) return false;
    this.db.execute(
      `DELETE FROM person_surfaces WHERE id = ? AND person_id = ?`,
      [surfaceId, personId],
    );
    return true;
  }

  mergePeople(keepId: string, mergeId: string): void {
    if (keepId === mergeId) return;
    const nowSec = Math.floor(this.nowFn() / 1000);
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE person_surfaces SET person_id = ?, updated_at = ?
         WHERE person_id = ?`,
        [keepId, nowSec, mergeId],
      );
      this.db.execute(
        `UPDATE people SET status = 'rejected', updated_at = ?
         WHERE person_id = ?`,
        [nowSec, mergeId],
      );
    });
  }

  deletePerson(personId: string): boolean {
    return this.rejectPerson(personId);
  }

  linkContact(personId: string, contactDid: string): boolean {
    const nowSec = Math.floor(this.nowFn() / 1000);
    const before = this.db.query(
      `SELECT 1 AS one FROM people WHERE person_id = ? LIMIT 1`,
      [personId],
    );
    if (before.length === 0) return false;
    this.db.execute(
      `UPDATE people SET contact_did = ?, updated_at = ? WHERE person_id = ?`,
      [contactDid, nowSec, personId],
    );
    return true;
  }

  upsertContactPerson(did: string, displayName: string): string {
    if (did === '') throw new Error('upsertContactPerson: did is required');
    const trimmedName = displayName.trim();
    if (trimmedName === '') {
      throw new Error('upsertContactPerson: displayName is required');
    }
    const nowSec = Math.floor(this.nowFn() / 1000);
    const norm = normalizeAlias(trimmedName);

    let personId = '';
    this.db.transaction(() => {
      // 1. Reuse an existing row already bound to this DID (the
      //    typical "edit display name" case + the idempotent "add
      //    same contact twice" case both land here).
      const existing = this.db.query(
        `SELECT person_id FROM people
         WHERE contact_did = ? AND status != 'rejected'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [did],
      );
      if (existing.length > 0 && typeof existing[0].person_id === 'string') {
        personId = existing[0].person_id;
        // Refresh canonical_name + status; user-driven edits should
        // win over a stale row. Status flips to confirmed if the
        // person was previously suggested (an LLM-extracted match
        // the user just promoted by saving as a contact).
        this.db.execute(
          `UPDATE people SET
             canonical_name = ?,
             status = 'confirmed',
             created_from = CASE WHEN created_from = 'llm' THEN 'user' ELSE created_from END,
             updated_at = ?
           WHERE person_id = ?`,
          [trimmedName, nowSec, personId],
        );
      } else {
        // 2. Otherwise, create a new confirmed person bound to the
        //    DID. We do NOT try to reuse an LLM-suggested person
        //    that happens to share the canonical name — auto-merging
        //    on a name collision is risky and the dedicated
        //    `mergePeople` API exists for that.
        personId = newPersonId();
        this.db.execute(
          `INSERT INTO people (person_id, canonical_name, contact_did,
            relationship_hint, status, created_from, created_at, updated_at)
           VALUES (?, ?, ?, '', 'confirmed', 'user', ?, ?)`,
          [personId, trimmedName, did, nowSec, nowSec],
        );
      }

      // 3. Confirmed name surface — the reminder planner expands
      //    inbound D2D FTS queries with every confirmed surface, so
      //    notes saved against the contact's display name surface
      //    even when the message body never says the name.
      this.upsertSurface({
        personId,
        surface: trimmedName,
        normalizedSurface: norm,
        surfaceType: 'name',
        status: SURFACE_STATUS_CONFIRMED,
        confidence: 'high',
        sourceItemId: `contact:${did}`,
        sourceExcerpt: '',
        extractorVersion: 'contact-directory',
        nowSec,
      });
    });

    return personId;
  }

  resolveConfirmedSurfaces(): Map<string, PersonSurface[]> {
    // Mirrors Go: surfaces resolve when the surface itself is confirmed
    // and the owning person isn't rejected. Suggested people whose
    // surface was manually promoted (e.g. via `confirmSurface`) still
    // participate in resolution — they're real, just not yet promoted
    // at the person level.
    const rows = this.db.query(
      `SELECT ps.id, ps.person_id, ps.surface, ps.normalized_surface,
              ps.surface_type, ps.status, ps.confidence,
              ps.source_item_id, ps.source_excerpt, ps.extractor_version,
              ps.created_from, ps.created_at, ps.updated_at
       FROM person_surfaces ps
       JOIN people p ON ps.person_id = p.person_id
       WHERE ps.status = 'confirmed' AND p.status != 'rejected'`,
    );
    const out = new Map<string, PersonSurface[]>();
    for (const row of rows) {
      const surface = rowToSurface(row);
      const existing = out.get(surface.normalizedSurface);
      if (existing !== undefined) {
        existing.push(surface);
      } else {
        out.set(surface.normalizedSurface, [surface]);
      }
    }
    return out;
  }

  clearExcerptsForItem(sourceItemId: string): number {
    const nowSec = Math.floor(this.nowFn() / 1000);
    const before = this.db.query(
      `SELECT COUNT(*) AS n FROM person_surfaces WHERE source_item_id = ?`,
      [sourceItemId],
    );
    const count = (before[0]?.n as number | undefined) ?? 0;
    this.db.execute(
      `UPDATE person_surfaces
       SET source_excerpt = '', updated_at = ?
       WHERE source_item_id = ?`,
      [nowSec, sourceItemId],
    );
    return count;
  }

  garbageCollect(maxAgeDays: number, nowMs?: number): number {
    // Mirrors Go: drop only suggested people that are stale AND have no
    // confirmed surfaces. Confirmed surfaces are a sign the operator
    // touched the row — promoting an alias even on an unpromoted person
    // — so we leave them alone.
    const cutoffSec = Math.floor((nowMs ?? this.nowFn()) / 1000) - maxAgeDays * 86_400;
    const before = this.db.query(
      `SELECT person_id FROM people
       WHERE status = 'suggested' AND updated_at < ?
         AND person_id NOT IN (
           SELECT DISTINCT person_id FROM person_surfaces WHERE status = 'confirmed'
         )`,
      [cutoffSec],
    );
    const ids = before.map((r) => String(r.person_id));
    if (ids.length === 0) return 0;
    const nowSec = Math.floor(this.nowFn() / 1000);
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.execute(
          `UPDATE person_surfaces SET status = 'rejected', updated_at = ?
           WHERE person_id = ?`,
          [nowSec, id],
        );
        this.db.execute(
          `UPDATE people SET status = 'rejected', updated_at = ? WHERE person_id = ?`,
          [nowSec, id],
        );
      }
    });
    return ids.length;
  }

  // -------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------

  private findOrAssignPersonId(link: ExtractionResult['results'][number]): string {
    // (1) Match by confirmed role_phrase first — the strongest signal
    // that this person already exists ("my brother" → exactly one).
    for (const entry of link.surfaces) {
      if (entry.surfaceType !== 'role_phrase') continue;
      const norm = normalizeAlias(entry.surface);
      const rows = this.db.query(
        `SELECT person_id FROM person_surfaces
         WHERE normalized_surface = ?
           AND surface_type = 'role_phrase'
           AND status = 'confirmed'
         LIMIT 1`,
        [norm],
      );
      if (rows.length > 0 && typeof rows[0].person_id === 'string') {
        return rows[0].person_id;
      }
    }

    // (2) Fall back to a confirmed name match across confirmed people.
    if (link.canonicalName !== '') {
      const norm = normalizeAlias(link.canonicalName);
      const rows = this.db.query(
        `SELECT ps.person_id FROM person_surfaces ps
         JOIN people p ON ps.person_id = p.person_id
         WHERE ps.normalized_surface = ?
           AND ps.surface_type = 'name'
           AND ps.status = 'confirmed'
           AND p.status = 'confirmed'
         LIMIT 1`,
        [norm],
      );
      if (rows.length > 0 && typeof rows[0].person_id === 'string') {
        return rows[0].person_id;
      }
    }

    // (3) New person.
    return newPersonId();
  }

  private personExists(personId: string): boolean {
    const rows = this.db.query(
      `SELECT 1 AS one FROM people WHERE person_id = ? LIMIT 1`,
      [personId],
    );
    return rows.length > 0;
  }

  private upsertSurface(args: {
    personId: string;
    surface: string;
    normalizedSurface: string;
    surfaceType: string;
    status: SurfaceStatus;
    confidence: SurfaceConfidence;
    sourceItemId: string;
    sourceExcerpt: string;
    extractorVersion: string;
    nowSec: number;
  }): void {
    const existing = this.db.query(
      `SELECT id FROM person_surfaces
       WHERE person_id = ? AND normalized_surface = ?
       LIMIT 1`,
      [args.personId, args.normalizedSurface],
    );
    if (existing.length > 0) {
      const id = existing[0].id as number;
      this.db.execute(
        `UPDATE person_surfaces SET
           confidence = ?,
           status = CASE WHEN ? = 'confirmed' THEN 'confirmed' ELSE status END,
           source_item_id = ?,
           source_excerpt = ?,
           extractor_version = ?,
           updated_at = ?
         WHERE id = ?`,
        [
          args.confidence,
          args.status,
          args.sourceItemId,
          args.sourceExcerpt,
          args.extractorVersion,
          args.nowSec,
          id,
        ],
      );
      return;
    }
    this.db.execute(
      `INSERT INTO person_surfaces
         (person_id, surface, normalized_surface, surface_type,
          status, confidence, source_item_id, source_excerpt,
          extractor_version, created_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm', ?, ?)`,
      [
        args.personId,
        args.surface,
        args.normalizedSurface,
        args.surfaceType,
        args.status,
        args.confidence,
        args.sourceItemId,
        args.sourceExcerpt,
        args.extractorVersion,
        args.nowSec,
        args.nowSec,
      ],
    );
  }

  private loadSurfaces(personId: string): PersonSurface[] {
    // ORDER BY created_at matches the Go reference's `loadSurfaces`
    // (`person_store.go:412`); `id` is a secondary tiebreaker for the
    // edge case where two surfaces in the same transaction share the
    // same epoch second.
    const rows = this.db.query(
      `SELECT id, person_id, surface, normalized_surface, surface_type,
              status, confidence, source_item_id, source_excerpt,
              extractor_version, created_from, created_at, updated_at
       FROM person_surfaces
       WHERE person_id = ? AND status != 'rejected'
       ORDER BY created_at ASC, id ASC`,
      [personId],
    );
    return rows.map(rowToSurface);
  }

  private updatePersonStatus(personId: string, status: PersonStatus): boolean {
    const nowSec = Math.floor(this.nowFn() / 1000);
    const before = this.db.query(
      `SELECT 1 AS one FROM people WHERE person_id = ? LIMIT 1`,
      [personId],
    );
    if (before.length === 0) return false;
    this.db.execute(
      `UPDATE people SET status = ?, updated_at = ? WHERE person_id = ?`,
      [status, nowSec, personId],
    );
    return true;
  }

  private updateSurfaceStatus(
    personId: string,
    surfaceId: number,
    status: SurfaceStatus,
  ): boolean {
    const nowSec = Math.floor(this.nowFn() / 1000);
    const before = this.db.query(
      `SELECT 1 AS one FROM person_surfaces WHERE id = ? AND person_id = ? LIMIT 1`,
      [surfaceId, personId],
    );
    if (before.length === 0) return false;
    this.db.execute(
      `UPDATE person_surfaces SET status = ?, updated_at = ?
       WHERE id = ? AND person_id = ?`,
      [status, nowSec, surfaceId, personId],
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPerson(row: DBRow): Person {
  return {
    personId: String(row.person_id ?? ''),
    canonicalName: String(row.canonical_name ?? ''),
    contactDid: String(row.contact_did ?? ''),
    relationshipHint: String(row.relationship_hint ?? ''),
    status: String(row.status ?? PERSON_STATUS_SUGGESTED) as PersonStatus,
    createdFrom: String(row.created_from ?? 'llm') as Person['createdFrom'],
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function rowToSurface(row: DBRow): PersonSurface {
  return {
    id: Number(row.id ?? 0),
    personId: String(row.person_id ?? ''),
    surface: String(row.surface ?? ''),
    normalizedSurface: String(row.normalized_surface ?? ''),
    surfaceType: String(row.surface_type ?? 'name') as PersonSurface['surfaceType'],
    status: String(row.status ?? SURFACE_STATUS_SUGGESTED) as SurfaceStatus,
    confidence: String(row.confidence ?? 'medium') as SurfaceConfidence,
    sourceItemId: String(row.source_item_id ?? ''),
    sourceExcerpt: String(row.source_excerpt ?? ''),
    extractorVersion: String(row.extractor_version ?? ''),
    createdFrom: String(row.created_from ?? 'llm') as Person['createdFrom'],
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * Generate a fresh person id. 16-byte random hex (128 bits) prefixed
 * with `person-` so the id is grep-able in logs and audit trails.
 * Uses the same `@noble/hashes/utils` random bytes the rest of the
 * codebase prefers.
 */
function newPersonId(): string {
  return `person-${bytesToHex(randomBytes(16))}`;
}

/**
 * Idempotency fingerprint — same algorithm as Go's
 * `extractionFingerprint`. Sorts `<normalizedSurface>:<surfaceType>`
 * pairs across all results, joins with `|`, SHA-256s, takes first 8
 * bytes hex-encoded. Stable across machines and across re-runs.
 */
export function computeExtractionFingerprint(result: ExtractionResult): string {
  const parts: string[] = [];
  for (const link of result.results) {
    for (const entry of link.surfaces) {
      parts.push(`${normalizeAlias(entry.surface)}:${entry.surfaceType}`);
    }
  }
  parts.sort();
  const digest = sha256(new TextEncoder().encode(parts.join('|')));
  return bytesToHex(digest.subarray(0, 8));
}
