/**
 * Audit service — append-only hash-chained log with query and retention.
 *
 * Every security-relevant action is appended to the audit log.
 * Entries form a tamper-evident chain (SHA-256 hash of previous entry).
 * 90-day retention: older entries are purged by sweepRetention.
 *
 * Key design decisions (matching Go audit.go):
 *   - Colon-separated canonical hash format
 *   - Genesis marker "genesis" for first entry
 *   - Monotonic seq counter (never reused, even after purge)
 *   - Newest-first query order
 *   - Max query limit of 200
 *
 * Source: ARCHITECTURE.md Task 2.48
 */

import { buildAuditEntry, computeEntryHash, type AuditEntry } from './hash_chain';
import { getAuditRepository, type AuditRepository } from './repository';

/** Default retention period in days. Configurable via setRetentionDays(). */
let retentionDays = 90;

function getRetentionMs(): number {
  return retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * Set the audit retention period in days.
 * Default: 90 days. Matching Go's configurable retention.
 */
export function setRetentionDays(days: number): void {
  if (days < 1) throw new Error('audit: retention must be at least 1 day');
  retentionDays = days;
}

/** Get the current retention period in days. */
export function getRetentionDays(): number {
  return retentionDays;
}

// ---------------------------------------------------------------
// Structured audit detail (matching Go's JSON-packed detail field)
// ---------------------------------------------------------------

/**
 * Structured audit detail — sub-fields packed into JSON.
 *
 * Matching Go's detail JSON blob with query_type, reason, metadata.
 * The flat `detail` string is replaced with structured context
 * that preserves audit semantics.
 */
export interface AuditDetail {
  query_type?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  text?: string; // free-form text (backward compatible with flat detail)
}

/**
 * Build a JSON-packed detail string from structured sub-fields.
 * Matching Go's detail JSON packing.
 */
export function buildAuditDetail(detail: AuditDetail): string {
  // Bounded here too, but this is NOT what makes the guarantee — `appendAudit`
  // re-packs any over-long structured detail with the same caps, whatever
  // built it. It has to: this function is reachable only through
  // `appendAuditWithDetail`, which has no production caller, while the JSON
  // details the codebase actually writes are `JSON.stringify(...)` handed
  // straight to `appendAudit`. A bound that lives only here would apply to
  // nothing that ships.
  //
  // Values only; the keys are this module's own. `metadata` strings are capped
  // and non-strings left alone, since counts and hashes are what callers pack.
  const capped: AuditDetail = {
    ...(detail.query_type === undefined
      ? {}
      : { query_type: detail.query_type.slice(0, MAX_DETAIL_FIELD) }),
    ...(detail.reason === undefined ? {} : { reason: detail.reason.slice(0, MAX_DETAIL_FIELD) }),
    ...(detail.text === undefined ? {} : { text: detail.text.slice(0, MAX_DETAIL_FIELD) }),
    ...(detail.metadata === undefined
      ? {}
      : {
          metadata: Object.fromEntries(
            Object.entries(detail.metadata).map(([key, value]) => [
              key,
              typeof value === 'string' ? value.slice(0, MAX_DETAIL_FIELD) : value,
            ]),
          ),
        }),
  };
  return JSON.stringify(capped);
}

/**
 * Parse a detail string back into structured sub-fields.
 * If the detail is not valid JSON, wraps it as { text: detail }.
 */
export function parseAuditDetail(detail: string): AuditDetail {
  if (!detail) return {};
  try {
    return JSON.parse(detail);
  } catch {
    return { text: detail };
  }
}

/** Maximum query result size (matching Go's cap). */
const MAX_QUERY_LIMIT = 200;

/** In-memory audit log. Append-only array. */
const log: AuditEntry[] = [];

/** Repetitive low-risk decisions may be sampled without skipping evaluation. */
const sampledAtMs = new Map<string, number>();
const MAX_SAMPLE_KEYS = 2_048;

/**
 * Monotonic sequence counter — never decremented, even after purge.
 * Prevents seq collision that would occur with `log.length + 1`.
 * Matches Go's AUTOINCREMENT behavior.
 */
let nextSeq = 1;
let retainedAnchorHash = 'genesis';

/**
 * Load and validate the durable chain before routes begin serving traffic.
 * A tampered or structurally invalid audit database is not silently replaced
 * with a fresh chain.
 */
export function hydrateAuditState(repository: AuditRepository | null = getAuditRepository()): void {
  if (repository === null) return;
  const entries = repository.allEntries();
  const highestSequence = repository.highestSequence();
  const checkpoint = repository.retentionCheckpoint();
  const anchorHash = checkpoint?.anchorHash ?? 'genesis';
  const expectedFirstSequence = checkpoint?.firstRetainedSeq ?? 1;
  const actualFirstSequence = entries[0]?.seq ?? highestSequence + 1;
  const latestSequence = entries[entries.length - 1]?.seq ?? 0;
  const tailMatches =
    entries.length > 0
      ? latestSequence === highestSequence
      : checkpoint === null
        ? highestSequence === 0
        : highestSequence === expectedFirstSequence - 1;
  if (
    actualFirstSequence !== expectedFirstSequence ||
    !tailMatches ||
    !verifyRetainedChain(entries, anchorHash).valid
  ) {
    throw new Error('audit: durable hash chain verification failed');
  }
  log.length = 0;
  log.push(...entries);
  sampledAtMs.clear();
  retainedAnchorHash = anchorHash;
  nextSeq = highestSequence + 1;
}

/**
 * Append an audit entry.
 *
 * Automatically computes seq (monotonic), prev_hash, and entry_hash
 * using the hash_chain primitives. Returns the appended entry.
 */
/**
 * Longest `detail` that reaches the chained log. Generous for metadata and an
 * error message tail, far below anything a peer could use to bloat the log.
 */
const MAX_AUDIT_DETAIL = 512;

/**
 * Bound ONE peer-controlled field before it is interpolated into a detail.
 *
 * A CALL-SITE helper, not the sink — `guardAuditDetail` below is what every
 * detail passes through, and it cannot be bypassed. This exists for the
 * narrower job the sink cannot do: when a line interpolates a variable field
 * alongside a fixed one, capping the variable field here keeps the fixed part
 * from being pushed past the overall cap. See the commerce line in
 * `receive_pipeline.ts`, which caps `query_id` and `capability` and puts
 * `outcome=` first so the ordering makes the guarantee twice.
 *
 * WHY PEER FIELDS NEED IT AT ALL. A `service.query`'s `capability` is checked
 * only for "is a non-empty string" by the wire validator — no length bound, no
 * charset restriction — and it flows straight into an audit detail.
 *
 * This mirrors `sanitizeStatusText`, which does the same job for runner-
 * supplied status text: the identical hazard from a less hostile source.
 */
export function sanitizeAuditDetail(value: string, maxLen = MAX_AUDIT_DETAIL): string {
  let out = '';
  for (let i = 0; i < value.length && out.length < maxLen; i++) {
    const c = value.charCodeAt(i);
    out += c <= 0x1f || c === 0x7f ? ' ' : value[i];
  }
  return out.trim();
}

/**
 * Replace control characters, and nothing else.
 *
 * The forgery vector is the newline — it makes one entry render as several —
 * and that is worth removing from every detail unconditionally. Length is a
 * separate question with a separate answer per shape, below.
 *
 * ONE THING IT CAN STILL TOUCH INSIDE PACKED JSON. `JSON.stringify` escapes
 * U+0000–U+001F, so those never appear raw in a structured detail and this
 * cannot reach them. It does NOT escape U+007F (DEL), which is emitted
 * literally and is replaced here. That is intended — DEL in an audit reason is
 * pathological rather than content — and the swap is length-preserving and
 * leaves the JSON valid, but it is a value being altered, so it is written
 * down rather than left as a surprise.
 *
 * NO WHITESPACE-RUN COLLAPSE. The first version of this collapsed `\s+` to a
 * single space, which quietly rewrote stored values: a JSON-packed detail
 * carrying `"reason": "a  b"` was stored as `"a b"`. Altering content inside a
 * log whose entire purpose is to be tamper-evident is worse than the cosmetic
 * tidiness it bought, and it applied to flat details too.
 */
function stripControlCharacters(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    out += c <= 0x1f || c === 0x7f ? ' ' : value[i];
  }
  return out;
}

