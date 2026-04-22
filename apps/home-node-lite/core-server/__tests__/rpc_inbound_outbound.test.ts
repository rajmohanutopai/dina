/**
 * Task 4.45 (unseal) + 4.47 (re-seal) round-trip tests.
 *
 * Uses @dina/core's sealRPCRequest / verifyResponseSignature as the
 * counter-parties so tests exercise the full sealed-box pipeline in
 * both directions — the two orchestrators here need to be
 * byte-interoperable with the @dina/core originals.
 */

import {
  sealRPCRequest,
  unsealRPCRequest,
  verifyResponseSignature,
  sealDecrypt,
  sealEncrypt,
  type CoreRPCRequest,
  type CoreRPCResponse,
} from '@dina/core';
import { RPC_REQUEST_TYPE, RPC_RESPONSE_TYPE } from '@dina/protocol';
import { mnemonicToSeed, generateMnemonic } from '@dina/core';
import { deriveIdentity } from '../src/identity/derivations';
import { unsealInboundRpc } from '../src/msgbox/rpc_inbound';
import { sealOutboundRpc } from '../src/msgbox/rpc_outbound';

function identityFromFresh() {
  return deriveIdentity({ masterSeed: mnemonicToSeed(generateMnemonic()) });
}

const CORE_DID = 'did:plc:core-home-node';
const SENDER_DID = 'did:plc:alice';

function validRequest(overrides: Partial<CoreRPCRequest> = {}): CoreRPCRequest {
  return {
    type: RPC_REQUEST_TYPE,
    request_id: 'req-abc',
    from: SENDER_DID,
    method: 'POST',
    path: '/v1/vault/store',
    query: '',
    headers: { 'x-did': SENDER_DID, 'content-type': 'application/json' },
    body: '{"persona":"general"}',
    ...overrides,
  };
}

describe('unsealInboundRpc (task 4.45)', () => {
  describe('happy path', () => {
    it('unseals + parses a well-formed sealed request', () => {
      const core = identityFromFresh().root;
      const sealed = sealRPCRequest(validRequest(), core.publicKey);
      const res = unsealInboundRpc({
        sealed,
        recipientEd25519Pub: core.publicKey,
        recipientEd25519Priv: core.privateKey,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.request.type).toBe(RPC_REQUEST_TYPE);
        expect(res.request.request_id).toBe('req-abc');
        expect(res.request.method).toBe('POST');
        expect(res.request.path).toBe('/v1/vault/store');
      }
    });
  });

  describe('decrypt_failed', () => {
    it('wrong recipient keypair → decrypt_failed', () => {
      const core = identityFromFresh().root;
      const otherCore = identityFromFresh().root;
      const sealed = sealRPCRequest(validRequest(), core.publicKey);
      const res = unsealInboundRpc({
        sealed,
        recipientEd25519Pub: otherCore.publicKey,
        recipientEd25519Priv: otherCore.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'decrypt_failed' });
    });

    it('truncated sealed bytes → decrypt_failed', () => {
      const core = identityFromFresh().root;
      const sealed = sealRPCRequest(validRequest(), core.publicKey);
      const res = unsealInboundRpc({
        sealed: sealed.slice(0, 20), // snip most of the ciphertext
        recipientEd25519Pub: core.publicKey,
        recipientEd25519Priv: core.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'decrypt_failed' });
    });

    it('wrong-length pub → decrypt_failed with detail', () => {
      const core = identityFromFresh().root;
      const res = unsealInboundRpc({
        sealed: new Uint8Array(48),
        recipientEd25519Pub: new Uint8Array(31),
        recipientEd25519Priv: core.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'decrypt_failed' });
    });
  });

  describe('malformed_json', () => {
    it('sealed bytes of invalid JSON → malformed_json', () => {
      const core = identityFromFresh().root;
      const raw = new TextEncoder().encode('not-json{at all');
      const sealed = sealEncrypt(raw, core.publicKey);
      const res = unsealInboundRpc({
        sealed,
        recipientEd25519Pub: core.publicKey,
        recipientEd25519Priv: core.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'malformed_json' });
    });
  });

  describe('wrong_envelope_type', () => {
    it('sealed JSON with type != core_rpc_request → wrong_envelope_type', () => {
      const core = identityFromFresh().root;
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: 'something_else', request_id: 'x' }),
      );
      const sealed = sealEncrypt(payload, core.publicKey);
      const res = unsealInboundRpc({
        sealed,
        recipientEd25519Pub: core.publicKey,
        recipientEd25519Priv: core.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'wrong_envelope_type' });
    });
  });

  describe('missing_required_field', () => {
    function sealedJson(core: ReturnType<typeof identityFromFresh>['root'], obj: unknown) {
      return sealEncrypt(new TextEncoder().encode(JSON.stringify(obj)), core.publicKey);
    }

    it('missing body field → missing_required_field', () => {
      const core = identityFromFresh().root;
      const sealed = sealedJson(core, {
        type: RPC_REQUEST_TYPE,
        request_id: 'r',
        from: SENDER_DID,
        method: 'GET',
        path: '/x',
        query: '',
        headers: {},
        // body: absent
      });
      const res = unsealInboundRpc({
        sealed,
        recipientEd25519Pub: core.publicKey,
        recipientEd25519Priv: core.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'missing_required_field' });
    });

    it('wrong type on request_id → missing_required_field', () => {
      const core = identityFromFresh().root;
      const sealed = sealedJson(core, {
        type: RPC_REQUEST_TYPE,
        request_id: 42, // must be string
        from: SENDER_DID,
        method: 'GET',
        path: '/x',
        query: '',
        headers: {},
        body: '',
      });
      const res = unsealInboundRpc({
        sealed,
        recipientEd25519Pub: core.publicKey,
        recipientEd25519Priv: core.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'missing_required_field' });
    });

    it('wrong type on headers → missing_required_field', () => {
      const core = identityFromFresh().root;
      const sealed = sealedJson(core, {
        type: RPC_REQUEST_TYPE,
        request_id: 'r',
        from: SENDER_DID,
        method: 'GET',
        path: '/x',
        query: '',
        headers: 'not-an-object',
        body: '',
      });
      const res = unsealInboundRpc({
        sealed,
        recipientEd25519Pub: core.publicKey,
        recipientEd25519Priv: core.privateKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'missing_required_field' });
    });
  });
});

