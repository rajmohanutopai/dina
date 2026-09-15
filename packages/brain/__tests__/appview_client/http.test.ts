/**
 * Tests for AppViewClient (Brain-side AppView HTTP adapter).
 *
 * Source parity: brain/src/adapter/appview_client.py
 */

import { AppViewClient, AppViewError, ServiceProfile } from '../../src/appview_client/http';

type FetchFn = typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetch(responses: (Response | Error | (() => Response | Error))[]): {
  fetchFn: FetchFn;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (input) => {
    calls.push(typeof input === 'string' ? input : (input as URL | Request).toString());
    const entry = responses[i];
    i = Math.min(i + 1, responses.length - 1);
    const resolved = typeof entry === 'function' ? entry() : entry;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  return { fetchFn, calls };
}

function noSleep(): Promise<void> {
  return Promise.resolve();
}

const APPVIEW = 'https://appview.test';
const SERVICE_A: ServiceProfile = {
  did: 'did:plc:demoprovider',
  handle: 'demoprovider.dinakernel.com',
  name: 'Demo Provider 42',
  description: 'Route 42 operator',
  capabilities: ['eta_query'],
  responsePolicy: { eta_query: 'auto' },
  isDiscoverable: true,
};

describe('AppViewClient', () => {
  describe('construction', () => {
    it('requires appViewURL', () => {
      expect(() => new AppViewClient({ appViewURL: '' })).toThrow(/appViewURL/);
    });

    it('rejects non-positive timeout', () => {
      expect(() => new AppViewClient({ appViewURL: APPVIEW, timeoutMs: 0 })).toThrow(/timeoutMs/);
    });

    it('rejects negative maxRetries', () => {
      expect(() => new AppViewClient({ appViewURL: APPVIEW, maxRetries: -1 })).toThrow(
        /maxRetries/,
      );
    });

    it('strips trailing slash', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(200, { services: [] })]);
      const c = new AppViewClient({
        appViewURL: 'https://appview.test/',
        fetch: fetchFn,
        sleepFn: noSleep,
      });
      await c.searchServices({ capability: 'eta_query' });
      expect(calls[0].startsWith('https://appview.test/xrpc/')).toBe(true);
      expect(calls[0].startsWith('https://appview.test//xrpc/')).toBe(false);
    });
  });

  describe('searchServices', () => {
    it('returns services from the response', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, { services: [SERVICE_A] })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      const result = await c.searchServices({ capability: 'eta_query' });
      expect(result).toHaveLength(1);
      expect(result[0].did).toBe('did:plc:demoprovider');
    });

    it('preserves the listing uri from the result (#1, multi-listing per DID)', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, {
          services: [
            {
              uri: 'at://did:plc:bus42/com.dinakernel.service.profile/route-42',
              operatorDid: 'did:plc:bus42',
              name: 'Bus 42',
              capabilities: ['eta_query'],
            },
          ],
        }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      const [profile] = await c.searchServices({ capability: 'eta_query' });
      // The chosen listing's uri must survive onto ServiceProfile so it can
      // ride the service.query (disambiguates which listing under this DID).
      expect(profile.uri).toBe('at://did:plc:bus42/com.dinakernel.service.profile/route-42');
    });

    it('passes all query params', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(200, { services: [] })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      await c.searchServices({
        capability: 'eta_query',
        lat: 37.77,
        lng: -122.41,
        radiusKm: 10,
        q: 'bus',
        limit: 20,
      });

      const url = new URL(calls[0]);
      expect(url.pathname).toBe('/xrpc/com.dinakernel.service.search');
      expect(url.searchParams.get('capability')).toBe('eta_query');
      expect(url.searchParams.get('lat')).toBe('37.77');
      expect(url.searchParams.get('lng')).toBe('-122.41');
      expect(url.searchParams.get('radiusKm')).toBe('10');
      expect(url.searchParams.get('q')).toBe('bus');
      expect(url.searchParams.get('limit')).toBe('20');
    });

    it('omits undefined params', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(200, { services: [] })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      await c.searchServices({ capability: 'eta_query' });

      const url = new URL(calls[0]);
      expect([...url.searchParams.keys()]).toEqual(['capability']);
    });

    it('throws on missing capability', async () => {
      const { fetchFn } = makeFetch([]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      await expect(c.searchServices({ capability: '' })).rejects.toBeInstanceOf(AppViewError);
    });

    it('returns [] when services is not an array', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, { services: 'oops' })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      expect(await c.searchServices({ capability: 'eta_query' })).toEqual([]);
    });

    it('filters out malformed entries', async () => {
      const mixed = [
        SERVICE_A,
        { did: 'did:plc:missing-name' }, // missing name & capabilities & isDiscoverable
        { did: 'did:plc:bad-caps', name: 'x', capabilities: [1, 2], isDiscoverable: true },
      ];
      const { fetchFn } = makeFetch([jsonResponse(200, { services: mixed })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      const result = await c.searchServices({ capability: 'eta_query' });
      expect(result).toHaveLength(1);
      expect(result[0].did).toBe('did:plc:demoprovider');
    });

    // REAL AppView wire shape: a provider with no published schema is
    // emitted as `capabilitySchemas: null` (NOT undefined) — see
    // appview/src/api/xrpc/service-search.ts (`r.capabilitySchemas ??
    // null`). normalizeProfile must treat null like absent;
    // `Object.entries(null)` would otherwise throw and crash the whole
    // search for any discoverable schemaless provider.
    it('handles a real-AppView profile with capabilitySchemas: null (does not throw)', async () => {
      const schemalessProvider = {
        did: 'did:plc:noschema',
        name: 'Schemaless Bus',
        capabilities: ['eta_query'],
        isDiscoverable: true,
        capabilitySchemas: null,
      };
      const { fetchFn } = makeFetch([
        jsonResponse(200, { services: [SERVICE_A, schemalessProvider] }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      const result = await c.searchServices({ capability: 'eta_query' });
      // BOTH providers returned — the null-schema one not dropped or crashing.
      expect(result.map((p) => p.did)).toEqual(['did:plc:demoprovider', 'did:plc:noschema']);
      // The null was normalized away (not left as a wire `null`).
      const noschema = result.find((p) => p.did === 'did:plc:noschema');
      expect(noschema?.capabilitySchemas).toBeUndefined();
    });
  });

  describe('resolveServiceByUri (unlisted shared-link path)', () => {
    const LISTING = {
      uri: 'at://did:plc:bus42/com.dinakernel.service.profile/route-42',
      operatorDid: 'did:plc:bus42',
      name: 'Bus 42 (unlisted)',
      capabilities: ['eta_query'],
      capabilitySchemas: { eta_query: { schemaHash: 'abc123' } },
    };

    it('hits getByUri with the uri param', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(200, LISTING)]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      await c.resolveServiceByUri(LISTING.uri);
      expect(calls[0]).toContain('/xrpc/com.dinakernel.service.getByUri');
      expect(calls[0]).toContain(encodeURIComponent(LISTING.uri));
    });

    it('maps a resolved listing to a ServiceProfile (operatorDid → did)', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, LISTING)]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      const profile = await c.resolveServiceByUri(LISTING.uri);
      expect(profile).not.toBeNull();
      expect(profile?.did).toBe('did:plc:bus42');
      expect(profile?.uri).toBe(LISTING.uri);
      expect(profile?.capabilities).toContain('eta_query');
    });

    it('returns null when the endpoint returns null (not found / known_only)', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, null)]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      expect(await c.resolveServiceByUri(LISTING.uri)).toBeNull();
    });

    it('requires a uri', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, null)]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      await expect(c.resolveServiceByUri('')).rejects.toThrow(/uri is required/);
    });
  });

  describe('isDiscoverable', () => {
    it('returns { isDiscoverable, capabilities } on 200', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, { isDiscoverable: true, capabilities: ['eta_query'] }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      expect(await c.isDiscoverable('did:plc:x')).toEqual({
        isDiscoverable: true,
        capabilities: ['eta_query'],
      });
    });

    it('encodes the did parameter', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { isDiscoverable: false, capabilities: [] }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });

      await c.isDiscoverable('did:web:ex/ample?x=1');
      expect(calls[0]).toContain('did=did%3Aweb%3Aex%2Fample%3Fx%3D1');
    });

    it('defaults missing fields safely', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, {})]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      expect(await c.isDiscoverable('did:plc:x')).toEqual({
        isDiscoverable: false,
        capabilities: [],
      });
    });

    it('throws AppViewError on 404', async () => {
      const { fetchFn } = makeFetch([jsonResponse(404, { error: 'NotFound' })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      await expect(c.isDiscoverable('did:plc:x')).rejects.toBeInstanceOf(AppViewError);
    });

    it('throws on missing did', async () => {
      const { fetchFn } = makeFetch([]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      await expect(c.isDiscoverable('')).rejects.toBeInstanceOf(AppViewError);
    });
  });

  describe('retry semantics', () => {
    it('retries 5xx and returns on final success', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(503, {}),
        jsonResponse(500, {}),
        jsonResponse(200, { services: [SERVICE_A] }),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 3,
      });
      const result = await c.searchServices({ capability: 'eta_query' });
      expect(result).toHaveLength(1);
      expect(calls).toHaveLength(3);
    });

    it('retries 429 (rate limit) and 408 (timeout)', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(429, {}),
        jsonResponse(408, {}),
        jsonResponse(200, { services: [] }),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 3,
      });
      await c.searchServices({ capability: 'eta_query' });
      expect(calls).toHaveLength(3);
    });

    it('does NOT retry 4xx client errors (400/404)', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(400, {})]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 3,
      });
      await expect(c.searchServices({ capability: 'eta_query' })).rejects.toBeInstanceOf(
        AppViewError,
      );
      expect(calls).toHaveLength(1);
    });

    it('does NOT retry 401/403 (auth)', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(401, {})]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 3,
      });
      await expect(c.searchServices({ capability: 'eta_query' })).rejects.toBeInstanceOf(
        AppViewError,
      );
      expect(calls).toHaveLength(1);
    });

    it('retries network errors', async () => {
      const { fetchFn, calls } = makeFetch([
        new Error('ECONNRESET'),
        new Error('ECONNREFUSED'),
        jsonResponse(200, { services: [] }),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 3,
      });
      await c.searchServices({ capability: 'eta_query' });
      expect(calls).toHaveLength(3);
    });

    it('throws after exhausting retries', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(503, {}),
        jsonResponse(503, {}),
        jsonResponse(503, {}),
        jsonResponse(503, {}),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 2,
      });
      const err = await c.searchServices({ capability: 'eta_query' }).catch((e) => e);
      expect(err).toBeInstanceOf(AppViewError);
      expect((err as AppViewError).status).toBe(503);
      // maxRetries=2 → 3 total attempts.
      expect(calls).toHaveLength(3);
    });

    it('sleeps with backoff(attempt) between retries', async () => {
      const attempts: number[] = [];
      const sleepFn = async (a: number) => {
        attempts.push(a);
      };
      const { fetchFn } = makeFetch([
        jsonResponse(503, {}),
        jsonResponse(503, {}),
        jsonResponse(200, { services: [] }),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn,
        maxRetries: 3,
      });
      await c.searchServices({ capability: 'eta_query' });
      expect(attempts).toEqual([0, 1]);
    });
  });

  describe('timeout', () => {
    it('aborts on slow responses', async () => {
      let aborted = false;
      const fetchFn: FetchFn = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        timeoutMs: 10,
        maxRetries: 0,
      });
      await expect(c.searchServices({ capability: 'eta_query' })).rejects.toBeInstanceOf(
        AppViewError,
      );
      expect(aborted).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // GAP-WIRE-01 — snake_case interop with main-dina AppView responses
  // -----------------------------------------------------------------

  describe('searchServices — wire format interop', () => {
    it('normalises main-dina snake_case per-capability schemas into mobile camelCase', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, {
          services: [
            {
              ...SERVICE_A,
              capabilitySchemas: {
                eta_query: {
                  params: { type: 'object' },
                  result: { type: 'object' },
                  schema_hash: 'sha256:canonical',
                  default_ttl_seconds: 60,
                  description: 'Returns ETA',
                },
              },
            },
          ],
        }),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 0,
      });
      const [profile] = await c.searchServices({ capability: 'eta_query' });
      const schema = profile.capabilitySchemas!.eta_query;
      // Mobile consumers see the idiomatic camelCase shape regardless
      // of whether the wire used snake_case or camelCase inner keys.
      expect(schema.schemaHash).toBe('sha256:canonical');
      expect(schema.defaultTtlSeconds).toBe(60);
      expect(schema.description).toBe('Returns ETA');
    });

    it('passes through already-camelCase responses unchanged', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, {
          services: [
            {
              ...SERVICE_A,
              capabilitySchemas: {
                eta_query: {
                  params: { type: 'object' },
                  result: { type: 'object' },
                  schemaHash: 'sha256:legacy',
                  defaultTtlSeconds: 90,
                },
              },
            },
          ],
        }),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 0,
      });
      const [profile] = await c.searchServices({ capability: 'eta_query' });
      const schema = profile.capabilitySchemas!.eta_query;
      expect(schema.schemaHash).toBe('sha256:legacy');
      expect(schema.defaultTtlSeconds).toBe(90);
    });

    it('prefers snake_case when both casings are present on the same entry', async () => {
      // Shouldn't happen in practice, but belt-and-braces: main is the
      // canonical wire, so its casing wins.
      const { fetchFn } = makeFetch([
        jsonResponse(200, {
          services: [
            {
              ...SERVICE_A,
              capabilitySchemas: {
                eta_query: {
                  params: { type: 'object' },
                  result: { type: 'object' },
                  schema_hash: 'sha256:main',
                  schemaHash: 'sha256:legacy',
                },
              },
            },
          ],
        }),
      ]);
      const c = new AppViewClient({
        appViewURL: APPVIEW,
        fetch: fetchFn,
        sleepFn: noSleep,
        maxRetries: 0,
      });
      const [profile] = await c.searchServices({ capability: 'eta_query' });
      expect(profile.capabilitySchemas!.eta_query.schemaHash).toBe('sha256:main');
    });
  });
});

