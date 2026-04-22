/**
 * Task 4.58 — self-certify + verify DID doc tests.
 */

import type { DIDDocument } from '@dina/core';
import { generateMnemonic, mnemonicToSeed } from '@dina/core';
import { deriveIdentity } from '../src/identity/derivations';
import { buildHomeNodeDIDDocument } from '../src/identity/home_node_did_document';
import {
  PROOF_TYPE,
  PROOF_PURPOSE_ASSERTION,
  SIGNING_VM_FRAGMENT,
  canonicalizeDIDDoc,
  selfCertifyDIDDoc,
  verifyDIDDocProof,
  type DIDProof,
} from '../src/identity/did_doc_proof';

function freshIdentity() {
  return deriveIdentity({ masterSeed: mnemonicToSeed(generateMnemonic()) });
}

function buildDoc(overrides: { did?: string } = {}) {
  const id = freshIdentity();
  const doc = buildHomeNodeDIDDocument(
    {
      did: overrides.did ?? 'did:plc:homenode-abcd',
      signingKey: id.root,
      msgboxEndpoint: 'wss://relay.example/ws', // populates `service` so tamper tests bite
    },
    () => new Date('2026-04-22T00:00:00Z'),
  );
  return { doc, id };
}

describe('selfCertifyDIDDoc + verifyDIDDocProof (task 4.58)', () => {
  describe('constants', () => {
    it('exports the proof type + purpose + VM fragment', () => {
      expect(PROOF_TYPE).toBe('Ed25519Signature2020');
      expect(PROOF_PURPOSE_ASSERTION).toBe('assertionMethod');
      expect(SIGNING_VM_FRAGMENT).toBe('#dina_signing');
    });
  });

  describe('happy-path round-trip', () => {
    it('sign → verify succeeds', () => {
      const { doc, id } = buildDoc();
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
        nowFn: () => new Date('2026-04-22T12:34:56Z'),
      });
      expect(proof.type).toBe('Ed25519Signature2020');
      expect(proof.proofPurpose).toBe('assertionMethod');
      expect(proof.verificationMethod).toBe(
        'did:plc:homenode-abcd#dina_signing',
      );
      expect(proof.created).toBe('2026-04-22T12:34:56.000Z');
      expect(proof.signatureHex).toMatch(/^[0-9a-f]{128}$/);

      const res = verifyDIDDocProof(doc, proof, id.root.publicKey);
      expect(res).toEqual({ ok: true });
    });

    it('signature round-trip is deterministic (Ed25519)', () => {
      const { doc, id } = buildDoc();
      const fixedNow = () => new Date('2026-04-22T00:00:00Z');
      const a = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
        nowFn: fixedNow,
      });
      const b = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
        nowFn: fixedNow,
      });
      expect(a.proof.signatureHex).toBe(b.proof.signatureHex);
    });
  });

  describe('canonicalization', () => {
    it('field order in the input does NOT affect the digest', () => {
      const { doc, id } = buildDoc();
      // Shuffle top-level key order by collecting + reversing.
      const entries = Object.entries(doc).reverse();
      const shuffled = Object.fromEntries(entries) as unknown as DIDDocument;
      const a = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
        nowFn: () => new Date('2026-04-22T00:00:00Z'),
      });
      const b = selfCertifyDIDDoc({
        doc: shuffled,
        signingPrivateKey: id.root.privateKey,
        nowFn: () => new Date('2026-04-22T00:00:00Z'),
      });
      expect(a.proof.signatureHex).toBe(b.proof.signatureHex);
    });

    it('canonicalizeDIDDoc produces identical strings for key-shuffled input', () => {
      const orig = { a: 1, b: 2, c: { x: 10, y: 20 } };
      const shuffled = { c: { y: 20, x: 10 }, b: 2, a: 1 };
      expect(canonicalizeDIDDoc(orig as unknown as DIDDocument)).toBe(
        canonicalizeDIDDoc(shuffled as unknown as DIDDocument),
      );
    });
  });

  describe('verification failures', () => {
    it('rejects wrong proof type', () => {
      const { doc, id } = buildDoc();
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
      });
      const tampered: DIDProof = {
        ...proof,
        type: 'Ed25519Signature2018' as unknown as typeof PROOF_TYPE,
      };
      expect(verifyDIDDocProof(doc, tampered, id.root.publicKey)).toEqual({
        ok: false,
        reason: 'wrong_proof_type',
      });
    });

    it('rejects wrong purpose', () => {
      const { doc, id } = buildDoc();
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
      });
      const tampered: DIDProof = {
        ...proof,
        proofPurpose: 'authentication' as unknown as typeof PROOF_PURPOSE_ASSERTION,
      };
      expect(verifyDIDDocProof(doc, tampered, id.root.publicKey)).toEqual({
        ok: false,
        reason: 'wrong_purpose',
      });
    });

    it('rejects mismatched VM (different DID)', () => {
      const { doc, id } = buildDoc();
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
      });
      const tampered: DIDProof = {
        ...proof,
        verificationMethod: 'did:plc:other#dina_signing',
      };
      expect(verifyDIDDocProof(doc, tampered, id.root.publicKey)).toEqual({
        ok: false,
        reason: 'vm_mismatch',
      });
    });

    it('rejects malformed signatureHex (wrong length / non-hex)', () => {
      const { doc, id } = buildDoc();
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
      });
      for (const bad of ['abc', '', 'zz' + 'ff'.repeat(63), 'ff'.repeat(32)]) {
        const tampered: DIDProof = { ...proof, signatureHex: bad };
        const res = verifyDIDDocProof(doc, tampered, id.root.publicKey);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('malformed_signature');
      }
    });

    it('rejects bad signature against a wrong verifier pubkey', () => {
      const { doc, id } = buildDoc();
      const other = freshIdentity().root;
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
      });
      expect(verifyDIDDocProof(doc, proof, other.publicKey)).toEqual({
        ok: false,
        reason: 'signature_invalid',
      });
    });

    it('rejects bad signature when doc has been tampered with', () => {
      const { doc, id } = buildDoc();
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
      });
      const tamperedDoc: DIDDocument = { ...doc, id: 'did:plc:evil' };
      expect(verifyDIDDocProof(tamperedDoc, proof, id.root.publicKey)).toEqual({
        ok: false,
        reason: 'vm_mismatch', // vm_mismatch fires before signature_invalid
      });
    });

    it('rejects tampered doc when VM check passes but content differs', () => {
      const { doc, id } = buildDoc();
      const { proof } = selfCertifyDIDDoc({
        doc,
        signingPrivateKey: id.root.privateKey,
      });
      // Keep id same but mutate non-id content.
      const tamperedDoc = { ...doc, service: [] } as unknown as DIDDocument;
      expect(verifyDIDDocProof(tamperedDoc, proof, id.root.publicKey)).toEqual({
        ok: false,
        reason: 'signature_invalid',
      });
    });
  });

  describe('input validation', () => {
    it('rejects missing doc', () => {
      const id = freshIdentity();
      expect(() =>
        selfCertifyDIDDoc({
          doc: null as unknown as DIDDocument,
          signingPrivateKey: id.root.privateKey,
        }),
      ).toThrow(/doc is required/);
    });

    it('rejects non-DID doc.id', () => {
      const id = freshIdentity();
      expect(() =>
        selfCertifyDIDDoc({
          doc: { id: 'not-a-did' } as unknown as DIDDocument,
          signingPrivateKey: id.root.privateKey,
        }),
      ).toThrow(/doc\.id must be a DID/);
    });

    it('rejects wrong-length signingPrivateKey', () => {
      const { doc } = buildDoc();
      expect(() =>
        selfCertifyDIDDoc({
          doc,
          signingPrivateKey: new Uint8Array(16),
        }),
      ).toThrow(/32 bytes/);
    });
  });
});
