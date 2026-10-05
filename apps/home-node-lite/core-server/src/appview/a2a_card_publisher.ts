/**
 * The A2A card publisher (design §8.2, M5): this node's public Agent Card
 * in its own repository, as `com.dinakernel.a2a.card/self`, for AppView's
 * trust-ranked directory. A trusted host process: Brain can neither build
 * nor publish the card, and Core holds no PDS.
 *
 * What it publishes. The record carries the card as a string (its
 * canonical bytes, byte-identical to what the gateway serves), a separately
 * signed directory envelope (the card's hash, a freshness epoch, this
 * node's publisher epoch and instance), and convenience siblings AppView
 * cross-checks. A refresh every 14 days bumps only the envelope's
 * freshness epoch, so the record is a real new commit while the card stays
 * byte-stable.
 *
 * When. The publication predicate (Core's `publicationEligible`) says
 * whether the card should be there; each tick compares it with what is
 * there: publish on a new projection, a new card hash, a due refresh, or a
 * failed or missing publication; unpublish when the predicate is false and
 * the repository may hold a card (Core's `card_maybe_present`: set by every
 * publish claim and every activation, cleared only by a landed delete or a
 * read that found none). A rotated `dina_signing` key, or a new epoch after
 * re-activation, re-signs the fence and republishes at once (§8.2 trigger
 * c): the row records which key and epoch signed what, so noticing needs no
 * read of the repository, and a node with nothing to do reads nothing. No
 * card goes out before the node's DID document names the card key.
 *
 * How, every time. Who holds the repository is settled by the fence record
 * (`com.dinakernel.a2a.fence/self`, written at activation, never deleted):
 * its epoch and instance must be this node's. Every card write or delete
 * runs the pinned read sequence: (1) the repository head C, (2) the fence,
 * verified, (3) the head again, restarting if it moved, (4) the write
 * with `swapCommit = C`, so a fence written by another server in between
 * makes the write fail. A foreign fence (a greater epoch, or the same
 * epoch under another instance) stands this node down until the owner
 * activates it again. Each write is claimed first as a durable attempt in
 * Core, and its completion lands only if that attempt still stands (no
 * deactivation, stand-down or newer projection meanwhile); a lost swap or
 * an ambiguous failure is judged by evidence: the record read back must
 * byte-match the one attempted. Before every write the PDS session's DID
 * must be the node's own.
 */

import {
  A2A_CARD_COLLECTION,
  A2A_LIMITS,
  A2A_FENCE_COLLECTION,
  A2A_PROTOCOL_VERSION,
  A2A_SELF_RKEY,
  PROTOCOL_BINDING_JSONRPC,
  attemptedRecordDigest,
  canonicalize,
  cardStringHash,
  isPlainObject,
  signDirectoryEnvelope,
  signFence,
  verifyFence,
  type AgentCard,
  type JsonValue,
  type Sha256Fn,
} from '@dina/a2a';
import {
  DIRECTORY_FRESHNESS_CADENCE_MS,
  beginDeactivation,
  claimAttempt,
  completeDeactivation,
  completePublish,
  completeUnpublish,
  ensurePublication,
  failAttempt,
  markPublishedCurrent,
  publicationEligible,
  readPublication,
  recordActivation,
  retryWaiting,
  recordFenceKey,
  recordStandDown,
  type A2APublisherPort,
  type A2AStore,
  type ActivationOutcome,
  type DeactivationOutcome,
  type PublicationAttempt,
  type PublicationRow,
} from '@dina/core';

/** The slice of the PDS client the publisher uses: reads, the head, and conditional writes. */
export interface CardRepoClient {
  /** The DID the PDS session is signed in as; checked against the node's before every write. */
  sessionDid(): Promise<string>;
  getLatestCommit(): Promise<{ cid: string; rev: string }>;
  getRecord(collection: string, rkey: string): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null>;
  putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    options: { swapCommit: string; swapRecord?: string | null },
  ): Promise<{ uri: string; cid: string }>;
  deleteRecord(collection: string, rkey: string, options: { swapCommit: string }): Promise<void>;
}

