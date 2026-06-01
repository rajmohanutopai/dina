/**
 * Publish a `price_check` ServiceConfig (the "Corner Market" demo provider
 * — the THIRD live capability, commerce) to a lite Core.
 *
 * price_check is in the shared canonical capability-registry (@dina/protocol)
 * as of the commerce-domain addition, but has NO brain wire-schema (only
 * eta_query does). So this supplies an ad-hoc params/result schema in the
 * config. The requester's sender-side validation skips unregistered-schema
 * capabilities (getCapability -> undefined -> return), so the query flows;
 * the provider's isCapabilityConfigured accepts price_check because it's
 * keyed here and canonicalized via the registry.
 *
 * MULTI-LISTING: this publishes under a DISTINCT rkey (default `corner-market`),
 * NOT `self`. When pointed at the SAME Core that already holds the eta_query
 * `self` listing (put_service_config.ts), the provider's single DID then carries
 * TWO listings — `self` → eta_query and `corner-market` → price_check — each
 * minting its own `com.dinakernel.service.profile/<rkey>` record. That's the
 * scenario that actually exercises per-rkey publish + `service_uri`
 * disambiguation end-to-end (the requester must pick the right listing). Set
 * DINA_SERVICE_RKEY=self to fall back to the old single-listing (clobbering)
 * behaviour.
 *
 * Env knobs (so it works against whichever warm node hosts the provider):
 *   DINA_SERVICE_KEY_DIR        dir holding brain.ed25519  (default /tmp/price-key-dir)
 *   DINA_BRAIN_SERVICE_KEY_FILE key file name              (default brain.ed25519)
 *   DINA_CORE_URL               target Core                (default http://127.0.0.1:18298)
 *   DINA_SERVICE_NAME           display name               (default "Corner Market")
 *   DINA_SERVICE_RKEY           listing record key         (default "corner-market")
 *
 * Run: `npx tsx put_service_config_price.ts` from this directory.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { HttpCoreTransport, deriveDIDKey, getPublicKey } from '@dina/core';
import { computeSchemaHash } from '@dina/brain';
import type { ServiceConfig } from '@dina/core';

const priceParamsSchema = {
  type: 'object',
  properties: {
    product_name: { type: 'string' },
    query: { type: 'string' },
    store_name: { type: 'string' },
  },
  additionalProperties: true,
} as const;

const priceResultSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
    product_name: { type: 'string' },
    price: { type: 'number' },
    currency: { type: 'string' },
    store_name: { type: 'string' },
    product_url: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['status', 'price'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const keyDir = process.env.DINA_SERVICE_KEY_DIR ?? '/tmp/price-key-dir';
  const keyPath = join(keyDir, process.env.DINA_BRAIN_SERVICE_KEY_FILE ?? 'brain.ed25519');
  const seed = new Uint8Array(await readFile(keyPath));
  if (seed.byteLength !== 32) {
    throw new Error(`Expected 32-byte Ed25519 seed at ${keyPath}, got ${seed.byteLength}`);
  }

  const crypto = new Crypto();
  const publicKey = getPublicKey(seed);
  const did = deriveDIDKey(publicKey);
  const signer = createCanonicalRequestSigner({
    did,
    privateKey: seed,
    sign: (priv, msg) => crypto.ed25519Sign(priv, msg),
    nonce: (n) => crypto.randomBytes(n),
  });

  const core = new HttpCoreTransport({
    baseUrl: process.env.DINA_CORE_URL ?? 'http://127.0.0.1:18298',
    httpClient: new HttpClient({ timeoutMs: 10000 }),
    signer,
  });

  const schemaHash = computeSchemaHash(priceParamsSchema);
  const name = process.env.DINA_SERVICE_NAME ?? 'Corner Market';
  // Publish as a 2nd listing on this DID (distinct rkey ⇒ distinct
  // service.profile record). DINA_SERVICE_RKEY=self reverts to the old
  // single-listing clobber.
  const rkey = process.env.DINA_SERVICE_RKEY ?? 'corner-market';

  const config: ServiceConfig = {
    isDiscoverable: true,
    discoverability: 'public',
    name,
    description: 'lite-stack provider — price_check (test stub; Corner Market demo)',
    capabilities: {
      price_check: {
        mcpServer: 'stub_price',
        mcpTool: 'price_check',
        responsePolicy: 'auto',
        category: 'commerce',
        schemaHash,
      },
    },
    capabilitySchemas: {
      price_check: {
        params: priceParamsSchema as unknown as Record<string, unknown>,
        result: priceResultSchema as unknown as Record<string, unknown>,
        schemaHash,
        description: 'Check the current price and stock availability of a product at a store.',
        defaultTtlSeconds: 120,
      },
    },
    serviceArea: { lat: 37.77, lng: -122.43, radiusKm: 25 },
  };

  console.log(`[put_service_config_price] sending config (rkey=${rkey}):`, JSON.stringify(config, null, 2).slice(0, 500));
  await core.putServiceConfig(config, rkey);
  console.log(`[put_service_config_price] PUT succeeded (listing rkey=${rkey})`);
}

main().catch((err) => {
  console.error('[put_service_config_price] FAILED:', err.message);
  process.exit(1);
});
