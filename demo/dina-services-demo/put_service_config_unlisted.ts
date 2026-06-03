/**
 * Publish an UNLISTED listing (discoverability='unlisted') under a distinct
 * rkey so the eta `self` listing is untouched. Used to live-verify the
 * "unlisted resolve-by-link" behaviour on the deployed AppView:
 *   - EXCLUDED from com.dinakernel.service.search
 *   - RESOLVABLE by exact URI via com.dinakernel.service.getByUri
 *
 * Run: DINA_SERVICE_KEY_DIR=/tmp/dina-cic-service-key-dir npx tsx put_service_config_unlisted.ts
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { HttpCoreTransport, deriveDIDKey, getPublicKey } from '@dina/core';
import { computeSchemaHash } from '@dina/brain';
import type { ServiceConfig } from '@dina/core';

const etaParamsSchema = {
  type: 'object',
  properties: {
    route_id: { type: 'string' },
    stop_id: { type: 'string' },
  },
  required: ['route_id'],
  additionalProperties: true,
} as const;

const etaResultSchema = {
  type: 'object',
  properties: {
    eta_minutes: { type: 'number' },
    text: { type: 'string' },
  },
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const keyDir = process.env.DINA_SERVICE_KEY_DIR ?? '/tmp/dina-cic-service-key-dir';
  const keyPath = join(keyDir, process.env.DINA_BRAIN_SERVICE_KEY_FILE ?? 'brain.ed25519');
  const seed = new Uint8Array(await readFile(keyPath));
  if (seed.byteLength !== 32) {
    throw new Error(`Expected 32-byte Ed25519 seed at ${keyPath}, got ${seed.byteLength}`);
  }

  const crypto = new Crypto();
  const did = deriveDIDKey(getPublicKey(seed));
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

  const schemaHash = computeSchemaHash(etaParamsSchema);
  const disc = (process.env.DINA_DISCOVERABILITY ?? 'unlisted') as
    | 'public'
    | 'unlisted'
    | 'known_only';
  const rkey = process.env.DINA_SERVICE_RKEY ?? 'unlisted-demo';

  const config: ServiceConfig = {
    isDiscoverable: disc === 'public',
    discoverability: disc,
    name: disc === 'known_only' ? 'Known-Only ETA (grant-gated)' : 'Hidden Link-Only ETA',
    description: `${disc} listing — test`,
    capabilities: {
      eta_query: {
        mcpServer: 'stub_eta',
        mcpTool: 'eta_query',
        responsePolicy: 'auto',
        category: 'transit',
        schemaHash,
      },
    },
    capabilitySchemas: {
      eta_query: {
        params: etaParamsSchema as unknown as Record<string, unknown>,
        result: etaResultSchema as unknown as Record<string, unknown>,
        schemaHash,
        description: 'Hidden ETA (unlisted).',
        defaultTtlSeconds: 120,
      },
    },
    serviceArea: { lat: 37.77, lng: -122.43, radiusKm: 25 },
  };

  console.log(`[put_service_config_unlisted] sending (rkey=${rkey}, disc=unlisted)`);
  await core.putServiceConfig(config, rkey);
  console.log(`[put_service_config_unlisted] PUT succeeded (listing rkey=${rkey})`);
}

main().catch((err) => {
  console.error('[put_service_config_unlisted] FAILED:', err.message);
  process.exit(1);
});
