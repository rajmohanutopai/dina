/**
 * In-memory AppView stub — seed a provider profile for the Bus Driver demo.
 *
 * Replaces the real AppView HTTP client for dev/demo builds: no network
 * dependency, no PDS round-trip, deterministic ranking. Production builds
 * swap this for `AppViewClient` (brain/src/appview_client/http.ts).
 *
 * The stub satisfies the minimal `Pick<AppViewClient, 'searchServices'>`
 * surface that `ServiceQueryOrchestrator` consumes. Callers seed it
 * with one or more profiles at boot; searches match on capability name
 * and optionally rank by haversine distance to the viewer.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md Blocker #4 (demo seed).
 */

import type { ServiceProfile, SearchServicesParams } from '@dina/brain/src/appview_client/http';

export interface AppViewStubOptions {
  /** Initial profiles to publish. Use `publish()` to add more at runtime. */
  profiles?: ServiceProfile[];
}

/**
 * Brand symbol for identifying AppViewStub instances after minification.
 * Previously boot_service detected the stub via `constructor.name ===
 * 'AppViewStub'`, which is brittle under bundling — a Metro release
 * build can rename the class and silently defeat demo-mode detection
 * (review #20). A Symbol reference is stable across any bundling step.
 */
export const APPVIEW_STUB_BRAND = Symbol.for('dina.appview_stub');

export function isAppViewStub(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { readonly [APPVIEW_STUB_BRAND]?: true })[APPVIEW_STUB_BRAND] === true
  );
}

export class AppViewStub {
  /** See `APPVIEW_STUB_BRAND` — used by `isAppViewStub()` detection. */
  readonly [APPVIEW_STUB_BRAND]: true = true;
  private readonly profiles = new Map<string, ServiceProfile>();

  constructor(options: AppViewStubOptions = {}) {
    for (const p of options.profiles ?? []) this.publish(p);
  }

  /** Add / overwrite a profile keyed by DID. */
  publish(profile: ServiceProfile): void {
    this.profiles.set(profile.did, profile);
  }

  /** Remove a profile. Returns true when it existed. */
  unpublish(did: string): boolean {
    return this.profiles.delete(did);
  }

  /** Current number of published profiles. */
  size(): number {
    return this.profiles.size;
  }

  /**
   * Mirrors `AppViewClient.searchServices`: filter to discoverable
   * profiles that advertise the capability, compute `distanceKm` when
   * viewer coords are supplied, and sort by distance.
   */
  async searchServices(params: SearchServicesParams): Promise<ServiceProfile[]> {
    if (!params.capability) {
      throw new Error('AppViewStub: capability is required');
    }
    const matches: ServiceProfile[] = [];
    for (const profile of this.profiles.values()) {
      if (!profile.isDiscoverable) continue;
      if (!profile.capabilities.includes(params.capability)) continue;
      if (params.q !== undefined && params.q !== '') {
        const q = params.q.toLowerCase();
        if (!profile.name.toLowerCase().includes(q)) continue;
      }
      if (
        typeof params.lat === 'number' &&
        typeof params.lng === 'number' &&
        typeof (profile as ServiceProfile & { lat?: number }).lat === 'number' &&
        typeof (profile as ServiceProfile & { lng?: number }).lng === 'number'
      ) {
        const plat = (profile as ServiceProfile & { lat: number }).lat;
        const plng = (profile as ServiceProfile & { lng: number }).lng;
        const dKm = haversineKm(params.lat, params.lng, plat, plng);
        if (typeof params.radiusKm === 'number' && dKm > params.radiusKm) continue;
        matches.push({ ...profile, distanceKm: dKm });
      } else {
        matches.push(profile);
      }
    }
    matches.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    return matches;
  }

  /** `isDiscoverable` mirror. */
  async isDiscoverable(did: string): Promise<{ isDiscoverable: boolean; capabilities: string[] }> {
    const p = this.profiles.get(did);
    if (p === undefined) return { isDiscoverable: false, capabilities: [] };
    return { isDiscoverable: p.isDiscoverable, capabilities: p.capabilities };
  }

  /**
   * Trust Network stubs — no local trust data in dev mode, so these
   * return the shape the real AppView would return for an unknown
   * subject. The `search_trust_network` tool surfaces this as a
   * graceful "no verified peer data" note instead of throwing.
   * Production swaps in `AppViewClient` whose implementations actually
   * hit `com.dina.trust.resolve` / `com.dina.trust.search`.
   */
  async resolveTrust(): Promise<{
    subjectType: string;
    trustLevel: string;
    confidence: number;
    attestationSummary: null;
    flags: [];
    authenticity: null;
    graphContext: null;
    recommendation: string;
    reasoning: string;
  }> {
    return {
      subjectType: 'unknown',
      trustLevel: 'none',
      confidence: 0,
      attestationSummary: null,
      flags: [],
      authenticity: null,
      graphContext: null,
      recommendation: 'no_data',
      reasoning: 'AppView not wired in this build — no verified trust data.',
    };
  }

  async searchTrust(): Promise<{ results: []; cursor: undefined; totalEstimate: number }> {
    return { results: [], cursor: undefined, totalEstimate: 0 };
  }
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Convenience: build a Bus Driver demo profile for `eta_query`.
 * Keeps demo seeds consistent across bootstrap + tests.
 */
export function busDriverDemoProfile(overrides: Partial<ServiceProfile> = {}): ServiceProfile {
  return {
    did: 'did:plc:bus42demo',
    name: 'Bus 42',
    description: 'Bus Driver demo — deterministic transit stub',
    capabilities: ['eta_query'],
    responsePolicy: { eta_query: 'auto' },
    isDiscoverable: true,
    ...overrides,
  };
}

/**
 * Convenience: build a Dr Carl demo profile for `appointment_status`.
 * Paired with a contact whose `preferredFor` contains `dental` so the
 * reasoning agent's `find_preferred_provider` tool resolves to this
 * provider on "my dentist appointment" queries, then dispatches
 * directly via `query_service` — no intermediate
 * `search_provider_services` turn needed.
 *
 * Seed alongside `busDriverDemoProfile` in demo bootstraps when you
 * want both the Bus Driver (ETA) and Dr Carl (appointment) surfaces
 * available end-to-end.
 */
export function drCarlDemoProfile(overrides: Partial<ServiceProfile> = {}): ServiceProfile {
  return {
    did: 'did:plc:drcarldemo',
    name: "Dr Carl's Clinic",
    description: 'Dr Carl demo — appointment_status live capability',
    capabilities: ['appointment_status'],
    responsePolicy: { appointment_status: 'auto' },
    isDiscoverable: true,
    capabilitySchemas: {
      appointment_status: {
        // Minimal declared schema — the demo server echoes back a
        // fixture payload; the shape matches the provider reply the
        // formatter expects (see WM-BRAIN-10).
        params: {
          type: 'object',
          properties: {
            patient_id: { type: 'string' },
            date: { type: 'string' },
          },
          required: ['patient_id'],
        },
        result: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            date: { type: 'string' },
            time: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['status'],
        },
        schemaHash: 'demo-drcarl-v1',
      },
    },
    ...overrides,
  };
}
