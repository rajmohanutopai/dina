/**
 * Task 4.57 — Home Node DID Document tests.
 */

import {
  mnemonicToSeed,
  generateMnemonic,
  publicKeyToMultibase,
} from '@dina/core';
import { deriveIdentity, PERSONA_INDEX } from '../src/identity/derivations';
import {
  buildHomeNodeDIDDocument,
  SIGNING_VM_FRAGMENT,
  MESSAGING_VM_FRAGMENT,
  MSGBOX_SERVICE_FRAGMENT,
} from '../src/identity/home_node_did_document';

function fixedIdentity() {
  const seed = mnemonicToSeed(generateMnemonic());
  return deriveIdentity({ masterSeed: seed });
}

describe('buildHomeNodeDIDDocument (task 4.57)', () => {
  const DID = 'did:plc:example123';

  describe('underscore-form VM fragments', () => {
    it('fragment ids are #dina_signing and #dina_messaging (underscore, not dash)', () => {
      expect(SIGNING_VM_FRAGMENT).toBe('#dina_signing');
      expect(MESSAGING_VM_FRAGMENT).toBe('#dina_messaging');
      expect(MSGBOX_SERVICE_FRAGMENT).toBe('#dina_messaging_endpoint');
    });

    it('emits #dina_signing VM id under the DID', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      expect(doc.verificationMethod.some((vm) => vm.id === `${DID}#dina_signing`)).toBe(
        true,
      );
    });
  });

  describe('messaging aliases signing by default', () => {
    it('when no messagingKey → only ONE VM emitted', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      expect(doc.verificationMethod.length).toBe(1);
      expect(doc.verificationMethod[0]!.id).toBe(`${DID}#dina_signing`);
    });

    it('authentication array carries both fragment ids, pointing at the same VM', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      // When sharing, authentication contains the #dina_signing id twice
      // (or listed once with fragment semantics understood). We pin the
      // pragmatic shape: 2 entries for consumers that key off fragment.
      expect(doc.authentication.length).toBe(2);
      expect(doc.authentication[0]).toBe(`${DID}#dina_signing`);
    });
  });

  describe('distinct messaging key', () => {
    it('when messagingKey supplied + different from signing → two VMs', () => {
      const id = fixedIdentity();
      // Use a persona key as the "messaging" key — guaranteed distinct
      // from root (different SLIP-0010 path).
      const messagingKey = id.derivePersona(PERSONA_INDEX.health);
      const doc = buildHomeNodeDIDDocument({
        did: DID,
        signingKey: id.root,
        messagingKey,
      });
      expect(doc.verificationMethod.length).toBe(2);
      expect(doc.verificationMethod[0]!.id).toBe(`${DID}#dina_signing`);
      expect(doc.verificationMethod[1]!.id).toBe(`${DID}#dina_messaging`);
      expect(doc.verificationMethod[1]!.publicKeyMultibase).toBe(
        publicKeyToMultibase(messagingKey.publicKey),
      );
    });

    it('authentication lists BOTH distinct VM ids', () => {
      const id = fixedIdentity();
      const messagingKey = id.derivePersona(PERSONA_INDEX.health);
      const doc = buildHomeNodeDIDDocument({
        did: DID,
        signingKey: id.root,
        messagingKey,
      });
      expect(doc.authentication).toEqual([
        `${DID}#dina_signing`,
        `${DID}#dina_messaging`,
      ]);
    });

    it('explicit messagingKey that happens to match signing → still just one VM', () => {
      // Degenerate case: caller passes a messagingKey that's byte-identical
      // to signing. The builder detects + collapses.
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({
        did: DID,
        signingKey: id.root,
        messagingKey: id.root,
      });
      expect(doc.verificationMethod.length).toBe(1);
    });
  });

  describe('MsgBox service endpoint', () => {
    it('adds #dina_messaging_endpoint with DinaMsgBox type when msgboxEndpoint provided', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({
        did: DID,
        signingKey: id.root,
        msgboxEndpoint: 'https://msgbox.example.com',
      });
      expect(doc.service.length).toBe(1);
      expect(doc.service[0]).toEqual({
        id: '#dina_messaging_endpoint',
        type: 'DinaMsgBox',
        serviceEndpoint: 'https://msgbox.example.com',
      });
    });

    it('no service entry when msgboxEndpoint omitted', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      expect(doc.service).toEqual([]);
    });

    it('no service entry when msgboxEndpoint is empty string', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({
        did: DID,
        signingKey: id.root,
        msgboxEndpoint: '',
      });
      expect(doc.service).toEqual([]);
    });
  });

  describe('W3C DID Core shape', () => {
    it('emits the canonical @context', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      expect(doc['@context']).toEqual([
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1',
      ]);
    });

    it('VMs use type: "Multikey" with publicKeyMultibase', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      const vm = doc.verificationMethod[0]!;
      expect(vm.type).toBe('Multikey');
      expect(vm.publicKeyMultibase).toBe(publicKeyToMultibase(id.root.publicKey));
      expect(vm.controller).toBe(DID);
    });

    it('includes a `created` RFC3339 timestamp', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      expect(doc.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    it('created uses the injected clock for reproducibility', () => {
      const id = fixedIdentity();
      const fixedNow = new Date('2026-04-21T22:00:00.000Z');
      const doc = buildHomeNodeDIDDocument(
        { did: DID, signingKey: id.root },
        () => fixedNow,
      );
      expect(doc.created).toBe('2026-04-21T22:00:00.000Z');
    });

    it('DID id field matches the input did', () => {
      const id = fixedIdentity();
      const doc = buildHomeNodeDIDDocument({ did: DID, signingKey: id.root });
      expect(doc.id).toBe(DID);
    });
  });

  describe('input validation', () => {
    it('rejects empty did', () => {
      const id = fixedIdentity();
      expect(() =>
        buildHomeNodeDIDDocument({ did: '', signingKey: id.root }),
      ).toThrow(/did is required/);
    });

    it('rejects wrong-length signing public key', () => {
      expect(() =>
        buildHomeNodeDIDDocument({
          did: DID,
          signingKey: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(31), chainCode: new Uint8Array(32) },
        }),
      ).toThrow(/32-byte Ed25519/);
    });
  });
});
