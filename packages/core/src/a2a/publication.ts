/**
 * The node's one directory publication (design §8.2, M5): the durable state
 * the card publisher reads and writes, kept in `a2a_card_publication`.
 *
 * Core owns the state and its rules; the publisher (a trusted host process,
 * never Brain) owns the PDS and drives the steps. Every change here is a
 * guarded update, so a step that lost its race (a late completion, a
 * deactivation or stand-down in between, a newer projection) writes
 * nothing.
 *
 * Three fields decide whether the node may publish at all:
 *   - `listing_enabled`, the owner's switch (off by default; per-listing
 *     `isDiscoverable` never implies it);
 *   - `publication_active`, set only by the owner's activation, which
 *     claims a publisher epoch strictly greater than any seen in the
 *     repository's fence; a node with no row (fresh, or restored from an
 *     archive, which carries no A2A table) starts inactive;
 *   - `state`: `stood_down` (another server claimed a greater epoch) and
 *     `deactivating` (two-phase deactivation, whose one authority is the
 *     fence-bound delete of the card) never publish.
 * `fencing_generation` moves at every activation, deactivation and
 * stand-down, and every attempt binds it, so an attempt begun before one of
 * those can never land after it.
 *
 * `card_maybe_present` is the durable unpublish intent (§8.2): whether the
 * repository may hold a card this node answers for, judged by evidence,
 * never by what this node remembers publishing. A publish claim sets it (the
 * write may land though its answer never arrives), and so does every
 * activation (a handoff leaves the previous holder's card under this node's
 * fence). Only evidence clears it: a delete that landed, or a read under
 * this node's fence that found no card. While the predicate is false and it
 * is set, the publisher deletes.
 *
 * `fence_key_id` and `published_key_id` (with `published_publisher_epoch`)
 * say what the fence and the published envelope were signed under. A
 * rotated `dina_signing` key, or a new epoch after re-activation, no longer
 * matches, and the publisher re-signs the fence and republishes at once
 * (§8.2 trigger c), with no need to read the repository to notice.
 */

import { isPlainObject } from '@dina/a2a';

import type { A2AStore } from './store';

export type PublicationState = 'pending' | 'published' | 'failed' | 'not_published' | 'stood_down' | 'deactivating';

export interface PublicationRow {
  listing_enabled: number;
  publication_active: number;
  card_projection_revision: number;
  desired_card_hash: string | null;
  freshness_epoch: number;
  publisher_epoch: number;
  publisher_instance: string;
  fencing_generation: number;
  /** The `dina_signing` key (hex public key) the fence was last written under. */
  fence_key_id: string | null;
  state: PublicationState;
  card_maybe_present: number;
  attempt_tuple_json: string | null;
  attempt_expected_cid: string | null;
  attempt_expected_repo_commit_cid: string | null;
  published_revision: number | null;
  last_published_uri: string | null;
  last_published_cid: string | null;
  last_published_card_hash: string | null;
  last_published_at: number | null;
  /** The publisher epoch and signing key the published envelope carries. */
  published_publisher_epoch: number | null;
  published_key_id: string | null;
  attempts: number;
  next_retry_at: number | null;
  /** The operation whose failure set `next_retry_at`; the wait holds back only it (null: both). */
  retry_operation: 'publish' | 'unpublish' | null;
  notice: string | null;
  updated_at: number;
}

/** How often a healthy publisher refreshes its envelope, so its record is a real new commit (design §8.2). */
export const DIRECTORY_FRESHNESS_CADENCE_MS = 14 * 24 * 60 * 60 * 1000;

/** The publication, or null when the node has never had one. */
export function readPublication(store: A2AStore): PublicationRow | null {
  const rows = store.db.query('SELECT * FROM a2a_card_publication WHERE id = 1');
  return (rows[0] as unknown as PublicationRow | undefined) ?? null;
}

/**
 * The publication, made if missing: switched off, inactive, under a fresh
 * random publisher instance (a UUID, as the envelope and fence require).
 */
export function ensurePublication(store: A2AStore, nowMs: number, newInstance: () => string): PublicationRow {
  store.db.execute(
    `INSERT OR IGNORE INTO a2a_card_publication (id, publisher_instance, updated_at) VALUES (1, ?, ?)`,
    [newInstance(), nowMs],
  );
  const row = readPublication(store);
  if (row === null) throw new Error('a2a: the publication row could not be made');
  return row;
}

/**
 * The owner's switch (`POST /v1/owner/a2a/directory-listing`). The
 * projection moves, so the publisher acts; turned off, it deletes whatever
 * card the repository may hold (`card_maybe_present`), which survives a
 * restart until the evidence clears it. A fresh instruction from the owner,
 * so any backoff from an earlier failure is dropped.
 */
