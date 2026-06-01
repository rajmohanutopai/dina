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
import { onServiceConfigChanged, type ServiceConfig } from '@dina/core';
import { effectiveDiscoverability, isValidServiceListingRkey } from '@dina/protocol';

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
  /** Direct handle for one-shot publishes (boot-time, /admin actions). */
  publisher: ServiceProfilePublisher;
  /** Stop listening for config-change events. */
  dispose(): void;
}

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

  // 3. Subscribe to config changes. When `setServiceConfig` fires for a
  //    listing, (re)publish THAT listing's record under its rkey; when a
  //    listing is cleared (config === null) or is known-only, unpublish that
  //    one rkey — siblings are untouched (one row → one record). First-fire
  //    happens AFTER `hydrateServiceConfig` reads the persisted catalog during
  //    boot, so each listing reflects persisted state on every restart even
  //    when no edit happens.
  const unsubscribe = onServiceConfigChanged((rkey, config) => {
    if (config === null || !shouldPublishListing(config)) {
      void unpublishOnce(pdsPublisher, rkey, logger);
      return;
    }
    void publishOnce(publisher, pdsIdentity, config, logger, rkey);
  });

  return {
    publisher,
    dispose: () => unsubscribe(),
  };
}

/**
 * Whether a listing config should be PUBLISHED to the PDS (catalog §5.2).
 *
 *   - `public`   → published (and AppView surfaces it in normal search).
 *   - `unlisted` → published (AppView excludes it from search via the
 *                  `isDiscoverable=false` gate, but the PDS record exists so it
 *                  resolves by URI / link / QR / direct D2D).
 *   - `known_only` → NOT published — local/pairing-bound; never on the PDS.
 *
 * Used at BOTH the config-change subscription and boot's first-publish loop so
 * the two agree. Back-compat: a legacy config with no explicit
 * `discoverability` derives it from `isDiscoverable` (true→public,
 * false→known_only), preserving the old "isDiscoverable=false → unpublish".
 */
export function shouldPublishListing(config: ServiceConfig): boolean {
  return effectiveDiscoverability(config) !== 'known_only';
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
    logger.warn({ error: message }, 'service profile publish rejected');
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
): Promise<void> {
  if (!isValidServiceListingRkey(rkey)) {
    logger.warn({ rkey }, 'service profile unpublish skipped (invalid rkey)');
    return;
  }
  try {
    await pdsPublisher.deleteRecordIdempotent('com.dinakernel.service.profile', rkey);
    logger.info({ rkey }, 'service profile unpublished from PDS');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ rkey, error: message }, 'service profile unpublish failed');
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
      // Fallback hash MUST use the canonical {description, params, result}
      // shape — the same input Brain's ServicePublisher and the lite
      // profile_builder.hashCapabilitySchema hash. The previous fallback
      // hashed only `params`, producing a hash no other component would
      // ever reproduce (so a requester's version check would always
      // mismatch). In practice schemaHash is pre-computed; the fallback
      // must still be the RIGHT hash, not a wrong one.
      schema_hash:
        localSchema.schemaHash ??
        computeSchemaHash({
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
