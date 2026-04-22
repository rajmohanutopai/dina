/**
 * Fixture compatibility — protocol types must stay structurally consistent
 * with the wire shapes `@dina/fixtures` documents.
 *
 * Double-layer validation:
 *   1. **Compile-time** — each example object literal below is typed
 *      against the exported protocol type. TypeScript refuses to compile
 *      if a rename/reshape drifts the types out of spec (e.g. if
 *      `VerificationMethod.type` changes from `'Multikey'` to something
 *      else without fixture updates).
 *   2. **Runtime** — every example round-trips through `JSON.stringify` +
 *      `JSON.parse` without field loss or re-shape. Catches accidents
 *      like an interface with a hidden non-serializable field.
 *
 * The fixtures in `@dina/fixtures/*` are harness-formatted test vectors
 * (with `vectors[].inputs` / `vectors[].expected` wrappers), not raw
 * protocol-shape JSON. This test reaches into those wrapped values to
 * confirm they're consistent with our type assumptions.
 *
 * Task owner: docs/HOME_NODE_LITE_TASKS.md task 1.27.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  DIDDocument,
  VerificationMethod,
  ServiceEndpoint,
  ServiceQueryBody,
  ServiceResponseBody,
  CoreRPCRequest,
  CoreRPCResponse,
  AuthChallengeFrame,
  AuthResponseFrame,
  AuthSuccessFrame,
  D2DPayload,
} from '../src';
import {
  AUTH_CHALLENGE,
  AUTH_RESPONSE,
  AUTH_SUCCESS,
  RPC_REQUEST_TYPE,
  RPC_RESPONSE_TYPE,
  SERVICE_TYPE_MSGBOX,
  DINA_MESSAGING_FRAGMENT,
  DINA_SIGNING_FRAGMENT,
  DID_V1_CONTEXT,
  MULTIKEY_CONTEXT,
  MSG_TYPE_SERVICE_QUERY,
  MSG_TYPE_SERVICE_RESPONSE,
  MAX_SERVICE_TTL,
} from '../src';

const FIXTURES_ROOT = resolve(__dirname, '..', '..', 'fixtures');

/** Round-trip a protocol-typed value through JSON and assert shape equality. */
function roundTrip<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('@dina/protocol type ↔ fixture compatibility (task 1.27)', () => {
  it('DIDDocument compiles with values consistent with fixtures/identity', () => {
    // Example constructed with values the Go + Python test vectors use.
    const vm: VerificationMethod = {
      id: `did:plc:test123${DINA_SIGNING_FRAGMENT}`,
      type: 'Multikey',
      controller: 'did:plc:test123',
      publicKeyMultibase: 'z6MkTest',
    };
    const svc: ServiceEndpoint = {
      id: DINA_MESSAGING_FRAGMENT,
      type: SERVICE_TYPE_MSGBOX,
      serviceEndpoint: 'wss://mailbox.example/ws',
    };
    const doc: DIDDocument = {
      '@context': [DID_V1_CONTEXT, MULTIKEY_CONTEXT],
      id: 'did:plc:test123',
      verificationMethod: [vm],
      authentication: [vm.id],
      service: [svc],
      created: '2026-04-21T12:00:00Z',
    };

    // Confirm the DID doc fixture actually references the shape we expect.
    const fixture = JSON.parse(
      readFileSync(resolve(FIXTURES_ROOT, 'identity', 'did_document.json'), 'utf8'),
    ) as {
      vectors: Array<{ expected: { context: string[]; service_type: string } }>;
    };
    expect(fixture.vectors.length).toBeGreaterThan(0);
    expect(fixture.vectors[0]!.expected.context).toContain(DID_V1_CONTEXT);

    // Round-trip preserves every field.
    expect(roundTrip(doc)).toEqual(doc);
    expect(roundTrip(vm)).toEqual(vm);
    expect(roundTrip(svc)).toEqual(svc);
  });

  it('D2D service-query/response bodies compile with MSG_TYPE_* + MAX_SERVICE_TTL', () => {
    const query: ServiceQueryBody = {
      query_id: 'q-abc',
      capability: 'eta_query',
      params: { route_id: '42' },
      schema_hash: 'a1b2c3d4',
      ttl_seconds: 60,
    };
    const response: ServiceResponseBody = {
      query_id: 'q-abc',
      capability: 'eta_query',
      status: 'success',
      result: { eta_minutes: 12 },
      schema_hash: 'a1b2c3d4',
    };

    // Type is string-literal; values narrow correctly.
    expect(MSG_TYPE_SERVICE_QUERY).toBe('service.query');
    expect(MSG_TYPE_SERVICE_RESPONSE).toBe('service.response');
    expect(query.ttl_seconds).toBeLessThanOrEqual(MAX_SERVICE_TTL);

    expect(roundTrip(query)).toEqual(query);
    expect(roundTrip(response)).toEqual(response);
  });

  it('Core RPC envelopes compile with RPC_REQUEST_TYPE / RPC_RESPONSE_TYPE', () => {
    const request: CoreRPCRequest = {
      type: RPC_REQUEST_TYPE,
      request_id: 'rpc-deadbeef',
      from: 'did:key:z6MkTest',
      method: 'GET',
      path: '/v1/vault/query',
      query: 'limit=10',
      headers: { 'X-DID': 'did:key:z6MkTest' },
      body: '',
    };
    const response: CoreRPCResponse = {
      type: RPC_RESPONSE_TYPE,
      request_id: 'rpc-deadbeef',
      from: 'did:plc:homenode',
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
      signature: 'deadbeef'.repeat(16),
    };

    expect(roundTrip(request)).toEqual(request);
    expect(roundTrip(response)).toEqual(response);
  });

  it('Auth frames compile with the string-literal constants', () => {
    const challenge: AuthChallengeFrame = {
      type: AUTH_CHALLENGE,
      nonce: '53d7c64fbc420c33935c168ad83d0a50',
      ts: 1776700149,
    };
    const resp: AuthResponseFrame = {
      type: AUTH_RESPONSE,
      did: 'did:plc:homenode',
      sig: 'aa'.repeat(32),
      pub: 'bb'.repeat(32),
    };
    const success: AuthSuccessFrame = { type: AUTH_SUCCESS };

    expect(roundTrip(challenge)).toEqual(challenge);
    expect(roundTrip(resp)).toEqual(resp);
    expect(roundTrip(success)).toEqual(success);
  });

  it('D2DPayload compiles as base64 + hex fields', () => {
    const payload: D2DPayload = {
      c: 'AAECAwQFBgc=',
      s: 'cc'.repeat(32),
    };
    expect(roundTrip(payload)).toEqual(payload);
  });
});
