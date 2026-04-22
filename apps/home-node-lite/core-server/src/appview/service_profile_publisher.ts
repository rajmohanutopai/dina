/**
 * Task 6.19 — Publish to `com.dina.service.profile`.
 *
 * When a Home Node exposes a D2D capability, it publishes a
 * `com.dina.service.profile` record to its AT Protocol PDS. The
 * AppView (`appview/src/ingester/handlers/service-profile.ts`)
 * picks it up from the firehose + indexes the capabilities so
 * requesters can discover the provider via `service.search`.
 *
 * This module is the publisher primitive — it takes a built
 * profile (from `ProfileBuilder` task 6.17) + an injected
 * `putRecordFn` (production wires to `PDSClient.putRecord`) and
 * executes the publish with structured outcomes + retry-friendly
 * error shapes.
 *
 * **Pattern**:
 *
 *   1. Validate the profile shape inline (final defensive check —
 *      ProfileBuilder should have caught structural issues; we only
 *      re-check the `$type` field + `isPublic` flag to guard against
 *      a bug that snuck a malformed record past the builder).
 *   2. Call `putRecordFn(collection, rkey, record)` — PDS writes
 *      are idempotent by (repo, collection, rkey).
 *   3. Return `{ok: true, cid, uri}` on success, structured
 *      failure otherwise.
 *
 * **Retry semantics**: the publisher does NOT retry internally —
 * callers (the auto-republisher in task 6.20) decide retry policy.
 * Network errors surface as `{ok: false, reason: 'network_error'}`;
 * validation rejections as `{ok: false, reason: 'malformed_profile'}`.
 * A `PDS.putRecord` rejection with a structured body passes through
 * verbatim so the caller can inspect (e.g. rate limited, auth
 * expired).
 *
 * **Rkey strategy**: the rkey for `service.profile` is always
 * `'self'` — each account has exactly one service profile.
 * Multiple records are nonsensical; `putRecord` idempotency +
 * a fixed rkey makes the publish trivially re-runnable.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6e task 6.19.
 */

import type { ServiceProfileRecord } from './profile_builder';

export const SERVICE_PROFILE_COLLECTION = 'com.dina.service.profile' as const;
/** Every actor has exactly one service profile. */
export const SERVICE_PROFILE_RKEY = 'self' as const;

export interface PutRecordInput {
  collection: typeof SERVICE_PROFILE_COLLECTION;
  rkey: typeof SERVICE_PROFILE_RKEY;
  record: ServiceProfileRecord;
}

export interface PutRecordResult {
  /** AT Protocol CID of the committed record. */
  cid: string;
  /** Full AT URI (e.g. `at://did:plc:…/com.dina.service.profile/self`). */
  uri: string;
}

/**
 * Fetcher — production wires to `PDSClient.putRecord`. Throws on
 * transport / HTTP errors; returns the committed `{cid, uri}` on
 * success.
 */
export type PutRecordFn = (input: PutRecordInput) => Promise<PutRecordResult>;

export type PublishOutcome =
  | { ok: true; cid: string; uri: string }
  | { ok: false; reason: 'malformed_profile'; detail: string }
  | { ok: false; reason: 'network_error'; error: string }
  | { ok: false; reason: 'rejected_by_pds'; status?: number; error: string };

export interface ServiceProfilePublisherOptions {
  putRecordFn: PutRecordFn;
  /** Diagnostic hook. */
  onEvent?: (event: ServiceProfilePublisherEvent) => void;
}

export type ServiceProfilePublisherEvent =
  | { kind: 'publishing'; schemaHashSet: string[] }
  | { kind: 'published'; cid: string; uri: string; durationMs: number }
  | { kind: 'rejected'; reason: string; detail?: string };

/**
 * Single-shot publisher. Production wires one instance per Brain;
 * tests pass a scripted `putRecordFn`. Safe to share across
 * concurrent publishes — stateless beyond the injected fn.
 */
export class ServiceProfilePublisher {
  private readonly putRecordFn: PutRecordFn;
  private readonly onEvent?: (event: ServiceProfilePublisherEvent) => void;

