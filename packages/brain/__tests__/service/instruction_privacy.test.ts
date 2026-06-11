/**
 * PRIVACY PIN — the Tier 1 `instruction` is PROVIDER-PRIVATE
 * (docs/SERVICE_PROVIDER_TIERS.md; ServiceCapabilityConfig docstring).
 *
 * It may carry internal pricing rules, personal guidance, or operating
 * detail ("give Mrs. Rao a discount", "I'm closed Thursday for the
 * hospital visit"). It must NEVER appear in anything published to the
 * PDS / AppView. These tests scan the FULL serialized publisher config
 * and wire record for the marker text — so a future "just spread the
 * capability entry" refactor fails here, not in production.
 */

import { toPublisherConfig } from '../../src/service/config_sync';
import { buildRecord } from '../../src/service/service_publisher';

import type { ServiceConfig } from '@dina/protocol';

const SECRET_MARKER = 'TIER1-SECRET give Mrs. Rao a discount, closed Thursday for the hospital';

const tier1Config: ServiceConfig = {
  isDiscoverable: true,
  discoverability: 'public',
  status: 'active',
  name: "Maya's Salon",
  description: 'Haircuts and styling',
  // Execution config like `instruction` — provider-private.
  vaultPersona: 'TIER1-SECRET-PERSONA-salon-notes',
  capabilities: {
    appointment_availability: {
      responsePolicy: 'auto',
      category: 'appointments',
      instruction: SECRET_MARKER,
      instructionUpdatedAt: 1_750_000_000_000,
    },
    appointment_book: {
      responsePolicy: 'review',
      category: 'appointments',
      instruction: `${SECRET_MARKER} — and always ask me before booking`,
      instructionUpdatedAt: 1_750_000_000_000,
    },
  },
  capabilitySchemas: {
    appointment_availability: {
      params: { type: 'object' },
      result: { type: 'object' },
      schemaHash: 'cafe'.repeat(16),
    },
  },
};

describe('Tier 1 instruction never leaves the node', () => {
  it('toPublisherConfig carries NO instruction text or timestamps', () => {
    const pub = toPublisherConfig(tier1Config);
    const wire = JSON.stringify(pub);
    expect(wire).not.toContain('TIER1-SECRET');
    expect(wire).not.toContain('instruction');
    expect(wire).not.toContain('vaultPersona');
    expect(wire).not.toContain('1750000000000');
  });

  it('the published service.profile record carries NO instruction text', () => {
    const record = buildRecord(toPublisherConfig(tier1Config), 1_750_000_100_000);
    const wire = JSON.stringify(record);
    expect(wire).not.toContain('TIER1-SECRET');
    expect(wire).not.toContain('instruction');
    expect(wire).not.toContain('vaultPersona');
    // Sanity: the record still carries the PUBLIC facts.
    expect(wire).toContain("Maya's Salon");
    expect(wire).toContain('appointment_availability');
    expect((record as { responsePolicy?: Record<string, string> }).responsePolicy).toEqual({
      appointment_availability: 'auto',
      appointment_book: 'review',
    });
  });
});
