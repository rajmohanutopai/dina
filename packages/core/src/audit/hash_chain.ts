/**
 * Audit log hash chain — append-only integrity chain.
 *
 * Each entry contains SHA-256(previous entry's hash), forming a tamper-evident
 * chain. Verification walks the chain and checks each link.
 *
 * Canonical field order for hashing (colon-separated, matching Go):
 *   {seq}:{ts}:{actor}:{action}:{resource}:{detail}:{prev_hash}
 *
 * Genesis marker: first entry uses prev_hash = "genesis" (matching Go).
 *
 * Source: core/test/traceability_test.go
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AuditEntry } from '@dina/test-harness';

export type { AuditEntry } from '@dina/test-harness';

/** Genesis marker for the first entry in the chain. Matches Go's `prev_hash = "genesis"`. */
export const GENESIS_MARKER = 'genesis';

/**
 * Compute the hash for an audit entry (SHA-256 of canonical fields).
 *
 * Canonical string: "{seq}:{ts}:{actor}:{action}:{resource}:{detail}:{prev_hash}"
 * Colon separator matches Go's hash chain format.
 * This ensures any field modification is detectable.
 */
export function computeEntryHash(entry: Omit<AuditEntry, 'entry_hash'>): string {
  const canonical = [
    entry.seq,
    entry.ts,
    entry.actor,
    entry.action,
    entry.resource,
    entry.detail,
    entry.prev_hash,
  ].join(':');

  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/**
 * Compute prev_hash for a new entry.
 * For the first entry in the chain, returns the genesis marker.
 * For subsequent entries, returns the previous entry's entry_hash.
 */
export function computePrevHash(previousEntryHash: string): string {
  return previousEntryHash || GENESIS_MARKER;
}

/**
 * Build a complete audit entry with computed hashes.
 *
 * @param seq - Sequence number (1-indexed, monotonically increasing)
 * @param actor - Who performed the action (e.g., "brain", "admin", "user")
 * @param action - What was done (e.g., "vault_query", "persona_unlock")
 * @param resource - What was affected (e.g., "/health", "contact:alice")
 * @param detail - Human-readable description
 * @param previousEntryHash - Hash of the previous entry (empty for first entry)
 */
export function buildAuditEntry(
  seq: number,
  actor: string,
  action: string,
  resource: string,
  detail: string,
  previousEntryHash: string,
  tsOverride?: number,
): AuditEntry {
  const prev_hash = computePrevHash(previousEntryHash);
  const ts = tsOverride ?? Math.floor(Date.now() / 1000);

  const partial = { seq, ts, actor, action, resource, detail, prev_hash };
  const entry_hash = computeEntryHash(partial);

  return { ...partial, entry_hash };
}

/**
 * Verify a chain of audit entries.
 *
 * Walks the chain and checks:
 * 1. First entry's prev_hash must be the genesis marker
 * 2. Each subsequent entry's prev_hash matches the prior entry's entry_hash
 * 3. Each entry's entry_hash matches its recomputed hash
 *
 * @returns { valid: true } or { valid: false, brokenAt: index }
 */
export function verifyChain(entries: AuditEntry[]): { valid: boolean; brokenAt?: number } {
  if (entries.length === 0) return { valid: true };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Check prev_hash links correctly
    if (i === 0) {
      // First entry: prev_hash must be genesis marker
      if (entry.prev_hash !== GENESIS_MARKER) {
        return { valid: false, brokenAt: i };
      }
    } else {
      // Subsequent: prev_hash must match prior entry's entry_hash
      if (entry.prev_hash !== entries[i - 1].entry_hash) {
        return { valid: false, brokenAt: i };
      }
    }

    // Check entry_hash integrity
    const { entry_hash: _, ...partial } = entry;
    const recomputed = computeEntryHash(partial);
    if (recomputed !== entry.entry_hash) {
      return { valid: false, brokenAt: i };
    }
  }

  return { valid: true };
}

/**
 * Verify a single link in the chain.
 * Checks that entry.prev_hash matches the expected previous hash.
 */
export function verifyLink(entry: AuditEntry, previousEntryHash: string): boolean {
  return entry.prev_hash === previousEntryHash;
}
