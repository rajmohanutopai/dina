/**
 * Cross-builder wire-record PARITY contract (catalog §2/§3, Codex review #7).
 *
 * There are TWO live `com.dinakernel.service.profile` builders on two publish
 * paths that must NEVER drift:
 *
 *   - HNL core-server:  `buildWireServiceProfile(ServiceConfig)` (this app)
 *   - mobile/brain:     `buildServiceProfileRecord(ServicePublisherConfig)`
 *                       (@dina/brain, fed by `toPublisherConfig`)
 *
 * They take different input shapes (the brain one is flattened), so a field
 * added to one is trivially forgotten in the other — which is exactly how
 * `category` + `discoverability` were dropped before this change. This test
 * pins BOTH to the same wire fields for an equivalent config, so a future field
 * added to one builder but not the other fails here. It also asserts the two
 * publish/unpublish GATES agree (public/unlisted publish, known_only does not).
 *
 * Contract-test, not scenario-test: it closes the drift bug CLASS rather than
 * re-checking one capability.
 */

import {
  buildServiceProfileRecord,
  shouldPublishProfile,
  toPublisherConfig,
} from '@dina/brain';

import { buildWireServiceProfile, shouldPublishListing } from '../src/appview/wire_publisher';

import type { ServiceConfig } from '@dina/core';


/** A representative two-capability listing with concrete categories. */
function makeConfig(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    isDiscoverable: true,
    name: 'Dr Rao Clinic',
    capabilities: {
      appointment_availability: {
        mcpServer: 'clinic',
        mcpTool: 'appointment_availability',
        responsePolicy: 'auto',
        category: 'healthcare',
      },
      eta_query: {
        mcpServer: 'transit',
        mcpTool: 'eta_query',
        responsePolicy: 'auto',
        category: 'transit',
      },
    },
    ...over,
  };
}

/** Pull a record (builders return `Record | string` on HNL; `Record` on brain). */
function wire(cfg: ServiceConfig): Record<string, unknown> {
  const r = buildWireServiceProfile(cfg);
  if (typeof r === 'string') throw new Error(`HNL builder rejected config: ${r}`);
  return r;
}
function brain(cfg: ServiceConfig): Record<string, unknown> {
  return buildServiceProfileRecord(toPublisherConfig(cfg), 0);
}

describe('service.profile wire-record parity (HNL ↔ brain)', () => {
  it('both builders emit the SAME discoverability + capabilityCategories (public)', () => {
    const cfg = makeConfig({ discoverability: 'public', isDiscoverable: true });
    const a = wire(cfg);
    const b = brain(cfg);

    expect(a.discoverability).toBe('public');
    expect(b.discoverability).toBe('public');
    expect(a.discoverability).toBe(b.discoverability);

    const expectedCats = { appointment_availability: 'healthcare', eta_query: 'transit' };
    expect(a.capabilityCategories).toEqual(expectedCats);
    expect(b.capabilityCategories).toEqual(expectedCats);

    expect(a.isDiscoverable).toBe(b.isDiscoverable);
    expect([...(a.capabilities as string[])].sort()).toEqual(
      [...(b.capabilities as string[])].sort(),
    );
  });

  it('unlisted: both carry discoverability=unlisted + isDiscoverable=false, both still publishable', () => {
    const cfg = makeConfig({ discoverability: 'unlisted', isDiscoverable: false });
    const a = wire(cfg);
    const b = brain(cfg);
    expect(a.discoverability).toBe('unlisted');
    expect(b.discoverability).toBe('unlisted');
    expect(a.isDiscoverable).toBe(false);
    expect(b.isDiscoverable).toBe(false);
    // unlisted IS published (search-excluded by AppView, URI-resolvable).
    expect(shouldPublishListing(cfg)).toBe(true);
    expect(shouldPublishProfile(toPublisherConfig(cfg))).toBe(true);
  });

  it('gates AGREE across all three discoverability values', () => {
    const cases: [ServiceConfig['discoverability'], boolean][] = [
      ['public', true],
      ['unlisted', true],
      ['known_only', false],
    ];
    for (const [disc, publishes] of cases) {
      const cfg = makeConfig({ discoverability: disc, isDiscoverable: disc === 'public' });
      expect(shouldPublishListing(cfg)).toBe(publishes);
      expect(shouldPublishProfile(toPublisherConfig(cfg))).toBe(publishes);
      // The gates must never disagree — that's the drift this test guards.
      expect(shouldPublishListing(cfg)).toBe(shouldPublishProfile(toPublisherConfig(cfg)));
    }
  });

  it('gates AGREE on status: paused/draft never publish, even when public', () => {
    const cases: [ServiceConfig['status'], boolean][] = [
      ['active', true],
      ['paused', false],
      ['draft', false],
      [undefined, true], // no status → default active
    ];
    for (const [status, publishes] of cases) {
      // discoverability is public throughout — only `status` flips the result,
      // proving availability is its own axis (not faked via discoverability).
      const cfg = makeConfig({ discoverability: 'public', isDiscoverable: true, status });
      expect(shouldPublishListing(cfg)).toBe(publishes);
      expect(shouldPublishProfile(toPublisherConfig(cfg))).toBe(publishes);
      expect(shouldPublishListing(cfg)).toBe(shouldPublishProfile(toPublisherConfig(cfg)));
    }
  });

  it('legacy back-compat: no explicit discoverability → derived identically by both', () => {
    const pub = makeConfig({ discoverability: undefined, isDiscoverable: true });
    expect(wire(pub).discoverability).toBe('public');
    expect(brain(pub).discoverability).toBe('public');

    const priv = makeConfig({ discoverability: undefined, isDiscoverable: false });
    expect(wire(priv).discoverability).toBe('known_only');
    expect(brain(priv).discoverability).toBe('known_only');
    // legacy isDiscoverable=false still unpublishes (derived known_only).
    expect(shouldPublishListing(priv)).toBe(false);
    expect(shouldPublishProfile(toPublisherConfig(priv))).toBe(false);
  });

  it('a capability with no category is omitted from capabilityCategories by both', () => {
    const cfg = makeConfig();
    // Drop the category on eta_query only.
    cfg.capabilities.eta_query = {
      mcpServer: 'transit',
      mcpTool: 'eta_query',
      responsePolicy: 'auto',
    };
    const a = wire(cfg);
    const b = brain(cfg);
    expect(a.capabilityCategories).toEqual({ appointment_availability: 'healthcare' });
    expect(b.capabilityCategories).toEqual({ appointment_availability: 'healthcare' });
  });

  it('both OMIT capabilitySchemas when none are configured (schema-less catalog caps)', () => {
    // Regression for Codex #2: an empty `capabilitySchemas: {}` is rejected by
    // AppView's coverage refine. Both builders must omit it, not emit `{}`.
    const cfg = makeConfig();
    expect(wire(cfg)).not.toHaveProperty('capabilitySchemas');
    expect(brain(cfg)).not.toHaveProperty('capabilitySchemas');
  });

  it('both include ONLY the capabilities that have a schema (partial schemas)', () => {
    const cfg = makeConfig({
      capabilitySchemas: {
        appointment_availability: {
          params: { type: 'object' },
          result: { type: 'object' },
          schemaHash: 'a'.repeat(64),
          description: 'slots',
        },
      },
    });
    // eta_query has no schema → only appointment_availability appears, in BOTH.
    expect(Object.keys(wire(cfg).capabilitySchemas as object)).toEqual(['appointment_availability']);
    expect(Object.keys(brain(cfg).capabilitySchemas as object)).toEqual([
      'appointment_availability',
    ]);
  });
});