export function setDirectoryListing(store: A2AStore, enabled: boolean, nowMs: number, newInstance: () => string): PublicationRow {
  return store.transaction(() => {
    ensurePublication(store, nowMs, newInstance);
    store.db.execute(
      `UPDATE a2a_card_publication
          SET listing_enabled = ?, card_projection_revision = card_projection_revision + 1,
              attempts = 0, next_retry_at = NULL, retry_operation = NULL, updated_at = ?
        WHERE id = 1`,
      [enabled ? 1 : 0, nowMs],
    );
    const row = readPublication(store);
    if (row === null) throw new Error('a2a: the publication row vanished');
    return row;
  });
}

/** What, besides the row, decides whether the card may be published. */
export interface PublicationInputs {
  /** The gateway is configured: the card has a public origin to name. */
  gatewayLive: boolean;
  /** Skills the public card would carry. */
  projectableSkills: number;
}

/** The normative publication predicate (design §8.2): every condition, or no publication. */
export function publicationEligible(row: PublicationRow, inputs: PublicationInputs): boolean {
  return (
    row.listing_enabled === 1 &&
    inputs.gatewayLive &&
    inputs.projectableSkills > 0 &&
    row.publication_active === 1 &&
    row.state !== 'stood_down' &&
    row.state !== 'deactivating'
  );
}

/** The attempt a publisher claims before it writes (design §8.2's durable attempt CAS). */
export interface PublicationAttempt {
  operation_kind: 'publish' | 'unpublish';
  card_projection_revision: number;
  freshness_epoch: number;
  publisher_epoch: number;
  publisher_instance: string;
  fencing_generation: number;
  desired_card_hash: string | null;
  /** Lowercase SHA-256 hex over the canonical JSON of the record attempted (`attemptedRecordDigest`); null for an unpublish. */
  attempted_record_digest: string | null;
  /** The `dina_signing` key (hex public key) the attempt's envelope is signed with. */
  signing_key_id: string;
}

export function parseAttempt(json: string | null): PublicationAttempt | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isPlainObject(value) ? (value as unknown as PublicationAttempt) : null;
  } catch {
    return null;
  }
}

/**
 * Claim an attempt: recorded only while the fencing generation is the one
 * the attempt names, the projection is still the revision it was built
 * from, and the state allows the operation. A publish needs the node active
 * with the switch on and neither stood down nor deactivating; an unpublish
 * needs it active (deactivation keeps that one authority) and not stood
 * down. A publish claim marks the card as maybe present before the write
 * goes out. Returns whether the claim landed; a lost claim means something
 * moved, and the publisher starts again from the state as it now stands.
 */
export function claimAttempt(
  store: A2AStore,
  attempt: PublicationAttempt,
  expected: { priorCid: string | null; repoCommitCid: string },
  nowMs: number,
): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET attempt_tuple_json = ?, attempt_expected_cid = ?, attempt_expected_repo_commit_cid = ?,
              state = CASE WHEN state = 'deactivating' THEN state ELSE 'pending' END,
              card_maybe_present = CASE WHEN ? = 'publish' THEN 1 ELSE card_maybe_present END,
              updated_at = ?
        WHERE id = 1 AND fencing_generation = ? AND card_projection_revision = ?
          AND publisher_epoch = ? AND publisher_instance = ?
          AND publication_active = 1 AND state != 'stood_down'
          AND (? = 'unpublish' OR (listing_enabled = 1 AND state != 'deactivating'))`,
      [
        JSON.stringify(attempt),
        expected.priorCid,
        expected.repoCommitCid,
        attempt.operation_kind,
        nowMs,
        attempt.fencing_generation,
        attempt.card_projection_revision,
        attempt.publisher_epoch,
        attempt.publisher_instance,
        attempt.operation_kind,
      ],
    ) === 1
  );
}

/** The guard every completion carries: the attempt it claimed is still the one recorded, under the same fencing generation. */
const ATTEMPT_GUARD = `id = 1 AND attempt_tuple_json = ? AND fencing_generation = ?`;

/**
 * A publish that landed: recorded only if its attempt is still the one
 * claimed. A late completion (after a deactivation, a stand-down, or a
 * newer claim) writes nothing, so an obsolete record is never recorded as
 * published.
 */
export function completePublish(
  store: A2AStore,
  attempt: PublicationAttempt,
  result: { uri: string; cid: string },
  nowMs: number,
): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET state = 'published', card_maybe_present = 1, published_revision = ?, freshness_epoch = ?, desired_card_hash = ?,
              last_published_uri = ?, last_published_cid = ?, last_published_card_hash = ?, last_published_at = ?,
              published_publisher_epoch = ?, published_key_id = ?,
              attempt_tuple_json = NULL, attempt_expected_cid = NULL, attempt_expected_repo_commit_cid = NULL,
              attempts = 0, next_retry_at = NULL, retry_operation = NULL, updated_at = ?
        WHERE ${ATTEMPT_GUARD}`,
      [
        attempt.card_projection_revision,
        attempt.freshness_epoch,
        attempt.desired_card_hash,
        result.uri,
        result.cid,
        attempt.desired_card_hash,
        nowMs,
        attempt.publisher_epoch,
        attempt.signing_key_id,
        nowMs,
        JSON.stringify(attempt),
        attempt.fencing_generation,
      ],
    ) === 1
  );
}

