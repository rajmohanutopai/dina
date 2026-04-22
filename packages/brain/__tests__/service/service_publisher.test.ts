/**
 * Tests for ServicePublisher — the PDS-facing service profile publisher.
 *
 * Source parity: brain/src/service/service_publisher.py
 */

import { PDSPublisher, PDSPublisherError } from '../../src/pds/publisher';
import {
  PublisherConfigError,
  PublisherIdentityMismatchError,
  SERVICE_PROFILE_COLLECTION,
  SERVICE_PROFILE_RKEY,
  ServicePublisher,
  ServicePublisherConfig,
  buildRecord,
} from '../../src/service/service_publisher';
import { computeSchemaHash } from '../../src/service/capabilities/registry';

type FetchFn = typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Recorded {
  url: string;
  body: unknown;
}

function makeFetch(responses: Array<Response | Error>): {
  fetchFn: FetchFn;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body: bodyStr ? JSON.parse(bodyStr) : undefined });
    const entry = responses[i];
    i = Math.min(i + 1, responses.length - 1);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { fetchFn, calls };
}

const PDS = 'https://pds.test';
const HANDLE = 'bus.dinakernel.com';
const PASSWORD = 'pw';
const DID = 'did:plc:busdriver';
const JWT = 'jwt.abc';

function sessionOK(did = DID): Response {
  return jsonResponse(200, { accessJwt: JWT, did });
}

const validPublishConfig: ServicePublisherConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  description: 'Route 42 operator',
  capabilities: ['eta_query'],
  responsePolicy: { eta_query: 'auto' },
  capabilitySchemas: {
    eta_query: {
      params: { type: 'object', required: ['location'] },
      result: { type: 'object', required: ['eta_minutes'] },
      schemaHash: 'abc123',
    },
  },
};

function makePublisher(fetchFn: FetchFn, expectedDID = DID, nowMs?: number) {
  const pds = new PDSPublisher({
    pdsUrl: PDS,
    handle: HANDLE,
    password: PASSWORD,
    fetch: fetchFn,
  });
  return new ServicePublisher({
    pds,
    expectedDID,
    nowFn: nowMs !== undefined ? () => nowMs : undefined,
  });
}

