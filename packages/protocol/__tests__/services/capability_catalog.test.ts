/**
 * Service-capability catalog — V1 foundation tests.
 *
 * Covers: catalog integrity (incl. fail-loud on bad fixtures, spec §41), the
 * catalog ⊇ resolver-registry consistency gate (spec §79 — prevents the two
 * vocabularies diverging), the build/serialize contract, and accessors.
 */

import {
  CATALOG_CATEGORIES,
  CATALOG_CAPABILITIES,
  CATALOG_VERSION,
  DEPRECATED_CAPABILITIES,
  buildCapabilityCatalog,
  classifyCatalogCapability,
  getCatalogCapability,
  getCatalogCategory,
  isOfficialCapability,
  resolveCatalogCapability,
  serializeCatalogForHash,
  validateCatalogIntegrity,
} from '../../src/services/capability-catalog';
import { CAPABILITY_REGISTRY } from '../../src/services/capability-registry';

import type { CapabilityDefinition, CatalogCategory } from '../../src/types/catalog';

// ── Valid minimal fixtures to mutate for the fail-loud cases. ──
const CAT_A: CatalogCategory = {
  id: 'cat_a',
  display_name: 'Cat A',
  short_description: 'a',
  sort_order: 1,
  lifecycle: 'stable',
};
const CAT_B: CatalogCategory = { ...CAT_A, id: 'cat_b', display_name: 'Cat B' };
const CAP_A: CapabilityDefinition = {
  id: 'thing_status',
  aliases: ['thing_state'],
  category_ids: ['cat_a'],
  default_category_id: 'cat_a',
  display_name: 'Thing status',
  short_description: 'status of a thing',
  lifecycle: 'stable',
  action_class: 'read',
  privacy_class: 'public',
  default_discoverability: 'public',
  approval_policy_hint: 'none',
  intent_routable: true,
  requires_verified_provider: false,
  requires_subject_authorization: false,
  introduced_in: '2026-06-01',
};
// Same as CAP_A but with NO default_category_id (exactOptionalPropertyTypes
// forbids setting an optional prop to `undefined`, so omit it via destructure).
const { default_category_id: _omitDefault, ...CAP_NO_DEFAULT } = CAP_A;

describe('catalog integrity — shipped catalog', () => {
  it('the shipped catalog passes integrity (module-load enforced too)', () => {
    expect(() => validateCatalogIntegrity(CATALOG_CATEGORIES, CATALOG_CAPABILITIES)).not.toThrow();
  });

  it('every capability id is flat snake_case (no dots — dots are for custom)', () => {
    for (const cap of CATALOG_CAPABILITIES) {
      expect(cap.id).not.toContain('.');
      expect(cap.id).toBe(cap.id.trim().toLowerCase());
    }
  });

  it('every category_ids / default_category_id resolves to a real category', () => {
    const ids = new Set(CATALOG_CATEGORIES.map((c) => c.id));
    for (const cap of CATALOG_CAPABILITIES) {
      for (const cid of cap.category_ids) expect(ids.has(cid)).toBe(true);
      if (cap.default_category_id !== undefined) {
        expect(cap.category_ids).toContain(cap.default_category_id);
      }
    }
  });

  it('developer/ops + home/IoT capabilities default to known_only (official but private — spec §19/§24)', () => {
    for (const cap of CATALOG_CAPABILITIES) {
      if (cap.default_category_id === 'developer_ops' || cap.default_category_id === 'home_iot') {
        expect(cap.default_discoverability).toBe('known_only');
      }
    }
  });

  it('the 3 launch-backed capabilities carry default params/result schemas', () => {
    for (const id of ['eta_query', 'price_check', 'appointment_status']) {
      const cap = getCatalogCapability(id);
      expect(cap).not.toBeNull();
      expect(cap?.params_schema).toBeDefined();
      expect(cap?.result_schema).toBeDefined();
    }
  });
});

