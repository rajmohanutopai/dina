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
import type { TxRunner } from '../run/tx';

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

export interface EpochServiceDeps {
  tx: TxRunner;
  /** Quote state as aggregates; the raw ledger is not reachable here. */
  families: QuoteFamilyStore;
  receipts: CommerceReceiptRepository;
  businessDid: string;
  fetchLive: EpochFetcher;
  publish: EpochPublisher;
  now: () => number;
  /** Bounded CAS retry attempts for concurrent restores. */
  maxPublishAttempts?: number;
}

export class CommerceEpochService {
  private epoch: string | null = null;

  constructor(private readonly deps: EpochServiceDeps) {}

  /** Current epoch for signing. Throws until established (fail closed). */
  currentEpoch(): string {
    if (this.epoch === null) {
      throw new Error('commerce epoch: not established — commerce signing is fail-closed (§16.2)');
    }
    return this.epoch;
  }

  get established(): boolean {
    return this.epoch !== null;
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
        this.epoch = live.epoch;
        return live;
      }
      const genesis = this.buildRecord('1', null);
      const published = await this.deps.publish(genesis, null);
      if (published) {
        this.epoch = genesis.epoch;
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
      this.deps.tx(() => {
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
      this.epoch = next.epoch;
      return next;
    }
    throw new Error(
      'commerce epoch: CAS publication kept losing — repo contention; commerce signing stays fail-closed',
    );
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
