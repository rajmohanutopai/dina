/**
 * AppViewStub — seed helper + search/isDiscoverable parity.
 *
 * Covers both demo fixtures (`demoServiceProfile`, `drCarlDemoProfile`
 * / WM-DEMO-02) and the stub's `AppViewClient` parity surface so the
 * reasoning pipeline can consume either interchangeably.
 */

import {
  AppViewStub,
  demoServiceProfile,
  drCarlDemoProfile,
  isAppViewStub,
} from '../../src/services/appview_stub';

describe('AppViewStub', () => {
  it('publishes seeded profiles and counts them', () => {
    const stub = new AppViewStub({
      profiles: [demoServiceProfile(), drCarlDemoProfile()],
    });
    expect(stub.size()).toBe(2);
  });

  it('searchServices filters by capability', async () => {
    const stub = new AppViewStub({
      profiles: [demoServiceProfile(), drCarlDemoProfile()],
    });
    const eta = await stub.searchServices({ capability: 'eta_query' });
    const appt = await stub.searchServices({ capability: 'appointment_status' });
    expect(eta.map((p) => p.did)).toEqual(['did:plc:bus42demo']);
    expect(appt.map((p) => p.did)).toEqual(['did:plc:drcarldemo']);
  });

  // The stub must mirror real AppView's canonical capability matching:
  // search_capabilities returns the canonical `eta_query`, so
  // search_provider_services('eta_query') must still find an
  // `eta_query`-advertising (or alias-advertising) profile. Also the
  // inverse — an alias query finds a canonical profile.
  it('searchServices matches on the CANONICAL capability (alias-aware)', async () => {
    const stub = new AppViewStub({
      profiles: [demoServiceProfile()], // advertises canonical eta_query
    });
    // alias `bus_eta` → finds the canonical eta_query provider.
    const viaAlias = await stub.searchServices({ capability: 'bus_eta' });
    expect(viaAlias.map((p) => p.did)).toEqual(['did:plc:bus42demo']);
    // canonical query still finds it.
    const viaCanonical = await stub.searchServices({ capability: 'eta_query' });
    expect(viaCanonical.map((p) => p.did)).toEqual(['did:plc:bus42demo']);
    // a different canonical does not cross.
    const other = await stub.searchServices({ capability: 'appointment_status' });
    expect(other).toEqual([]);
  });

  // Real AppView drops UNKNOWN (out-of-registry) capabilities — the index
  // holds only canonical names, so a non-canonical query short-circuits
  // to []. The stub must mirror that, else demos pass for custom
  // capabilities production AppView will never discover.
  it('searchServices drops an unknown (out-of-registry) capability query', async () => {
    const stub = new AppViewStub({ profiles: [demoServiceProfile()] });
    expect(await stub.searchServices({ capability: 'totally_made_up' })).toEqual([]);
  });

  it('searchServices does NOT match a profile advertising an unknown custom capability', async () => {
    // A profile advertising a non-registry capability is invisible to
    // search (real AppView only indexes canonical names). The query for
    // that same custom string also resolves to null → [].
    const customProfile = { ...demoServiceProfile(), capabilities: ['my_custom_cap'] };
    const stub = new AppViewStub({ profiles: [customProfile] });
    expect(await stub.searchServices({ capability: 'my_custom_cap' })).toEqual([]);
  });

  it('isDiscoverable reports the right caps per DID', async () => {
    const stub = new AppViewStub({ profiles: [drCarlDemoProfile()] });
    expect(await stub.isDiscoverable('did:plc:drcarldemo')).toEqual({
      isDiscoverable: true,
      capabilities: ['appointment_status'],
    });
    // Unknown DID → conservative negative.
    expect(await stub.isDiscoverable('did:plc:unknown')).toEqual({
      isDiscoverable: false,
      capabilities: [],
    });
  });

  it('isAppViewStub brand survives overrides', () => {
    const stub = new AppViewStub();
    expect(isAppViewStub(stub)).toBe(true);
    expect(isAppViewStub({})).toBe(false);
    expect(isAppViewStub(null)).toBe(false);
  });
});

describe('drCarlDemoProfile (WM-DEMO-02)', () => {
  it('carries appointment_status capability + a concrete schema', () => {
    const p = drCarlDemoProfile();
    expect(p.did).toBe('did:plc:drcarldemo');
    expect(p.capabilities).toEqual(['appointment_status']);
    expect(p.responsePolicy).toEqual({ appointment_status: 'auto' });
    expect(p.isDiscoverable).toBe(true);
    // Schema is declared so the schema-autofetch path (WM-BRAIN-06d)
    // lights up in demo builds.
    const sch = p.capabilitySchemas?.appointment_status;
    expect(sch).toBeDefined();
    expect(sch!.schemaHash).toBe('demo-drcarl-v1');
    expect(sch!.params).toMatchObject({
      type: 'object',
      required: ['patient_id'],
    });
    expect(sch!.result).toMatchObject({
      type: 'object',
      required: ['status'],
    });
  });

  it('overrides are applied on top of the defaults', () => {
    const p = drCarlDemoProfile({ name: 'Custom Clinic' });
    expect(p.name).toBe('Custom Clinic');
    // Defaults still present.
    expect(p.capabilities).toEqual(['appointment_status']);
  });

  it('integrates with the stub: search + isDiscoverable return the Dr Carl profile', async () => {
    const stub = new AppViewStub({ profiles: [drCarlDemoProfile()] });
    const [match] = await stub.searchServices({ capability: 'appointment_status' });
    expect(match.name).toBe("Dr Carl's Clinic");
    const disc = await stub.isDiscoverable('did:plc:drcarldemo');
    expect(disc.isDiscoverable).toBe(true);
    expect(disc.capabilities).toContain('appointment_status');
  });
});
