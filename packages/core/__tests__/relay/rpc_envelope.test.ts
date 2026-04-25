/**
 * T3.5 — Core RPC request envelope: build, seal, unseal, validate inner auth.
 *
 * Source: ARCHITECTURE.md Section 19.2.
 */

import {
  buildRPCRequest,
  sealRPCRequest,
  unsealRPCRequest,
  validateInnerAuth,
} from '../../src/relay/rpc_envelope';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('Core RPC Request Envelope', () => {
  const senderDID = 'did:key:z6MkCLIDevice';
  const recipientPriv = TEST_ED25519_SEED;
  const recipientPub = getPublicKey(recipientPriv);

  describe('buildRPCRequest', () => {
    it('creates envelope with type core_rpc_request', () => {
      const req = buildRPCRequest(
        'POST',
        '/v1/staging/ingest',
        '',
        '{"source":"gmail"}',
        { 'X-DID': senderDID },
        senderDID,
      );
      expect(req.type).toBe('core_rpc_request');
    });

    it('includes unique request_id', () => {
      const r1 = buildRPCRequest('GET', '/', '', '', {}, senderDID);
      const r2 = buildRPCRequest('GET', '/', '', '', {}, senderDID);
      expect(r1.request_id).toMatch(/^rpc-/);
      expect(r1.request_id).not.toBe(r2.request_id);
    });

    // CONTRACT: every call mints a fresh request_id, no matter how often
    // the wrapper is invoked. Core's idempotency cache (rpc_idempotency.go
    // / packages/core/src/relay/idempotency.ts) keys on
    // (from_did, request_id) — a stable id across calls makes the cache
    // return the first response forever.
    //
    // The Python CLI shipped with exactly this bug: `DinaClient.__init__`
    // set `self._req_id = uuid.uuid4().hex[:12]` once and threaded it
    // into every MsgBoxTransport call, so any long-lived client (the
    // agent-daemon) got cached responses on every claim/mark_running/
    // progress/complete. The fix was per-call generation; this test
    // pins the equivalent invariant on the TS side so the same shape
    // can't regress here.
    it('mints distinct request_ids across many calls (idempotency safety)', () => {
      const ids = new Set<string>();
      const N = 1000;
      for (let i = 0; i < N; i++) {
        ids.add(buildRPCRequest('GET', '/', '', '', {}, senderDID).request_id);
      }
      expect(ids.size).toBe(N);
    });

    it('preserves method, path, query, body, headers', () => {
      const req = buildRPCRequest(
        'POST',
        '/v1/vault/query',
        'limit=10',
        '{}',
        { 'X-DID': senderDID },
        senderDID,
      );
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/v1/vault/query');
      expect(req.query).toBe('limit=10');
      expect(req.body).toBe('{}');
    });

    it('sets from field to sender DID', () => {
      const req = buildRPCRequest('GET', '/', '', '', {}, senderDID);
      expect(req.from).toBe(senderDID);
    });
  });

  describe('sealRPCRequest + unsealRPCRequest', () => {
    it('seal → unseal recovers original request', () => {
      const req = buildRPCRequest(
        'POST',
        '/test',
        '',
        '{"data":true}',
        { 'X-DID': senderDID },
        senderDID,
      );
      const sealed = sealRPCRequest(req, recipientPub);
      expect(sealed).toBeInstanceOf(Uint8Array);
      expect(sealed.length).toBeGreaterThan(32); // at least eph_pub + overhead

      const recovered = unsealRPCRequest(sealed, recipientPub, recipientPriv);
      expect(recovered.type).toBe('core_rpc_request');
      expect(recovered.method).toBe('POST');
      expect(recovered.path).toBe('/test');
      expect(recovered.body).toBe('{"data":true}');
      expect(recovered.from).toBe(senderDID);
      expect(recovered.request_id).toBe(req.request_id);
    });

    it('sealed output is opaque bytes', () => {
      const req = buildRPCRequest('POST', '/', '', 'secret', {}, senderDID);
      const sealed = sealRPCRequest(req, recipientPub);
      // Should not contain plaintext
      const asString = Buffer.from(sealed).toString('utf-8');
      expect(asString).not.toContain('secret');
    });

    it('wrong recipient key fails', () => {
      const req = buildRPCRequest('GET', '/', '', '', {}, senderDID);
      const sealed = sealRPCRequest(req, recipientPub);
      const wrongPriv = new Uint8Array(32).fill(0x99);
      const wrongPub = getPublicKey(wrongPriv);
      expect(() => unsealRPCRequest(sealed, wrongPub, wrongPriv)).toThrow();
    });
  });

  describe('validateInnerAuth', () => {
    it('accepts request with valid inner Ed25519 headers', () => {
      const req = buildRPCRequest(
        'POST',
        '/v1/staging/ingest',
        '',
        '{}',
        {
          'X-DID': senderDID,
          'X-Timestamp': '2026-04-09T12:00:00Z',
          'X-Nonce': 'abc123',
          'X-Signature': 'deadbeef',
        },
        senderDID,
      );
      expect(validateInnerAuth(req)).toBe(true);
    });

    it('rejects request missing X-DID header', () => {
      const req = buildRPCRequest('POST', '/', '', '', {}, senderDID);
      expect(validateInnerAuth(req)).toBe(false);
    });

    it('rejects request with partial headers', () => {
      const req = buildRPCRequest('POST', '/', '', '', { 'X-DID': senderDID }, senderDID);
      expect(validateInnerAuth(req)).toBe(false);
    });
  });
});
