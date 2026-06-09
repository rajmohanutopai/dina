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
  isListingPublic,
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

  it('isListingPublic is STRICTER — only active+public (unlisted is NOT public)', () => {
    // Reachable by a generic no-URI query iff active + public.
    expect(isListingPublic(mkConfig({}, { discoverability: 'public', status: 'active' }))).toBe(true);
    // unlisted is publishable (URI-resolvable) but NOT public (link-only).
    expect(isListingPublic(mkConfig({}, { discoverability: 'unlisted', status: 'active' }))).toBe(false);
    expect(isListingPublishable(mkConfig({}, { discoverability: 'unlisted', status: 'active' }))).toBe(true);
    // paused/known_only never public.
    expect(isListingPublic(mkConfig({}, { discoverability: 'public', status: 'paused' }))).toBe(false);
    expect(isListingPublic(mkConfig({}, { discoverability: 'known_only', status: 'active' }))).toBe(false);
  });
});

describe('no_capabilities — a LIVE listing must advertise a capability (Codex P2#4)', () => {
  it('rejects an active public listing with zero capabilities', () => {
    const r = validateServiceListing(mkConfig({}, { discoverability: 'public', status: 'active' }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('no_capabilities');
  });

  it('rejects an active UNLISTED listing with zero capabilities (still live)', () => {
    const r = validateServiceListing(mkConfig({}, { discoverability: 'unlisted', status: 'active' }));
    expect(codes(r)).toContain('no_capabilities');
  });

  it('ALLOWS an empty PAUSED listing (work in progress, not live)', () => {
    const r = validateServiceListing(mkConfig({}, { discoverability: 'public', status: 'paused' }));
    expect(codes(r)).not.toContain('no_capabilities');
  });

  it('ALLOWS an empty known_only listing (not published)', () => {
    const r = validateServiceListing(mkConfig({}, { discoverability: 'known_only', status: 'active' }));
    expect(codes(r)).not.toContain('no_capabilities');
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

describe('public_sensitive_capability — taxonomy §3 / guardrail #7', () => {
  it('rejects a PUBLIC listing carrying school_homework_status (sensitive + subject-scoped)', () => {
    const r = validateServiceListing(
      mkConfig({ school_homework_status: cap('school') }, { discoverability: 'public' }),
    );
    expect(codes(r)).toContain('public_sensitive_capability');
  });

  it('rejects a PUBLIC listing carrying appointment_status (sensitive + subject-scoped)', () => {
    const r = validateServiceListing(
      mkConfig({ appointment_status: cap('appointments') }, { discoverability: 'public' }),
    );
    expect(codes(r)).toContain('public_sensitive_capability');
  });

  it('rejects a PUBLIC listing carrying deploy_status (sensitive, not intent-routable)', () => {
    const r = validateServiceListing(
      mkConfig({ deploy_status: cap('developer_ops') }, { discoverability: 'public' }),
    );
    expect(codes(r)).toContain('public_sensitive_capability');
  });

  it('catches the rule when the sensitive capability is published under an ALIAS', () => {
    // homework_status folds to school_homework_status — the override must not
    // slip through via an alias spelling.
    const r = validateServiceListing(
      mkConfig({ homework_status: cap('school') }, { discoverability: 'public' }),
    );
    expect(codes(r)).toContain('public_sensitive_capability');
  });

  it('ALLOWS a PUBLIC sensitive capability whose policy explicitly permits it (appointment_book: routable + not subject-scoped)', () => {
    const r = validateServiceListing(
      mkConfig({ appointment_book: cap('healthcare', 'review') }, { discoverability: 'public' }),
    );
    expect(r.ok).toBe(true);
  });

  it('ALLOWS a PUBLIC service_health_status (sensitive but routable — public status pages)', () => {
    const r = validateServiceListing(
      mkConfig({ service_health_status: cap('developer_ops') }, { discoverability: 'public' }),
    );
    expect(r.ok).toBe(true);
  });

  it('only constrains PUBLIC — unlisted/known_only sensitive listings stay valid (review-gated)', () => {
    for (const discoverability of ['unlisted', 'known_only'] as const) {
      const r = validateServiceListing(
        mkConfig({ school_homework_status: cap('school', 'review') }, { discoverability }),
      );
      expect(r.ok).toBe(true);
    }
  });
});

describe('subject_auth_needs_review — stranger-reachable subject-scoped caps must be review-gated', () => {
  it('rejects AUTO for a subject-scoped capability on an UNLISTED listing', () => {
    // unlisted is reachable by anyone with the service_uri; stranger-chosen
    // subject identifiers (order ids, student names) need a human in front.
    const r = validateServiceListing(
      mkConfig({ school_homework_status: cap('school', 'auto') }, { discoverability: 'unlisted' }),
    );
    expect(codes(r)).toContain('subject_auth_needs_review');
  });

  it('rejects AUTO for order_status on a PUBLIC listing (personal privacy class — the public_sensitive rule does NOT cover it)', () => {
    const r = validateServiceListing(
      mkConfig({ order_status: cap('commerce', 'auto') }, { discoverability: 'public' }),
    );
    expect(codes(r)).toContain('subject_auth_needs_review');
    // and review satisfies it:
    const review = validateServiceListing(
      mkConfig({ order_status: cap('commerce', 'review') }, { discoverability: 'public' }),
    );
    expect(review.ok).toBe(true);
  });

  it('ALLOWS auto on a KNOWN_ONLY listing (access is explicitly grant-gated per grantee)', () => {
    const r = validateServiceListing(
      mkConfig({ school_homework_status: cap('school', 'auto') }, { discoverability: 'known_only' }),
    );
    expect(r.ok).toBe(true);
  });

  it('does not touch non-subject-scoped reads (eta_query auto public stays valid)', () => {
    const r = validateServiceListing(
      mkConfig({ eta_query: cap('transit', 'auto') }, { discoverability: 'public' }),
    );
    expect(r.ok).toBe(true);
  });
});
