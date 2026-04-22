/**
 * HTTP harness end-to-end tests (task 10.16).
 *
 * Boots the harness on a random port, hits every endpoint, shuts down.
 * Uses Node's built-in `fetch` (available in Node ≥ 18).
 */

import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import sodium from 'libsodium-wrappers';

import { createHarness, type Harness } from '../conformance/http_harness';

const VECTORS_DIR = path.resolve(__dirname, '..', 'conformance', 'vectors');

function baseURL(h: Harness): string {
  const addr = h.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe('HTTP harness (task 10.16)', () => {
  let harness: Harness;
  let origin: string;

  beforeAll(async () => {
    await sodium.ready; // /report runs the runner which exercises the sealed-box verifier
    harness = createHarness({ vectorsDir: VECTORS_DIR });
    await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', () => resolve()));
    origin = baseURL(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('GET /healthz → 200 ok', async () => {
    const res = await fetch(`${origin}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toContain('conformance-harness');
  });

  it('every GET response carries CORS: *', async () => {
    const res = await fetch(`${origin}/healthz`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('GET /vectors → index.json body', async () => {
    const res = await fetch(`${origin}/vectors`);
    expect(res.status).toBe(200);
    const body = await res.json() as { vectors: Array<{ name: string }> };
    expect(Array.isArray(body.vectors)).toBe(true);
    expect(body.vectors.length).toBeGreaterThan(0);
  });

  it.each([
    'canonical_request_string',
    'd2d_envelope_round_trip',
    'sha256_body_hash',
    'ed25519_sign_verify',
    'auth_challenge_response',
    'did_key_from_ed25519_pub',
    'blake2b_24_sealed_nonce',
    'plc_document_verification',
    'nacl_sealed_box',
  ])('GET /vectors/%s → 200 vector JSON', async (name) => {
    const res = await fetch(`${origin}/vectors/${name}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string };
    expect(body.name).toBe(name);
  });

  it('GET /vectors/<unknown> → 404', async () => {
    const res = await fetch(`${origin}/vectors/definitely_not_a_vector`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unknown_vector');
  });

  it('GET /report → JSON report', async () => {
    const res = await fetch(`${origin}/report`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const report = await res.json() as { summary: { passed: number; failed: number } };
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBeGreaterThan(0);
  });

  it('GET /report?format=text → plain text', async () => {
    const res = await fetch(`${origin}/report?format=text`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('@dina/protocol conformance report');
    expect(text).toContain('PASS ');
  });

  it('GET /features → count + array of frozen vectors', async () => {
    const res = await fetch(`${origin}/features`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      count: number;
      features: Array<{ name: string; task: string; level: string }>;
    };
    expect(body.count).toBe(body.features.length);
    expect(body.count).toBeGreaterThan(0);
    // Every frozen vector must be in the feature list.
    const names = new Set(body.features.map((f) => f.name));
    expect(names.has('canonical_request_string')).toBe(true);
    expect(names.has('nacl_sealed_box')).toBe(true);
  });

  it('POST / → 405 (only GET is supported)', async () => {
    const res = await fetch(`${origin}/vectors`, { method: 'POST' });
    expect(res.status).toBe(405);
    const body = await res.json() as { error: string; allowed: string[] };
    expect(body.error).toBe('method_not_allowed');
    expect(body.allowed).toContain('GET');
  });

  it('GET /unknown → 404 with discovery path list', async () => {
    const res = await fetch(`${origin}/totally-bogus`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; available_paths: string[] };
    expect(body.error).toBe('not_found');
    expect(body.available_paths).toContain('/healthz');
    expect(body.available_paths).toContain('/report');
  });

  it('no cache — responses include Cache-Control: no-store', async () => {
    const res = await fetch(`${origin}/report`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
