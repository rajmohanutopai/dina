/**
 * T3.9 — MsgBox POST /forward: all 6 headers, canonical auth, POST delivery.
 *
 * Source: ARCHITECTURE.md Section 19.1
 */

import {
  buildForwardHeaders,
  buildForwardCanonical,
  postToForward,
  setFetchFn,
  resetFetchFn,
} from '../../src/relay/msgbox_forward';
import { verify, getPublicKey } from '../../src/crypto/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('MsgBox POST /forward', () => {
  const senderDID = 'did:key:z6MkSender';
  const recipientDID = 'did:plc:recipient';
  const senderPub = getPublicKey(TEST_ED25519_SEED);
  const senderPubHex = bytesToHex(senderPub);
  const payload = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

  afterEach(() => resetFetchFn());

  describe('buildForwardHeaders', () => {
    it('returns all 6 required headers', () => {
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      expect(headers['X-Recipient-DID']).toBe(recipientDID);
      expect(headers['X-Sender-DID']).toBe(senderDID);
      expect(headers['X-Timestamp']).toBeTruthy();
      expect(headers['X-Nonce']).toBeTruthy();
      expect(headers['X-Signature']).toBeTruthy();
      expect(headers['X-Sender-Pub']).toBe(senderPubHex);
    });

    it('X-Timestamp is RFC3339 format', () => {
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      expect(headers['X-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('X-Nonce is 32-char hex string', () => {
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      expect(headers['X-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    });

    it('X-Signature is 128-char hex (Ed25519)', () => {
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      expect(headers['X-Signature']).toMatch(/^[0-9a-f]{128}$/);
    });

    it('X-Sender-Pub is 64-char hex (32 bytes)', () => {
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      expect(headers['X-Sender-Pub'].length).toBe(64);
    });

    it('signature is verifiable', () => {
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      const bodyHash = bytesToHex(sha256(payload));
      const canonical = buildForwardCanonical(
        recipientDID,
        headers['X-Timestamp'],
        headers['X-Nonce'],
        bodyHash,
      );
      const sig = hexToBytes(headers['X-Signature']);
      expect(verify(senderPub, new TextEncoder().encode(canonical), sig)).toBe(true);
    });

    it('two calls produce different nonces', () => {
      const h1 = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      const h2 = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      expect(h1['X-Nonce']).not.toBe(h2['X-Nonce']);
    });
  });

  describe('buildForwardCanonical', () => {
    it('format: POST\\n/forward\\n{recipientDID}\\n{timestamp}\\n{nonce}\\n{bodyHash}', () => {
      const canonical = buildForwardCanonical(
        'did:plc:recip',
        '2026-04-09T12:00:00Z',
        'abc123',
        'deadbeef',
      );
      expect(canonical).toBe(
        'POST\n/forward\ndid:plc:recip\n2026-04-09T12:00:00Z\nabc123\ndeadbeef',
      );
    });

    it('different body hash → different canonical', () => {
      const c1 = buildForwardCanonical('did:plc:r', '2026-04-09T12:00:00Z', 'abc123', 'hash1');
      const c2 = buildForwardCanonical('did:plc:r', '2026-04-09T12:00:00Z', 'abc123', 'hash2');
      expect(c1).not.toBe(c2);
    });

    it('different recipient → different canonical (replay protection)', () => {
      const c1 = buildForwardCanonical('did:plc:alice', 'ts', 'nonce', 'hash');
      const c2 = buildForwardCanonical('did:plc:bob', 'ts', 'nonce', 'hash');
      expect(c1).not.toBe(c2);
    });

    it('has 6 newline-separated components', () => {
      const canonical = buildForwardCanonical('did:plc:r', 'ts', 'nonce', 'hash');
      expect(canonical.split('\n').length).toBe(6);
    });

    it('method is POST, path is /forward, recipient is 3rd field', () => {
      const canonical = buildForwardCanonical('did:plc:recip', 'ts', 'nonce', 'hash');
      const parts = canonical.split('\n');
      expect(parts[0]).toBe('POST');
      expect(parts[1]).toBe('/forward');
      expect(parts[2]).toBe('did:plc:recip');
    });
  });

  describe('postToForward', () => {
    it('POSTs to /forward and returns delivered status', async () => {
      setFetchFn(async (url: any) => {
        expect(url).toBe('https://mailbox.dinakernel.com/forward');
        return {
          ok: true,
          json: async () => ({ status: 'delivered', msg_id: 'msg-001' }),
        } as Response;
      });
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      const result = await postToForward('https://mailbox.dinakernel.com', headers, payload);
      expect(result.status).toBe('delivered');
      expect(result.msg_id).toBe('msg-001');
    });

    it('returns buffered status when recipient offline', async () => {
      setFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ status: 'buffered', msg_id: 'msg-002' }),
          }) as Response,
      );
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      const result = await postToForward('https://mb.com', headers, payload);
      expect(result.status).toBe('buffered');
    });

    it('throws on HTTP error', async () => {
      setFetchFn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error',
          }) as Response,
      );
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      await expect(postToForward('https://mb.com', headers, payload)).rejects.toThrow('HTTP 500');
    });

    it('sends Content-Type octet-stream', async () => {
      let capturedHeaders: Record<string, string> = {};
      setFetchFn(async (_url: any, opts: any) => {
        capturedHeaders = opts.headers;
        return { ok: true, json: async () => ({ status: 'delivered', msg_id: 'x' }) } as Response;
      });
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      await postToForward('https://mb.com', headers, payload);
      expect(capturedHeaders['Content-Type']).toBe('application/octet-stream');
    });

    it('includes all 6 auth headers in POST', async () => {
      let capturedHeaders: Record<string, string> = {};
      setFetchFn(async (_url: any, opts: any) => {
        capturedHeaders = opts.headers;
        return { ok: true, json: async () => ({ status: 'delivered', msg_id: 'x' }) } as Response;
      });
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      await postToForward('https://mb.com', headers, payload);
      expect(capturedHeaders['X-Recipient-DID']).toBe(recipientDID);
      expect(capturedHeaders['X-Sender-DID']).toBe(senderDID);
      expect(capturedHeaders['X-Sender-Pub']).toBeTruthy();
      expect(capturedHeaders['X-Timestamp']).toBeTruthy();
      expect(capturedHeaders['X-Nonce']).toBeTruthy();
      expect(capturedHeaders['X-Signature']).toBeTruthy();
    });

    it('appends /forward to URL', async () => {
      let capturedURL = '';
      setFetchFn(async (url: any) => {
        capturedURL = url as string;
        return { ok: true, json: async () => ({ status: 'delivered', msg_id: 'x' }) } as Response;
      });
      const headers = buildForwardHeaders(
        recipientDID,
        senderDID,
        senderPubHex,
        TEST_ED25519_SEED,
        payload,
      );
      await postToForward('https://mb.dinakernel.com', headers, payload);
      expect(capturedURL).toBe('https://mb.dinakernel.com/forward');
    });
  });
});