describe('catalog integrity — fail-loud on authoring bugs (spec §41)', () => {
  it('rejects a duplicate category id', () => {
    expect(() => validateCatalogIntegrity([CAT_A, { ...CAT_A }], [CAP_A])).toThrow(/duplicate category id/i);
  });

  it('rejects a duplicate capability id', () => {
    expect(() => validateCatalogIntegrity([CAT_A], [CAP_A, { ...CAP_A, aliases: [] }])).toThrow(
      /duplicate capability id "thing_status"/i,
    );
  });

  it('rejects an alias that collides with another capability id', () => {
    const other: CapabilityDefinition = { ...CAP_A, id: 'other_status', aliases: ['thing_status'] };
    expect(() => validateCatalogIntegrity([CAT_A], [CAP_A, other])).toThrow(/maps to both/i);
  });

  it('rejects two capabilities sharing one alias', () => {
    const a: CapabilityDefinition = { ...CAP_A, id: 'a_status', aliases: ['shared'] };
    const b: CapabilityDefinition = { ...CAP_A, id: 'b_status', aliases: ['shared'] };
    expect(() => validateCatalogIntegrity([CAT_A], [a, b])).toThrow(/maps to both/i);
  });

  it('rejects a dotted id/alias (dots reserved for namespaced custom)', () => {
    expect(() => validateCatalogIntegrity([CAT_A], [{ ...CAP_A, id: 'com.acme.thing' }])).toThrow(
      /reserved for namespaced custom/i,
    );
    expect(() => validateCatalogIntegrity([CAT_A], [{ ...CAP_A, aliases: ['com.acme.thing'] }])).toThrow(
      /reserved for namespaced custom/i,
    );
  });

  it('rejects an id/alias that is not trimmed-lowercase', () => {
    expect(() => validateCatalogIntegrity([CAT_A], [{ ...CAP_A, aliases: ['Thing_State'] }])).toThrow(
      /trimmed \+ lowercase/i,
    );
  });

  it('rejects a category reference to an unknown category', () => {
    expect(() =>
      validateCatalogIntegrity([CAT_A], [{ ...CAP_NO_DEFAULT, category_ids: ['nope'] }]),
    ).toThrow(/unknown category "nope"/i);
  });

  it('rejects an empty category_ids', () => {
    expect(() =>
      validateCatalogIntegrity([CAT_A], [{ ...CAP_NO_DEFAULT, category_ids: [] }]),
    ).toThrow(/no category_ids/i);
  });

  it('rejects default_category_id not within category_ids', () => {
    expect(() =>
      validateCatalogIntegrity(
        [CAT_A, CAT_B],
        [{ ...CAP_A, category_ids: ['cat_a'], default_category_id: 'cat_b' }],
      ),
    ).toThrow(/default_category_id "cat_b" is not in its category_ids/i);
  });

  it('rejects a booking/write/payment/agentic capability with approval_policy_hint "none"', () => {
    const booking: CapabilityDefinition = { ...CAP_A, id: 'book_thing', action_class: 'booking', approval_policy_hint: 'none' };
    expect(() => validateCatalogIntegrity([CAT_A], [booking])).toThrow(/must carry a non-"none" approval/i);
  });

  it('rejects a subject-scoped capability marked intent_routable (taxonomy §3)', () => {
    const subjectScoped: CapabilityDefinition = {
      ...CAP_A,
      id: 'subject_thing',
      requires_subject_authorization: true,
      intent_routable: true,
    };
    expect(() => validateCatalogIntegrity([CAT_A], [subjectScoped])).toThrow(
      /must not be intent_routable/i,
    );
  });

  it('rejects a sensitive capability failing the public-exposure predicate with a PUBLIC default (self-contradicting catalog)', () => {
    // Such a default steers every new listing into a guaranteed
    // public_sensitive_capability publish error.
    const selfContradicting: CapabilityDefinition = {
      ...CAP_A,
      id: 'lab_results_status',
      privacy_class: 'sensitive',
      intent_routable: false,
      requires_subject_authorization: true,
      default_discoverability: 'public',
    };
    expect(() => validateCatalogIntegrity([CAT_A], [selfContradicting])).toThrow(
      /fails the public-exposure predicate/i,
    );
    // A sensitive cap that PASSES the predicate (routable + not subject-scoped,
    // e.g. a public status page) MAY default public.
    const allowed: CapabilityDefinition = {
      ...CAP_A,
      id: 'status_page_thing',
      privacy_class: 'sensitive',
      intent_routable: true,
      requires_subject_authorization: false,
      default_discoverability: 'public',
    };
    expect(() => validateCatalogIntegrity([CAT_A], [allowed])).not.toThrow();
  });

  it('rejects requires_verified_provider + intent_routable until verified-provider routing exists (taxonomy §6 Stage B)', () => {
    const credentialVerify: CapabilityDefinition = {
      ...CAP_A,
      id: 'credential_verify',
      requires_verified_provider: true,
      intent_routable: true,
    };
    expect(() => validateCatalogIntegrity([CAT_A], [credentialVerify])).toThrow(
      /verified-provider routing exists/i,
    );
  });
});

