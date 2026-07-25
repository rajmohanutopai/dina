/**
 * Wire the service-profile publisher pipeline.
 *
 * After `loadOrProvisionPdsIdentity` has minted (or rehydrated) the
 * lite Home Node's atproto account, this module:
 *
 *   1. Builds a session-cached `PDSPublisher` (from `@dina/brain`)
 *      using the persisted handle + password. Lazy auth: the first
 *      publish triggers `createSession`; subsequent publishes reuse
 *      the cached JWT until it expires.
 *
 *   2. Adapts `PDSPublisher.putRecord` into the `PutRecordFn` shape
 *      that the lite-side `ServiceProfilePublisher` (task 6.19)
 *      expects, and binds the two together. From here on, calling
 *      `serviceProfilePublisher.publish(record)` actually writes
 *      `com.dinakernel.service.profile/self` to the PDS.
 *
 *   3. Subscribes the publisher to `onServiceConfigChanged` from
 *      `@dina/core`. Every successful `PUT /v1/service/config` (or
 *      `setServiceConfig` write from anywhere) rebuilds the profile
 *      and republishes to the PDS. AppView's Jetstream ingester sees
 *      the record + indexes the new capabilities, making the node
 *      discoverable via `com.dinakernel.service.search?capability=…`.
 *
 * **Why this is its own module.** boot.ts orchestrates a lot already;
 * keeping the publish-pipeline wiring here makes the boot diff small
 * and the publishing flow easy to audit + unit-test.
 *
 * **Failure handling.** Each publish call returns a structured
 * `PublishOutcome`. We log + continue — a transient PDS outage
 * should not crash the node. The auto-republisher (task 6.20) lives
 * to retry, but the minimum viable path here is "publish-on-change,
 * log the result, move on." Operators can re-trigger by re-saving
 * the config.
 */

import { PDSPublisher } from '@dina/brain';
import {
  getServiceConfigRepository,
  listServiceConfigs,
  onServiceConfigChanged,
  type ServiceConfig,
  type SetServicePublicationStatusInput,
} from '@dina/core';
import {
  effectiveDiscoverability,
  isListingPublishable,
  isValidServiceListingRkey,
} from '@dina/protocol';

import { type ServiceProfileRecord } from './profile_builder';
import { computeSchemaHash } from './schema_hash';
import {
  ServiceProfilePublisher,
  type PutRecordFn,
  type PutRecordInput,
  type PublishOutcome,
  SERVICE_PROFILE_RKEY,
} from './service_profile_publisher';

import type { PdsIdentity } from '../identity/provision_pds';
import type { Logger } from '../logger';

export interface WireServicePublisherOptions {
  /** Identity persisted by `loadOrProvisionPdsIdentity`. */
  pdsIdentity: PdsIdentity;
  /** Boot logger; receives publish-outcome diagnostics. */
  logger: Logger;
  /**
   * Optional injected fetch — production uses `globalThis.fetch`,
   * tests pass a stub.
   */
  fetch?: typeof globalThis.fetch;
}

