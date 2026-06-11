/**
 * Publish a CUSTOM (namespaced) ServiceConfig — the "not in the official
 * catalog" half of the open capability vocabulary.
 *
 * Unlike eta_query / price_check (canonical registry entries), the capability
 * here is a reverse-DNS NSID (`com.acme.widget_price`) that is NOT in
 * CAPABILITY_REGISTRY. classifyCapability() returns {kind:'custom'} for it:
 * it is its OWN search key (no alias folding), discoverable ONLY by exact
 * NSID match — never via an official-catalog search. A public custom
 * capability MUST ship a schema (there's no shared wire-schema to fall back
 * on), which is why we supply params/result here.
 *
 * MULTI-LISTING: publishes under a DISTINCT rkey (default `acme-widget`), so
 * when pointed at the SAME Core that already holds eta_query@self +
 * price_check@corner-market, the provider DID carries a THIRD listing — each
 * minting its own com.dinakernel.service.profile/<rkey> record.
 *
 * Env knobs:
 *   DINA_SERVICE_KEY_DIR        dir holding brain.ed25519  (default /tmp/price-key-dir)
 *   DINA_BRAIN_SERVICE_KEY_FILE key file name              (default brain.ed25519)
 *   DINA_CORE_URL               target Core                (default http://127.0.0.1:18298)
 *   DINA_SERVICE_NAME           display name               (default "Acme Widget Pricing")
 *   DINA_SERVICE_RKEY           listing record key         (default "acme-widget")
 *   DINA_CUSTOM_CAPABILITY      NSID                        (default "com.acme.widget_price")
 *
 * Run: `npx tsx put_service_config_custom.ts` from this directory.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { HttpCoreTransport, deriveDIDKey, getPublicKey } from '@dina/core';
import { canonicalCapabilitySchemaHash } from '@dina/brain';
import type { ServiceConfig } from '@dina/core';

const paramsSchema = {
  type: 'object',
  properties: {
    sku: { type: 'string' },
    quantity: { type: 'number' },
  },
  additionalProperties: true,
} as const;

const resultSchema = {
  type: 'object',
  properties: {
    sku: { type: 'string' },
    unit_price: { type: 'number' },
    currency: { type: 'string' },
    lead_time_days: { type: 'number' },
  },
  required: ['unit_price'],
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

  const capability = process.env.DINA_CUSTOM_CAPABILITY ?? 'com.acme.widget_price';
  const schemaHash = canonicalCapabilitySchemaHash({ params: paramsSchema as Record<string, unknown>, result: resultSchema as unknown as Record<string, unknown>, description: 'Look up the unit price + lead time for an Acme widget SKU.' });
  const name = process.env.DINA_SERVICE_NAME ?? 'Acme Widget Pricing';
  const rkey = process.env.DINA_SERVICE_RKEY ?? 'acme-widget';

  const config: ServiceConfig = {
    isDiscoverable: true,
    discoverability: 'public',
    name,
    description: 'lite-stack provider — custom NSID (test stub; Acme widgets)',
    capabilities: {
      [capability]: {
        mcpServer: 'stub_custom',
        mcpTool: 'widget_price',
        responsePolicy: 'auto',
        category: 'commerce',
        schemaHash,
      },
    },
    capabilitySchemas: {
      [capability]: {
        params: paramsSchema as unknown as Record<string, unknown>,
        result: resultSchema as unknown as Record<string, unknown>,
        schemaHash,
        description: 'Look up the unit price + lead time for an Acme widget SKU.',
        defaultTtlSeconds: 120,
      },
    },
    serviceArea: { lat: 37.77, lng: -122.43, radiusKm: 25 },
  };

  console.log(`[put_service_config_custom] sending config (cap=${capability}, rkey=${rkey}):`, JSON.stringify(config, null, 2).slice(0, 400));
  await core.putServiceConfig(config, rkey);
  console.log(`[put_service_config_custom] PUT succeeded (listing rkey=${rkey}, capability=${capability})`);
}

main().catch((err) => {
  console.error('[put_service_config_custom] FAILED:', err.message);
  process.exit(1);
});
