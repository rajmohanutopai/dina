/**
 * Envelope builder smoke — task 1.19.
 *
 * Verifies the pure constructors emit deterministic shapes that
 * match the wire contract. Cross-runtime signature interop depends
 * on these producing the exact same bytes as the Go port's
 * `json.Marshal` output, so we pin the expected JSON exactly.
 */

import { buildMessageJSON, buildRPCRequest } from '../src';

describe('buildMessageJSON (task 1.19)', () => {
  it('emits fixed Go-interop key order (id, type, from, to, created_time, body)', () => {
    const json = buildMessageJSON({
      id: 'msg-1',
      type: 'coordination.request',
      from: 'did:plc:alice',
      to: ['did:plc:bob'],
      created_time: 1776700000,
      bodyBase64: 'aGVsbG8=',
    });
    // Exact byte match — re-ordering keys breaks Ed25519 verification
    // against Go peers.
    expect(json).toBe(
      '{"id":"msg-1","type":"coordination.request","from":"did:plc:alice","to":["did:plc:bob"],"created_time":1776700000,"body":"aGVsbG8="}',
    );
  });

  it('normalises a single-string `to` into an array on the wire', () => {
    const json = buildMessageJSON({
      id: 'm',
      type: 't',
      from: 'a',
      to: 'did:plc:bob', // bare string
      created_time: 0,
      bodyBase64: '',
    });
    const parsed = JSON.parse(json);
    expect(parsed.to).toEqual(['did:plc:bob']);
  });

  it('preserves an array `to` unchanged', () => {
    const json = buildMessageJSON({
      id: 'm',
      type: 't',
      from: 'a',
      to: ['did:plc:x', 'did:plc:y'],
      created_time: 0,
      bodyBase64: '',
    });
    const parsed = JSON.parse(json);
    expect(parsed.to).toEqual(['did:plc:x', 'did:plc:y']);
  });

  it('is deterministic — same input, same bytes', () => {
    const input = {
      id: 'id-abc',
      type: 'presence.signal',
      from: 'did:a',
      to: ['did:b'] as string[],
      created_time: 1234567890,
      bodyBase64: 'YQ==',
    };
    expect(buildMessageJSON(input)).toBe(buildMessageJSON(input));
  });
});

describe('buildRPCRequest (task 1.19)', () => {
  it('stamps type=core_rpc_request and forwards caller-minted requestId', () => {
    const env = buildRPCRequest({
      requestId: 'rpc-deadbeef',
      method: 'POST',
      path: '/v1/vault/store',
      query: '',
      body: '{"persona":"personal"}',
      headers: { 'x-did': 'did:plc:brain' },
      senderDID: 'did:plc:brain',
    });
    expect(env.type).toBe('core_rpc_request');
    expect(env.request_id).toBe('rpc-deadbeef');
    expect(env.from).toBe('did:plc:brain');
    expect(env.method).toBe('POST');
    expect(env.path).toBe('/v1/vault/store');
    expect(env.body).toBe('{"persona":"personal"}');
    expect(env.headers['x-did']).toBe('did:plc:brain');
  });

  it('preserves query + body even when empty strings', () => {
    // GET with no body: query and body are '' on the wire, not null.
    const env = buildRPCRequest({
      requestId: 'rpc-x',
      method: 'GET',
      path: '/healthz',
      query: '',
      body: '',
      headers: {},
      senderDID: 'did:plc:brain',
    });
    expect(env.query).toBe('');
    expect(env.body).toBe('');
  });

  it('does not mint random id (callers do) — two calls with same input return same envelope', () => {
    // Protocol has no entropy source; determinism is a requirement
    // for tests that pin wire shapes.
    const input = {
      requestId: 'rpc-fixed',
      method: 'GET',
      path: '/healthz',
      query: '',
      body: '',
      headers: {},
      senderDID: 'did:plc:brain',
    };
    const a = buildRPCRequest(input);
    const b = buildRPCRequest(input);
    expect(a).toEqual(b);
    expect(a.request_id).toBe('rpc-fixed');
  });
});