/**
 * Bound a detail on its way into the chain, WITHOUT breaking a structured one.
 *
 * The whole sequence, in order:
 *   1. strip control characters from everything — the newline is the forgery
 *      vector and no detail legitimately carries one;
 *   2. a detail already within `MAX_AUDIT_DETAIL` is returned as it arrived;
 *   3. an over-long detail that PARSES as an object or array is re-packed
 *      through the shared caps by `repackBounded` and comes back shorter;
 *   4. anything else is sliced.
 *
 * WHY STEP 3 EXISTS. Slicing a JSON-packed detail at 512 bytes lands
 * mid-string, so it stops parsing — and `parseAuditDetail` answers a parse
 * failure with `{ text: <broken JSON> }`, which makes the agent-audit route
 * return a well-formed response with every field blank. Silent loss, invisible
 * from outside. Re-packing bounds it and keeps it parseable.
 *
 * THE BOUND DOES NOT DEPEND ON WHO BUILT THE DETAIL, and an earlier version of
 * this comment said the opposite — that structured details passed through
 * unshortened because `buildAuditDetail` had already bounded them, and that
 * this was safe because no peer content reaches the JSON path. Both claims
 * were false: `buildAuditDetail` is reachable only via `appendAuditWithDetail`,
 * which has no production caller, so the JSON details this codebase actually
 * writes met no cap anywhere. That reasoning is written down here because it is
 * what would invite someone to restore the exemption.
 */