export interface A2ACardPublisherDeps {
  store: A2AStore;
  repo: CardRepoClient;
  /** The node's DID: the repository's, and the one its fence and envelope name. */
  nodeDid: string;
  /** The current public card, or why there is none. */
  buildCard(): Promise<{ ok: true; card: AgentCard } | { ok: false; reason: string }>;
  /** The gateway is configured (the card has a public origin). */
  gatewayLive(): boolean;
  /**
   * The card key is not known yet (a restored node reading its DID document,
   * UCP plan §4.8): no step judges the card meanwhile. Absent: never pending.
   */
  cardKeyPending?(): boolean;
  /** Signs with the node's `dina_signing` key. */
  sign(message: Uint8Array): Uint8Array;
  /** Verifies against the node's current `dina_signing` key. */
  verify(message: Uint8Array, signature: Uint8Array): boolean;
  /** The `dina_signing` key in use, as an id (its hex public key): a change is a rotation. */
  signingKeyId(): string;
  /**
   * Whether the node's DID document names the card-signing key
   * (`#a2a_card`), putting it there if not: AppView verifies the card
   * against it, so no card is published before it is there.
   */
  cardKeyReady(): Promise<boolean>;
  sha256: Sha256Fn;
  /** Whether a repository error is a lost swap (`InvalidSwap`), not a failure to reach it. */
  isLostSwap(err: unknown): boolean;
  newInstance(): string;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** How often to look again with nothing nudging. Default 30 s. */
  tickMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Retries after a failed attempt: 5 s, 30 s, 2 min, 10 min, then every 30 min. */
export const PUBLISH_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;
/** How many times the read sequence restarts on a moving head before it gives up for this tick. */
const MAX_READ_SEQUENCE_TRIES = 3;

type FenceVerdict =
  | { kind: 'ours' }
  | { kind: 'resign' }
  | { kind: 'foreign'; epoch: number }
  | { kind: 'absent' }
  | { kind: 'unverifiable'; epoch: number | null };

interface RepoView {
  head: string;
  fence: { cid: string; value: Record<string, unknown> } | null;
  card: { uri: string; cid: string; value: Record<string, unknown> } | null;
}

class RepoMoved extends Error {}

/** The card's JSON-RPC endpoint: the one AppView indexes (§8.3), or null when the card names none. */
function jsonRpcEndpoint(card: AgentCard): string | null {
  return card.supportedInterfaces.find((i) => i.protocolBinding === PROTOCOL_BINDING_JSONRPC)?.url ?? null;
}

/** A card AppView would index: a JSON-RPC interface, and canonical bytes within the card cap (§8.3). */
function publishable(card: AgentCard): boolean {
  return (
    jsonRpcEndpoint(card) !== null &&
    new TextEncoder().encode(canonicalize(card as unknown as JsonValue)).length <= A2A_LIMITS.maxCardBytes
  );
}

/** A record value as the contract sees it: the PDS stamps `$type`, which no contract counts. */
function withoutType(value: Record<string, unknown>): Record<string, unknown> {
  const { $type: _type, ...rest } = value;
  return rest;
}

export class A2ACardPublisher implements A2APublisherPort {
  private readonly now: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly tickMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;