/**
 * The projection moved but the card did not (a change no public skill
 * reads): the published record is still the right one, so it now answers
 * for this revision too. Nothing is written to the repository, since a
 * byte-identical put would be no commit at all. Guarded on everything it
 * relies on: the same card, signed under this epoch and this key.
 */
export function markPublishedCurrent(
  store: A2AStore,
  args: { revision: number; cardHash: string; keyId: string; nowMs: number },
): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication SET published_revision = ?, updated_at = ?
        WHERE id = 1 AND state = 'published' AND card_projection_revision = ? AND last_published_card_hash = ?
          AND published_publisher_epoch = publisher_epoch AND published_key_id = ?
          AND attempt_tuple_json IS NULL`,
      [args.revision, args.nowMs, args.revision, args.cardHash, args.keyId],
    ) === 1
  );
}

/** An unpublish that landed, or a read under this node's fence that found no card: the evidence that clears the intent. */
export function completeUnpublish(store: A2AStore, attempt: PublicationAttempt, nowMs: number): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET state = CASE WHEN state = 'deactivating' THEN state ELSE 'not_published' END,
              card_maybe_present = 0, published_revision = NULL,
              last_published_uri = NULL, last_published_cid = NULL, last_published_card_hash = NULL,
              published_publisher_epoch = NULL, published_key_id = NULL,
              attempt_tuple_json = NULL, attempt_expected_cid = NULL, attempt_expected_repo_commit_cid = NULL,
              attempts = 0, next_retry_at = NULL, retry_operation = NULL, updated_at = ?
        WHERE ${ATTEMPT_GUARD}`,
      [nowMs, JSON.stringify(attempt), attempt.fencing_generation],
    ) === 1
  );
}

/**
 * An attempt that failed: its operation is retried after `retryAtMs`. Only
 * its own attempt is released; one that lost its claim meanwhile changes
 * nothing.
 */
export function failAttempt(store: A2AStore, attempt: PublicationAttempt, retryAtMs: number, nowMs: number): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET state = CASE WHEN state IN ('stood_down', 'deactivating') THEN state ELSE 'failed' END,
              attempts = attempts + 1, next_retry_at = ?, retry_operation = ?,
              attempt_tuple_json = NULL, attempt_expected_cid = NULL, attempt_expected_repo_commit_cid = NULL,
              updated_at = ?
        WHERE ${ATTEMPT_GUARD}`,
      [retryAtMs, attempt.operation_kind, nowMs, JSON.stringify(attempt), attempt.fencing_generation],
    ) === 1
  );
}

/**
 * The owner's activation landed (design §8.2): this node now holds
 * `epoch`, strictly greater than any it saw in the fence. Clears a
 * stand-down; moves the fencing generation, voiding any attempt in flight.
 * Whatever card the repository holds is now this node's to answer for (the
 * previous holder's, after a handoff), so it is marked maybe present.
 * Guarded on the generation the ceremony began under.
 */
export function recordActivation(
  store: A2AStore,
  args: { fencingGeneration: number; epoch: number; keyId: string; nowMs: number },
): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET publication_active = 1, publisher_epoch = ?, fencing_generation = fencing_generation + 1,
              fence_key_id = ?, card_maybe_present = 1,
              state = CASE WHEN state IN ('stood_down', 'deactivating', 'pending') THEN 'not_published' ELSE state END,
              attempt_tuple_json = NULL, attempt_expected_cid = NULL, attempt_expected_repo_commit_cid = NULL,
              notice = NULL, next_retry_at = NULL, retry_operation = NULL, updated_at = ?
        WHERE id = 1 AND fencing_generation = ?`,
      [args.epoch, args.keyId, args.nowMs, args.fencingGeneration],
    ) === 1
  );
}

/**
 * The fence verifies under `keyId` (re-signed after a rotation, keeping
 * epoch and instance). Guarded on the generation the re-sign began under,
 * so a stand-down or deactivation in between is not overwritten.
 */
