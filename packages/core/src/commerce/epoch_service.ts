/**
 * Commerce epoch state (spec §16.2) — the supplier-side half of the
 * restore fence.
 *
 * The AUTHORITATIVE record lives in the supplier's own repo
 * (`com.dinakernel.commerce.epoch`, rkey `self`), outside every
 * backup; publication is CAS at the PDS and is performed by an
 * injected publisher (the PDS client is app-level wiring). This
 * service owns the local mirror + the restore protocol:
 *
 *   1. fetch the LIVE record (authoritative over anything local);
 *   2. build epoch N+1 chained to it (reason 'restore'; genesis is
 *      "1"/'initial') and publish via CAS — concurrent restores
 *      serialize at the PDS, the loser re-reads and re-increments;
 *   3. only after publication succeeds: void every unexpired quote
 *      head (capacity is never resurrected from a backup) and adopt
 *      the new epoch locally.
 *
 * A node that cannot reach its repo FAILS CLOSED for commerce
 * signing: `currentEpoch()` throws until an epoch is established.
 *
 * ESTABLISHING IT ONCE IS NOT ENOUGH (§16.2): "Signing nodes also
 * re-verify the live epoch on a bounded interval, so a forgotten
 * pre-restore node converges". Without that, a node that was running
 * when somebody restored the same identity elsewhere keeps signing at
 * the epoch it cached at boot — for ever. Counterparties reject those
 * records (that is the hard enforcement, and it is elsewhere), but the
 * supplier never learns it: from inside, a node signing into a wall
 * looks exactly like a node nobody is buying from.
 *
 * So the epoch carries a VALIDATED-AT time, `revalidate()` refreshes it
 * against the live record, and `currentEpoch()` refuses once it has gone
 * unverified for too long. The refusal is what makes this enforcement
 * rather than advice — a revalidation whose only effect is a log entry
 * changes nothing about what the node signs.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  COMMERCE_PROTOCOL_VERSION,
  commerceRecordDigest,
  validateCommerceEpochRecord,
  verifyEpochSuccession,
  type CommerceEpochRecord,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import type { QuoteFamilyStore } from './quote_family';
import type { CommerceReceiptRepository } from './receipts';
import type { CommerceTransaction } from './transaction';

const hash: Sha256Fn = (data) => sha256(data);

/** Fetch the live epoch record from the supplier's own repo; null when
 *  none exists yet. Throwing = repo unreachable = fail closed. */
export type EpochFetcher = () => Promise<CommerceEpochRecord | null>;

/**
 * CAS-publish a record against the previous record's identity; MUST
 * reject (throw or return false) when the live record is no longer
 * `previous` — that serialization is what makes concurrent restores
 * safe. `previous === null` publishes the genesis.
 */
export type EpochPublisher = (
  record: CommerceEpochRecord,
  previous: CommerceEpochRecord | null,
) => Promise<boolean>;

/**
 * How often a signing node re-reads the live epoch record (§16.2's
 * "bounded interval"). Cheap — one repo read — so it can be frequent.
 */
export const EPOCH_REVALIDATION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long signing survives with NO successful re-read before it refuses.
 *
 * A CHOSEN NUMBER, and the reasoning matters more than the value. The spec
 * puts the hard enforcement counterparty-side, so this is not the thing
 * standing between a stale node and a bad commitment — it is what stops a
 * node from producing commitments of unknown standing indefinitely while
 * believing itself healthy. Too short and a supplier whose PDS blips for an
 * afternoon stops trading for no reason; too long and "forgotten" has no
 * upper bound. A day is the point at which an unreachable repo has stopped
 * being an outage and started being a misconfiguration.
 */
export const EPOCH_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;

/**
 * What the local mirror knows. `stopped` is deliberately NOT a return to
 * `unestablished`: the difference between "this node never had an epoch" and
 * "this node had one and the repo says it is superseded" is the difference
 * between a node that should establish and a node whose operator has an
 * unresolved restore to deal with, and collapsing them loses that.
 */
type EpochState =
  | { kind: 'unestablished' }
  | { kind: 'established'; epoch: string; digest: string; validatedAtMs: number }
  | { kind: 'stopped'; epoch: string; reason: string };

