/**
 * AppViewStub — seed helper + search/isDiscoverable parity.
 *
 * Covers both demo fixtures (`busDriverDemoProfile`, `drCarlDemoProfile`
 * / WM-DEMO-02) and the stub's `AppViewClient` parity surface so the
 * reasoning pipeline can consume either interchangeably.
 */

import {
  AppViewStub,
  busDriverDemoProfile,
  drCarlDemoProfile,
  isAppViewStub,
} from '../../src/services/appview_stub';

describe('AppViewStub', () => {
  it('publishes seeded profiles and counts them', () => {
    const stub = new AppViewStub({
      profiles: [busDriverDemoProfile(), drCarlDemoProfile()],
    });
    expect(stub.size()).toBe(2);
  });

  it('searchServices filters by capability', async () => {
    const stub = new AppViewStub({
      profiles: [busDriverDemoProfile(), drCarlDemoProfile()],
    });
    const eta = await stub.searchServices({ capability: 'eta_query' });
    const appt = await stub.searchServices({ capability: 'appointment_status' });
    expect(eta.map((p) => p.did)).toEqual(['did:plc:bus42demo']);
    expect(appt.map((p) => p.did)).toEqual(['did:plc:drcarldemo']);
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
