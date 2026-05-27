/**
 * D2D outbox facade — durable when a repository is installed, in-memory
 * otherwise (issues.txt §1).
 *
 * All operations delegate to `getD2DOutboxRepository()` when a SQLite
 * repo has been wired at boot, falling back to a process-local
 * `InMemoryD2DOutboxRepository` for dev/tests. This is the single seam
 * the send path (`d2d/send.ts`) and the retry drainer (`transport/
 * retry.ts`) speak through, so neither needs to know whether durability
 * is on.
 *
 * Policy (matches the original Go d2d_outbox): exponential backoff from
 * a 30 s base, dead-letter after 5 attempts, 24 h TTL. The message
 * stored is SEMANTIC (target DID + type + JSON body); the envelope is
 * re-sealed against a freshly-resolved recipient key at retry time.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  getD2DOutboxRepository,
  InMemoryD2DOutboxRepository,
  type D2DOutboxRepository,
  type D2DOutboxRow,
} from './outbox_repository';

/** Backoff base: 30 s (Go's MarkFailed: 30s * 2^(attempts-1)). */
export const BASE_BACKOFF_MS = 30_000;

/** Max delivery attempts before dead-letter (Go's maxRetries = 5). */
export const MAX_ATTEMPTS = 5;

/** Default time-to-live before a queued message is dead-lettered (24 h). */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Process-local fallback used only when no SQL repo is installed. */
const memoryRepo = new InMemoryD2DOutboxRepository();

/** The repository the facade currently routes through. */
function activeRepo(): D2DOutboxRepository {
  return getD2DOutboxRepository() ?? memoryRepo;
}

/** True when a durable (SQL) repository backs the outbox. */
export function isOutboxDurable(): boolean {
  return getD2DOutboxRepository() !== null;
}

/**
 * Compute the next-attempt delay for a message that has now failed
 * `attempts` times (1-based). 30s → 60s → 120s → 240s → 480s.
 */
export function computeBackoff(attempts: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
}

/**
 * Derive a stable idempotency key so a double-enqueue of the same
 * logical message collapses to one row. Service traffic keys on the
 * `query_id` carried in the body (the natural cross-Dina correlation
 * id); everything else keys on the per-send message id.
 */
export function deriveIdempotencyKey(
  messageType: string,
  bodyJson: string,
  messageId: string,
): string {
  try {
    const body = JSON.parse(bodyJson) as { query_id?: unknown };
    if (typeof body.query_id === 'string' && body.query_id !== '') {
      return `${messageType}:${body.query_id}`;
    }
  } catch {
    /* body isn't JSON — fall through to the message id */
  }
  return messageId;
}

export interface EnqueueD2DInput {
  targetDID: string;
  messageType: string;
  /** Semantic message body (JSON string), NOT sealed wire bytes. */
  bodyJson: string;
  /** Stable dedupe key; derived from the body/message id when omitted. */
  idempotencyKey?: string;
  /** Override the default 24 h TTL. */
  ttlMs?: number;
  /** Test clock override. */
  now?: number;
}

/**
 * Enqueue a D2D message for durable retry. Returns the persisted row.
 *
 * Throws if the underlying store rejects the write — the send path
 * relies on this so it never reports `queued: true` for a message that
 * didn't actually persist.
 */
export function enqueueD2D(input: EnqueueD2DInput): D2DOutboxRow {
  const now = input.now ?? Date.now();
  const id = `d2d-out-${bytesToHex(randomBytes(8))}`;
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  return activeRepo().insert({
    id,
    targetDID: input.targetDID,
    messageType: input.messageType,
    bodyJson: input.bodyJson,
    idempotencyKey:
      input.idempotencyKey ?? deriveIdempotencyKey(input.messageType, input.bodyJson, id),
    nextAttemptAt: now,
    expiresAt: ttl > 0 ? now + ttl : null,
    createdAt: now,
  });
}

/** Claim up to `limit` due messages for delivery (marks them `sending`). */
export function claimDue(now: number, leaseMs: number, limit: number): D2DOutboxRow[] {
  return activeRepo().claimDue(now, leaseMs, limit);
}

/** Mark a claimed message delivered. */
export function markSent(id: string, now?: number): void {
  activeRepo().markSent(id, now ?? Date.now());
}

/**
 * Record a failed delivery attempt. Increments the attempt counter and
 * either schedules a backoff retry or dead-letters the message when it
 * has hit `MAX_ATTEMPTS` or passed its TTL. Returns the terminal state
 * so the caller can audit dead-letters.
 */
export function recordFailure(row: D2DOutboxRow, error: string, now?: number): 'failed' | 'dead' {
  const t = now ?? Date.now();
  const attempts = row.attempts + 1;
  const expired = row.expiresAt !== null && row.expiresAt <= t;
  const repo = activeRepo();
  if (attempts >= MAX_ATTEMPTS || expired) {
    repo.markDead(row.id, expired ? `expired: ${error}` : `max_attempts: ${error}`, t);
    return 'dead';
  }
  repo.markFailed(row.id, attempts, t + computeBackoff(attempts), error, t);
  return 'failed';
}

/** Reclaim crashed-mid-send (`sending`, lease expired) rows. Run on boot. */
export function resetStaleSending(now?: number): number {
  return activeRepo().resetStaleSending(now ?? Date.now());
}

/** Drop terminal rows older than the TTL window (cleanup). */
export function sweepTerminal(now?: number, ttlMs: number = DEFAULT_TTL_MS): number {
  return activeRepo().deleteTerminalBefore((now ?? Date.now()) - ttlMs);
}

/** Look up a row (tests + diagnostics). */
export function getOutboxRow(id: string): D2DOutboxRow | null {
  return activeRepo().get(id);
}

/** Count rows in a state (tests + diagnostics). */
export function outboxCount(state?: D2DOutboxRow['state']): number {
  return state ? activeRepo().listByState(state).length : activeRepo().listAll().length;
}

/**
 * Clear the in-memory fallback (test isolation). Does NOT touch an
 * installed SQL repo — those tests manage their own database.
 */
export function clearOutbox(): void {
  memoryRepo.clear();
}