/** What one re-read concluded. Reported so the boot can log/surface it. */
export type EpochRevalidation =
  | { kind: 'current'; epoch: string }
  | { kind: 'stopped'; epoch: string; reason: string }
  | { kind: 'unreachable'; epoch: string; reason: string; staleForMs: number }
  | { kind: 'not_established' };

export interface EpochServiceDeps {
  transaction: CommerceTransaction;
  /** Quote state as aggregates; the raw ledger is not reachable here. */
  families: QuoteFamilyStore;
  receipts: CommerceReceiptRepository;
  businessDid: string;
  fetchLive: EpochFetcher;
  publish: EpochPublisher;
  now: () => number;
  /** Bounded CAS retry attempts for concurrent restores. */
  maxPublishAttempts?: number;
  /** Override §16.2's re-read cadence. */
  revalidationIntervalMs?: number;
  /** Override how long signing survives without a successful re-read. */
  maxStalenessMs?: number;
}

export class CommerceEpochService {
  private state: EpochState = { kind: 'unestablished' };

  constructor(private readonly deps: EpochServiceDeps) {}

  private get maxStalenessMs(): number {
    return this.deps.maxStalenessMs ?? EPOCH_MAX_STALENESS_MS;
  }

  /** Current epoch for signing. Throws until established (fail closed). */
  currentEpoch(): string {
    const state = this.state;
    if (state.kind === 'unestablished') {
      throw new Error('commerce epoch: not established — commerce signing is fail-closed (§16.2)');
    }
    if (state.kind === 'stopped') {
      throw new Error(
        `commerce epoch: signing stopped at epoch ${state.epoch} — ${state.reason} (§16.2)`,
      );
    }
    const staleForMs = this.deps.now() - state.validatedAtMs;
    if (staleForMs > this.maxStalenessMs) {
      // THE REFUSAL IS THE POINT. A node that cannot re-read its own repo
      // cannot learn that it was superseded, and a node that keeps signing
      // while unable to learn that is the "forgotten pre-restore node"
      // §16.2 names — from the inside it looks perfectly healthy.
      throw new Error(
        `commerce epoch: live record unverified for ${Math.floor(staleForMs / 1000)}s — commerce signing is fail-closed (§16.2)`,
      );
    }
    return state.epoch;
  }

  get established(): boolean {
    return this.state.kind === 'established';
  }

  /** Milliseconds since the last successful live read; null when unestablished. */
  get staleForMs(): number | null {
    return this.state.kind === 'established' ? this.deps.now() - this.state.validatedAtMs : null;
  }

