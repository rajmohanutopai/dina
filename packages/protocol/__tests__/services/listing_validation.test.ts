/**
 * Provider service-listing validation tests (spec §5.1 / §41).
 *
 * Covers the listing invariants: capability must be official-or-namespaced
 * (never unknown flat), category required + allowed, explicit discoverability,
 * write-action approval gating, public-custom-needs-schema, and the
 * `isDiscoverable → discoverability` back-compat.
 */

import {
  effectiveDiscoverability,
  effectiveListingStatus,
  isListingPublishable,
  validateServiceListing,
} from '../../src/services/listing-validation';

import type { ServiceCapabilityConfig, ServiceConfig } from '../../src/types/capability';

function cap(
  category: string | undefined,
  responsePolicy: 'auto' | 'review' = 'auto',
): ServiceCapabilityConfig {
  return {
    mcpServer: 's',
    mcpTool: 't',
    responsePolicy,
    ...(category !== undefined ? { category } : {}),
  };
}

function mkConfig(
  capabilities: Record<string, ServiceCapabilityConfig>,
  over: Partial<ServiceConfig> = {},
): ServiceConfig {
  return { isDiscoverable: true, name: 'Svc', capabilities, ...over };
}

const codes = (r: ReturnType<typeof validateServiceListing>): string[] =>
  r.errors.map((e) => e.code).sort();

describe('effectiveDiscoverability — back-compat (spec §5.2)', () => {
  it('explicit discoverability wins', () => {
    expect(effectiveDiscoverability(mkConfig({}, { discoverability: 'unlisted' }))).toBe('unlisted');
  });
  it('derives from isDiscoverable when not explicit', () => {
    expect(effectiveDiscoverability(mkConfig({}, { isDiscoverable: true }))).toBe('public');
    expect(effectiveDiscoverability(mkConfig({}, { isDiscoverable: false }))).toBe('known_only');
  });
});

describe('effectiveListingStatus + isListingPublishable (availability axis)', () => {
  it('effectiveListingStatus defaults to active when absent', () => {
    expect(effectiveListingStatus(mkConfig({}))).toBe('active');
    expect(effectiveListingStatus(mkConfig({}, { status: 'paused' }))).toBe('paused');
    expect(effectiveListingStatus(mkConfig({}, { status: 'draft' }))).toBe('draft');
  });

  it('publishable iff active AND not known_only — status is an orthogonal AND', () => {
    // active + public/unlisted → live
    expect(isListingPublishable(mkConfig({}, { discoverability: 'public', status: 'active' }))).toBe(true);
    expect(isListingPublishable(mkConfig({}, { discoverability: 'unlisted', status: 'active' }))).toBe(true);
    // active + known_only → not live (local/pairing-bound)
    expect(isListingPublishable(mkConfig({}, { discoverability: 'known_only', status: 'active' }))).toBe(false);
    // paused/draft → never live, even when public (the OFF switch)
    expect(isListingPublishable(mkConfig({}, { discoverability: 'public', status: 'paused' }))).toBe(false);
    expect(isListingPublishable(mkConfig({}, { discoverability: 'public', status: 'draft' }))).toBe(false);
    // back-compat: no status → active; no discoverability → derived
    expect(isListingPublishable(mkConfig({}, { isDiscoverable: true }))).toBe(true);
    expect(isListingPublishable(mkConfig({}, { isDiscoverable: false }))).toBe(false);
  });
});

