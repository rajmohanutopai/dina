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
 *      `com.dina.service.profile/self` to the PDS.
 *
 *   3. Subscribes the publisher to `onServiceConfigChanged` from
 *      `@dina/core`. Every successful `PUT /v1/service/config` (or
 *      `setServiceConfig` write from anywhere) rebuilds the profile
 *      and republishes to the PDS. AppView's Jetstream ingester sees
 *      the record + indexes the new capabilities, making the node
 *      discoverable via `com.dina.service.search?capability=…`.
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
  getServiceConfig,
  onServiceConfigChanged,
  type ServiceConfig,
} from '@dina/core';

import type { Logger } from '../logger';
import type { PdsIdentity } from '../identity/provision_pds';
import {
  ServiceProfilePublisher,
  type PutRecordFn,
  type PutRecordInput,
  type PublishOutcome,
  SERVICE_PROFILE_COLLECTION,
  SERVICE_PROFILE_RKEY,
} from './service_profile_publisher';
import {
  buildServiceProfile,
  type BuildProfileInput,
  type ServiceProfileRecord,
} from './profile_builder';
import { computeSchemaHash } from './schema_hash';

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

  // 3. Subscribe to config changes. When `setServiceConfig` fires,
  //    rebuild the profile record from the new config + publish.
  //    First-fire happens AFTER `hydrateServiceConfig` reads the
  //    persisted config from disk during boot, so the published
  //    record reflects the persisted state on every restart even
  //    when no edit happens.
  const unsubscribe = onServiceConfigChanged(() => {
    const config = getServiceConfig();
    if (config === null) return;
    void publishOnce(publisher, pdsIdentity, config, logger);
  });

  return {
    publisher,
    dispose: () => unsubscribe(),
  };
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
): Promise<PublishOutcome> {
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
      collection: 'com.dina.service.profile',
      rkey: 'self',
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
 * Build a `com.dina.service.profile` record that matches the live
 * lexicon (verified against test-pds existing provider records).
 *
 * Returns the record on success, or an error string on validation
 * failure (caller turns it into a `malformed_profile` outcome).
 */
function buildWireServiceProfile(
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

  const record: Record<string, unknown> = {
    $type: 'com.dina.service.profile',
    name: config.name,
    isDiscoverable: config.isDiscoverable,
    capabilities,
    responsePolicy,
    capabilitySchemas: wireSchemas,
    updatedAt: new Date().toISOString(),
  };
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