  /**
   * §16.2's bounded-interval re-verification. Reads the live record and
   * decides whether this node may go on signing at the epoch it holds.
   *
   * IT NEVER ADOPTS A HIGHER EPOCH. Adopting would mean this node resumes
   * signing beside the node that actually restored — two generations under
   * one business identity, both "current", and this one still holding the
   * pre-restore capacity counters that the fence voided on the other. The
   * legitimate way to reach a higher epoch is `establishAfterRestore()`,
   * which publishes its own increment and voids capacity in the same commit.
   *
   * IT NEVER VOIDS CAPACITY EITHER. Voiding is the restore path's act and it
   * commits with a published epoch; a node that destroyed local state on the
   * strength of a read, and still could not sign, would have paid the cost of
   * a restore without performing one.
   *
   * SO SUPERSESSION STOPS SIGNING AND WAITS FOR AN OPERATOR. That is also
   * what keeps two nodes from ping-ponging: if observing a higher epoch made
   * a node increment, two live nodes would supersede each other for ever.
   */
  async revalidate(): Promise<EpochRevalidation> {
    const state = this.state;
    if (state.kind === 'unestablished') return { kind: 'not_established' };
    if (state.kind === 'stopped') {
      return { kind: 'stopped', epoch: state.epoch, reason: state.reason };
    }

    let live: CommerceEpochRecord | null;
    try {
      live = await this.deps.fetchLive();
    } catch (err) {
      // ONE failed read is not evidence of anything. A blip must not take a
      // healthy supplier off the market — the staleness bound in
      // `currentEpoch()` is what turns a long run of these into a refusal.
      return {
        kind: 'unreachable',
        epoch: state.epoch,
        reason: err instanceof Error ? err.message : String(err),
        staleForMs: this.deps.now() - state.validatedAtMs,
      };
    }

    const stop = (reason: string): EpochRevalidation => {
      this.state = { kind: 'stopped', epoch: state.epoch, reason };
      return { kind: 'stopped', epoch: state.epoch, reason };
    };

    if (live === null) {
      // Not "no epoch yet" — this node PUBLISHED or adopted one, so an empty
      // repo means the record was deleted. Reading that as "fine" would let a
      // deleted fence authorise signing for ever, which is the rollback the
      // fence exists to catch.
      return stop('the live epoch record is gone from the repo');
    }
    const invalid = validateCommerceEpochRecord(live, hash);
    if (invalid !== null) return stop(`the live epoch record is invalid — ${invalid}`);
    if (live.business_did !== this.deps.businessDid) {
      return stop('the live epoch record belongs to a different business DID');
    }

    // Both sides are canonical positive-integer strings — `live` because the
    // validator above says so, `state.epoch` because it came from a validated
    // record or from a published one this class validated before publishing.
    // Compared as BigInt because "10" sorts below "9" in every text collation.
    const liveEpoch = BigInt(live.epoch);
    const mine = BigInt(state.epoch);
    if (liveEpoch > mine) {
      return stop(
        `the live epoch is ${live.epoch}; this node is a superseded pre-restore generation`,
      );
    }
    if (liveEpoch < mine) {
      return stop(`the live epoch fell back to ${live.epoch}; the fence itself was rolled back`);
    }
    if (live.epoch_digest !== state.digest) {
      // Same number, different record: somebody rewrote the fence in place.
      // The digest covers `activated_at`, so this cannot happen by accident.
      return stop(`the live epoch record was replaced in place at epoch ${live.epoch}`);
    }

    this.state = { ...state, validatedAtMs: this.deps.now() };
    return { kind: 'current', epoch: state.epoch };
  }

  /**
   * Revalidate only if the interval has elapsed, so a caller can hang this on
   * any tick it already has without choosing a cadence of its own.
   */
  async revalidateIfDue(): Promise<EpochRevalidation | null> {
    const state = this.state;
    if (state.kind !== 'established') return null;
    const interval = this.deps.revalidationIntervalMs ?? EPOCH_REVALIDATION_INTERVAL_MS;
    if (this.deps.now() - state.validatedAtMs < interval) return null;
    return this.revalidate();
  }

