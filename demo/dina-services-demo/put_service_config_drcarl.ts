/**
 * Publish the "Dr Carl's Clinic" ServiceConfig on the SECOND lite Core
 * (:18299) — the appointment_status provider for the two-service test.
 *
 * appointment_status is in the shared canonical capability-registry
 * (@dina/protocol) but has NO brain wire-schema (only eta_query does),
 * so this supplies an ad-hoc params/result schema in the config. The
 * requester's sender-side validation skips unregistered capabilities
 * (getCapability -> undefined -> return), so the query still flows; the
 * provider's isCapabilityConfigured accepts appointment_status because
 * it's keyed in this config.
 *
 * Run: `npx tsx put_service_config_drcarl.ts` from this directory after
 * the Dr Carl Core is up on :18299 with its brain service key at
 * /tmp/drcarl-key-dir/brain.ed25519 (DID registered as DINA_BRAIN_DID).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import { HttpCoreTransport, deriveDIDKey, getPublicKey } from '@dina/core';
import { canonicalCapabilitySchemaHash } from '@dina/brain';
import type { ServiceConfig } from '@dina/core';

// Ad-hoc params/result schemas for appointment_status (no brain registry
// entry). Result shape matches result_formatter.ts::formatAppointmentStatus
// ({status, date, time, note}).
const apptParamsSchema = {
  type: 'object',
  properties: {
    provider_name: { type: 'string' },
    date: { type: 'string' },
    time: { type: 'string' },
    patient_ref: { type: 'string' },
  },
  additionalProperties: true,
} as const;

const apptResultSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['confirmed', 'rescheduled', 'cancelled', 'not_found'] },
    date: { type: 'string' },
    time: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: true,
} as const;

async function main(): Promise<void> {
  const keyDir = process.env.DINA_SERVICE_KEY_DIR ?? '/tmp/drcarl-key-dir';
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
    baseUrl: process.env.DINA_CORE_URL ?? 'http://127.0.0.1:18299',
    httpClient: new HttpClient({ timeoutMs: 10000 }),
    signer,
  });

  const schemaHash = canonicalCapabilitySchemaHash({ params: apptParamsSchema as Record<string, unknown>, result: apptResultSchema as unknown as Record<string, unknown>, description: 'Check the status or next availability of an appointment with a provider.' });

  const config: ServiceConfig = {
    isDiscoverable: true,
    discoverability: 'public',
    name: "Dr Carl's Clinic",
    description: 'lite-stack provider — appointment_status (test stub; Dr Carl demo) [t143000]',
    capabilities: {
      appointment_status: {
        mcpServer: 'stub_appt',
        mcpTool: 'appointment_status',
        responsePolicy: 'auto',
        // Dr Carl is a doctor → healthcare (one of appointment_status's
        // catalog category_ids: appointments | healthcare).
        category: 'healthcare',
        schemaHash,
      },
    },
    capabilitySchemas: {
      appointment_status: {
        params: apptParamsSchema as unknown as Record<string, unknown>,
        result: apptResultSchema as unknown as Record<string, unknown>,
        schemaHash,
        description: 'Check the status or next availability of an appointment with a provider.',
        defaultTtlSeconds: 120,
      },
    },
    serviceArea: { lat: 37.77, lng: -122.43, radiusKm: 25 },
  };

  console.log('[put_service_config_drcarl] sending config:', JSON.stringify(config, null, 2).slice(0, 500));
  await core.putServiceConfig(config);
  console.log('[put_service_config_drcarl] PUT succeeded');
}

main().catch((err) => {
  console.error('[put_service_config_drcarl] FAILED:', err.message);
  process.exit(1);
});