describe('sealOutboundRpc (task 4.47)', () => {
  describe('round-trip with a sender', () => {
    it('seals a signed response that the sender can open + verify', () => {
      const core = identityFromFresh().root;
      const sender = identityFromFresh().root;
      const { sealed, response } = sealOutboundRpc({
        requestId: 'req-abc',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        coreDid: CORE_DID,
        corePrivateKey: core.privateKey,
        senderEd25519Pub: sender.publicKey,
      });
      // Sender opens the envelope.
      const plaintext = sealDecrypt(sealed, sender.publicKey, sender.privateKey);
      const json = JSON.parse(new TextDecoder().decode(plaintext)) as CoreRPCResponse;
      expect(json.type).toBe(RPC_RESPONSE_TYPE);
      expect(json.request_id).toBe('req-abc');
      expect(json.status).toBe(200);
      expect(json.body).toBe('{"ok":true}');
      expect(json.from).toBe(CORE_DID);
      expect(json.signature).toMatch(/^[0-9a-f]{128}$/);
      // The structured response we also return matches what's inside
      // the sealed envelope.
      expect(response).toEqual(json);
    });

    it('signature verifies against Core\'s public key', () => {
      const core = identityFromFresh().root;
      const sender = identityFromFresh().root;
      const { response } = sealOutboundRpc({
        requestId: 'req-1',
        status: 200,
        headers: {},
        body: '{"k":"v"}',
        coreDid: CORE_DID,
        corePrivateKey: core.privateKey,
        senderEd25519Pub: sender.publicKey,
      });
      expect(verifyResponseSignature(response, core.publicKey)).toBe(true);
    });

    it('different request_id produces a different signature (no replay)', () => {
      const core = identityFromFresh().root;
      const sender = identityFromFresh().root;
      const a = sealOutboundRpc({
        requestId: 'req-a',
        status: 200,
        headers: {},
        body: 'same-body',
        coreDid: CORE_DID,
        corePrivateKey: core.privateKey,
        senderEd25519Pub: sender.publicKey,
      });
      const b = sealOutboundRpc({
        requestId: 'req-b',
        status: 200,
        headers: {},
        body: 'same-body',
        coreDid: CORE_DID,
        corePrivateKey: core.privateKey,
        senderEd25519Pub: sender.publicKey,
      });
      expect(a.response.signature).not.toBe(b.response.signature);
    });

    it('wrong recipient key → envelope does NOT open', () => {
      const core = identityFromFresh().root;
      const sender = identityFromFresh().root;
      const attacker = identityFromFresh().root;
      const { sealed } = sealOutboundRpc({
        requestId: 'req-x',
        status: 200,
        headers: {},
        body: 'secret',
        coreDid: CORE_DID,
        corePrivateKey: core.privateKey,
        senderEd25519Pub: sender.publicKey,
      });
      expect(() => sealDecrypt(sealed, attacker.publicKey, attacker.privateKey)).toThrow();
    });
  });

  describe('input validation', () => {
    const mkCore = () => identityFromFresh().root;
    const mkSender = () => identityFromFresh().root;

    it('rejects empty requestId', () => {
      const core = mkCore();
      const sender = mkSender();
      expect(() =>
        sealOutboundRpc({
          requestId: '',
          status: 200,
          headers: {},
          body: '',
          coreDid: CORE_DID,
          corePrivateKey: core.privateKey,
          senderEd25519Pub: sender.publicKey,
        }),
      ).toThrow(/requestId is required/);
    });

    it('rejects out-of-range HTTP status', () => {
      const core = mkCore();
      const sender = mkSender();
      for (const bad of [99, 600, 1000, 0, -1]) {
        expect(() =>
          sealOutboundRpc({
            requestId: 'x',
            status: bad,
            headers: {},
            body: '',
            coreDid: CORE_DID,
            corePrivateKey: core.privateKey,
            senderEd25519Pub: sender.publicKey,
          }),
        ).toThrow(/status must be a valid HTTP code/);
      }
    });

    it('rejects empty coreDid', () => {
      const core = mkCore();
      const sender = mkSender();
      expect(() =>
        sealOutboundRpc({
          requestId: 'x',
          status: 200,
          headers: {},
          body: '',
          coreDid: '',
          corePrivateKey: core.privateKey,
          senderEd25519Pub: sender.publicKey,
        }),
      ).toThrow(/coreDid is required/);
    });

    it('rejects wrong-length keys', () => {
      const core = mkCore();
      const sender = mkSender();
      expect(() =>
        sealOutboundRpc({
          requestId: 'x',
          status: 200,
          headers: {},
          body: '',
          coreDid: CORE_DID,
          corePrivateKey: new Uint8Array(31),
          senderEd25519Pub: sender.publicKey,
        }),
      ).toThrow(/corePrivateKey must be 32 bytes/);
      expect(() =>
        sealOutboundRpc({
          requestId: 'x',
          status: 200,
          headers: {},
          body: '',
          coreDid: CORE_DID,
          corePrivateKey: core.privateKey,
          senderEd25519Pub: new Uint8Array(33),
        }),
      ).toThrow(/senderEd25519Pub must be 32 bytes/);
    });
  });
});

