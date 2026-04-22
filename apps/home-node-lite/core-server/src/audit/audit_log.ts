/**
 * Task 4.73 — append-only audit log with hash-chain integrity.
 *
 * Every persona-tier gate decision, pairing ceremony, admin action,
 * and service-query bridging writes one entry here. The chain is
 * tamper-evident: each entry's `entry_hash = SHA256(seq:ts:actor:…:prev_hash)`,
 * and `prev_hash` is the prior entry's `entry_hash`. Flipping any
 * field breaks the chain at that point, detectable by `verifyChain()`.
 *
 * **Parity with Go**: canonical hashing rules + genesis marker come
 * from `@dina/core`'s `buildAuditEntry` + `verifyChain`, which already
 * mirror `core/test/traceability_test.go`. This module is the
 * *writer* — it owns the seq counter, the running `lastEntryHash`,
 * retention purge, and filtered querying.
 *
 * **Storage**: in-memory today. The SQLCipher-backed variant (when
 * `@dina/storage-node` lands) implements the same surface, so the
 * rest of the system binds to this shape and swaps the backend at
 * install time. Identical to how `SessionGrantRegistry` (task 4.70)
 * and `AutoLockRegistry` (task 4.71) are structured.
 *
 * **Purge + chain anchor**: retention purge drops oldest entries
 * (by ts) older than the cutoff. Doing so effectively resets the
 * chain's *anchor* — `prev_hash` of the oldest remaining entry is no
 * longer the genesis marker, but rather the `entry_hash` of a purged
 * entry. That's still fine: the chain's linkage is preserved as long
 * as we keep `entries[0].prev_hash` unchanged (we never rewrite it),
 * and `verifyChain()` walks from there. We cannot *prove* the anchor
 * came from a legitimate purged entry — only that the remaining
 * entries form an unbroken chain rooted at the anchor. That's the
 * standard tradeoff for any append-only log with retention.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4i task 4.73.
 */

import {
  buildAuditEntry,
  computeEntryHash,
  GENESIS_MARKER,
  type AuditHashEntry,
} from '@dina/core';

/** Re-export the canonical entry shape so callers don't import from `@dina/core` directly. */
export type AuditEntry = AuditHashEntry;

/** Shape a caller supplies to `append`. seq/prev_hash/entry_hash are computed. */
export interface AuditAppendInput {
  /** Who performed the action. E.g. `"admin"`, `"brain"`, `"agent:did:key:…"`. */
  actor: string;
  /** What was done. E.g. `"persona_unlock"`, `"service_query_bridge"`. */
  action: string;
  /** What was affected. E.g. `"/health"`, `"contact:alice"`, `"query:q-abc"`. */
  resource: string;
  /** Human-readable summary. MUST NOT contain vault content or PII. */
  detail: string;
  /** Optional timestamp override (seconds since epoch). Defaults to `nowMsFn()/1000`. */
  tsOverride?: number;
}

export interface AuditQueryFilter {
  actor?: string;
  action?: string;
  /** Lower bound (inclusive), seconds since epoch. */
  since?: number;
  /** Upper bound (inclusive), seconds since epoch. */
  until?: number;
  /** Max entries to return. No cap when omitted. */
  limit?: number;
}

export interface AuditLogOptions {
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Diagnostic hook. Fires after `append` + `purge` so ops can wire
   * this to logger / metrics without the writer owning either concern.
   */
  onEvent?: (event: AuditLogEvent) => void;
}

export type AuditLogEvent =
  | { kind: 'appended'; entry: AuditEntry }
  | { kind: 'purged'; removed: number; cutoffTs: number; newAnchor: string };

export interface VerifyResult {
  valid: boolean;
  /** Index of the first broken entry (or -1 when valid). */
  brokenAt: number;
}