  constructor(private readonly deps: A2ACardPublisherDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    this.tickMs = deps.tickMs ?? 30_000;
    this.setTimeoutFn = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimeoutFn = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.nudge();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Wait for the step in flight, and any it queued behind it. */
  async flush(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  nudge(): void {
    if (this.running !== null) {
      this.again = true;
      return;
    }
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.running = this.step()
      .catch((err: unknown) => this.log({ event: 'a2a.publisher.step_failed', error: err instanceof Error ? err.name : 'unknown' }))
      .finally(() => this.slotFreed());
  }

  /** The slot is free: run the step asked for meanwhile, or wait a tick. */
  private slotFreed(): void {
    this.running = null;
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.nudge();
      return;
    }
    this.timer = this.setTimeoutFn(() => this.nudge(), this.tickMs);
  }

  /**
   * Run an owner's ceremony in the slot steps run in, so no step reads or
   * judges the fence while the ceremony is between its repository write and
   * its local record: a step that read the new fence there would find it
   * foreign to the old epoch and stand the node down. The slot is taken
   * before `work` starts, so a nudge from inside it queues a step behind it.
   */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    while (this.running !== null) await this.running;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.running = held.finally(() => this.slotFreed());
    try {
      return await work();
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------- the owner's ceremonies

  activate(options: { refence: boolean }): Promise<ActivationOutcome> {
    return this.exclusive(() => this.activateHeld(options));
  }

  private async activateHeld(options: { refence: boolean }): Promise<ActivationOutcome> {
    const { store } = this.deps;
    // No public A2A address, no card: there is nothing to publish, so no
    // fence is written (a node keeps its publisher then only to take down
    // what it published before).
    if (!this.deps.gatewayLive()) return { ok: false, reason: 'not_configured' };
    const start = ensurePublication(store, this.now(), this.deps.newInstance);
    for (let tries = 0; tries < MAX_READ_SEQUENCE_TRIES; tries++) {
      let view: RepoView;
      try {
        view = await this.readSequence(false);
      } catch (err) {
        if (err instanceof RepoMoved) continue;
        return { ok: false, reason: 'repo_unreachable' };
      }
      const verdict = this.judgeFence(view.fence, start);
      let seen = 0;
      if (verdict.kind === 'unverifiable') {
        // Rollback through a "lost" fence is impossible: one we cannot verify
        // is replaced only on the owner's word, above whatever it claims.
        if (!options.refence) return { ok: false, reason: 'fence_unverifiable' };
        seen = verdict.epoch ?? 0;
      } else if (verdict.kind === 'foreign') {
        seen = verdict.epoch;
      } else if (verdict.kind !== 'absent') {
        seen = start.publisher_epoch;
      }
      const epoch = Math.max(seen, start.publisher_epoch) + 1;
      if (!Number.isSafeInteger(epoch)) return { ok: false, reason: 'lost_race' };
      if (!(await this.sessionIsOurs())) return { ok: false, reason: 'repo_unreachable' };
      const keyId = this.deps.signingKeyId();
      const fence = await signFence({ did: this.deps.nodeDid, publisher_epoch: epoch, publisher_instance: start.publisher_instance }, (m) =>
        this.deps.sign(m),
      );
      try {
        await this.deps.repo.putRecord(
          A2A_FENCE_COLLECTION,
          A2A_SELF_RKEY,
          { $type: A2A_FENCE_COLLECTION, ...fence },
          { swapCommit: view.head, swapRecord: view.fence?.cid ?? null },
        );
      } catch (err) {
        if (!this.deps.isLostSwap(err)) return { ok: false, reason: 'repo_unreachable' };
        // Another write landed in between. If it was a fence, another server
        // is activating: the owner decides, so stop. Otherwise read again.
        const fenceNow = await this.deps.repo.getRecord(A2A_FENCE_COLLECTION, A2A_SELF_RKEY).catch(() => undefined);
        if (fenceNow === undefined) return { ok: false, reason: 'repo_unreachable' };
        if ((fenceNow?.cid ?? null) !== (view.fence?.cid ?? null)) return { ok: false, reason: 'lost_race' };
        continue;
      }
      if (!recordActivation(store, { fencingGeneration: start.fencing_generation, epoch, keyId, nowMs: this.now() })) {
        return { ok: false, reason: 'lost_race' };
      }
      this.log({ event: 'a2a.publisher.activated', epoch });
      this.nudge();
      return { ok: true, epoch };
    }
    return { ok: false, reason: 'lost_race' };
  }

  async deactivate(): Promise<DeactivationOutcome> {
    // Begun between steps: a step in flight finishes on the state it read.
    const begun = await this.exclusive(() => Promise.resolve(beginDeactivation(this.deps.store, this.now())));
    if (!begun) return { ok: false, reason: 'not_active' };
    this.nudge();
    await this.flush();
    return { ok: true };
  }

  // ---------------------------------------------------------------- one step

  private async step(): Promise<void> {
    const { store } = this.deps;
    const row = readPublication(store);
    if (row === null) return;
    if (row.state === 'deactivating') {
      await this.remove(row, 'deactivate');
      return;
    }
    if (row.publication_active !== 1 || row.state === 'stood_down') return;
    // Not "no gateway": the card is not known yet. Neither publish nor take it down.
    if (this.deps.cardKeyPending?.() === true) return;
    const now = this.now();
    const keyId = this.deps.signingKeyId();
    if (row.fence_key_id !== keyId) {
      // A rotated key (§8.2 trigger c): the fence first, then the envelope; not while a failure is waited out.
      if (row.next_retry_at !== null && now < row.next_retry_at) return;
      await this.refence(row, keyId);
      return;
    }
    // What the card should be is judged first, and a failed attempt's wait
    // holds back only the operation that failed (`retryWaiting`): a publish
    // that failed never keeps a card the owner withdrew in the directory.
    const gatewayLive = this.deps.gatewayLive();
    const built = row.listing_enabled === 1 && gatewayLive ? await this.deps.buildCard() : null;
    // A card AppView would refuse (no JSON-RPC interface, or over the cap) is not publishable.
    const card = built !== null && built.ok && publishable(built.card) ? built.card : null;
    const eligible = publicationEligible(row, { gatewayLive, projectableSkills: card === null ? 0 : card.skills.length });
    if (eligible && card !== null) {
      const cardText = canonicalize(card as unknown as JsonValue);
      const hash = cardStringHash(cardText, this.deps.sha256);
      const due = row.last_published_at !== null && now - row.last_published_at >= DIRECTORY_FRESHNESS_CADENCE_MS;
      // The record there is this card, under this epoch and this key: nothing to write.
      const current =
        row.state === 'published' &&
        row.last_published_card_hash === hash &&
        row.published_publisher_epoch === row.publisher_epoch &&
        row.published_key_id === keyId;
      if (current && !due) {
        if (row.published_revision !== row.card_projection_revision) {
          markPublishedCurrent(store, { revision: row.card_projection_revision, cardHash: hash, keyId, nowMs: now });
        }
        return;
      }
      if (retryWaiting(row, 'publish', now)) return;
      await this.publish(row, card, cardText, hash, due, keyId);
      return;
    }
    // Predicate false: delete whatever card the repository may hold, judged
    // by evidence (a lost completion or a handoff leaves one the row never
    // recorded as published).
    if (row.card_maybe_present === 1 && !retryWaiting(row, 'unpublish', now)) await this.remove(row, 'unpublish');
  }

  /** The read sequence, restarted on a moving head a few times; null when the repository cannot be read. */
  private async settledView(withCard: boolean): Promise<RepoView | null> {
    for (let tries = 0; tries < MAX_READ_SEQUENCE_TRIES; tries++) {
      try {
        return await this.readSequence(withCard);
      } catch (err) {
        if (!(err instanceof RepoMoved)) {
          this.log({ event: 'a2a.publisher.repo_unreachable' });
          return null;
        }
      }
    }
    return null;
  }

  /** Steps (1)–(3) of the read sequence, and the card record when asked. */
  private async readSequence(withCard: boolean): Promise<RepoView> {
    const { repo } = this.deps;
    const head = (await repo.getLatestCommit()).cid;
    const fence = await repo.getRecord(A2A_FENCE_COLLECTION, A2A_SELF_RKEY);
    const card = withCard ? await repo.getRecord(A2A_CARD_COLLECTION, A2A_SELF_RKEY) : null;
    if ((await repo.getLatestCommit()).cid !== head) throw new RepoMoved();
    return { head, fence: fence === null ? null : { cid: fence.cid, value: fence.value }, card };
  }

  /** Whose the fence is, judged against this node's row and current key. */
  private judgeFence(fence: RepoView['fence'], row: PublicationRow): FenceVerdict {
    if (fence === null) return { kind: 'absent' };
    const value = withoutType(fence.value);
    const epoch = typeof value.publisher_epoch === 'number' && Number.isSafeInteger(value.publisher_epoch) ? value.publisher_epoch : null;
    const verified = verifyFence(value, this.deps.nodeDid, (m, s) => this.deps.verify(m, s)).ok;
    if (!verified) {
      // Ours by its content but signed under a key this node no longer holds:
      // a rotation whose refresh did not run. Re-signed, keeping epoch and instance.
      if (epoch === row.publisher_epoch && value.publisher_instance === row.publisher_instance && row.publication_active === 1) {
        return { kind: 'resign' };
      }
      return { kind: 'unverifiable', epoch };
    }
    if (epoch === row.publisher_epoch && value.publisher_instance === row.publisher_instance) return { kind: 'ours' };
    return { kind: 'foreign', epoch: epoch ?? 0 };
  }

  /**
   * A foreign or missing fence stops this node (design §8.2). True when this
   * step must stop: it stood down, or the row moved under it (an activation
   * during its reads), in which case the verdict, judged against the old
   * row, lands nothing and the next step judges afresh.
   */
  private standDownUnlessOurs(verdict: FenceVerdict, row: PublicationRow): boolean {
    if (verdict.kind === 'ours' || verdict.kind === 'resign') return false;
    const notice =
      verdict.kind === 'foreign'
        ? 'another_server_publishing'
        : verdict.kind === 'absent'
          ? 'fence_missing'
          : 'fence_unverifiable';
    if (recordStandDown(this.deps.store, notice, this.now(), row.fencing_generation)) {
      this.log({ event: 'a2a.publisher.stood_down', notice, epoch: row.publisher_epoch });
    } else {
      this.again = true;
    }
    return true;
  }

  private async sessionIsOurs(): Promise<boolean> {
    try {
      return (await this.deps.repo.sessionDid()) === this.deps.nodeDid;
    } catch {
      return false;
    }
  }

  private retryAt(row: PublicationRow): number {
    const delay = PUBLISH_RETRY_DELAYS_MS[Math.min(row.attempts, PUBLISH_RETRY_DELAYS_MS.length - 1)] ?? 1_800_000;
    return this.now() + delay;
  }

  /** The key moved since the fence was written: confirm the fence is ours, re-sign it if needed, record the key. */
  private async refence(row: PublicationRow, keyId: string): Promise<void> {
    const view = await this.settledView(false);
    if (view === null) return;
    const verdict = this.judgeFence(view.fence, row);
    if (this.standDownUnlessOurs(verdict, row)) return;
    if (verdict.kind === 'resign') {
      await this.resignFrom(row, keyId, view);
      return;
    }
    // Already under this key (a re-sign that landed before its record did).
    if (recordFenceKey(this.deps.store, { fencingGeneration: row.fencing_generation, keyId, nowMs: this.now() })) this.again = true;
  }

  /** Our fence, under another key: re-signed under this one, keeping epoch and instance. */
  private async resignFrom(row: PublicationRow, keyId: string, view: RepoView): Promise<void> {
    if (!(await this.sessionIsOurs())) return;
    const fence = await signFence(
      { did: this.deps.nodeDid, publisher_epoch: row.publisher_epoch, publisher_instance: row.publisher_instance },
      (m) => this.deps.sign(m),
    );
    try {
      await this.deps.repo.putRecord(A2A_FENCE_COLLECTION, A2A_SELF_RKEY, { $type: A2A_FENCE_COLLECTION, ...fence }, {
        swapCommit: view.head,
        swapRecord: view.fence?.cid ?? null,
      });
    } catch (err) {
      this.log({ event: 'a2a.publisher.fence_resign_failed', lost_swap: this.deps.isLostSwap(err) });
      return;
    }
    this.log({ event: 'a2a.publisher.fence_resigned', epoch: row.publisher_epoch });
    // The envelope follows on the next step, at once.
    if (recordFenceKey(this.deps.store, { fencingGeneration: row.fencing_generation, keyId, nowMs: this.now() })) this.again = true;
  }

  private async publish(row: PublicationRow, card: AgentCard, cardText: string, hash: string, due: boolean, keyId: string): Promise<void> {
    const { store, repo } = this.deps;
    if (!(await this.deps.cardKeyReady())) {
      this.log({ event: 'a2a.publisher.card_key_not_ready' });
      return;
    }
    const view = await this.settledView(true);
    if (view === null) return;
    const verdict = this.judgeFence(view.fence, row);
    if (this.standDownUnlessOurs(verdict, row)) return;
    if (verdict.kind === 'resign') {
      await this.resignFrom(row, keyId, view);
      return;
    }
    const freshness = due ? row.freshness_epoch + 1 : row.freshness_epoch;
    const envelope = await signDirectoryEnvelope(
      {
        did: this.deps.nodeDid,
        collection: A2A_CARD_COLLECTION,
        rkey: A2A_SELF_RKEY,
        card_hash: hash,
        freshness_epoch: freshness,
        publisher_epoch: row.publisher_epoch,
        publisher_instance: row.publisher_instance,
      },
      (m) => this.deps.sign(m),
    );
    const record: Record<string, unknown> = {
      $type: A2A_CARD_COLLECTION,
      card: cardText,
      directory_envelope: envelope,
      endpoint: jsonRpcEndpoint(card) as string,
      protocol_version: A2A_PROTOCOL_VERSION,
      skills: card.skills.map((s) => s.id),
    };
    const attempt: PublicationAttempt = {
      operation_kind: 'publish',
      card_projection_revision: row.card_projection_revision,
      freshness_epoch: freshness,
      publisher_epoch: row.publisher_epoch,
      publisher_instance: row.publisher_instance,
      fencing_generation: row.fencing_generation,
      desired_card_hash: hash,
      attempted_record_digest: attemptedRecordDigest(record as JsonValue, this.deps.sha256),
      signing_key_id: keyId,
    };
    if (!claimAttempt(store, attempt, { priorCid: view.card?.cid ?? null, repoCommitCid: view.head }, this.now())) return;
    if (!(await this.sessionIsOurs())) {
      failAttempt(store, attempt, this.retryAt(row), this.now());
      this.log({ event: 'a2a.publisher.session_not_ours' });
      return;
    }
    try {
      const written = await repo.putRecord(A2A_CARD_COLLECTION, A2A_SELF_RKEY, record, { swapCommit: view.head });
      if (completePublish(store, attempt, written, this.now())) {
        this.log({ event: 'a2a.publisher.published', revision: attempt.card_projection_revision, freshness });
      }
    } catch (err) {
      await this.recoverPublish(row, attempt, err);
    }
  }

  /**
   * A publish whose answer we do not have, or whose swap was lost: success
   * only if the record there now byte-matches the one attempted (and the
   * attempt still stands, which `completePublish` checks); otherwise
   * released for a retry.
   */
  private async recoverPublish(row: PublicationRow, attempt: PublicationAttempt, err: unknown): Promise<void> {
    const { store, repo } = this.deps;
    const lost = this.deps.isLostSwap(err);
    const there = await repo.getRecord(A2A_CARD_COLLECTION, A2A_SELF_RKEY).catch(() => undefined);
    if (there !== undefined && there !== null && isPlainObject(there.value)) {
      if (attemptedRecordDigest(there.value as JsonValue, this.deps.sha256) === attempt.attempted_record_digest) {
        if (completePublish(store, attempt, { uri: there.uri, cid: there.cid }, this.now())) {
          this.log({ event: 'a2a.publisher.published', revision: attempt.card_projection_revision, recovered: true });
        }
        return;
      }
    }
    // A lost swap is a moving head, not a failure: try again soon.
    failAttempt(store, attempt, lost ? this.now() + PUBLISH_RETRY_DELAYS_MS[0] : this.retryAt(row), this.now());
    this.log({ event: 'a2a.publisher.publish_failed', lost_swap: lost });
  }

  /**
   * Remove the card: an unpublish (the predicate turned false, or the
   * owner's intent), or deactivation's one authority. Fence-bound, like
   * every write; a foreign fence stands this node down, which also
   * satisfies a deactivation.
   */
  private async remove(row: PublicationRow, why: 'unpublish' | 'deactivate'): Promise<void> {
    const { store, repo } = this.deps;
    const view = await this.settledView(true);
    if (view === null) return;
    const verdict = this.judgeFence(view.fence, row);
    if (this.standDownUnlessOurs(verdict, row)) return;
    const attempt: PublicationAttempt = {
      operation_kind: 'unpublish',
      card_projection_revision: row.card_projection_revision,
      freshness_epoch: row.freshness_epoch,
      publisher_epoch: row.publisher_epoch,
      publisher_instance: row.publisher_instance,
      fencing_generation: row.fencing_generation,
      desired_card_hash: null,
      attempted_record_digest: null,
      signing_key_id: this.deps.signingKeyId(),
    };
    if (!claimAttempt(store, attempt, { priorCid: view.card?.cid ?? null, repoCommitCid: view.head }, this.now())) return;
    if (view.card !== null) {
      if (!(await this.sessionIsOurs())) {
        failAttempt(store, attempt, this.retryAt(row), this.now());
        return;
      }
      try {
        await repo.deleteRecord(A2A_CARD_COLLECTION, A2A_SELF_RKEY, { swapCommit: view.head });
      } catch (err) {
        // Success only when the record is gone.
        const there = await repo.getRecord(A2A_CARD_COLLECTION, A2A_SELF_RKEY).catch(() => undefined);
        if (there !== null) {
          failAttempt(store, attempt, this.deps.isLostSwap(err) ? this.now() + PUBLISH_RETRY_DELAYS_MS[0] : this.retryAt(row), this.now());
          this.log({ event: 'a2a.publisher.unpublish_failed', lost_swap: this.deps.isLostSwap(err) });
          return;
        }
      }
    }
    if (!completeUnpublish(store, attempt, this.now())) return;
    this.log({ event: why === 'deactivate' ? 'a2a.publisher.deactivated' : 'a2a.publisher.unpublished' });
    if (why === 'deactivate') completeDeactivation(store, this.now());
  }
}

/**
 * `cardKeyReady` over a check that puts the card key in the DID document
 * (`ensureA2ACardKey`), for the key that signs the card now
 * (`currentKey`; null while no card can be built). True once the document
 * names that key, remembered for that key: a different key is checked
 * afresh, so no card signed by a key the document does not name goes out.
 * After a failure, not asked again before the retry delay, so an
 * unreachable PLC directory is not polled on every tick; a new key starts
 * its own delays.
 */
export function cardKeyCheck(
  ensure: (cardPublicKey: Uint8Array) => Promise<unknown>,
  currentKey: () => Uint8Array | null,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let confirmed: string | null = null;
  let trying: string | null = null;
  let failures = 0;
  let notBefore = 0;
  return async () => {
    const key = currentKey();
    if (key === null) return false;
    const id = Buffer.from(key).toString('hex');
    if (id === confirmed) return true;
    if (id !== trying) {
      trying = id;
      failures = 0;
      notBefore = 0;
    }
    if (now() < notBefore) return false;
    try {
      await ensure(key);
      confirmed = id;
      return true;
    } catch {
      notBefore = now() + (PUBLISH_RETRY_DELAYS_MS[Math.min(failures, PUBLISH_RETRY_DELAYS_MS.length - 1)] ?? 1_800_000);
      failures += 1;
      return false;
    }
  };
}

/**
 * The repository client over the node's PDS publisher: the session check
 * through `authenticate()` (it answers the DID the session is signed in
 * as), and the four calls the read sequence and the conditional writes use.
 * Every read names the node's own repository: a session signed in as
 * another account must never be read as this node's fence or card (a
 * missing or foreign fence there would stand the node down). Writes go to
 * the session's repository, and the publisher checks the session first.
 */
export function cardRepoOverPds(
  pds: {
    authenticate(): Promise<string>;
    getLatestCommit(did?: string): Promise<{ cid: string; rev: string }>;
    getRecord(
      collection: string,
      rkey: string,
      did?: string,
    ): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null>;
  putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    options: { swapCommit?: string; swapRecord?: string | null },
  ): Promise<{ uri: string; cid: string }>;
  deleteRecord(collection: string, rkey: string, options: { swapCommit?: string }): Promise<void>;
  },
  nodeDid: string,
): CardRepoClient {
  return {
    sessionDid: () => pds.authenticate(),
    getLatestCommit: () => pds.getLatestCommit(nodeDid),
    getRecord: (collection, rkey) => pds.getRecord(collection, rkey, nodeDid),
    putRecord: (collection, rkey, record, options) => pds.putRecord(collection, rkey, record, options),
    deleteRecord: (collection, rkey, options) => pds.deleteRecord(collection, rkey, options),
  };
}