describe('routing-policy fields (PUBLIC_SERVICES_TAXONOMY §3)', () => {
  it('no shipped subject-scoped capability is intent_routable', () => {
    for (const cap of CATALOG_CAPABILITIES) {
      if (cap.requires_subject_authorization) {
        expect(cap.intent_routable).toBe(false);
      }
    }
  });

  it('school_homework_status is official but never generic-routable, approved-only by default', () => {
    const cap = getCatalogCapability('school_homework_status');
    expect(cap?.intent_routable).toBe(false);
    expect(cap?.requires_subject_authorization).toBe(true);
    expect(cap?.default_discoverability).toBe('known_only'); // target per taxonomy §3
  });

  it('the canonical generic-discovery capabilities stay routable', () => {
    for (const id of ['eta_query', 'price_check', 'appointment_availability', 'service_quote']) {
      expect(getCatalogCapability(id)?.intent_routable).toBe(true);
    }
  });

  it('bare generic-family ids (status_lookup etc.) stay CONCEPTUAL — not registered, not publishable (guardrail #4)', () => {
    // PUBLIC_SERVICES_TAXONOMY guardrail #4: until tuple routing
    // ({capability, category_id, object_type}) exists, broad families must not
    // ship as callable bare capabilities — only their typed profiles
    // (order_status, appointment_status, …) are real. A bare family id must
    // classify as UNKNOWN (flat, unregistered), which the listing validator
    // rejects as `unknown_capability`.
    for (const familyId of [
      'status_lookup',
      'availability_lookup',
      'schedule_lookup',
      'hours_lookup',
      'inventory_lookup',
      'balance_lookup',
      'usage_lookup',
    ]) {
      expect(getCatalogCapability(familyId)).toBeNull();
      expect(classifyCatalogCapability(familyId)).toEqual({ kind: 'unknown' });
    }
  });
});

describe('catalog ⊇ resolver-registry consistency gate (spec §79)', () => {
  it('every registry canonical exists in the catalog with IDENTICAL aliases + categoryIds', () => {
    for (const entry of CAPABILITY_REGISTRY) {
      const cap = getCatalogCapability(entry.canonical);
      expect(cap).not.toBeNull();
      // Aliases must match exactly (set equality) so the catalog and the sync
      // resolver canonicalize the same tokens — no drift.
      expect([...(cap?.aliases ?? [])].sort()).toEqual([...entry.aliases].sort());
      // categoryIds must match too — AppView validates published categories
      // against the registry's `categoryIds`, so they MUST equal the catalog's
      // `category_ids` or AppView would drop a category the catalog allows
      // (or admit one it forbids). This closes the anti-spoof gate (Codex #3).
      expect([...entry.categoryIds].sort()).toEqual([...(cap?.category_ids ?? [])].sort());
      // intentRoutable must mirror the catalog's intent_routable — AppView's
      // generic searchCapabilities filters on the REGISTRY flag (it can't
      // import the catalog), so a mismatch would route a capability the
      // catalog forbids from generic discovery (or hide one it allows).
      expect(entry.intentRoutable).toBe(cap?.intent_routable);
      // privacyClass + requiresSubjectAuthorization mirror the catalog so the
      // INGESTER can enforce the public-sensitive rule at the trust boundary
      // (a direct-to-PDS publisher bypasses the listing validator).
      expect(entry.privacyClass).toBe(cap?.privacy_class);
      expect(entry.requiresSubjectAuthorization).toBe(cap?.requires_subject_authorization);
      // description + domain are the LLM's actual routing signals in
      // searchCapabilities — pin them to the catalog's short_description /
      // default_category_id so the two vocabularies can't silently diverge.
      expect(entry.description).toBe(cap?.short_description);
      expect(entry.domain).toBe(cap?.default_category_id);
    }
  });

  it('the registry mirrors EVERY catalog capability (no catalog cap missing from the registry)', () => {
    // The §79 gate above checks registry ⊆ catalog; this checks catalog ⊆
    // registry. Without it, a catalog capability absent from the registry
    // would be pickable in mobile but unroutable + unfilterable in AppView.
    const registryIds = new Set(CAPABILITY_REGISTRY.map((e) => e.canonical));
    for (const cap of CATALOG_CAPABILITIES) {
      expect(registryIds.has(cap.id)).toBe(true);
    }
  });
});