  constructor(opts: ServiceProfilePublisherOptions) {
    if (typeof opts?.putRecordFn !== 'function') {
      throw new TypeError('ServiceProfilePublisher: putRecordFn is required');
    }
    this.putRecordFn = opts.putRecordFn;
    this.onEvent = opts.onEvent;
  }

  /**
   * Publish `profile` to the actor's PDS at
   * `com.dina.service.profile/self`. Never throws — every failure
   * path returns a structured outcome.
   */
  async publish(profile: ServiceProfileRecord): Promise<PublishOutcome> {
    const validation = validateProfile(profile);
    if (validation !== null) {
      this.onEvent?.({
        kind: 'rejected',
        reason: 'malformed_profile',
        detail: validation,
      });
      return { ok: false, reason: 'malformed_profile', detail: validation };
    }

    this.onEvent?.({
      kind: 'publishing',
      schemaHashSet: Object.values(profile.capabilitySchemas).map(
        (s) => s.schema_hash,
      ),
    });

    const start = Date.now();
    try {
      const result = await this.putRecordFn({
        collection: SERVICE_PROFILE_COLLECTION,
        rkey: SERVICE_PROFILE_RKEY,
        record: profile,
      });
      if (!result || typeof result.cid !== 'string' || typeof result.uri !== 'string') {
        this.onEvent?.({
          kind: 'rejected',
          reason: 'rejected_by_pds',
          detail: 'putRecordFn returned malformed result',
        });
        return {
          ok: false,
          reason: 'rejected_by_pds',
          error: 'putRecordFn returned malformed result',
        };
      }
      this.onEvent?.({
        kind: 'published',
        cid: result.cid,
        uri: result.uri,
        durationMs: Date.now() - start,
      });
      return { ok: true, cid: result.cid, uri: result.uri };
    } catch (err) {
      return this.categoriseError(err);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private categoriseError(err: unknown): PublishOutcome {
    const msg = err instanceof Error ? err.message : String(err);
    // PDS errors carry a `status` field (optional) — preserve when present.
    const status =
      err !== null &&
      typeof err === 'object' &&
      typeof (err as { status?: unknown }).status === 'number'
        ? ((err as { status: number }).status)
        : undefined;
    if (status !== undefined) {
      this.onEvent?.({
        kind: 'rejected',
        reason: 'rejected_by_pds',
        detail: `status ${status}: ${msg}`,
      });
      return { ok: false, reason: 'rejected_by_pds', status, error: msg };
    }
    this.onEvent?.({ kind: 'rejected', reason: 'network_error', detail: msg });
    return { ok: false, reason: 'network_error', error: msg };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Defensive validation — the ProfileBuilder (6.17) is
 * authoritative, but the publisher does not assume the caller
 * passed a freshly-built record. This guard catches the common
 * shape mistakes without re-running the full schema validation.
 */
function validateProfile(profile: ServiceProfileRecord): string | null {
  if (!profile || typeof profile !== 'object') {
    return 'profile must be an object';
  }
  if (profile.$type !== SERVICE_PROFILE_COLLECTION) {
    return `$type must be "${SERVICE_PROFILE_COLLECTION}" (got ${JSON.stringify(profile.$type)})`;
  }
  if (typeof profile.name !== 'string' || profile.name.trim() === '') {
    return 'name must be a non-empty string';
  }
  if (typeof profile.isPublic !== 'boolean') {
    return 'isPublic must be a boolean';
  }
  if (!Array.isArray(profile.capabilities) || profile.capabilities.length === 0) {
    return 'capabilities must be a non-empty array';
  }
  if (
    !profile.capabilitySchemas ||
    typeof profile.capabilitySchemas !== 'object' ||
    Array.isArray(profile.capabilitySchemas)
  ) {
    return 'capabilitySchemas must be an object';
  }
  // Every capability must have a schema + schema_hash.
  for (const cap of profile.capabilities) {
    const schema = profile.capabilitySchemas[cap];
    if (!schema) {
      return `capabilitySchemas missing entry for "${cap}"`;
    }
    if (typeof schema.schema_hash !== 'string' || schema.schema_hash === '') {
      return `capabilitySchemas["${cap}"].schema_hash must be a non-empty string`;
    }
  }
  return null;
}