describe('round-trip: sealRPCRequest → unsealInboundRpc → sealOutboundRpc → sender opens', () => {
  it('end-to-end: sender seals request, core decrypts + handles + seals response, sender opens', () => {
    const core = identityFromFresh().root;
    const sender = identityFromFresh().root;

    // Sender side: seal the request with Core's pub key.
    const sealedReq = sealRPCRequest(
      validRequest({ request_id: 'req-roundtrip' }),
      core.publicKey,
    );

    // Core side: unseal.
    const inbound = unsealInboundRpc({
      sealed: sealedReq,
      recipientEd25519Pub: core.publicKey,
      recipientEd25519Priv: core.privateKey,
    });
    expect(inbound.ok).toBe(true);
    if (!inbound.ok) return;
    expect(inbound.request.request_id).toBe('req-roundtrip');

    // Core side: build + seal the response (addressed to sender).
    const outbound = sealOutboundRpc({
      requestId: inbound.request.request_id,
      status: 200,
      headers: {},
      body: '{"ok":true}',
      coreDid: CORE_DID,
      corePrivateKey: core.privateKey,
      senderEd25519Pub: sender.publicKey,
    });

    // Sender side: open the sealed response.
    const sender_plain = sealDecrypt(outbound.sealed, sender.publicKey, sender.privateKey);
    const sender_rpcResp = JSON.parse(new TextDecoder().decode(sender_plain)) as CoreRPCResponse;
    expect(sender_rpcResp.request_id).toBe('req-roundtrip');
    expect(sender_rpcResp.status).toBe(200);

    // Sender side: verify Core's signature on the canonical response.
    expect(verifyResponseSignature(sender_rpcResp, core.publicKey)).toBe(true);

    // Sanity: unsealRPCRequest from @dina/core is byte-compatible with our unsealInboundRpc.
    const coreDirectUnseal = unsealRPCRequest(sealedReq, core.publicKey, core.privateKey);
    expect(coreDirectUnseal.request_id).toBe(inbound.request.request_id);
  });
});
