/**
 * One-off helper: write the lite Core's ServiceConfig with the
 * eta_query capability and watch the publisher fire.
 *
 * Run via: `npx tsx put_service_config.ts` from this directory after
 * the lite Core is running on http://127.0.0.1:18298 with the brain
 * service key at /tmp/dina-cic-service-key-dir/brain.ed25519.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { HttpCoreTransport, deriveDIDKey, getPublicKey } from '@dina/core';
import { listCapabilities, canonicalCapabilitySchemaHash } from '@dina/brain';
import type { ServiceConfig } from '@dina/core';

async function main(): Promise<void> {
  const keyDir = process.env.DINA_SERVICE_KEY_DIR ?? '/tmp/dina-cic-service-key-dir';
  const keyDirResolved = await readFile('/tmp/dina-cic-service-key-dir', 'utf-8').then(
    (s) => s.trim(),
    () => keyDir,
  );
  const keyPath = join(keyDirResolved, process.env.DINA_BRAIN_SERVICE_KEY_FILE ?? 'brain.ed25519');
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

  // Build a ServiceConfig with eta_query from the brain registry so
  // the canonical params/result schemas + schema_hash get attached.
  const known = listCapabilities();
  const eta = known.find((c) => c.name === 'eta_query');
  if (eta === undefined) throw new Error('eta_query not found in brain registry');

  // Discoverability override for MT-63/78/79 testing: public | unlisted | known_only.
  const disc = (process.env.DINA_DISCOVERABILITY ?? 'public') as
    | 'public'
    | 'unlisted'
    | 'known_only';
  const config: ServiceConfig = {
    isDiscoverable: disc === 'public',
    discoverability: disc,
    name: process.env.DINA_SERVICE_NAME ?? 'Demo ETA Provider',
    description: `lite-stack provider — eta_query (test stub) [rev ${Date.now()}]`,
    capabilities: {
      eta_query: {
        mcpServer: 'stub_eta',
        mcpTool: 'eta_query',
        responsePolicy: 'auto',
        category: 'transit',
        schemaHash: canonicalCapabilitySchemaHash({ params: eta.paramsSchema, result: eta.resultSchema, description: eta.description }),
      },
    },
    capabilitySchemas: {
      eta_query: {
        params: eta.paramsSchema,
        result: eta.resultSchema,
        schemaHash: canonicalCapabilitySchemaHash({ params: eta.paramsSchema, result: eta.resultSchema, description: eta.description }),
        description: eta.description,
        defaultTtlSeconds: eta.defaultTtlSeconds,
      },
    },
    // Location-configurable (defaults to SF). A test that needs deterministic
    // PUBLIC discovery over a SHARED AppView publishes at a unique location and
    // queries a bus THERE, so the geo-search returns only this provider.
    serviceArea: {
      lat: Number(process.env.DINA_SERVICE_LAT ?? '37.77'),
      lng: Number(process.env.DINA_SERVICE_LNG ?? '-122.43'),
      radiusKm: Number(process.env.DINA_SERVICE_RADIUS_KM ?? '25'),
    },
  };

  console.log('[put_service_config] sending config:', JSON.stringify(config, null, 2).slice(0, 400));
  await core.putServiceConfig(config);
  console.log('[put_service_config] PUT succeeded');
}

main().catch((err) => {
  console.error('[put_service_config] FAILED:', err.message);
  process.exit(1);
});