describe('ServicePublisher', () => {
  describe('construction', () => {
    it('requires pds', () => {
      expect(
        () => new ServicePublisher({ pds: undefined as unknown as PDSPublisher, expectedDID: DID }),
      ).toThrow(/pds/);
    });

    it('requires expectedDID', () => {
      const { fetchFn } = makeFetch([]);
      const pds = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      expect(() => new ServicePublisher({ pds, expectedDID: '' })).toThrow(/expectedDID/);
    });
  });

  describe('buildRecord', () => {
    it('produces the canonical AT-Proto record shape', () => {
      const now = Date.UTC(2026, 3, 17, 12, 0, 0);
      const record = buildRecord(validPublishConfig, now);
      expect(record.$type).toBe(SERVICE_PROFILE_COLLECTION);
      expect(record.name).toBe('Bus 42');
      expect(record.description).toBe('Route 42 operator');
      expect(record.capabilities).toEqual(['eta_query']);
      expect(record.isDiscoverable).toBe(true);
      expect(record.updatedAt).toBe('2026-04-17T12:00:00.000Z');
      expect(record.responsePolicy).toEqual({ eta_query: 'auto' });
      // WM-BRAIN-06c: the published schemaHash is always the canonical
      // hash computed from `{params, result, description}`, regardless
      // of what the caller stored on the config. `validPublishConfig`
      // hard-codes `'abc123'` specifically to prove we don't trust it.
      // GAP-PROF-02: description is part of the hash input so a
      // description change invalidates the cache.
      const canonical = computeSchemaHash({
        params: validPublishConfig.capabilitySchemas!.eta_query.params,
        result: validPublishConfig.capabilitySchemas!.eta_query.result,
        description: '',
      });
      expect(canonical).not.toBe('abc123');
      // GAP-WIRE-01: emitted record uses snake_case per main-dina.
      expect(record.capabilitySchemas).toEqual({
        eta_query: {
          params: validPublishConfig.capabilitySchemas!.eta_query.params,
          result: validPublishConfig.capabilitySchemas!.eta_query.result,
          schema_hash: canonical,
        },
      });
    });

    it('omits description when empty', () => {
      const rec = buildRecord({ ...validPublishConfig, description: '' }, Date.UTC(2026, 3, 17));
      expect(Object.prototype.hasOwnProperty.call(rec, 'description')).toBe(false);
    });

    it('omits responsePolicy when empty', () => {
      const { responsePolicy: _rp, ...rest } = validPublishConfig;
      const rec = buildRecord(rest, Date.UTC(2026, 3, 17));
      expect(Object.prototype.hasOwnProperty.call(rec, 'responsePolicy')).toBe(false);
    });

    it('omits capabilitySchemas when not provided', () => {
      const { capabilitySchemas: _cs, ...rest } = validPublishConfig;
      const rec = buildRecord(rest, Date.UTC(2026, 3, 17));
      expect(Object.prototype.hasOwnProperty.call(rec, 'capabilitySchemas')).toBe(false);
    });

    it('WM-BRAIN-06c: published schemaHash is ALWAYS the canonical hash', () => {
      // Caller-supplied `schemaHash` is treated as advisory only —
      // the publisher never writes it through. This prevents stale
      // cached hashes from leaking to AppView / ingesters.
      const params = { type: 'object', required: ['location'] };
      const result = { type: 'object', required: ['eta_minutes'] };
      const canonical = computeSchemaHash({ params, result, description: '' });
      expect(canonical).toMatch(/^[0-9a-f]{64}$/);

      const rec = buildRecord(
        {
          ...validPublishConfig,
          capabilitySchemas: {
            eta_query: { params, result, schemaHash: 'stale-cached-hash' },
          },
        },
        Date.UTC(2026, 3, 17),
      );
      const emitted = (rec.capabilitySchemas as Record<string, { schema_hash: string }>).eta_query
        .schema_hash;
      expect(emitted).toBe(canonical);
      expect(emitted).not.toBe('stale-cached-hash');
    });

    it('WM-BRAIN-06c: matches canonical when caller pre-computes correctly (no warning)', () => {
      const params = { type: 'object', required: ['location'] };
      const result = { type: 'object', required: ['eta_minutes'] };
      const canonical = computeSchemaHash({ params, result, description: '' });
      const entries: Array<Record<string, unknown>> = [];
      const rec = buildRecord(
        {
          ...validPublishConfig,
          capabilitySchemas: {
            eta_query: { params, result, schemaHash: canonical },
          },
        },
        Date.UTC(2026, 3, 17),
        (e) => entries.push(e),
      );
      // Published hash identical to canonical — no mismatch warning.
      expect(
        (rec.capabilitySchemas as Record<string, { schema_hash: string }>).eta_query.schema_hash,
      ).toBe(canonical);
      expect(
        entries.find((e) => e.event === 'service_publisher.schema_hash_mismatch'),
      ).toBeUndefined();
    });

    it('WM-BRAIN-06c: logs a mismatch warning when caller hash diverges from canonical', () => {
      const params = { type: 'object', required: ['location'] };
      const result = { type: 'object', required: ['eta_minutes'] };
      const canonical = computeSchemaHash({ params, result, description: '' });
      const entries: Array<Record<string, unknown>> = [];
      buildRecord(
        {
          ...validPublishConfig,
          capabilitySchemas: {
            eta_query: { params, result, schemaHash: 'clearly-wrong' },
          },
        },
        Date.UTC(2026, 3, 17),
        (e) => entries.push(e),
      );
      const warn = entries.find((e) => e.event === 'service_publisher.schema_hash_mismatch');
      expect(warn).toBeDefined();
      expect(warn!.capability).toBe('eta_query');
      expect(warn!.supplied).toBe('clearly-wrong');
      expect(warn!.canonical).toBe(canonical);
      expect(warn!.detail).toMatch(/supplied schema_hash does not match canonical for eta_query/);
    });

    it('WM-BRAIN-06c: empty supplied hash is silent (no warning, still overrides)', () => {
      // Empty string = "no cache available yet." Not an error.
      const entries: Array<Record<string, unknown>> = [];
      const rec = buildRecord(
        {
          ...validPublishConfig,
          capabilitySchemas: {
            eta_query: {
              params: { type: 'object' },
              result: { type: 'object' },
              schemaHash: '',
            },
          },
        },
        Date.UTC(2026, 3, 17),
        (e) => entries.push(e),
      );
      expect(
        entries.find((e) => e.event === 'service_publisher.schema_hash_mismatch'),
      ).toBeUndefined();
      const emitted = (rec.capabilitySchemas as Record<string, { schema_hash: string }>).eta_query
        .schema_hash;
      expect(emitted).toMatch(/^[0-9a-f]{64}$/);
    });

    it('copies capabilities array (defensive copy)', () => {
      const source = ['eta_query'];
      const rec = buildRecord({ ...validPublishConfig, capabilities: source }, 0);
      source.push('mutated');
      expect(rec.capabilities).toEqual(['eta_query']);
    });

    it('GAP-PROF-02: description is part of the canonical hash', () => {
      const params = { type: 'object' };
      const result = { type: 'object' };
      const withoutDesc = computeSchemaHash({ params, result, description: '' });
      const withDesc = computeSchemaHash({ params, result, description: 'Returns ETA in minutes' });
      expect(withoutDesc).not.toBe(withDesc);

      const rec = buildRecord(
        {
          ...validPublishConfig,
          capabilitySchemas: {
            eta_query: { params, result, schemaHash: '', description: 'Returns ETA in minutes' },
          },
        },
        Date.UTC(2026, 3, 17),
      );
      const emitted = (rec.capabilitySchemas as Record<string, { schema_hash: string }>).eta_query
        .schema_hash;
      expect(emitted).toBe(withDesc);
    });

    it('GAP-PROF-03: serialises description + defaultTtlSeconds per capability', () => {
      const rec = buildRecord(
        {
          ...validPublishConfig,
          capabilitySchemas: {
            eta_query: {
              params: { type: 'object' },
              result: { type: 'object' },
              schemaHash: '',
              description: 'Returns ETA',
              defaultTtlSeconds: 120,
            },
          },
        },
        Date.UTC(2026, 3, 17),
      );
      const schemas = rec.capabilitySchemas as Record<string, Record<string, unknown>>;
      expect(schemas.eta_query.description).toBe('Returns ETA');
      expect(schemas.eta_query.default_ttl_seconds).toBe(120);
    });

    it('GAP-PROF-03: omits description + defaultTtlSeconds when absent / non-positive', () => {
      const rec = buildRecord(
        {
          ...validPublishConfig,
          capabilitySchemas: {
            eta_query: {
              params: { type: 'object' },
              result: { type: 'object' },
              schemaHash: '',
              defaultTtlSeconds: 0, // non-positive → dropped
            },
          },
        },
        Date.UTC(2026, 3, 17),
      );
      const schemas = rec.capabilitySchemas as Record<string, Record<string, unknown>>;
      expect(Object.prototype.hasOwnProperty.call(schemas.eta_query, 'description')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(schemas.eta_query, 'default_ttl_seconds')).toBe(
        false,
      );
    });
  });

  describe('publish', () => {
    it('POSTs putRecord with the canonical body', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'at://did/col/self', cid: 'cid1' }),
      ]);
      const p = makePublisher(fetchFn, DID, Date.UTC(2026, 3, 17));
      const result = await p.publish(validPublishConfig);

      expect(result).toEqual({ uri: 'at://did/col/self', cid: 'cid1' });
      expect(calls[1].url).toContain('com.atproto.repo.putRecord');
      const putBody = calls[1].body as Record<string, unknown>;
      expect(putBody.collection).toBe(SERVICE_PROFILE_COLLECTION);
      expect(putBody.rkey).toBe(SERVICE_PROFILE_RKEY);
      const record = putBody.record as Record<string, unknown>;
      expect(record.$type).toBe(SERVICE_PROFILE_COLLECTION);
      expect(record.updatedAt).toBe('2026-04-17T00:00:00.000Z');
    });

    it('validates config before hitting the network', async () => {
      const { fetchFn, calls } = makeFetch([sessionOK()]);
      const p = makePublisher(fetchFn);

      const bad = { ...validPublishConfig, name: '' };
      await expect(p.publish(bad)).rejects.toBeInstanceOf(PublisherConfigError);
      expect(calls).toHaveLength(0);
    });

    it('rejects identity mismatch BEFORE any write', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK('did:plc:someone-else'),
        // If publish() ever called putRecord, this would be consumed. It must not be.
        jsonResponse(200, { uri: 'u', cid: 'c' }),
      ]);
      const p = makePublisher(fetchFn, DID);

      const err = await p.publish(validPublishConfig).catch((e) => e);
      expect(err).toBeInstanceOf(PublisherIdentityMismatchError);
      expect((err as PublisherIdentityMismatchError).expectedDID).toBe(DID);
      expect((err as PublisherIdentityMismatchError).actualDID).toBe('did:plc:someone-else');
      // Only createSession was called — putRecord was NOT reached.
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('createSession');
    });

    it('surfaces PDS errors transparently', async () => {
      const { fetchFn } = makeFetch([
        sessionOK(),
        jsonResponse(400, { error: 'InvalidSchema', message: 'bad record shape' }),
      ]);
      const p = makePublisher(fetchFn);
      await expect(p.publish(validPublishConfig)).rejects.toBeInstanceOf(PDSPublisherError);
    });

    it('is idempotent: same rkey overwrites in place', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'u1', cid: 'c1' }),
        jsonResponse(200, { uri: 'u1', cid: 'c2' }), // same uri, new cid
      ]);
      const p = makePublisher(fetchFn);
      await p.publish(validPublishConfig);
      await p.publish(validPublishConfig);

      expect(calls.filter((c) => c.url.includes('putRecord'))).toHaveLength(2);
      const bodies = calls
        .filter((c) => c.url.includes('putRecord'))
        .map((c) => (c.body as Record<string, unknown>).rkey);
      expect(new Set(bodies)).toEqual(new Set([SERVICE_PROFILE_RKEY]));
    });
  });

  describe('unpublish', () => {
    it('calls deleteRecord with the fixed rkey', async () => {
      const { fetchFn, calls } = makeFetch([sessionOK(), jsonResponse(200, {})]);
      const p = makePublisher(fetchFn);
      await p.unpublish();

      expect(calls[1].url).toContain('com.atproto.repo.deleteRecord');
      expect(calls[1].body).toEqual({
        repo: DID,
        collection: SERVICE_PROFILE_COLLECTION,
        rkey: SERVICE_PROFILE_RKEY,
      });
    });

    it('tolerates "record not found" (idempotent)', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(400, { error: 'RecordNotFound' })]);
      const p = makePublisher(fetchFn);
      await expect(p.unpublish()).resolves.toBeUndefined();
    });

    it('tolerates 404', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(404, {})]);
      const p = makePublisher(fetchFn);
      await expect(p.unpublish()).resolves.toBeUndefined();
    });

    it('rejects identity mismatch BEFORE calling deleteRecord', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK('did:plc:someone-else'),
        jsonResponse(200, {}),
      ]);
      const p = makePublisher(fetchFn, DID);
      await expect(p.unpublish()).rejects.toBeInstanceOf(PublisherIdentityMismatchError);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('createSession');
    });

    it('re-throws non-"gone" PDS errors', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(500, {})]);
      const p = makePublisher(fetchFn);
      await expect(p.unpublish()).rejects.toBeInstanceOf(PDSPublisherError);
    });
  });

  describe('sync', () => {
    it('publishes when isDiscoverable=true', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'u', cid: 'c' }),
      ]);
      const p = makePublisher(fetchFn);
      const result = await p.sync(validPublishConfig);

      expect(result).toEqual({ published: true, result: { uri: 'u', cid: 'c' } });
      expect(calls[1].url).toContain('putRecord');
    });

    it('unpublishes when isDiscoverable=false', async () => {
      const { fetchFn, calls } = makeFetch([sessionOK(), jsonResponse(200, {})]);
      const p = makePublisher(fetchFn);
      const result = await p.sync({ ...validPublishConfig, isDiscoverable: false });

      expect(result).toEqual({ published: false });
      expect(calls[1].url).toContain('deleteRecord');
    });
  });
});
