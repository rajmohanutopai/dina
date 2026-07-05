/**
 * Contact Services — peer-side OFFER setup for the live two-Dina test.
 *
 * Against an already-running headless lite-Core peer (DINA_DEBUG_MODE=1), this:
 *   1. publishes a `surface:'talk'` + `known_only` availability_coordination
 *      listing (Tier-1 instruction plane), pulling the canonical schema from
 *      the brain registry so the schema_hash matches;
 *   2. adds the mobile DID as a contact (offer route is contact-gated);
 *   3. issues a real `service.offer` to the mobile via POST /v1/service/offer
 *      (the shared issueServiceOffer path: mint grant + deliver offer over D2D).
 *
 * After this, the mobile (already a contact of the peer) ingests the offer, so
 * the NEXT `/schedule` from the mobile fires a real `service.query` and the
 * InlineServiceQueryCard renders.
 *
 *   PEER_URL=http://127.0.0.1:18298 MOBILE_DID=did:plc:... npx tsx \
 *     apps/mobile/maestro/harness/contact_services_offer.ts
 */
import { listCapabilities, canonicalCapabilitySchemaHash } from '@dina/brain';

const PEER = process.env.PEER_URL ?? 'http://127.0.0.1:18298';
const MOBILE_DID = process.env.MOBILE_DID ?? '';
if (MOBILE_DID === '') throw new Error('set MOBILE_DID');

async function debug(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${PEER}/v1/debug/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, path, body }),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  const cap = listCapabilities().find((c) => c.name === 'availability_coordination');
  if (cap === undefined) throw new Error('availability_coordination not in brain registry');
  const schemaHash = canonicalCapabilitySchemaHash({
    params: cap.paramsSchema,
    result: cap.resultSchema,
    description: cap.description,
  });

  const config = {
    isDiscoverable: false,
    discoverability: 'known_only',
    status: 'active',
    surface: 'talk',
    defaultOfferable: true,
    name: "Sancho — Find a time",
    description: 'Coordinate a meeting time with me',
    capabilities: {
      availability_coordination: {
        instruction: "I'm free weekday afternoons — offer 4:30pm or 5:15pm.",
        instructionUpdatedAt: Date.now(),
        responsePolicy: 'auto',
        category: 'appointments',
        schemaHash,
      },
    },
    capabilitySchemas: {
      availability_coordination: {
        params: cap.paramsSchema,
        result: cap.resultSchema,
        schemaHash,
        description: cap.description,
        defaultTtlSeconds: cap.defaultTtlSeconds,
      },
    },
  };

  console.log('1) PUT listing →', JSON.stringify(await debug('PUT', '/v1/service/config/self', config)));
  console.log('2) add mobile contact →', JSON.stringify(await debug('POST', '/v1/contacts', {
    did: MOBILE_DID,
    display_name: 'Alonso',
    trust_level: 'verified',
  })));
  console.log('3) issue offer →', JSON.stringify(await debug('POST', '/v1/service/offer', {
    to_did: MOBILE_DID,
    rkey: 'self',
    capability: 'availability_coordination',
  })));
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