export function recordFenceKey(store: A2AStore, args: { fencingGeneration: number; keyId: string; nowMs: number }): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication SET fence_key_id = ?, updated_at = ?
        WHERE id = 1 AND fencing_generation = ? AND publication_active = 1 AND state NOT IN ('stood_down', 'deactivating')`,
      [args.keyId, args.nowMs, args.fencingGeneration],
    ) === 1
  );
}

/**
 * Another server holds the fence (a greater epoch, or the same epoch under
 * another instance): this node stops, says so to the owner, and voids any
 * attempt in flight. Only the owner's activation clears it. Guarded on the
 * fencing generation the verdict was judged under: a verdict taken against a
 * row an activation has since moved (the owner's own new fence looks foreign
 * to the old epoch) lands nothing. Returns whether it landed.
 */
export function recordStandDown(store: A2AStore, notice: string, nowMs: number, fencingGeneration: number): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET state = 'stood_down', publication_active = 0, fencing_generation = fencing_generation + 1,
              attempt_tuple_json = NULL, attempt_expected_cid = NULL, attempt_expected_repo_commit_cid = NULL,
              notice = ?, updated_at = ?
        WHERE id = 1 AND fencing_generation = ?`,
      [notice, nowMs, fencingGeneration],
    ) === 1
  );
}

/**
 * Two-phase deactivation, phase one: the node keeps one authority, the
 * fence-bound delete of its card, and starts no publish. Voids any attempt
 * in flight. Refused unless active.
 */
export function beginDeactivation(store: A2AStore, nowMs: number): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET state = 'deactivating', fencing_generation = fencing_generation + 1,
              attempt_tuple_json = NULL, attempt_expected_cid = NULL, attempt_expected_repo_commit_cid = NULL,
              updated_at = ?
        WHERE id = 1 AND publication_active = 1 AND state != 'stood_down'`,
      [nowMs],
    ) === 1
  );
}

/** Phase two: the card is gone (or was never there); the node is inactive. */
export function completeDeactivation(store: A2AStore, nowMs: number): boolean {
  return (
    store.db.run(
      `UPDATE a2a_card_publication
          SET state = 'not_published', publication_active = 0, fencing_generation = fencing_generation + 1,
              card_maybe_present = 0, published_revision = NULL,
              last_published_uri = NULL, last_published_cid = NULL, last_published_card_hash = NULL,
              published_publisher_epoch = NULL, published_key_id = NULL,
              attempt_tuple_json = NULL, attempt_expected_cid = NULL, attempt_expected_repo_commit_cid = NULL,
              updated_at = ?
        WHERE id = 1 AND state = 'deactivating'`,
      [nowMs],
    ) === 1
  );
}

/** Whether a failed attempt's wait still holds back `operation` at `nowMs` (`retry_operation`). */
export function retryWaiting(row: PublicationRow, operation: 'publish' | 'unpublish', nowMs: number): boolean {
  return row.next_retry_at !== null && nowMs < row.next_retry_at && (row.retry_operation ?? operation) === operation;
}

/** What the owner sees: the switch, the activation, where the card stands, and any notice. */
export function publicationView(row: PublicationRow | null, inputs: PublicationInputs): Record<string, unknown> {
  if (row === null) {
    return { listing_enabled: false, active: false, state: 'not_published', eligible: false, notice: null };
  }
  return {
    listing_enabled: row.listing_enabled === 1,
    active: row.publication_active === 1,
    state: row.state,
    eligible: publicationEligible(row, inputs),
    publisher_epoch: row.publisher_epoch,
    published_uri: row.last_published_uri,
    published_at: row.last_published_at,
    attempts: row.attempts,
    next_retry_at: row.next_retry_at,
    notice: row.notice,
  };
}

// ---------------------------------------------------------------- the host's publisher

export type ActivationOutcome =
  | { ok: true; epoch: number }
  | { ok: false; reason: 'fence_unverifiable' | 'repo_unreachable' | 'lost_race' | 'not_configured' };

export type DeactivationOutcome = { ok: true } | { ok: false; reason: 'not_active' | 'repo_unreachable' };

/**
 * The card publisher a server host installs (design §8.2: a trusted host
 * process beside the other publication machinery, never Brain). Core has
 * no PDS, so the owner's activation and deactivation, which need the
 * repository, go through it.
 */
export interface A2APublisherPort {
  /**
   * The fencing ceremony: read and verify the repository's fence, claim an
   * epoch strictly greater than any it saw, write the fence, then record
   * the activation. `refence` lets the owner replace a fence that cannot be
   * verified (a key rotated without its refresh) under a greater epoch.
   */
  activate(options: { refence: boolean }): Promise<ActivationOutcome>;
  /** Begin two-phase deactivation; the publisher deletes the card, then completes it. */
  deactivate(): Promise<DeactivationOutcome>;
  /** Something the card depends on changed: look again now. */
  nudge(): void;
}

let publisher: A2APublisherPort | null = null;

export function installA2APublisher(port: A2APublisherPort | null): void {
  publisher = port;
}

export function getA2APublisher(): A2APublisherPort | null {
  return publisher;
}