function guardAuditDetail(detail: string): string {
  const singleLine = stripControlCharacters(detail);
  if (singleLine.length <= MAX_AUDIT_DETAIL) return singleLine;
  const repacked = repackBounded(singleLine);
  return repacked ?? singleLine.slice(0, MAX_AUDIT_DETAIL);
}

/** Hard ceiling for a structured detail after its fields have been bounded. */
const MAX_STRUCTURED_DETAIL = 4_096;
/** Most entries kept from one object or array. */
const MAX_DETAIL_ENTRIES = 32;
/** Deepest nesting kept. */
const MAX_DETAIL_DEPTH = 6;

/**
 * Bound every string, entry count and depth inside a parsed value.
 *
 * Recursive because `metadata` is free-form: capping only the top level would
 * bound `{"a": "..."}` and miss `{"a": {"b": "..."}}`.
 */
function boundJsonValue(value: unknown, dropped: { any: boolean }, depth = 0): unknown {
  if (depth > MAX_DETAIL_DEPTH) {
    dropped.any = true;
    return null;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_DETAIL_FIELD) dropped.any = true;
    return value.slice(0, MAX_DETAIL_FIELD);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_DETAIL_ENTRIES) dropped.any = true;
    return value
      .slice(0, MAX_DETAIL_ENTRIES)
      .map((entry) => boundJsonValue(entry, dropped, depth + 1));
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DETAIL_ENTRIES) dropped.any = true;
  return Object.fromEntries(
    entries
      .slice(0, MAX_DETAIL_ENTRIES)
      .map(([key, entry]) => {
        if (key.length > MAX_DETAIL_FIELD) dropped.any = true;
        return [key.slice(0, MAX_DETAIL_FIELD), boundJsonValue(entry, dropped, depth + 1)];
      }),
  );
}

/**
 * Re-pack an over-long structured detail so it is bounded AND still parses,
 * or `null` when it is not structured at all.
 *
 * WHY RE-PACK RATHER THAN EXEMPT. The first version of this waved long JSON
 * through on the stated grounds that `buildAuditDetail` had already bounded it
 * at the producer. That premise was false: `buildAuditDetail` is reachable only
 * via `appendAuditWithDetail`, which has NO production caller. Every JSON
 * detail this codebase actually writes is `JSON.stringify(...)` passed straight
 * to `appendAudit`, so those details met the producer cap nowhere and the
 * exemption removed the sink cap from exactly them — the unbounded write the
 * round-5 fix existed to close, re-opened behind a comment claiming it was
 * closed.
 *
 * Bounding here instead makes the guarantee independent of how a detail was
 * built. A writer that never heard of `buildAuditDetail` gets the same bound,
 * which is the only version of this that survives the next new call site.
 *
 * Objects AND arrays: shape decided it before, so an array-shaped detail was
 * capped mid-string while an object-shaped one was not.
 *
 * The last resort keeps the parse guarantee rather than the content: if a value
 * is still over the ceiling once its fields are bounded, it becomes a small
 * valid object that says so. A consumer that reads sub-fields gets a parseable
 * object either way, never `{ text: <broken JSON> }`.
 */