describe('validateServiceListing', () => {
  it('accepts a valid official listing (capability + allowed category)', () => {
    const r = validateServiceListing(mkConfig({ eta_query: cap('transit') }));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.capabilities[0]).toMatchObject({ raw: 'eta_query', kind: 'official', canonical: 'eta_query', category: 'transit' });
  });

  it('accepts an official capability published under an alias (folds to canonical)', () => {
    const r = validateServiceListing(mkConfig({ bus_eta: cap('transit') }));
    expect(r.ok).toBe(true);
    expect(r.capabilities[0]).toMatchObject({ kind: 'official', canonical: 'eta_query' });
  });

  it('rejects an unknown flat capability name (anti-spoof — spec §6)', () => {
    const r = validateServiceListing(mkConfig({ eta_query2: cap('transit') }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('unknown_capability');
  });

  it('rejects an official capability with NO category', () => {
    const r = validateServiceListing(mkConfig({ eta_query: cap(undefined) }));
    expect(codes(r)).toContain('missing_category');
  });

  it('rejects an official capability with a category not in its category_ids', () => {
    // eta_query allows only `transit`; `commerce` is not allowed.
    const r = validateServiceListing(mkConfig({ eta_query: cap('commerce') }));
    expect(codes(r)).toContain('category_not_allowed');
  });

  it('accepts a cross-category official capability in any allowed category', () => {
    // appointment_availability allows appointments/healthcare/professional/home_local.
    expect(validateServiceListing(mkConfig({ appointment_availability: cap('healthcare') })).ok).toBe(true);
    expect(validateServiceListing(mkConfig({ appointment_availability: cap('home_local') })).ok).toBe(true);
  });

  it('requires explicit discoverability only when asked (mobile publish path)', () => {
    const noExplicit = mkConfig({ eta_query: cap('transit') }); // isDiscoverable:true, no discoverability
    expect(validateServiceListing(noExplicit).ok).toBe(true); // back-compat path
    const strict = validateServiceListing(noExplicit, { requireExplicitDiscoverability: true });
    expect(codes(strict)).toContain('missing_discoverability');
    // Explicit value satisfies the strict check.
    const explicit = mkConfig({ eta_query: cap('transit') }, { discoverability: 'public' });
    expect(validateServiceListing(explicit, { requireExplicitDiscoverability: true }).ok).toBe(true);
  });

  it('gates a booking/write official capability behind review, not auto (spec §6)', () => {
    const auto = validateServiceListing(
      mkConfig({ appointment_book: cap('healthcare', 'auto') }, { discoverability: 'unlisted' }),
    );
    expect(codes(auto)).toContain('write_needs_approval');
    const review = validateServiceListing(
      mkConfig({ appointment_book: cap('healthcare', 'review') }, { discoverability: 'unlisted' }),
    );
    expect(review.ok).toBe(true);
  });

  it('accepts a namespaced custom capability with a category (non-public needs no schema)', () => {
    const r = validateServiceListing(
      mkConfig({ 'com.rajschool.homework_status': cap('school') }, { discoverability: 'unlisted' }),
    );
    expect(r.ok).toBe(true);
    expect(r.capabilities[0]).toMatchObject({ kind: 'custom', canonical: 'com.rajschool.homework_status' });
  });

  it('requires schemas for a PUBLIC custom capability (spec §8.1)', () => {
    const noSchema = validateServiceListing(
      mkConfig({ 'com.acme.banana_inventory': cap('commerce') }, { discoverability: 'public' }),
    );
    expect(codes(noSchema)).toContain('public_custom_needs_schema');
    // With a schema present it passes.
    const withSchema = validateServiceListing(
      mkConfig(
        { 'com.acme.banana_inventory': cap('commerce') },
        {
          discoverability: 'public',
          capabilitySchemas: {
            'com.acme.banana_inventory': { params: {}, result: {}, schemaHash: 'h' },
          },
        },
      ),
    );
    expect(withSchema.ok).toBe(true);
  });

  it('reports per-capability classification for diagnostics', () => {
    const r = validateServiceListing(
      mkConfig(
        { eta_query: cap('transit'), 'com.acme.thing': cap('commerce') },
        { discoverability: 'unlisted' },
      ),
    );
    expect(r.capabilities.map((c) => c.kind).sort()).toEqual(['custom', 'official']);
  });
});