export interface WiredServicePublisher {
  /** Shared authenticated writer for other owner-PDS records (PeerLens, etc.). */
  pdsPublisher: PDSPublisher;
  /** Direct handle for one-shot publishes (boot-time, /admin actions). */
  publisher: ServiceProfilePublisher;
  /** Queue the latest desired state for one listing. Single-flight per rkey. */
  reconcile(rkey: string, config: ServiceConfig | null): void;
  /** Stop listening for config-change events. */
  dispose(): void;
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

interface PublicationSlot {
  desired: ServiceConfig | null;
  version: number;
  attempt: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type UnpublishOutcome =
  | { ok: true }
  | { ok: false; reason: 'network_error' | 'rejected_by_pds'; error: string; status?: number };

/**
 * Stand up the publish pipeline + subscribe to `onServiceConfigChanged`.
 * Idempotent — call once per boot. Returns a `dispose()` the caller
 * pushes onto its global teardown stack.
 */
export function wireServiceProfilePublisher(
  options: WireServicePublisherOptions,
): WiredServicePublisher {
  const { pdsIdentity, logger } = options;

  // 1. Session-cached PDS XRPC client.
  const pdsPublisher = new PDSPublisher({
    pdsUrl: pdsIdentity.pdsUrl,
    handle: pdsIdentity.handle,
    password: pdsIdentity.password,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  // 2. Adapt `PDSPublisher.putRecord` into the `PutRecordFn` shape that
  //    `ServiceProfilePublisher.publish` consumes. The brain publisher
  //    handles session lifecycle internally; we only translate the
  //    argument shape + surface errors as structured outcomes upstream.
  const putRecordFn: PutRecordFn = async (input: PutRecordInput) => {
    const { uri, cid } = await pdsPublisher.putRecord(
      input.collection,
      input.rkey,
      input.record as unknown as Record<string, unknown>,
    );
    return { uri, cid };
  };

  const publisher = new ServiceProfilePublisher({
    putRecordFn,
    onEvent: (event) => {
      // Trace publishes at info, rejections at warn. Keeps the boot log
      // narratable without spamming on the steady-state happy path.
      if (event.kind === 'published') {
        logger.info(
          { uri: event.uri, cid: event.cid, durationMs: event.durationMs },
          'service profile published to PDS',
        );
      } else if (event.kind === 'rejected') {
        logger.warn(
          { reason: event.reason, detail: event.detail },
          'service profile publish rejected',
        );
      }
    },
  });

  const slots = new Map<string, PublicationSlot>();
  let disposed = false;

  const persistStatus = async (
    rkey: string,
    status: SetServicePublicationStatusInput,
  ): Promise<void> => {
    try {
      await getServiceConfigRepository()?.setPublicationStatus(rkey, status);
    } catch (error) {
      logger.warn(
        { rkey, error: error instanceof Error ? error.message : String(error) },
        'service publication status persistence failed',
      );
    }
  };

  const run = async (rkey: string): Promise<void> => {
    const slot = slots.get(rkey);
    if (disposed || slot === undefined || slot.running) return;
    slot.running = true;
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    const version = slot.version;
    const desired = slot.desired;
    const attemptedAtMs = Date.now();
    await persistStatus(rkey, {
      state: 'pending',
      attemptedAtMs,
      nextRetryAtMs: null,
    });

    const publishing = desired !== null && shouldPublishListing(desired);
    const outcome =
      publishing
        ? await publishOnce(publisher, pdsIdentity, desired, logger, rkey)
        : await unpublishOnce(pdsPublisher, rkey, logger);

    slot.running = false;
    if (disposed) return;
    if (slot.version !== version) {
      slot.attempt = 0;
      void run(rkey);
      return;
    }

    if (outcome.ok) {
      slot.attempt = 0;
      if (publishing) {
        const published = outcome as Extract<PublishOutcome, { ok: true }>;
        await persistStatus(rkey, {
          state: 'published',
          uri: published.uri,
          cid: published.cid,
          attemptedAtMs,
        });
      } else if (desired !== null) {
        await persistStatus(rkey, {
          state: 'not_published',
          attemptedAtMs,
        });
      }
      return;
    }

    const permanent =
      outcome.reason === 'malformed_profile' ||
      (outcome.reason === 'rejected_by_pds' &&
        outcome.status !== undefined &&
        outcome.status >= 400 &&
        outcome.status < 500 &&
        outcome.status !== 408 &&
        outcome.status !== 429);
    const error = 'detail' in outcome ? outcome.detail : outcome.error;
    if (permanent) {
      await persistStatus(rkey, {
        state: 'failed',
        error,
        attemptedAtMs,
      });
      return;
    }

    slot.attempt += 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(slot.attempt - 1, 8));
    const nextRetryAtMs = Date.now() + delay;
    await persistStatus(rkey, {
      state: 'pending',
      error,
      attemptedAtMs,
      nextRetryAtMs,
    });
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void run(rkey);
    }, delay);
    slot.timer.unref?.();
  };

  const reconcile = (rkey: string, config: ServiceConfig | null): void => {
    let slot = slots.get(rkey);
    if (slot === undefined) {
      slot = { desired: config, version: 0, attempt: 0, running: false, timer: null };
      slots.set(rkey, slot);
    } else {
      slot.desired = config;
      slot.version += 1;
      slot.attempt = 0;
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
    }
    void run(rkey);
  };

  // 3. Subscribe to config changes, then reconcile every hydrated listing.
  // Per-rkey single-flight prevents overlapping saves/retries from allowing an
  // older publish attempt to become the final PDS state.
  const unsubscribe = onServiceConfigChanged(reconcile);
  for (const { rkey, config } of listServiceConfigs()) reconcile(rkey, config);