/**
 * In-memory append-only audit log. Thread-safe is irrelevant (Node
 * single-threaded), and ordering is deterministic — seq is a simple
 * monotone counter, not derived from the clock, so clock skew or
 * reset can't corrupt it.
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: AuditLogEvent) => void;
  private lastEntryHash = '';
  private nextSeq = 1;

  constructor(opts: AuditLogOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /**
   * Append one entry. Returns the assigned seq number (1-indexed,
   * strictly monotone). Throws on empty actor/action — those fields
   * are load-bearing for filtering + forensic review.
   */
  append(input: AuditAppendInput): number {
    if (!input.actor) throw new Error('AuditLog.append: actor is required');
    if (!input.action) throw new Error('AuditLog.append: action is required');
    if (!input.resource) throw new Error('AuditLog.append: resource is required');
    // `detail` intentionally allowed to be empty — some events are self-describing.

    const seq = this.nextSeq++;
    const ts = input.tsOverride ?? Math.floor(this.nowMsFn() / 1000);
    const entry = buildAuditEntry(
      seq,
      input.actor,
      input.action,
      input.resource,
      input.detail,
      this.lastEntryHash,
      ts,
    );
    this.entries.push(entry);
    this.lastEntryHash = entry.entry_hash;
    this.onEvent?.({ kind: 'appended', entry });
    return seq;
  }

  /**
   * Query entries matching the filter. Returns a copy — callers
   * cannot mutate the internal log. Results are ordered by seq
   * ascending (oldest first) which matches the natural append order.
   */
  query(filter: AuditQueryFilter = {}): AuditEntry[] {
    let out = this.entries;
    if (filter.actor !== undefined) {
      const actor = filter.actor;
      out = out.filter((e) => e.actor === actor);
    }
    if (filter.action !== undefined) {
      const action = filter.action;
      out = out.filter((e) => e.action === action);
    }
    if (filter.since !== undefined) {
      const since = filter.since;
      out = out.filter((e) => e.ts >= since);
    }
    if (filter.until !== undefined) {
      const until = filter.until;
      out = out.filter((e) => e.ts <= until);
    }
    if (filter.limit !== undefined && filter.limit >= 0) {
      out = out.slice(0, filter.limit);
    }
    // Return a copy so callers don't mutate internal state.
    return out.slice();
  }

  /**
   * Verify the hash chain's integrity. Walks the remaining entries
   * and checks each link + each recomputed hash. After a purge the
   * first entry's `prev_hash` is the anchor (hash of the last-purged
   * entry), not the genesis marker — the chain is still valid, just
   * not rooted at genesis. Callers that need "was this log purged"
   * compare `entries[0]?.prev_hash` to `GENESIS_MARKER`.
   */
  verifyChain(): VerifyResult {
    if (this.entries.length === 0) return { valid: true, brokenAt: -1 };

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (i > 0) {
        const prior = this.entries[i - 1]!;
        if (entry.prev_hash !== prior.entry_hash) {
          return { valid: false, brokenAt: i };
        }
      }
      const { entry_hash: _discard, ...partial } = entry;
      if (computeEntryHash(partial) !== entry.entry_hash) {
        return { valid: false, brokenAt: i };
      }
    }
    return { valid: true, brokenAt: -1 };
  }

  /**
   * Drop entries older than `retentionDays` days. Returns the count
   * removed. Purge operates in absolute-time terms against
   * `nowMsFn()`, which is injectable for deterministic tests.
   *
   * **Retention semantics**: `entry.ts >= cutoff` is kept, strictly
   * older is dropped. Matches Go's retention-days behavior.
   *
   * **Chain continuity**: we never rewrite the oldest remaining
   * entry's `prev_hash`. It now anchors the chain. `verifyChain()`
   * continues to work because linkage between remaining entries is
   * intact — only the root changed.
   */
  purge(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new Error(`AuditLog.purge: retentionDays must be >= 0 (got ${retentionDays})`);
    }
    const cutoffTs = Math.floor(this.nowMsFn() / 1000) - retentionDays * 86400;
    let removed = 0;
    while (this.entries.length > 0 && this.entries[0]!.ts < cutoffTs) {
      this.entries.shift();
      removed++;
    }
    if (removed > 0) {
      const newAnchor = this.entries[0]?.prev_hash ?? this.lastEntryHash;
      this.onEvent?.({ kind: 'purged', removed, cutoffTs, newAnchor });
    }
    return removed;
  }

  /** Count of entries currently retained. */
  size(): number {
    return this.entries.length;
  }

  /**
   * Anchor hash of the chain — either `GENESIS_MARKER` (log never
   * purged) or the `entry_hash` of the oldest entry that has since
   * been purged. Useful for ops visibility + cross-node parity.
   */
  anchorHash(): string {
    if (this.entries.length === 0) return this.lastEntryHash || GENESIS_MARKER;
    return this.entries[0]!.prev_hash;
  }

  /**
   * Latest entry's hash — lets callers cheaply snapshot / compare
   * state without walking the full log.
   */
  headHash(): string {
    return this.lastEntryHash;
  }

  /** Read-only snapshot (copy). */
  all(): AuditEntry[] {
    return this.entries.slice();
  }
}