function repackBounded(value: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const dropped = { any: false };
  const bounded = boundJsonValue(parsed, dropped);
  // SAY SO WHEN SOMETHING WAS DROPPED. A bounded-away sub-field reads back
  // through `parseAuditDetail` as `''` or `undefined`, which is exactly what a
  // field that was never set looks like — so an operator cannot tell a value
  // this node declined to store from one the writer never recorded. Only the
  // last-resort branch below used to admit it.
  //
  // Objects only: an array has nowhere to carry the marker without changing
  // the shape a consumer is reading.
  const marked =
    dropped.any && bounded !== null && typeof bounded === 'object' && !Array.isArray(bounded)
      ? { ...(bounded as Record<string, unknown>), truncated: true }
      : bounded;
  const serialized = JSON.stringify(marked);
  if (serialized !== undefined && serialized.length <= MAX_STRUCTURED_DETAIL) return serialized;
  return JSON.stringify({ text: value.slice(0, MAX_DETAIL_FIELD), truncated: true });
}

/**
 * Longest free-text value inside a JSON-packed detail.
 *
 * Applied in BOTH places, which is what makes it a guarantee rather than a
 * convention: `buildAuditDetail` caps its fields when a caller uses it, and
 * `boundJsonValue` applies the same cap at the sink for every detail that
 * reaches it, however it was built.
 */
const MAX_DETAIL_FIELD = 256;

export function appendAudit(
  actor: string,
  action: string,
  resource: string,
  detail?: string,
  /** Optional Unix-seconds timestamp override for import/migration. */
  tsOverride?: number,
): AuditEntry | null {
  // Input validation — actor and action are required (matching Go's error path)
  if (!actor || actor.trim().length === 0) {
    throw new Error('audit: actor is required');
  }
  if (!action || action.trim().length === 0) {
    throw new Error('audit: action is required');
  }

  const seq = nextSeq;
  const prevHash =
    log.length > 0
      ? log[log.length - 1].entry_hash
      : retainedAnchorHash === 'genesis'
        ? ''
        : retainedAnchorHash;
  const entry = buildAuditEntry(
    seq,
    actor,
    action,
    resource,
    guardAuditDetail(detail ?? ''),
    prevHash,
    tsOverride,
  );
  const sqlRepo = getAuditRepository();
  if (sqlRepo) {
    try {
      sqlRepo.append(entry);
    } catch {
      // Audit is a best-effort side effect at existing call sites. Do not
      // publish an in-memory entry that did not commit, but also do not turn a
      // completed external action into a retry and risk executing it twice.
      return null;
    }
  }
  log.push(entry);
  nextSeq += 1;
  return entry;
}

/**
 * Append at most one matching audit event per sampling window.
 *
 * This is for repetitive SAFE/allow decisions only. Policy evaluation still
 * runs for every call, while high-risk, denied, and approval decisions continue
 * to use appendAudit and are never sampled.
 */
export function appendSampledAudit(
  actor: string,
  action: string,
  resource: string,
  detail: string,
  options: {
    key: string;
    intervalMs: number;
    nowMs?: number;
  },
): AuditEntry | null {
  if (options.intervalMs < 1) {
    throw new Error('audit: sample interval must be positive');
  }
  const nowMs = options.nowMs ?? Date.now();
  const lastAt = sampledAtMs.get(options.key);
  if (lastAt !== undefined && nowMs - lastAt < options.intervalMs) {
    return null;
  }

  if (sampledAtMs.size >= MAX_SAMPLE_KEYS) {
    const staleBefore = nowMs - options.intervalMs;
    for (const [key, sampledAt] of sampledAtMs) {
      if (sampledAt < staleBefore) sampledAtMs.delete(key);
    }
    while (sampledAtMs.size >= MAX_SAMPLE_KEYS) {
      const oldestKey = sampledAtMs.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      sampledAtMs.delete(oldestKey);
    }
  }

  const entry = appendAudit(actor, action, resource, detail);
  if (entry !== null) {
    sampledAtMs.delete(options.key);
    sampledAtMs.set(options.key, nowMs);
  }
  return entry;
}

/**
 * Append an audit entry with structured detail (JSON-packed sub-fields).
 *
 * Matching Go's audit entries that pack query_type, reason, metadata
 * into the detail JSON blob.
 */
export function appendAuditWithDetail(
  actor: string,
  action: string,
  resource: string,
  detail: AuditDetail,
): AuditEntry | null {
  return appendAudit(actor, action, resource, buildAuditDetail(detail));
}

/**
 * Query audit entries with optional filters.
 *
 * Filters by actor, action, resource, and time range.
 * Returns matching entries in newest-first order (matching Go).
 * Limit is capped at MAX_QUERY_LIMIT (200).
 */