  /**
   * Normal boot (no restore): adopt the live record, publishing the
   * genesis when none exists. A local mirror lower than the live
   * record simply adopts the live value (the live record is
   * authoritative).
   */
  async establish(): Promise<CommerceEpochRecord> {
    // Bounded like establishAfterRestore: a publisher that keeps losing
    // the CAS while fetchLive() keeps returning null (a misbehaving or
    // partially available repo) must surface the fail-closed error, not
    // spin unboundedly against the repo on the path §16.2 makes
    // mandatory before any commerce signing.
    const attempts = this.deps.maxPublishAttempts ?? 5;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const live = await this.deps.fetchLive();
      if (live) {
        const invalid = validateCommerceEpochRecord(live, hash);
        if (invalid) throw new Error(`commerce epoch: live record invalid — ${invalid}`);
        // The epoch record is the restore fence for ONE business identity.
        // Adopting another DID's record (a misconfigured repo pointer, a
        // rotation, a shared PDS client) stamps an arbitrary epoch into
        // every quote and status this node signs. Fail closed.
        this.assertOwnRecord(live);
        this.adopt(live);
        return live;
      }
      const genesis = this.buildRecord('1', null);
      const published = await this.deps.publish(genesis, null);
      if (published) {
        this.adopt(genesis);
        return genesis;
      }
      // Raced by another node's genesis: loop re-reads and adopts.
    }
    throw new Error(
      'commerce epoch: genesis publication kept losing the CAS — repo contention; commerce signing stays fail-closed',
    );
  }

  /**
   * RESTORE boot (§16.2): increment the epoch via CAS, then void all
   * unexpired quote capacity and record the restore-fence event. The
   * void + adoption happen only AFTER publication succeeds.
   */
  async establishAfterRestore(): Promise<CommerceEpochRecord> {
    const attempts = this.deps.maxPublishAttempts ?? 5;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const live = await this.deps.fetchLive();
      // Validate the fetched record BEFORE any arithmetic on it. The
      // normal boot path validates; this one did not, so a malformed
      // epoch string crashed restore inside BigInt, and a structurally
      // plausible record with a forged digest could be legitimized as
      // the predecessor of a newly published chain (§16.2).
      if (live) {
        const liveInvalid = validateCommerceEpochRecord(live, hash);
        if (liveInvalid !== null) {
          throw new Error(`commerce epoch: live record rejected — ${liveInvalid}`);
        }
        this.assertOwnRecord(live);
      }
      const next = live
        ? this.buildRecord((BigInt(live.epoch) + 1n).toString(10), live)
        : this.buildRecord('1', null);
      // Validate our own successor too: publishing an invalid epoch
      // record poisons every counterparty watermark check downstream.
      const nextInvalid = validateCommerceEpochRecord(next, hash);
      if (nextInvalid !== null) {
        throw new Error(`commerce epoch: refusing to publish an invalid record — ${nextInvalid}`);
      }
      if (live) {
        const chain = verifyEpochSuccession(live, next);
        if (chain) throw new Error(`commerce epoch: ${chain}`);
      }
      const published = await this.deps.publish(next, live);
      if (!published) continue; // concurrent restore won; re-read.

      const nowMs = this.deps.now();
      // ARCH-0c — the boundary belongs to the coordinator, not to this class.
      // The restore event and the quote voiding it records commit together:
      // a receipt saying "these families were frozen" beside families that
      // were not is worse than neither, because the receipt is what a later
      // audit believes.
      this.deps.transaction.atomically('publishRestoreEpoch', () => {
        // Explicit restore event + its receipt. The DURABLE guard is epoch
        // monotonicity inside QuoteFamily: this sweep marks the families it
        // can see, but a family it misses (an expired one, historically) is
        // still frozen because its head carries the old epoch.
        const voided = this.deps.families.voidPreRestore(nowMs);
        this.deps.receipts.put({
          recordDigest: next.epoch_digest,
          domain: 'restore_fence_event',
          buyerDid: '',
          quoteId: '',
          purchaseOrderId: '',
          recordJson: JSON.stringify({ record: next, voidedQuotes: voided }),
          evidenceJson: '{}',
          createdAt: nowMs,
        });
      });
      this.adopt(next);
      return next;
    }
    throw new Error(
      'commerce epoch: CAS publication kept losing — repo contention; commerce signing stays fail-closed',
    );
  }

  /**
   * Take a record as this node's signing epoch.
   *
   * Establishing IS a successful live read, so it starts the staleness clock
   * rather than leaving it at zero — otherwise `currentEpoch()` would refuse
   * the moment `establish()` returned.
   */
  private adopt(record: CommerceEpochRecord): void {
    this.state = {
      kind: 'established',
      epoch: record.epoch,
      digest: record.epoch_digest,
      validatedAtMs: this.deps.now(),
    };
  }

  /** Fail closed on an epoch record belonging to another business DID. */
  private assertOwnRecord(record: CommerceEpochRecord): void {
    if (record.business_did !== this.deps.businessDid) {
      throw new Error(
        'commerce epoch: live record belongs to a different business DID — commerce signing stays fail-closed (§16.2)',
      );
    }
  }

  private buildRecord(epoch: string, previous: CommerceEpochRecord | null): CommerceEpochRecord {
    const draft = {
      protocol_version: COMMERCE_PROTOCOL_VERSION,
      business_did: this.deps.businessDid,
      epoch,
      reason: (epoch === '1' ? 'initial' : 'restore') as 'initial' | 'restore',
      activated_at: new Date(this.deps.now()).toISOString(),
      ...(previous ? { previous_epoch_digest: previous.epoch_digest } : {}),
    };
    return {
      ...draft,
      epoch_digest: commerceRecordDigest('epoch', draft as Record<string, unknown>, hash),
    } as CommerceEpochRecord;
  }
}

let service: CommerceEpochService | null = null;

export function setCommerceEpochService(value: CommerceEpochService | null): void {
  service = value;
}

export function getCommerceEpochService(): CommerceEpochService | null {
  return service;
}
