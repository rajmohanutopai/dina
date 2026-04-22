/**
 * W3C DID Document construction and validation.
 *
 * Structure aligned with Go's identity adapter:
 * - @context: ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"]
 * - verificationMethod: Multikey type with publicKeyMultibase
 * - Fragment: #key-1 (singular, matching Go)
 * - service: [{ id: "#dina-messaging", type: "DinaMsgBox", serviceEndpoint: "wss://..." }]
 * - created: ISO 8601 timestamp
 * - authentication references the verification method
 *
 * Source: core/internal/adapter/identity/did_document.go
 */

// Types + context constants moved to `@dina/protocol` in Phase 1b task 1.17b / 1.21.
// Re-exported here so `@dina/core`'s public API surface is unchanged for
// downstream consumers (@dina/brain, @dina/test-harness, apps/mobile).
export type { VerificationMethod, ServiceEndpoint, DIDDocument } from '@dina/protocol';
import { DID_V1_CONTEXT, MULTIKEY_CONTEXT } from '@dina/protocol';
import type { DIDDocument, ServiceEndpoint } from '@dina/protocol';

/**
 * Build a W3C DID Document from identity material.
 *
 * Produces a document compatible with Go's identity system:
 * - Two @context values (DID v1 + Multikey v1)
 * - Multikey verification method type
 * - #key-1 fragment (singular, matching Go)
 * - created timestamp
 *
 * @param did - The DID (did:plc:... or did:key:...)
 * @param publicKeyMultibase - z-prefixed multibase Ed25519 public key
 * @param msgboxEndpoint - MsgBox WebSocket URL (optional)
 */
export function buildDIDDocument(
  did: string,
  publicKeyMultibase: string,
  msgboxEndpoint?: string,
): DIDDocument {
  const vmId = `${did}#key-1`;

  const doc: DIDDocument = {
    '@context': [DID_V1_CONTEXT, MULTIKEY_CONTEXT],
    id: did,
    verificationMethod: [
      {
        id: vmId,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase,
      },
    ],
    authentication: [vmId],
    service: [],
    created: new Date().toISOString(),
  };

  if (msgboxEndpoint) {
    doc.service.push({
      id: '#dina-messaging',
      type: 'DinaMsgBox',
      serviceEndpoint: msgboxEndpoint,
    });
  }

  return doc;
}

/**
 * Validate a DID Document structure.
 * @returns List of validation errors (empty = valid)
 */
export function validateDIDDocument(doc: DIDDocument): string[] {
  const errors: string[] = [];

  if (!doc['@context'] || !doc['@context'].includes(DID_V1_CONTEXT)) {
    errors.push('@context must include W3C DID v1 context');
  }
  if (!doc['@context'] || !doc['@context'].includes(MULTIKEY_CONTEXT)) {
    errors.push('@context must include Multikey v1 context');
  }
  if (!doc.id) {
    errors.push('id is required');
  }
  if (!doc.verificationMethod || doc.verificationMethod.length === 0) {
    errors.push('at least one verificationMethod is required');
  } else {
    const vm = doc.verificationMethod[0];
    if (vm.type !== 'Multikey') {
      errors.push('verificationMethod type must be Multikey');
    }
    if (vm.controller !== doc.id) {
      errors.push('verificationMethod controller must match document id');
    }
    if (!vm.publicKeyMultibase || !vm.publicKeyMultibase.startsWith('z')) {
      errors.push('publicKeyMultibase must start with "z"');
    }
  }
  // `authentication` is NOT required — the W3C DID Core spec defines it
  // as optional, and the ATProto did:plc docs we resolve from
  // plc.directory authenticate off the verificationMethod directly
  // without populating `authentication`. Requiring it here meant every
  // real did:plc peer bounced with "authentication is required" and
  // D2D send never reached the wire.

  return errors;
}

/**
 * Extract the messaging service endpoint from a DID Document.
 *
 * Accepts either fragment form — ATProto / busdriver PLC docs publish
 * the service under `#dina_messaging` (underscore), while older Dina
 * docs used `#dina-messaging` (hyphen). Accepting both keeps cross-
 * generation peers routable without the caller caring which fragment
 * convention the peer picked.
 *
 * @returns { type, endpoint } or null if no dina_messaging service
 */
export function getMessagingService(doc: DIDDocument): { type: string; endpoint: string } | null {
  const svc = doc.service?.find((s) => s.id === '#dina_messaging' || s.id === '#dina-messaging');
  if (!svc) return null;
  return { type: svc.type, endpoint: svc.serviceEndpoint };
}