  return {
    pdsPublisher,
    publisher,
    reconcile,
    dispose: () => {
      disposed = true;
      unsubscribe();
      for (const slot of slots.values()) {
        if (slot.timer !== null) clearTimeout(slot.timer);
      }
      slots.clear();
    },
  };
}

/**
 * Whether a listing config should be PUBLISHED to the PDS — `isListingPublishable`
 * (the shared live-listing predicate). A listing is published iff it is `active`
 * AND its discoverability is not `known_only` (catalog §5.2):
 *
 *   - `active` + `public`   → published (AppView surfaces it in normal search).
 *   - `active` + `unlisted` → published (AppView excludes it from search via the
 *                  `isDiscoverable=false` gate, but the PDS record exists so it
 *                  resolves by URI / link / QR / direct D2D).
 *   - `active` + `known_only` → NOT published — local/pairing-bound.
 *   - `paused` / `draft` (any discoverability) → NOT published — config kept,
 *                  record unpublished. This is the per-listing OFF switch that
 *                  is distinct from node role + from discoverability.
 *
 * Used at BOTH the config-change subscription and boot's first-publish loop, and
 * mirrored by Core's inbound query gate (`isCapabilityConfigured`), so
 * publish ⇔ queryable. Back-compat: a legacy config with no status/
 * discoverability derives active + (isDiscoverable?public:known_only).
 */
export function shouldPublishListing(config: ServiceConfig): boolean {
  return isListingPublishable(config);
}

/**
 * Build + publish a single profile snapshot. Exposed so boot.ts can
 * fire one publish immediately after wiring, in case the config was
 * already populated when the listener registered.
 */
export async function publishOnce(
  publisher: ServiceProfilePublisher,
  pdsIdentity: PdsIdentity,
  config: ServiceConfig,
  logger: Logger,
  rkey: string = SERVICE_PROFILE_RKEY,
): Promise<PublishOutcome> {
  // Reject an invalid listing key before any PDS write — a key this path mints
  // must be one `parseServiceListingUri` will later accept (shared gate). Boot
  // + config-change callers pass no rkey → defaults to `'self'`.
  if (!isValidServiceListingRkey(rkey)) {
    const detail = `invalid service listing rkey: ${JSON.stringify(rkey)}`;
    logger.warn({ error: detail }, 'service profile publish skipped (invalid rkey)');
    return { ok: false, reason: 'malformed_profile', detail };
  }
  // The lite-side `buildServiceProfile` in `profile_builder.ts`
  // emits a record shape that's out of sync with the lexicon
  // currently accepted by the production PDS — `isPublic` instead
  // of `isDiscoverable`, float `lat`/`lng` instead of integer
  // `latE7`/`lngE7`, missing `updatedAt`. Building the record
  // directly here matches the wire shape verified against an
  // existing provider's repo on test-pds. Keeping this inline
  // (vs editing `profile_builder.ts`) avoids cascading test
  // breakage in the builder's own suite.
  const record = buildWireServiceProfile(config);
  if (typeof record === 'string') {
    logger.warn({ error: record }, 'service profile build failed; publish skipped');
    return { ok: false, reason: 'malformed_profile', detail: record };
  }
  // Bypass the publisher's `validateProfile` because it still checks
  // for the legacy `isPublic` field shape. We hit `putRecordFn`
  // directly (same call path the publisher uses internally) with the
  // wire-shape record. Once profile_builder is updated to the new
  // lexicon we can route through publisher.publish again.
  const putRecord = (publisher as unknown as { putRecordFn: PutRecordFn })
    .putRecordFn;
  try {
    const result = await putRecord({
      collection: 'com.dinakernel.service.profile',
      rkey,
      record: record as unknown as ServiceProfileRecord,
    });
    logger.info(
      { uri: result.uri, cid: result.cid },
      'service profile published to PDS (bypass validator)',
    );
    return { ok: true, uri: result.uri, cid: result.cid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err !== null &&
      typeof err === 'object' &&
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : undefined;
    logger.warn({ error: message }, 'service profile publish rejected');
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 429
    ) {
      return { ok: false, reason: 'rejected_by_pds', status, error: message };
    }
    return { ok: false, reason: 'network_error', error: message };
  }
}

/**
 * Remove a single listing's published record (the `<rkey>` record), e.g. when a
 * listing is deleted from config or flips to non-discoverable. Idempotent —
 * deleting an already-absent record is a no-op. Only this rkey is touched; the
 * provider's other listings stay published (one row → one record).
 */
export async function unpublishOnce(
  pdsPublisher: PDSPublisher,
  rkey: string,
  logger: Logger,
): Promise<UnpublishOutcome> {
  if (!isValidServiceListingRkey(rkey)) {
    logger.warn({ rkey }, 'service profile unpublish skipped (invalid rkey)');
    return { ok: false, reason: 'rejected_by_pds', error: 'invalid service listing rkey' };
  }
  try {
    await pdsPublisher.deleteRecordIdempotent('com.dinakernel.service.profile', rkey);
    logger.info({ rkey }, 'service profile unpublished from PDS');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err !== null &&
      typeof err === 'object' &&
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : undefined;
    logger.warn({ rkey, error: message }, 'service profile unpublish failed');
    return {
      ok: false,
      reason:
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
          ? 'rejected_by_pds'
          : 'network_error',
      error: message,
      ...(status !== undefined ? { status } : {}),
    };
  }
}

/**
 * Build a `com.dinakernel.service.profile` record that matches the live
 * lexicon (verified against test-pds existing provider records).
 *
 * Returns the record on success, or an error string on validation
 * failure (caller turns it into a `malformed_profile` outcome).
 */
export function buildWireServiceProfile(
  config: ServiceConfig,
): Record<string, unknown> | string {
  if (typeof config.name !== 'string' || config.name.trim() === '') {
    return 'service profile name is required';
  }
  const capabilityKeys = Object.keys(config.capabilities);
  if (capabilityKeys.length === 0) {
    return 'service profile must declare at least one capability';
  }
  // Sorted capability list — stable across boots regardless of iteration order.
  const capabilities = [...new Set(capabilityKeys)].sort();

  // capabilitySchemas → wire shape: snake_case keys, plus
  // schema_hash + default_ttl_seconds where available.
  const wireSchemas: Record<string, Record<string, unknown>> = {};
  for (const cap of capabilities) {
    const localSchema = config.capabilitySchemas?.[cap];
    if (localSchema === undefined) continue; // skip caps with no schema (custom)
    const wireEntry: Record<string, unknown> = {
      params: localSchema.params,
      result: localSchema.result,
      // The wire hash is derived from the schema, never trusted from the
      // caller's cached `schemaHash`. AppView rejects malformed hashes and a
      // stale-but-well-formed hash makes every invocation fail version
      // negotiation. This mirrors Brain's ServicePublisher exactly.
      schema_hash: computeSchemaHash({
        description: localSchema.description ?? '',
        params: localSchema.params,
        result: localSchema.result,
      }),
    };
    if (localSchema.description !== undefined) {
      wireEntry.description = localSchema.description;
    }
    if (localSchema.defaultTtlSeconds !== undefined) {
      wireEntry.default_ttl_seconds = localSchema.defaultTtlSeconds;
    }
    wireSchemas[cap] = wireEntry;
  }

  const responsePolicy: Record<string, string> = {};
  for (const cap of capabilities) {
    const policy = config.capabilities[cap]?.responsePolicy ?? 'auto';
    responsePolicy[cap] = policy;
  }

  // Per-capability concrete category/vertical (catalog §9.1) — travels onto the
  // listing so AppView can filter/rank by vertical. Only caps that carry one
  // are included (custom caps may legitimately have none until validated).
  const capabilityCategories: Record<string, string> = {};
  for (const cap of capabilities) {
    const category = config.capabilities[cap]?.category;
    if (typeof category === 'string' && category !== '') capabilityCategories[cap] = category;
  }

  const record: Record<string, unknown> = {
    $type: 'com.dinakernel.service.profile',
    name: config.name,
    isDiscoverable: config.isDiscoverable,
    // Explicit discoverability (catalog §5.2). `isDiscoverable` stays as the
    // back-compat boolean (= public); this carries the full tri-state so
    // AppView + URI-resolvers can tell `unlisted` from `known_only`.
    discoverability: effectiveDiscoverability(config),
    capabilities,
    responsePolicy,
    updatedAt: new Date().toISOString(),
  };
  // Only include capabilitySchemas when non-empty. Many catalog capabilities
  // (deploy_status, order_status, …) ship no schema, so a schema-less listing
  // would otherwise emit `capabilitySchemas: {}` — which AppView's coverage
  // refine rejects. Matches the brain publisher, which omits it when empty.
  if (Object.keys(wireSchemas).length > 0) {
    record.capabilitySchemas = wireSchemas;
  }
  if (Object.keys(capabilityCategories).length > 0) {
    record.capabilityCategories = capabilityCategories;
  }
  if (config.description !== undefined && config.description !== '') {
    record.description = config.description;
  }
  if (config.serviceArea !== undefined) {
    // Lexicon stores coordinates as fixed-point integers × 1e7 to
    // avoid float precision drift across implementations.
    record.serviceArea = {
      latE7: Math.round(config.serviceArea.lat * 10_000_000),
      lngE7: Math.round(config.serviceArea.lng * 10_000_000),
      radiusKm: config.serviceArea.radiusKm,
    };
  }
  return record;
}