describe('build + serialize', () => {
  it('buildCapabilityCatalog assembles the response with injected hash + timestamp', () => {
    const cat = buildCapabilityCatalog({ generatedAt: '2026-06-01T00:00:00Z', hash: 'deadbeef' });
    expect(cat.catalog_version).toBe(CATALOG_VERSION);
    expect(cat.catalog_hash).toBe('deadbeef');
    expect(cat.generated_at).toBe('2026-06-01T00:00:00Z');
    expect(cat.categories).toBe(CATALOG_CATEGORIES);
    expect(cat.capabilities).toBe(CATALOG_CAPABILITIES);
    expect(cat.deprecated_capabilities).toBe(DEPRECATED_CAPABILITIES);
    expect(cat.min_client_version).toBeUndefined();
  });

  it('includes min_client_version only when supplied', () => {
    const cat = buildCapabilityCatalog({ generatedAt: 't', hash: 'h', minClientVersion: '1.2.0' });
    expect(cat.min_client_version).toBe('1.2.0');
  });

  it('serializeCatalogForHash is deterministic and excludes volatile fields', () => {
    const a = serializeCatalogForHash();
    const b = serializeCatalogForHash();
    expect(a).toBe(b);
    expect(a).not.toContain('generated_at');
    expect(a).not.toContain('catalog_hash');
    expect(a).toContain(CATALOG_VERSION);
  });
});

describe('accessors', () => {
  it('getCatalogCapability / isOfficialCapability resolve canonical ids only', () => {
    expect(getCatalogCapability('eta_query')?.id).toBe('eta_query');
    expect(isOfficialCapability('eta_query')).toBe(true);
    // An alias is not a canonical id; the resolver folds aliases, the catalog
    // is keyed by canonical id.
    expect(getCatalogCapability('bus_eta')).toBeNull();
    expect(isOfficialCapability('com.acme.widget_price')).toBe(false);
    expect(isOfficialCapability('nonsense')).toBe(false);
  });

  it('getCatalogCategory resolves real categories', () => {
    expect(getCatalogCategory('transit')?.display_name).toBe('Transit and Mobility');
    expect(getCatalogCategory('nope')).toBeNull();
  });
});

describe('catalog-aware resolver (knows the WHOLE catalog, not just the 3 seed)', () => {
  it('resolveCatalogCapability folds aliases over all catalog capabilities', () => {
    expect(resolveCatalogCapability('eta_query')).toBe('eta_query');
    expect(resolveCatalogCapability('bus_eta')).toBe('eta_query'); // seed alias
    expect(resolveCatalogCapability('deploy_status')).toBe('deploy_status'); // non-seed cap
    expect(resolveCatalogCapability('deployment_status')).toBe('deploy_status'); // non-seed alias
    expect(resolveCatalogCapability('  DEPLOY_STATUS ')).toBe('deploy_status'); // normalised
    expect(resolveCatalogCapability('not_a_capability')).toBeNull();
    expect(resolveCatalogCapability('')).toBeNull();
  });

  it('classifyCatalogCapability splits official / custom / unknown (anti-spoof)', () => {
    expect(classifyCatalogCapability('eta_query')).toEqual({ kind: 'official', canonical: 'eta_query' });
    expect(classifyCatalogCapability('bus_eta')).toEqual({ kind: 'official', canonical: 'eta_query' });
    expect(classifyCatalogCapability('deploy_status')).toEqual({ kind: 'official', canonical: 'deploy_status' });
    expect(classifyCatalogCapability('com.acme.widget_price')).toEqual({
      kind: 'custom',
      canonical: 'com.acme.widget_price',
    });
    // An unknown FLAT name is NOT admitted as official (the spoof the spec guards).
    expect(classifyCatalogCapability('eta_query2')).toEqual({ kind: 'unknown' });
    expect(classifyCatalogCapability('random_flat')).toEqual({ kind: 'unknown' });
  });
});
