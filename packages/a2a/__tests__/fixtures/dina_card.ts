/**
 * A card as Dina projects it (`projectAgentCard`), built on the frame Core's
 * `buildInboundCard` uses (`dinaCardFrame`: both interfaces, the bearer scheme
 * with its description, a non-ASCII apostrophe in it, the scope-less
 * requirement every bearer card carries, every flag), and a public listing
 * whose params schema has the bounds a real one carries. Only the version is
 * fixed (Core derives it from the card's hash) and the signature left off (a
 * signature covers the card; it is not part of it).
 *
 * The SDK vector `dina_projected` (a2a_sdk_card_forms.json) is this card, so
 * the SDK's own canonical form of Dina's card is frozen there. A test projects
 * the card afresh and fails if the projection moved: then regenerate, so the
 * SDK checks the new shape too.
 *
 *   npx tsx -e "import { dinaProjectedCard } from './packages/a2a/__tests__/fixtures/dina_card';
 *     process.stdout.write(JSON.stringify(dinaProjectedCard()))" > /tmp/dina_card.json
 *   apps/home-node-lite/core-server/__tests__/a2a/reference/.venv/bin/python \
 *     apps/home-node-lite/core-server/__tests__/a2a/reference/card_forms.py vectors /tmp/dina_card.json \
 *     > packages/a2a/__tests__/fixtures/a2a_sdk_card_forms.json
 */

import { dinaCardFrame, projectAgentCard, type AgentCard } from '../../src';

const ORIGIN = 'https://dina.example.org';

export function dinaProjectedCard(): AgentCard {
  const projected = projectAgentCard({
    nodeDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    name: 'Bus 42',
    description: 'Arrival times for route 42.',
    version: '1.0.0+0000000000000000',
    // The frame Core's card is built with, not a copy of it.
    ...dinaCardFrame(ORIGIN),
    listings: [
      {
        rkey: 'bus',
        status: 'active',
        discoverability: 'public',
        surface: 'services',
        capabilities: [
          {
            capability: 'eta_query',
            canonical: 'eta_query',
            actionClass: 'read',
            publicExposureAllowed: true,
            paramsSchema: {
              type: 'object',
              required: ['route_id'],
              additionalProperties: false,
              properties: {
                route_id: { type: 'string', minLength: 1, maxLength: 16 },
                stops_ahead: { type: 'integer', minimum: 0, maximum: 10 },
              },
            },
            schemaHash: 'c'.repeat(64),
            schemasEnforceable: true,
            executor: 'mcp_server',
            displayName: 'ETA / arrival time',
            description: 'Estimated arrival time for a transit route at a stop.',
            tags: ['transit'],
          },
        ],
      },
    ],
    acceptsExample: () => true,
  });
  if (!projected.ok) throw new Error(`projection refused: ${projected.reason}`);
  return projected.card;
}