export function queryAudit(filters?: {
  actor?: string;
  action?: string;
  resource?: string;
  since?: number; // unix ms timestamp
  until?: number; // unix ms timestamp
  limit?: number;
}): AuditEntry[] {
  let results = [...log];

  if (filters?.actor) {
    results = results.filter((e) => e.actor === filters.actor);
  }
  if (filters?.action) {
    results = results.filter((e) => e.action === filters.action);
  }
  if (filters?.resource) {
    results = results.filter((e) => e.resource === filters.resource);
  }
  if (filters?.since) {
    const sinceS = Math.floor(filters.since / 1000);
    results = results.filter((e) => e.ts >= sinceS);
  }
  if (filters?.until) {
    const untilS = Math.floor(filters.until / 1000);
    results = results.filter((e) => e.ts <= untilS);
  }

  // Newest-first ordering (matching Go's default)
  results.reverse();

  // Apply limit with cap
  const effectiveLimit = filters?.limit
    ? Math.min(filters.limit, MAX_QUERY_LIMIT)
    : MAX_QUERY_LIMIT;
  results = results.slice(0, effectiveLimit);

  return results;
}

/**
 * Verify the integrity of the full audit chain.
 *
 * Returns { valid: true } if the chain is intact, or
 * { valid: false, brokenAt: N } if entry N's hash doesn't match.
 */
export function verifyAuditChain(): { valid: boolean; brokenAt?: number } {
  return verifyRetainedChain(log, retainedAnchorHash);
}

/**
 * Sweep entries older than 90 days.
 * Returns the count of purged entries.
 *
 * Uses splice instead of shift() loop for O(n) instead of O(n²).
 *
 * Note: this breaks the hash chain at the purge point.
 * In production, a compaction marker is stored so verification
 * starts from the new head.
 */
export function sweepRetention(now?: number): number {
  const cutoff = ((now ?? Date.now()) - getRetentionMs()) / 1000;

  // Find first entry that's within retention
  const keepFromIndex = log.findIndex((e) => e.ts >= cutoff);

  if (keepFromIndex === -1) {
    // All entries are old — purge everything
    const purged = log.length;
    if (purged === 0) return 0;
    const lastRemoved = log[log.length - 1];
    const checkpoint = {
      firstRetainedSeq: lastRemoved.seq + 1,
      anchorHash: lastRemoved.entry_hash,
    };
    const sqlRepo = getAuditRepository();
    if (sqlRepo) sqlRepo.compact(checkpoint);
    log.length = 0;
    retainedAnchorHash = checkpoint.anchorHash;
    return purged;
  }

  if (keepFromIndex === 0) {
    return 0; // nothing to purge
  }

  // Splice out old entries in one operation (O(n))
  const purged = keepFromIndex;
  const checkpoint = {
    firstRetainedSeq: log[keepFromIndex].seq,
    anchorHash: log[keepFromIndex].prev_hash,
  };
  const sqlRepo = getAuditRepository();
  if (sqlRepo) sqlRepo.compact(checkpoint);
  log.splice(0, keepFromIndex);
  retainedAnchorHash = checkpoint.anchorHash;
  return purged;
}

/** Get the total number of audit entries. */
export function auditCount(): number {
  return log.length;
}

/** Get the latest entry. Returns null if log is empty. */
export function latestEntry(): AuditEntry | null {
  return log.length > 0 ? log[log.length - 1] : null;
}

/** Reset all audit state (for testing). */
export function resetAuditState(): void {
  log.length = 0;
  sampledAtMs.clear();
  nextSeq = 1;
  retainedAnchorHash = 'genesis';
  retentionDays = 90;
}

function verifyRetainedChain(
  entries: readonly AuditEntry[],
  anchorHash: string = entries[0]?.prev_hash ?? 'genesis',
): { valid: boolean; brokenAt?: number } {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedPrevious = index === 0 ? anchorHash : entries[index - 1].entry_hash;
    if (
      !Number.isSafeInteger(entry.seq) ||
      entry.seq < 1 ||
      (index > 0 && entry.seq !== entries[index - 1].seq + 1) ||
      entry.prev_hash !== expectedPrevious
    ) {
      return { valid: false, brokenAt: index };
    }
    const { entry_hash: _entryHash, ...unsigned } = entry;
    if (computeEntryHash(unsigned) !== entry.entry_hash) {
      return { valid: false, brokenAt: index };
    }
  }
  return { valid: true };
}