describe('AppViewClient — commerce catalog + profile trust', () => {
  const CANDIDATE = {
    supplier_did: 'did:plc:chairmaker99',
    service_uri: 'at://did:plc:chairmaker99/com.dinakernel.service.profile/self',
    service_rkey: 'self',
    product: { scheme: 'gtin', value: '08901234567890' },
    catalog_snapshot_ref: 'bafysnap',
    matched_fields: ['identifier'],
    indicative_price: { currency: 'INR', minor_units: '50000' },
    fulfilment_regions: [{ scheme: 'iso-3166-2', value: 'IN-KA' }],
    generated_at: '2026-08-08T10:00:00.000Z',
    retrieval_score_bp: 6000,
  };

  describe('searchCatalog', () => {
    it('coerces snake_case candidates into the local camelCase shape', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, { candidates: [CANDIDATE], examined: 1, suppressed_below_trust_floor: 0 }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      const [cand] = await c.searchCatalog({ q: 'oak chair' });
      expect(cand.supplierDid).toBe('did:plc:chairmaker99');
      expect(cand.indicativePrice).toEqual({ currency: 'INR', minorUnits: '50000' });
      expect(cand.product).toEqual({ scheme: 'gtin', value: '08901234567890' });
      expect(cand.fulfilmentRegions).toEqual([{ scheme: 'iso-3166-2', value: 'IN-KA' }]);
      expect(cand.retrievalScoreBp).toBe(6000);
      expect(cand.validUntil).toBeUndefined();
    });

    it('sends identifiers and categories as REPEATED query params', async () => {
      const { fetchFn, calls } = makeFetch([jsonResponse(200, { candidates: [] })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      await c.searchCatalog({ identifiers: ['gtin:1', 'gtin:2'], categories: ['a', 'b'], limit: 5 });
      const url = calls[0];
      expect(url).toContain('/xrpc/com.dinakernel.commerce.searchCatalog');
      expect(url).toContain('identifier=gtin%3A1');
      expect(url).toContain('identifier=gtin%3A2');
      expect(url).toContain('category=a');
      expect(url).toContain('category=b');
      expect(url).toContain('limit=5');
    });

    it('drops a malformed candidate rather than passing a phantom offer', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, { candidates: [CANDIDATE, { supplier_did: 'did:plc:x' }] }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      const result = await c.searchCatalog({ q: 'x' });
      expect(result).toHaveLength(1);
      expect(result[0].supplierDid).toBe('did:plc:chairmaker99');
    });

    it('returns [] when the response has no candidates array', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, {})]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      expect(await c.searchCatalog({ q: 'x' })).toEqual([]);
    });

    it('coerces the optional fields (validUntil, region issuer, scoped product) when present', async () => {
      const { fetchFn } = makeFetch([
        jsonResponse(200, {
          candidates: [
            {
              ...CANDIDATE,
              valid_until: '2026-09-01T00:00:00.000Z',
              fulfilment_regions: [{ scheme: 'iso-3166-2', value: 'IN-KA', issuer_did: 'did:plc:reg' }],
              product: {
                scheme: 'manufacturer_sku',
                value: 'SKU1',
                issuer_did: 'did:plc:m',
                variant_digest: 'v1',
              },
            },
          ],
        }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      const [cand] = await c.searchCatalog({ q: 'x' });
      expect(cand.validUntil).toBe('2026-09-01T00:00:00.000Z');
      expect(cand.fulfilmentRegions[0]).toEqual({
        scheme: 'iso-3166-2',
        value: 'IN-KA',
        issuerDid: 'did:plc:reg',
      });
      expect(cand.product).toEqual({
        scheme: 'manufacturer_sku',
        value: 'SKU1',
        issuerDid: 'did:plc:m',
        variantDigest: 'v1',
      });
    });
  });

  describe('getProfile', () => {
    it('returns the numeric overallTrustScore', async () => {
      const { fetchFn, calls } = makeFetch([
        jsonResponse(200, { did: 'did:plc:s', overallTrustScore: 0.72, handle: 's' }),
      ]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      const profile = await c.getProfile('did:plc:s');
      expect(profile).toEqual({ overallTrustScore: 0.72 });
      expect(calls[0]).toContain('/xrpc/com.dinakernel.peerlens.getProfile');
      expect(calls[0]).toContain('did=did%3Aplc%3As');
    });

    it('maps a known DID with no score to null (never scored as zero)', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, { did: 'did:plc:s', overallTrustScore: null })]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      expect(await c.getProfile('did:plc:s')).toEqual({ overallTrustScore: null });
    });

    it('returns null when the DID has no profile', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, null)]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      expect(await c.getProfile('did:plc:missing')).toBeNull();
    });

    it('rejects an empty did', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, {})]);
      const c = new AppViewClient({ appViewURL: APPVIEW, fetch: fetchFn, sleepFn: noSleep });
      await expect(c.getProfile('')).rejects.toThrow(/did is required/);
    });
  });
});
