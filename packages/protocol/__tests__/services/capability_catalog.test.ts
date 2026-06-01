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
});

describe('catalog ⊇ resolver-registry consistency gate (spec §79)', () => {
  it('every registry canonical exists in the catalog with IDENTICAL aliases', () => {
    for (const entry of CAPABILITY_REGISTRY) {
      const cap = getCatalogCapability(entry.canonical);
      expect(cap).not.toBeNull();
      // Aliases must match exactly (set equality) so the catalog and the sync
      // resolver canonicalize the same tokens — no drift.
      expect([...(cap?.aliases ?? [])].sort()).toEqual([...entry.aliases].sort());
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
