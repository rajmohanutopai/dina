/**
 * Push services — the real subscription delivery loop (dina_details.md §3.9).
 *
 * One Home Node Lite services ITSELF over MsgBox: it publishes a public
 * eta_query listing, subscribes to its own DID's listing, the poll goes out
 * over the test relay and comes back (a public service accepts an eta_query
 * from any sender), its own scripted Tier-1 answers, and the ETA card lands in
 * Activity. Everything inside Dina is the real signed/relayed path; only the
 * model is scripted (deterministic + $0).
 *
 * Exercises, end to end: service publish → Core canonical schema + schemaHash →
 * owner subscription that PINS + forwards schema_hash (GAP-SH-01) → poll over
 * MsgBox → provider ingress accepts + Tier-1 answers → silence classifier →
 * notification → Activity card.
 *
 * Config: playwright.services.config.ts (msgbox + scripted LLM). Requires the
 * autopilot bundle (dist-e2e) + network to the test relay/pds.
 */

import { expect, test } from '../fixtures/human_session';

const SUB_ID = 'e2e-sub-route42';
const SERVICE_PROFILE_COLLECTION = 'com.dinakernel.service.profile';

/** A public Tier-1 eta_query listing. The instruction contains "Route 42" so
 *  the scripted provider returns the fixed ETA JSON. Core stamps the schema +
 *  schemaHash on PUT. */
const ETA_CONFIG = {
  isDiscoverable: true,
  discoverability: 'public',
  status: 'active',
  name: 'Route 42 Dispatch',
  description: 'Live ETA for city bus Route 42',
  vaultPersona: 'general',
  capabilities: {
    eta_query: {
      category: 'transit',
      responsePolicy: 'auto',
      instruction:
        'You are the live dispatcher for city bus Route 42. Reply with the current status and a plausible ETA in minutes for the requested stop (default Castro).',
    },
  },
  // The published schema (what the real form attaches). A non-empty `schemaHash`
  // makes the provider REQUIRE a matching `schema_hash` on every poll — so this
  // exercises the pin-and-forward path (GAP-SH-01). `defaultTtlSeconds` doubles
  // as the answer-cache freshness window. Minimal but valid params/result.
  capabilitySchemas: {
    eta_query: {
      params: {
        type: 'object',
        required: ['route_id'],
        properties: { route_id: { type: 'string' } },
      },
      result: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string' },
          eta_minutes: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      schemaHash: 'e2e-eta-schema-v1',
      defaultTtlSeconds: 60,
    },
  },
};

test.describe('Push services — subscription delivery', () => {
  test('publish a service, subscribe to it, and receive periodic ETA cards in Activity', async ({
    human,
  }) => {
    const { backstage, page } = human;
    const vaultDir = process.env.DINA_E2E_VAULT_DIR;
    expect(vaultDir, 'the services config publishes the vault dir').toBeTruthy();

    // ── The node's own identity (self-service target) ────────────────────
    const did = await backstage.waitForOwnerDid(vaultDir as string);
    const serviceUri = `at://${did}/${SERVICE_PROFILE_COLLECTION}/self`;

    // ── Publish a public eta_query listing (owner) ───────────────────────
    await backstage.publishServiceConfig(ETA_CONFIG);
    // Core canonicalises the schema + stamps the hash the subscription must pin.
    const schemaHash = await backstage.serviceSchemaHash('eta_query');
    expect(schemaHash, 'Core stamped a schema hash on the published listing').toBeTruthy();

    // ── Subscribe to our OWN service (owner-only watch create) ───────────
    // Pin schema_hash (GAP-SH-01) + a 60s freshness so the poll is accepted.
    const watchId = await backstage.createWatch({
      subscription_id: SUB_ID,
      persona: 'general',
      provider_did: did,
      service_uri: serviceUri,
      capability: 'eta_query',
      poll_interval_sec: 60,
      query: { route_id: '42' },
      ...(schemaHash !== undefined ? { schema_hash: schemaHash } : {}),
      freshness_sec: 60,
    });

    try {
      // ── Delivery (visible): open Activity and wait for the ETA card. The
      //    first poll is ≥60s out, then a D2D round-trip over MsgBox, then the
      //    scripted Tier-1 answer flows to the Activity feed. The card's body
      //    carries the scripted message ("Route 42 … on route …"). ───────────
      await page.getByRole('tab', { name: 'Activity tab' }).click();
      await expect(page.getByText('Route 42').first()).toBeVisible({ timeout: 150_000 });
      await expect(page.getByText(/on route/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      // Stop the poll loop so it doesn't bleed into teardown / other runs.
      await backstage.cancelWatch(watchId);
    }
  });
});
